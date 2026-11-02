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
    rebuild_links(idx.conn(), dir.path()).unwrap();
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
fn 反链面板给出入链与出链且悬空那条带着原始写法() {
    let dir = fixture();
    let (v, idx) = open(dir.path());
    idx.rebuild_all(&v).unwrap();
    // 夹具的形状：主动层设计 → [[检索策略]] + [[不存在的笔记]]（悬空）；
    // 检索策略 → [[主动层设计#^b-k3x9m2v7qa]]（块级）
    let (入, _, 出, _) = idx.note_links("notes/主动层设计.md", 50).unwrap();
    assert_eq!(入.len(), 1, "只该有一篇链到我: {入:?}");
    assert_eq!(入[0].rel, "notes/检索策略.md");
    assert!(入[0].to_block, "对方指到的是我某个块，不整篇");
    assert!(
        入[0].snippet.contains("分节渲染之后"),
        "上下文要带发起那条链的块: {入:?}"
    );
    assert!(!入[0].broken, "入链必然是解析成功的");

    assert_eq!(出.len(), 2, "两条出链: {出:?}");
    assert!(出[0].broken, "悬空的那条排在前面（面板上它才是要处理的）");
    assert_eq!(出[0].rel, "", "没有对方笔记");
    assert_eq!(出[0].status, "missing");
    assert_eq!(出[0].target, "不存在的笔记", "原始写法是仅剩的信息");
    assert_eq!(出[0].title, "不存在的笔记", "标题退回写法，别显示空");
    assert!(!出[1].broken);
    assert_eq!(出[1].rel, "notes/检索策略.md");

    // 另一头看回来：块级引用在入链侧认得出"指到具体块"
    let (入, _, 出, _) = idx.note_links("notes/检索策略.md", 50).unwrap();
    assert_eq!(入[0].rel, "notes/主动层设计.md");
    assert!(!入[0].to_block, "对方链的是整篇");
    assert_eq!(出.len(), 1);
    assert!(出[0].to_block, "我链到对方的具体块");
}

/// 一张内容寻址的图落进 `attachments/`，返回库内相对路径。
/// 字节随便写——这一档判的是"文件在不在"，不看内容（格式判定住在 `sniff`，粘贴那条路才用它）。
fn 一张图(v: &Vault) -> String {
    let 路 = format!("attachments/aa/{}.png", "a".repeat(64));
    v.write_atomic(&路, b"\x89PNG\r\n\x1a\n").unwrap();
    路
}

#[test]
fn 资产链接在盘上_面板不说链空了() {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(dir.path()).unwrap();
    let 图 = 一张图(&v);
    v.write_atomic("notes/甲.md", format!("看图。\n\n![[{图}]]\n").as_bytes())
        .unwrap();
    let idx = Index::open(&v).unwrap();
    idx.rebuild_all(&v).unwrap();

    let (_, _, 出, _) = idx.note_links("notes/甲.md", 50).unwrap();
    assert_eq!(出.len(), 1, "{出:?}");
    assert_eq!(出[0].kind, "asset");
    assert!(!出[0].broken, "图就在盘上，面板不能说它空了");
    assert_eq!(
        出[0].rel, 图,
        "对方是那个文件：同一张图的两种写法该归并进同一行"
    );

    // docs/03 欠的那条重建路径：删掉 index.db 之后 attachments 表要能自己长回来
    let 数: i64 = idx
        .conn()
        .query_row("SELECT count(*) FROM attachments", [], |r| r.get(0))
        .unwrap();
    assert_eq!(数, 1, "重建全量时按 attachments/ 目录登记");
}

#[test]
fn 附件被外部删掉_不重索引面板当场改口() {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(dir.path()).unwrap();
    let 图 = 一张图(&v);
    v.write_atomic("notes/甲.md", format!("看图。\n\n![[{图}]]\n").as_bytes())
        .unwrap();
    let idx = Index::open(&v).unwrap();
    idx.rebuild_all(&v).unwrap();
    let (_, _, 出, _) = idx.note_links("notes/甲.md", 50).unwrap();
    assert!(!出[0].broken);

    // 资源管理器 / Obsidian / 同步盘把那张图删了。**中间不跑任何索引**：
    // 外部删附件不会惊动任何一篇 `.md`，`watch::ignorable` 在攒批之前就把非 `.md` 挡了，
    // 所以"面板追得上盘上"这件事只能由读路径现算来保证。
    std::fs::remove_file(dir.path().join(&图)).unwrap();
    let (_, _, 出, _) = idx.note_links("notes/甲.md", 50).unwrap();
    assert!(出[0].broken, "文件真没了才说没了");
    assert_eq!(出[0].rel, "", "没有可打开的对方");
    assert_eq!(出[0].target, 图, "原始写法是仅剩的信息");
}

