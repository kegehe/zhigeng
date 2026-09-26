#![allow(non_snake_case)]
//! 索引层测试：docs/05 的 M0 验收项在这里落地。
//! ②删库重建逐表一致 ⑤无孤儿索引行 以及中文检索、隐私硬门、视图排除。

use note_core::index::{rebuild_links, Index};
use note_core::vault::Vault;

const PRIVATE_BODY: &str = "---\nid: n-priv0001\ntitle: 私人账户备忘\nai:\n  private: true\n---\n\n银行卡尾号 4321 的校验位是 77。\n";
const ACTIVE_BODY: &str = "---\nid: n-4h7kq2w9\ntitle: 主动层设计\ntags: [ai-native]\ncreated: 2026-09-22T20:41:07+08:00\n---\n\n核心问题是打扰预算是多少。 ^b-k3x9m2v7qa\n\n## 触发点\n\n- 打开笔记时做分节渲染的建议\n- 写下问题型句子时检查已有答案 due:: 2026-09-28 ^b-p8d2f4h1wr\n\n参见 [[检索策略]] 与 [[不存在的笔记]]。\n";
const OTHER_BODY: &str = "---\nid: n-8fk2m3n7\ntitle: 检索策略\n---\n\n分节渲染之后要重排候选块，见 [[主动层设计#^b-k3x9m2v7qa]]。\n";
const VIEW_BODY: &str =
    "---\nid: n-v12mk8pq\ntitle: 待整理的想法\nview:\n  kind: smart\n  query: 主动层\n---\n";

fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(dir.path()).unwrap();
    v.write_atomic("notes/主动层设计.md", ACTIVE_BODY.as_bytes())
        .unwrap();
    v.write_atomic("notes/检索策略.md", OTHER_BODY.as_bytes())
        .unwrap();
    v.write_atomic("notes/私人.md", PRIVATE_BODY.as_bytes())
        .unwrap();
    v.write_atomic(
        "archive/旧笔记.md",
        "---\nid: n-old00001\n---\n归档里的内容不该出现在默认结果。\n".as_bytes(),
    )
    .unwrap();
    v.write_atomic("views/待整理的想法.md", VIEW_BODY.as_bytes())
        .unwrap();
    v.write_atomic("inbox/速记.md", "临时记下的一件事。\n".as_bytes())
        .unwrap();
    dir
}

fn open(dir: &std::path::Path) -> (Vault, Index) {
    let v = Vault::open(dir).unwrap();
    let idx = Index::open(&v).unwrap();
    (v, idx)
}

#[test]
fn 全量重建产出完整索引且无漂移() {
    let dir = fixture();
    let (v, idx) = open(dir.path());
    let stats = idx.rebuild_all(&v).unwrap();
    assert_eq!(stats.notes, 6, "{stats:?}");
    assert!(stats.blocks >= 9, "块过少 {stats:?}");
    assert!(stats.chunks >= 5, "切片过少 {stats:?}");
    assert_eq!(stats.links, 3, "两条可解析 + 一条悬空: {stats:?}");
    assert_eq!(idx.drift(&v).unwrap(), 0, "md 与 db 不应有偏差");
    assert!(idx.orphan_counts().unwrap().is_clean());
}

#[test]
fn 增量重建与全量重建逐表一致() {
    let dir = fixture();
    let (v, idx) = open(dir.path());
    idx.rebuild_all(&v).unwrap();
    let full = idx.table_counts().unwrap();

    // 逐篇走增量路径（模拟日常保存），结果必须与全量重建一模一样
    for f in v.scan().unwrap() {
        let src = String::from_utf8(v.read(&f.rel).unwrap()).unwrap();
        idx.index_file(&f, &src).unwrap();
    }
    rebuild_links(idx.conn()).unwrap();
    let inc = idx.table_counts().unwrap();
    assert_eq!(full, inc, "增量与全量结果不一致");
    assert!(idx.orphan_counts().unwrap().is_clean());
}