#[test]
fn 指得到笔记的带点写法不按盘上判() {
    // `[[notes/乙.md]]` 会被 `link_kind` 标成 asset（写法里有点），但它的真值是那篇笔记：
    // 要是也去按"文件名的后缀"猜，就会有一篇活得好好的笔记在面板上被叫成附件。
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(dir.path()).unwrap();
    v.write_atomic("notes/乙.md", "乙。\n".as_bytes()).unwrap();
    v.write_atomic("notes/甲.md", "见 [[notes/乙.md]]。\n".as_bytes())
        .unwrap();
    let idx = Index::open(&v).unwrap();
    idx.rebuild_all(&v).unwrap();
    let (_, _, 出, _) = idx.note_links("notes/甲.md", 50).unwrap();
    assert_eq!(出[0].rel, "notes/乙.md");
    assert!(!出[0].broken);
}

#[test]
fn 真找不到的图还是说丢了() {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(dir.path()).unwrap();
    v.write_atomic(
        "notes/甲.md",
        "看图。\n\n![[attachments/aa/不存在.png]]\n\n裸名 ![[也没有.png]]\n".as_bytes(),
    )
    .unwrap();
    let idx = Index::open(&v).unwrap();
    idx.rebuild_all(&v).unwrap();
    let (_, _, 出, _) = idx.note_links("notes/甲.md", 50).unwrap();
    assert_eq!(出.len(), 2, "{出:?}");
    assert!(
        出.iter().all(|l| l.broken),
        "盘上没有就是丢了，两种写法都一样"
    );
}

#[test]
fn 视图文件不进反链面板() {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(dir.path()).unwrap();
    v.write_atomic("notes/甲.md", "---\nid: n-a1\n---\n甲的内容。\n".as_bytes())
        .unwrap();
    v.write_atomic(
        "views/看板.md",
        "---\nid: n-v1\ntitle: 看板\nview:\n  kind: smart\n  query: 甲\n---\n\n视图里也写了 [[甲]]。\n"
            .as_bytes(),
    )
    .unwrap();
    let idx = Index::open(&v).unwrap();
    idx.rebuild_all(&v).unwrap();
    let (入, _, _, _) = idx.note_links("notes/甲.md", 50).unwrap();
    assert!(
        入.is_empty(),
        "视图不是笔记，链到它不该出现在面板上: {入:?}"
    );
}

#[test]
fn 归档笔记的入链照收但带着状态() {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(dir.path()).unwrap();
    v.write_atomic("notes/甲.md", "---\nid: n-a1\n---\n甲的内容。\n".as_bytes())
        .unwrap();
    v.write_atomic(
        "archive/旧笔记.md",
        "---\nid: n-old1\n---\n以前写过 [[甲]]。\n".as_bytes(),
    )
    .unwrap();
    let idx = Index::open(&v).unwrap();
    idx.rebuild_all(&v).unwrap();
    let (入, _, _, _) = idx.note_links("notes/甲.md", 50).unwrap();
    assert_eq!(入.len(), 1, "归档是真结构，藏起来面板就说谎: {入:?}");
    assert_eq!(入[0].status, "archived", "但要带着状态，界面好淡化");
}