#[test]
fn 删除库文件后能完整重建() {
    let dir = fixture();
    let (v, idx) = open(dir.path());
    idx.rebuild_all(&v).unwrap();
    let before = idx.table_counts().unwrap();

    drop(idx);
    std::fs::remove_file(v.meta_dir().join("index.db")).unwrap();
    let (v2, idx2) = open(dir.path());
    idx2.rebuild_all(&v2).unwrap();
    assert_eq!(before, idx2.table_counts().unwrap(), "删库重建后表计数变了");
}

#[test]
fn 同篇重复索引不留孤儿() {
    let dir = fixture();
    let (v, idx) = open(dir.path());
    idx.rebuild_all(&v).unwrap();
    let f = v
        .scan()
        .unwrap()
        .into_iter()
        .find(|x| x.rel.ends_with("主动层设计.md"))
        .unwrap();
    for _ in 0..3 {
        let src = String::from_utf8(v.read(&f.rel).unwrap()).unwrap();
        idx.index_file(&f, &src).unwrap();
    }
    assert!(
        idx.orphan_counts().unwrap().is_clean(),
        "派生表出现孤儿：清理顺序被破坏了"
    );
    let hits = idx.search_keyword("打扰预算", 10).unwrap();
    let uniq: std::collections::HashSet<_> = hits.iter().map(|h| h.block_id.clone()).collect();
    assert_eq!(hits.len(), uniq.len(), "重复索引造成同一块多次命中");
}

#[test]
fn 中文分词后能命中词组() {
    let dir = fixture();
    let (v, idx) = open(dir.path());
    idx.rebuild_all(&v).unwrap();

    let hits = idx.search_keyword("打扰预算", 10).unwrap();
    assert!(!hits.is_empty(), "中文词组检索应命中");
    assert_eq!(hits[0].note_id, "n-4h7kq2w9", "{:?}", hits[0]);

    let hits2 = idx.search_keyword("分节渲染", 10).unwrap();
    assert!(!hits2.is_empty(), "跨两篇的词都应命中");
    assert!(hits2.iter().all(|h| h.score.is_finite()));

    // 单词的一部分不应该命中（证明是分词而非子串）
    let partial = idx.search_keyword("预算是多少", 10).unwrap();
    assert!(!partial.is_empty(), "组合词应通过分词命中");
}

#[test]
fn 隐私硬门在SQL层生效() {
    let dir = fixture();
    let (v, idx) = open(dir.path());
    idx.rebuild_all(&v).unwrap();
    let hits = idx.search_keyword("银行卡", 20).unwrap();
    assert!(
        hits.iter().all(|h| h.note_id != "n-priv0001"),
        "ai.private 笔记被召回了: {hits:?}"
    );
    let n: i64 = idx
        .conn()
        .query_row(
            "SELECT count(*) FROM notes WHERE id='n-priv0001' AND ai_private=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1, "private 标记没落到库里");
}

#[test]
fn 归档默认排除但已索引() {
    let dir = fixture();
    let (v, idx) = open(dir.path());
    idx.rebuild_all(&v).unwrap();
    let n: i64 = idx
        .conn()
        .query_row(
            "SELECT count(*) FROM notes WHERE status='archived'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
    let hits = idx.search_keyword("归档里的内容", 20).unwrap();
    assert!(
        hits.iter().all(|h| h.status != "archived"),
        "归档笔记不该出现在默认结果"
    );
}

#[test]
fn 视图定义不进块表也不进检索() {
    let dir = fixture();
    let (v, idx) = open(dir.path());
    idx.rebuild_all(&v).unwrap();
    let n: i64 = idx
        .conn()
        .query_row(
            "SELECT count(*) FROM blocks b JOIN notes n ON n.id=b.note_id WHERE n.note_kind='view'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0, "视图不应产生块");
    let hits = idx.search_keyword("待整理的想法", 20).unwrap();
    assert!(
        hits.iter().all(|h| h.note_id != "n-v12mk8pq"),
        "视图定义被当成知识内容召回了"
    );
}

#[test]
fn 链接图解析出双向与悬空() {
    let dir = fixture();
    let (v, idx) = open(dir.path());
    idx.rebuild_all(&v).unwrap();
    let resolved: i64 = idx
        .conn()
        .query_row("SELECT count(*) FROM links WHERE broken=0", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(resolved >= 2, "至少解析出两条链接: {resolved}");
    let broken: i64 = idx
        .conn()
        .query_row("SELECT count(*) FROM links WHERE broken=1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(broken, 1, "指向不存在的笔记应登记为悬空链接");
    // 块级引用要能解析到具体块。库内的块 ID 是 `{笔记}#{锚点}` 的限定形式
    // （裸锚点在跨笔记复制时会撞主键，见 plan_blocks），文件里写的仍是裸锚点
    let block_level: i64 = idx
        .conn()
        .query_row(
            "SELECT count(*) FROM links l JOIN blocks b ON b.id = l.to_block
             WHERE l.to_block LIKE '%#b-k3x9m2v7qa' AND l.broken=0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(block_level, 1, "块级引用没解析出来（AI 引用溯源依赖它）");
}

#[test]
fn 切片带标题面包屑且行内字段入库() {
    let dir = fixture();
    let (v, idx) = open(dir.path());
    idx.rebuild_all(&v).unwrap();
    let crumbs: i64 = idx
        .conn()
        .query_row(
            "SELECT count(*) FROM chunks WHERE header_path IS NOT NULL AND header_path LIKE '%触发点%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(crumbs >= 1, "切片缺少标题面包屑，AI 会拿到无上下文片段");

    let due: i64 = idx
        .conn()
        .query_row(
            "SELECT count(*) FROM blocks WHERE props_json LIKE '%2026-09-28%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(due, 1, "due:: 字段没进 props_json");
}

#[test]
fn 两篇带同一个front_matter_id的文件不该让整库索引崩掉() {
    // 导入真实 Vault 最容易踩的一条：Obsidian 模板另存、Notion 导出重复页，都会带着
    // 同一个 `id:` 进来。`notes.id` 是主键，撞了就是一整次重建失败——一个坏文件拖垮全库。
    let dir = tempfile::tempdir().unwrap();
    let vault = note_core::vault::Vault::open(dir.path()).unwrap();
    let idx = note_core::index::Index::open(&vault).unwrap();
    for (rel, body) in [
        ("notes/甲.md", "---\nid: n-dup1\n---\n\n甲的内容\n"),
        ("notes/乙.md", "---\nid: n-dup1\n---\n\n乙的内容\n"),
    ] {
        vault.write_atomic(rel, body.as_bytes()).unwrap();
    }
    let stats = idx.rebuild_all(&vault).unwrap();
    assert_eq!(stats.notes, 2, "两篇都该进库：{stats:?}");
    assert_eq!(idx.count_notes().unwrap(), 2);
    // 后到的那个退回按路径的 id，而不是把前一篇顶掉
    let rows = idx.list_notes(10).unwrap();
    let paths: Vec<&str> = rows.iter().map(|n| n.rel.as_str()).collect();
    assert!(
        paths.contains(&"notes/甲.md") && paths.contains(&"notes/乙.md"),
        "{paths:?}"
    );
    assert_eq!(
        idx.search_keyword("乙的内容", 5).unwrap().len(),
        1,
        "被撞掉的那一篇会搜不到"
    );
    assert_eq!(idx.drift(&vault).unwrap(), 0);
}

#[test]
fn 旧库的链接暂存表在打开时重灌锚点不再丢() {
    // 钉的是 v1 → v2 这条迁移本身。v1 的主键漏了 to_block，同一段里指向同一篇的
    // 三条链接会塌成一条；库里已有的数据必须在下次打开时按 blocks.markdown 重算出来。
    let dir = tempfile::tempdir().unwrap();
    let vault = note_core::vault::Vault::open(dir.path()).unwrap();
    {
        let idx = note_core::index::Index::open(&vault).unwrap();
        vault
            .write_atomic(
                "notes/甲.md",
                "都在这儿：[[乙]]、[[乙#某标题]]、[[乙#^b-k3x9m2v7qa]]\n".as_bytes(),
            )
            .unwrap();
        vault
            .write_atomic(
                "notes/乙.md",
                "## 某标题\n\n被指的那块。 ^b-k3x9m2v7qa\n".as_bytes(),
            )
            .unwrap();
        idx.rebuild_all(&vault).unwrap();
        assert_eq!(
            idx.conn()
                .query_row("SELECT COUNT(*) FROM link_targets", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            3,
            "新库就该有三条暂存链接（各自带锚点）"
        );
        // 手工退回 v1 的形状与版本号
        idx.conn()
            .execute_batch("DROP TABLE link_targets;")
            .unwrap();
        idx.conn()
            .execute_batch(
                "CREATE TABLE link_targets (
               from_block TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
               target TEXT NOT NULL, to_block TEXT, kind TEXT NOT NULL,
               PRIMARY KEY (from_block, target, kind));",
            )
            .unwrap();
        // 按 v1 的行为灌一遍：第一条赢，后两条被 OR IGNORE 吃掉
        for (t, a) in [
            ("乙", None),
            ("乙", Some("某标题")),
            ("乙", Some("b-k3x9m2v7qa")),
        ] {
            idx.conn()
                .execute(
                    "INSERT OR IGNORE INTO link_targets(from_block,target,to_block,kind)
                 SELECT id, ?1, ?2, 'ref' FROM blocks WHERE markdown LIKE '%[[乙#^b-%'",
                    rusqlite::params![t, a],
                )
                .unwrap();
        }
        idx.conn()
            .execute("UPDATE meta SET value='1' WHERE key='schema_version'", [])
            .unwrap();
        assert_eq!(
            idx.conn()
                .query_row("SELECT COUNT(*) FROM link_targets", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1,
            "v1 的形状就该塌成一条，否则这个测试没在测东西"
        );
    }
    let idx = note_core::index::Index::open(&vault).unwrap();
    assert_eq!(
        idx.conn()
            .query_row("SELECT COUNT(*) FROM link_targets", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        3,
        "打开时没重灌链接"
    );
    assert_eq!(
        idx.conn()
            .query_row(
                "SELECT COUNT(*) FROM links WHERE to_block IS NOT NULL",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1,
        "块级引用没解析出来"
    );
}

#[test]
fn 标签与属性按类型落进各自的列() {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(dir.path()).unwrap();
    v.write_atomic(
        "notes/带属性.md",
        "---\nid: n-prop0001\ntitle: 带属性\ntags: [ai-native, m4, ai-native]\nprops:\n  priority: high\n  as_of: 2026-09-22\n  weight: 3\n  已确认: true\n---\n\n一段正文。\n"
            .as_bytes(),
    )
    .unwrap();
    let idx = Index::open(&v).unwrap();
    idx.rebuild_all(&v).unwrap();

    let tags: Vec<String> = {
        let mut s = idx
            .conn()
            .prepare("SELECT tag FROM tags ORDER BY tag")
            .unwrap();
        s.query_map([], |r| r.get(0))
            .unwrap()
            .filter_map(|x| x.ok())
            .collect()
    };
    assert_eq!(tags, vec!["ai-native", "m4"], "重复的只留一条: {tags:?}");

    // (key, text, num, date, json)——五元组写 inline 太糊，起个名字
    type PropRow = (
        String,
        Option<String>,
        Option<f64>,
        Option<String>,
        Option<String>,
    );
    let rows: Vec<PropRow> = {
        let mut s = idx
            .conn()
            .prepare(
                "SELECT key, value_text, value_num, value_date, value_json FROM props ORDER BY key",
            )
            .unwrap();
        s.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .unwrap()
        .filter_map(|x| x.ok())
        .collect()
    };
    assert_eq!(rows.len(), 4, "{rows:?}");
    // 分列存的意义：按 due 排序、按 priority 分组不用在 SQL 里现解析字符串
    assert_eq!(
        rows.iter()
            .find(|(k, ..)| k == "as_of")
            .unwrap()
            .3
            .as_deref(),
        Some("2026-09-22"),
        "日期该落在 value_date: {rows:?}"
    );
    assert_eq!(
        rows.iter().find(|(k, ..)| k == "weight").unwrap().2,
        Some(3.0),
        "数字该落在 value_num: {rows:?}"
    );
    assert_eq!(
        rows.iter()
            .find(|(k, ..)| k == "priority")
            .unwrap()
            .1
            .as_deref(),
        Some("high")
    );
}

#[test]
fn 改了frontmatter旧标签不会留在库里() {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(dir.path()).unwrap();
    let 初版 = "---\nid: n-tag0001\ntags: [甲, 乙]\nprops:\n  priority: high\n---\n\n内容。\n";
    v.write_atomic("notes/甲.md", 初版.as_bytes()).unwrap();
    let (v2, idx) = open(dir.path());
    idx.rebuild_all(&v2).unwrap();
    let count = |sql: &str| -> i64 { idx.conn().query_row(sql, [], |r| r.get(0)).unwrap() };
    assert_eq!(count("SELECT COUNT(*) FROM tags"), 2);
    assert_eq!(count("SELECT COUNT(*) FROM props"), 1);

    // 日常保存路径：换标签、删属性
    v2.write_atomic(
        "notes/甲.md",
        "---\nid: n-tag0001\ntags: [丙]\n---\n\n内容。\n".as_bytes(),
    )
    .unwrap();
    let f = v2.note_file("notes/甲.md").unwrap();
    idx.index_file(&f, "---\nid: n-tag0001\ntags: [丙]\n---\n\n内容。\n")
        .unwrap();
    let tags: Vec<String> = {
        let mut s = idx.conn().prepare("SELECT tag FROM tags").unwrap();
        s.query_map([], |r| r.get(0))
            .unwrap()
            .filter_map(|x| x.ok())
            .collect()
    };
    assert_eq!(tags, vec!["丙"], "旧标签洗掉了没有: {tags:?}");
    assert_eq!(
        count("SELECT COUNT(*) FROM props"),
        0,
        "front-matter 里删掉的属性必须跟着消失"
    );
    assert!(idx.orphan_counts().unwrap().is_clean());
}

#[test]
fn 删掉一篇后标签与属性不留孤儿() {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(dir.path()).unwrap();
    v.write_atomic(
        "notes/甲.md",
        "---\nid: n-del0001\ntags: [留痕]\nprops:\n  as_of: 2026-09-22\n---\n\n内容。\n".as_bytes(),
    )
    .unwrap();
    let (v2, idx) = open(dir.path());
    idx.rebuild_all(&v2).unwrap();
    assert_eq!(
        idx.conn()
            .query_row("SELECT COUNT(*) FROM tags", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    std::fs::remove_file(v2.root().join("notes").join("甲.md")).unwrap();
    idx.rebuild_all(&v2).unwrap();
    let 剩 = |t: &str| {
        idx.conn()
            .query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
    };
    assert_eq!(
        剩("tags"),
        0,
        "文件没了标签还在，标签视图就会多出一个点不开的标签"
    );
    assert_eq!(剩("props"), 0);
    assert!(idx.orphan_counts().unwrap().is_clean());
}

#[test]
fn 视图文件的标签不进标签表() {
    // views/ 是查询定义，不参与检索（docs/02）；标签与属性同一口径，
    // 否则"按标签筛选"的结果里会混进视图自己
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(dir.path()).unwrap();
    v.write_atomic(
        "views/待办.md",
        "---\nid: n-view0001\ntags: [视图标签]\nprops:\n  priority: high\n---\n".as_bytes(),
    )
    .unwrap();
    let (v2, idx) = open(dir.path());
    idx.rebuild_all(&v2).unwrap();
    assert_eq!(
        idx.conn()
            .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1,
        "视图本身还是要登记的"
    );
    assert_eq!(
        idx.conn()
            .query_row("SELECT COUNT(*) FROM tags", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        idx.conn()
            .query_row("SELECT COUNT(*) FROM props", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}