#[test]
fn 旧库的链接表在打开时补上原始写法() {
    // 钉的是 v2 → v3 这条迁移。`links` 是纯解析结果，所以迁移按"删掉重算"而不是改写：
    // link_targets 没动，重跑一次 rebuild_links 就该把 target 填回每一行
    let dir = tempfile::tempdir().unwrap();
    let vault = note_core::vault::Vault::open(dir.path()).unwrap();
    {
        let idx = note_core::index::Index::open(&vault).unwrap();
        vault
            .write_atomic(
                "notes/甲.md",
                "链到 [[乙]]，还链到 [[不存在的笔记]]。\n".as_bytes(),
            )
            .unwrap();
        vault
            .write_atomic("notes/乙.md", "被链的一方。\n".as_bytes())
            .unwrap();
        idx.rebuild_all(&vault).unwrap();
        assert_eq!(
            idx.conn()
                .query_row("SELECT COUNT(*) FROM links WHERE target<>''", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            2,
            "新库每条链接都该带写法"
        );
        // 手工退回 v2 的形状与版本号
        idx.conn().execute_batch("DROP TABLE links;").unwrap();
        idx.conn()
            .execute_batch(
                "CREATE TABLE links (
               id INTEGER PRIMARY KEY,
               from_block TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
               to_note TEXT REFERENCES notes(id) ON DELETE CASCADE,
               to_block TEXT REFERENCES blocks(id) ON DELETE SET NULL,
               kind TEXT NOT NULL, provenance TEXT NOT NULL DEFAULT 'human',
               broken INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0);
             CREATE INDEX links_to_idx ON links(to_note);
             CREATE INDEX links_from_idx ON links(from_block);
             CREATE INDEX links_to_block_idx ON links(to_block);",
            )
            .unwrap();
        // 按 v2 的行为灌两条：一条解析到了对方，一条悬空——两条都没有 target 这一列
        for (to, broken) in [
            ("(SELECT id FROM notes WHERE path='notes/乙.md')", false),
            ("NULL", true),
        ] {
            idx.conn()
                .execute(
                    &format!(
                        "INSERT INTO links(from_block,to_note,to_block,kind,broken)
                         SELECT id, {to}, NULL, 'ref', ?1 FROM blocks WHERE markdown LIKE '%[[%'"
                    ),
                    rusqlite::params![broken as i64],
                )
                .unwrap();
        }
        idx.conn()
            .execute("UPDATE meta SET value='2' WHERE key='schema_version'", [])
            .unwrap();
        assert_eq!(
            idx.conn()
                .query_row("SELECT COUNT(*) FROM links", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2,
            "v2 的形状就该有两条没有写法的链接，否则这个测试没在测东西"
        );
    }
    let idx = note_core::index::Index::open(&vault).unwrap();
    let (入, _, 出, _) = idx.note_links("notes/甲.md", 50).unwrap();
    assert_eq!(入.len(), 0);
    assert_eq!(出.len(), 2, "迁移后链接图要完整回来: {出:?}");
    assert_eq!(
        idx.conn()
            .query_row("SELECT COUNT(*) FROM links WHERE target<>''", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2,
        "打开时没把原始写法补进 links"
    );
    let 悬空 = 出.iter().find(|l| l.broken).expect("悬空那条没了");
    assert_eq!(悬空.target, "不存在的笔记");
}

#[test]
fn 老库的两张链接表一起升级且版本号要记下来() {
    // 真机照出来的两条，缺一不可：
    // ① 迁移原先"每档各自 drop/建/算"，v1 那一档跑 `rebuild_links` 时 `links` 还是旧形状，
    //    插 target 列直接 `table links has no column named target`，整个库打不开；
    // ② 迁移完只 `pragma_update(user_version, 旧值)`，meta 里那条没更新 ⇒ 每次开库重跑迁移。
    let dir = tempfile::tempdir().unwrap();
    let vault = note_core::vault::Vault::open(dir.path()).unwrap();
    vault
        .write_atomic("notes/甲.md", "链到 [[乙]] 和 [[不存在]]。\n".as_bytes())
        .unwrap();
    vault
        .write_atomic("notes/乙.md", "被链的一方。\n".as_bytes())
        .unwrap();
    {
        let idx = note_core::index::Index::open(&vault).unwrap();
        idx.rebuild_all(&vault).unwrap();
        // 手工退回 v1：两张表都是旧形状，版本号也改回去
        idx.conn()
            .execute_batch("DROP TABLE links; DROP TABLE link_targets;")
            .unwrap();
        idx.conn()
            .execute_batch(
                "CREATE TABLE links (
               id INTEGER PRIMARY KEY,
               from_block TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
               to_note TEXT REFERENCES notes(id) ON DELETE CASCADE,
               to_block TEXT REFERENCES blocks(id) ON DELETE SET NULL,
               kind TEXT NOT NULL, provenance TEXT NOT NULL DEFAULT 'human',
               broken INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE link_targets (
               from_block TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
               target TEXT NOT NULL, to_block TEXT, kind TEXT NOT NULL,
               PRIMARY KEY (from_block, target, kind));",
            )
            .unwrap();
        idx.conn()
            .execute("UPDATE meta SET value='1' WHERE key='schema_version'", [])
            .unwrap();
        // 故意留一个**不等于本程序 MD_FORMAT_VERSION** 的值：schema 迁移不该碰它。
        // 这两个版本号管的对象不同——`md_format_version` 长在用户资产里，改它要写数据迁移
        idx.conn()
            .execute(
                "UPDATE meta SET value='7' WHERE key='md_format_version'",
                [],
            )
            .unwrap();
    }
    let idx = note_core::index::Index::open(&vault).unwrap();
    assert_eq!(
        idx.conn()
            .query_row(
                "SELECT value FROM meta WHERE key='md_format_version'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "7",
        "schema 迁移把 md_format_version 一起刷掉了——那是资产格式的版本号"
    );
    assert_eq!(
        idx.conn()
            .query_row(
                "SELECT value FROM meta WHERE key='schema_version'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "4",
        "迁移跑完没把版本号记下来，下次开库还要重跑"
    );
    assert_eq!(
        idx.conn()
            .query_row("SELECT COUNT(*) FROM links WHERE target<>''", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2,
        "v1 库升级后链接图要完整回来且带写法"
    );
    let (入, _, 出, _) = idx.note_links("notes/乙.md", 50).unwrap();
    assert_eq!(入.len(), 1, "甲 → 乙 的入链要在");
    assert!(入[0].snippet.contains("链到"));
    assert!(出.is_empty());
    // 再开一次：版本号已经是 4，不该再有迁移动作，数据也不能变
    drop(idx);
    let idx = note_core::index::Index::open(&vault).unwrap();
    assert_eq!(
        idx.conn()
            .query_row("SELECT COUNT(*) FROM links", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
}

/// v3 → v4：`note_versions` 换钥匙（path 代替 note_id、不挂外键），**而且必须保行**。
///
/// 迁移框架是"丢掉重算"，而版本不是能重算出来的东西——盘上早就没有那一版了。
/// 所以这一档得把旧行搬到新表里，不能像链接表那样 drop 掉重算。
#[test]
fn 老库的版本表换钥匙但不丢行() {
    let dir = tempfile::tempdir().unwrap();
    let vault = note_core::vault::Vault::open(dir.path()).unwrap();
    vault
        .write_atomic(
            "notes/甲.md",
            "---\nid: n-old0001\ntitle: 甲\n---\n\n正文。\n".as_bytes(),
        )
        .unwrap();
    {
        let idx = note_core::index::Index::open(&vault).unwrap();
        idx.rebuild_all(&vault).unwrap();
        // 手工退回 v3：旧形状（挂外键、钥匙是 note_id），并塞一条旧行
        idx.conn()
            .execute_batch("DROP TABLE note_versions;")
            .unwrap();
        idx.conn()
            .execute_batch(
                "CREATE TABLE note_versions (
                   id INTEGER PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                   content_hash TEXT NOT NULL, blob_path TEXT NOT NULL,
                   reason TEXT, created_at INTEGER NOT NULL,
                   UNIQUE (note_id, content_hash));",
            )
            .unwrap();
        idx.conn()
            .execute(
                "INSERT INTO note_versions(note_id,content_hash,blob_path,reason,created_at)
                 VALUES('n-old0001','abc123','.note/versions/n-old0001/abc123','manual',1000)",
                [],
            )
            .unwrap();
        idx.conn()
            .execute("UPDATE meta SET value='3' WHERE key='schema_version'", [])
            .unwrap();
    }
    let idx = note_core::index::Index::open(&vault).unwrap();
    // 行还在，而且 path 从 notes 表反查得到
    let 行: (String, String, String) = idx
        .conn()
        .query_row(
            "SELECT path,note_id,content_hash FROM note_versions WHERE content_hash='abc123'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(行.0, "notes/甲.md", "旧行的 path 该从 notes 表反查回来");
    assert_eq!(行.1, "n-old0001");
    assert_eq!(行.2, "abc123");
    // 新表不再挂外键：笔记的行被删，版本行必须还在
    idx.conn()
        .execute("DELETE FROM notes WHERE id='n-old0001'", [])
        .unwrap();
    let 还在: i64 = idx
        .conn()
        .query_row("SELECT COUNT(*) FROM note_versions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(还在, 1, "版本活得比笔记久：notes 行删了它也得在");
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

#[test]
fn 反链取不完要老实说截断() {
    // 面板上那句「还有更多没列出」靠这两个布尔位。前端猜数组长度等于把截断藏起来
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(dir.path()).unwrap();
    v.write_atomic(
        "notes/目标.md",
        "---\nid: n-t1\n---\n被链的一方。\n".as_bytes(),
    )
    .unwrap();
    for i in 1..=3 {
        v.write_atomic(
            &format!("notes/来源{i}.md"),
            format!("---\nid: n-s{i}\n---\n第 {i} 篇链到 [[目标]]。\n").as_bytes(),
        )
        .unwrap();
    }
    let idx = Index::open(&v).unwrap();
    idx.rebuild_all(&v).unwrap();
    let (入, 入截, 出, 出截) = idx.note_links("notes/目标.md", 2).unwrap();
    assert_eq!(入.len(), 2, "取回来的不超过 limit");
    assert!(入截, "还有第 3 条没取回来，必须报截断");
    assert_eq!(出.len(), 0);
    assert!(!出截, "一篇都没链出去，不该谎报截断");
    let (入, 入截, _, _) = idx.note_links("notes/目标.md", 50).unwrap();
    assert_eq!(入.len(), 3);
    assert!(!入截, "全取回来了就不该报截断");
}

#[test]
fn 颜色与高亮不进检索正文与面包屑() {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(dir.path()).unwrap();
    let body = "---\nid: n-color0001\ntitle: 排版试验\n---\n\n## <span style=\"color:#e5534b\">红标题</span>\n\n<span style=\"background-color:#4a9eff33\">整行蓝底</span> 与 ==高亮==。\n";
    v.write_atomic("notes/排版试验.md", body.as_bytes())
        .unwrap();
    let (v, idx) = open(dir.path());
    idx.rebuild_all(&v).unwrap();

    // 切片正文（要拿去嵌入、也要拼给模型）与面包屑都不能带标签 / 记号
    let text: String = idx
        .conn()
        .query_row("SELECT text FROM chunks ORDER BY rowid LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(!text.contains("<span"), "切片正文带了标签: {text}");
    assert!(!text.contains("=="), "切片正文带了高亮记号: {text}");
    assert!(text.contains("红标题"), "{text}");
    assert!(text.contains("高亮"), "{text}");

    // 块级纯文本同一口径
    let dirty: i64 = idx
        .conn()
        .query_row(
            "SELECT count(*) FROM blocks WHERE text LIKE '%<span%' OR text LIKE '%==%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(dirty, 0, "有块的 text 里还带着颜色语法");

    // 行首的 span 不许把整块判成 html（那样再打开就不能当正文编辑）
    let html: i64 = idx
        .conn()
        .query_row("SELECT count(*) FROM blocks WHERE type='html'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(html, 0);
}

#[test]
fn 上下标不进检索正文且行首不判成HTML块() {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(dir.path()).unwrap();
    let body = "---\nid: n-sup0001\ntitle: 上下标试验\n---\n\n<sup>2</sup> 是平方\n\nH<sub>2</sub>O 是水\n";
    v.write_atomic("notes/上下标试验.md", body.as_bytes())
        .unwrap();
    let (v, idx) = open(dir.path());
    idx.rebuild_all(&v).unwrap();

    let text: String = idx
        .conn()
        .query_row("SELECT text FROM chunks ORDER BY rowid LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(!text.contains("<sup"), "切片正文带了标签: {text}");
    assert!(!text.contains("<sub"), "切片正文带了标签: {text}");
    assert!(text.contains("2 是平方"), "{text}");
    assert!(text.contains("H2O"), "{text}");

    let dirty: i64 = idx
        .conn()
        .query_row(
            "SELECT count(*) FROM blocks WHERE text LIKE '%<sup%' OR text LIKE '%<sub%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(dirty, 0, "有块的 text 里还带着上下标标签");

    // 行首的 <sup> 不许把整块判成 html（那样再打开就不能当正文编辑）
    let html: i64 = idx
        .conn()
        .query_row("SELECT count(*) FROM blocks WHERE type='html'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(html, 0);
}
