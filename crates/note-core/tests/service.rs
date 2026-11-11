#![allow(non_snake_case)]
//! 服务层端到端：README 里写的那条命令流程，这里跑一遍同样的路径。
//! 手工跑一次才发现的"正文被写两遍"这类问题，必须留在测试里。

use note_core::meta_edit::{MetaPatch, PropEdit};
use note_core::service::{reindex_note, Hub};

fn hub_in(dir: &std::path::Path) -> Hub {
    std::fs::create_dir_all(dir).unwrap();
    Hub::open(dir).unwrap()
}

#[test]
fn 捕获两篇后端到端可用且不重复() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());

    let a = hub
        .capture("第一条想法：分节渲染要实测才知道代价", None)
        .unwrap();
    let b = hub
        .capture("检索策略：先分词再 BM25，然后 rerank", None)
        .unwrap();

    // 每篇速记应当只有 1 个块（曾经在正文里插 H1 会变成 2 块且内容重复）
    let blocks_a = hub.read_note(&a.rel).unwrap().blocks;
    assert_eq!(blocks_a.len(), 1, "{:?}", blocks_a);
    let blocks_b = hub.read_note(&b.rel).unwrap().blocks;
    assert_eq!(blocks_b.len(), 1, "{:?}", blocks_b);

    let hits = hub.search_keyword("分词", 10).unwrap();
    assert_eq!(hits.len(), 1, "检索出现重复命中: {hits:?}");
    assert_eq!(hits[0].note_id, b.id);

    let list = hub.list_notes(10).unwrap();
    assert_eq!(list.notes.len(), 2, "{:?}", list.notes);
    let titles: Vec<&str> = list.notes.iter().map(|n| n.title.as_str()).collect();
    assert!(
        titles.contains(&"第一条想法：分节渲染要实测才知道代价"),
        "标题没从 front-matter 取: {titles:?}"
    );
    assert!(
        list.notes.iter().all(|n| n.status == "inbox"),
        "速记应标成 inbox: {:?}",
        list.notes
    );

    assert_eq!(hub.drift().unwrap(), 0, "md 与 db 有漂移");
    assert!(hub.orphan_counts().unwrap().is_clean());
}

#[test]
fn 保存已有笔记会重索引并留下可搜的新内容() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    let c = hub.capture("最初只有一句话", None).unwrap();

    let hash = hub
        .save_note(&c.rel, "最初只有一句话\n\n后来补的一句：波浪号补充内容\n")
        .unwrap();
    assert!(!hash.is_empty());

    let blocks = hub.read_note(&c.rel).unwrap().blocks;
    assert_eq!(blocks.len(), 2, "第二块没被索引: {blocks:?}");
    let hits = hub.search_keyword("波浪号", 10).unwrap();
    assert_eq!(hits.len(), 1, "{hits:?}");
    assert_eq!(hub.drift().unwrap(), 0);
}

#[test]
fn 属性面板只改指定几行_并走与正文同一条冲突判定() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    let c = hub.capture("一句话", None).unwrap();
    let 前 = hub.read_raw(&c.rel).unwrap();
    let v = hub.note_meta(&c.rel).unwrap();
    assert!(v.tags.is_empty(), "{v:?}");
    assert!(!v.private && !v.no_ai);

    let patch = MetaPatch {
        tags: Some(vec!["m5".into()]),
        props: Some(vec![PropEdit {
            key: "due".into(),
            kind: "date".into(),
            value: Some("2026-11-05".into()),
        }]),
        private: Some(true),
        no_ai: None,
    };
    let h = hub.note_meta_save(&c.rel, &patch, Some(&v.hash)).unwrap();
    let 后 = hub.read_raw(&c.rel).unwrap();
    assert_eq!(后.hash, h);
    assert!(后.content.contains("tags: [m5]\n"), "{}", 后.content);
    assert!(
        后.content.contains("props:\n  due: 2026-11-05\n"),
        "{}",
        后.content
    );
    assert!(
        后.content.contains("ai:\n  private: true\n"),
        "{}",
        后.content
    );
    assert!(
        后.content.contains("title: "),
        "写了属性不能丢标题：{}",
        后.content
    );
    assert!(后.content.contains("一句话"), "正文不能丢：{}", 后.content);

    // 同一份意图再存一次：字节与 hash 都不动（不该产生版本快照）
    let v2 = hub.note_meta(&c.rel).unwrap();
    let h2 = hub.note_meta_save(&c.rel, &patch, Some(&v2.hash)).unwrap();
    assert_eq!(h, h2);
    assert_eq!(hub.read_raw(&c.rel).unwrap().content, 后.content);

    // 旧 hash 来存 = 盘上已经变过，拒绝
    let err = hub
        .note_meta_save(&c.rel, &patch, Some(&前.hash))
        .unwrap_err();
    assert!(matches!(err, note_core::Error::Conflict(_)), "{err:?}");
}

#[test]
fn 正好一页不算截断多一篇才算() {
    // 曾经按 `rows.len() == limit` 猜：库里正好 limit 篇时，侧栏会说"只列出了最近
    // N 篇（库里共 N 篇）"——一篇没少却说自己被截断了。
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    for i in 0..3 {
        hub.capture(&format!("第 {i} 条"), None).unwrap();
    }

    let 两篇 = hub.list_notes(2).unwrap();
    assert_eq!(两篇.notes.len(), 2);
    assert!(两篇.truncated, "库里 3 篇只取 2 篇，后面确实还有");
    assert_eq!(两篇.indexed, 3);

    let 三篇 = hub.list_notes(3).unwrap();
    assert_eq!(三篇.notes.len(), 3);
    assert!(!三篇.truncated, "正好一页不该说自己被截断");

    let 四篇 = hub.list_notes(4).unwrap();
    assert_eq!(四篇.notes.len(), 3, "取不满时也不能补空行");
    assert!(!四篇.truncated);
}

#[test]
fn 空内容不落盘() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    assert!(hub.capture("   \n ", None).is_err());
    assert_eq!(hub.list_notes(10).unwrap().notes.len(), 0);
}

#[test]
fn 索引一次都不落在启动路径之外() {
    // 重开 Hub（模拟应用重启）不该重复堆索引，也不该出现漂移
    let d = tempfile::tempdir().unwrap();
    {
        let mut hub = hub_in(d.path());
        hub.capture("重启前要留住的一条", None).unwrap();
    }
    let hub = hub_in(d.path());
    assert_eq!(hub.list_notes(10).unwrap().notes.len(), 1);
    assert_eq!(hub.drift().unwrap(), 0);
    assert_eq!(hub.search_keyword("重启", 10).unwrap().len(), 1);
}

#[test]
fn 新建改名移动删除恢复全程索引不漂() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());

    let rel = hub.note_create("周会纪要", None).unwrap();
    assert!(rel.starts_with("notes/"), "{rel}");
    assert_eq!(hub.read_note(&rel).unwrap().title, "周会纪要");

    let renamed = hub.note_rename(&rel, "周会纪要 9 月").unwrap();
    assert_ne!(renamed, rel);
    assert_eq!(
        hub.read_note(&renamed).unwrap().title,
        "周会纪要 9 月",
        "改名必须连 front-matter 一起改，列表显示的是 title"
    );
    assert_eq!(hub.list_notes(10).unwrap().notes.len(), 1, "改名后多出一篇");

    let file = renamed.rsplit('/').next().unwrap().to_string();
    let moved = format!("整理/{file}");
    hub.note_move(&renamed, &moved).unwrap();
    let row = hub.list_notes(10).unwrap().notes.remove(0);
    assert_eq!(
        (row.rel.as_str(), row.status.as_str()),
        (moved.as_str(), "active")
    );

    hub.note_trash(&moved).unwrap();
    assert_eq!(hub.list_notes(10).unwrap().notes.len(), 0);
    let trash = hub.list_trash().unwrap();
    assert_eq!(trash.len(), 1, "{trash:?}");
    assert_eq!(trash[0].rel, moved, "回收站要记得恢复目标路径");

    hub.note_restore(&trash[0].batch, &trash[0].rel).unwrap();
    assert_eq!(hub.list_notes(10).unwrap().notes.len(), 1);
    assert!(hub.list_trash().unwrap().is_empty());
    assert_eq!(hub.drift().unwrap(), 0, "每一步之后 md 与 db 都必须对齐");
    assert!(hub.orphan_counts().unwrap().is_clean());
}

fn open_index(hub: &Hub) -> rusqlite::Connection {
    rusqlite::Connection::open(hub.vault().meta_dir().join("index.db")).unwrap()
}

fn link_stats(conn: &rusqlite::Connection) -> (i64, i64) {
    conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(broken), 0) FROM links",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

#[test]
fn 删掉被引用的笔记时入链退回悬空而不是静默消失() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    let target = hub.note_create("目标笔记", None).unwrap();
    hub.save_note("notes/引用者.md", "看 [[目标笔记]] 那篇。\n")
        .unwrap();

    let conn = open_index(&hub);
    assert_eq!(link_stats(&conn), (1, 0), "新建的链接应当解析成功");

    // notes 行一删，指向它的 links 行会被 ON DELETE CASCADE 一起带走。
    // 不重解析的话，用户的反链就在界面上凭空少一条——它其实只是暂时悬空。
    hub.note_trash(&target).unwrap();
    assert_eq!(link_stats(&conn), (1, 1), "目标被删后链接必须退回 broken=1");

    let trash = hub.list_trash().unwrap();
    hub.note_restore(&trash[0].batch, &trash[0].rel).unwrap();
    assert_eq!(link_stats(&conn), (1, 0), "恢复后链接要重新接上");
}

#[test]
fn 悬空的笔记链接靠新建同名笔记接得回来() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    hub.save_note("notes/引用者.md", "看 [[下周要写的]]。\n")
        .unwrap();
    let conn = open_index(&hub);
    assert_eq!(link_stats(&conn), (1, 1), "前置：这条链接是悬空的");

    // 面板上「新建这篇并打开」走的就是这一步：链接原文当标题建一篇。
    // 落点会带日期前缀，但 `resolve_broken_to` 按**标题**接回来——标题改一个字就接不上，
    // 所以前端传的必须是 target 原文，不能顺手清理成文件名。
    let rel = hub.note_create("下周要写的", None).unwrap();
    assert!(
        rel.ends_with("-下周要写的.md"),
        "落点应当带上日期前缀，链接却仍按标题接回来: {rel}"
    );
    assert_eq!(link_stats(&conn), (1, 0), "新建之后链接应当接回来");
}

#[test]
fn 同名笔记删两次在回收站里不互相覆盖() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    let rel = hub.note_create("同名", None).unwrap();
    hub.save_note(
        &rel,
        "---\nid: n-keep0001\ntitle: \"同名\"\n---\n\n第一条内容\n",
    )
    .unwrap();
    hub.note_trash(&rel).unwrap();
    hub.save_note(
        &rel,
        "---\nid: n-keep0002\ntitle: \"同名\"\n---\n\n第二条内容\n",
    )
    .unwrap();
    hub.note_trash(&rel).unwrap();

    let trash = hub.list_trash().unwrap();
    assert_eq!(
        trash.len(),
        2,
        "镜像存放会把第二次覆盖到第一次上: {trash:?}"
    );
    assert_ne!(trash[0].batch, trash[1].batch);
    let bodies: Vec<String> = trash
        .iter()
        .map(|t| {
            String::from_utf8_lossy(&hub.vault().read_from_trash(&t.batch, &t.rel).unwrap())
                .to_string()
        })
        .collect();
    assert!(bodies.iter().any(|b| b.contains("第一条")), "{bodies:?}");
    assert!(bodies.iter().any(|b| b.contains("第二条")), "{bodies:?}");

    hub.note_restore(&trash[0].batch, &rel).unwrap();
    // 原位已被占用，第二次恢复必须报冲突而不是盖掉刚恢复的那篇
    assert!(matches!(
        hub.note_restore(&trash[1].batch, &rel),
        Err(note_core::Error::Conflict(_))
    ));
}

#[test]
fn 回收站可预览正文也可永久删除() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    let rel = hub.note_create("要删的", None).unwrap();
    hub.note_trash(&rel).unwrap();
    let t = hub.list_trash().unwrap().remove(0);

    // 删之前写了什么，读盘就能看见——这正是"确认删的是哪一版"要的东西
    assert!(hub
        .read_trash(&t.batch, &t.rel)
        .unwrap()
        .content
        .contains("要删的"));
    // 删除时刻来自批次名，不是文件 mtime（rename 会把 mtime 原样留下来）
    let now = note_core::versions::现在();
    assert!(
        (now - t.deleted_ms).abs() < 60_000,
        "删除时刻不对: deleted={} now={now}",
        t.deleted_ms
    );

    // 原位又写了一篇同名：永久删除回收件不能把它一起带走
    hub.save_note(
        &rel,
        "---\nid: n-reborn01\ntitle: \"新写的\"\n---\n\n新写的正文\n",
    )
    .unwrap();

    hub.note_purge(&t.batch, &t.rel).unwrap();
    assert!(hub.list_trash().unwrap().is_empty());
    assert!(hub.read_trash(&t.batch, &t.rel).is_err());
    let alive = String::from_utf8(hub.vault().read(&rel).unwrap()).unwrap();
    assert!(
        alive.contains("新写的正文"),
        "永久删除回收件误伤了原位的新笔记: {alive}"
    );

    // 清空是另一条路：还剩几条就删几条，返回删掉的文件数
    let rel2 = hub.note_create("另一篇", None).unwrap();
    hub.note_trash(&rel2).unwrap();
    assert_eq!(hub.empty_trash().unwrap(), 1);
    assert!(hub.list_trash().unwrap().is_empty());
    assert_eq!(
        hub.list_notes(10).unwrap().notes.len(),
        1,
        "原位那篇新笔记还在"
    );
}

#[test]
fn 回收站预览超过服务端上限要标截断() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    // 直接落盘绕过索引：这份用例只关心预览读了多少钱
    let 大 = "a".repeat(note_core::service::TRASH_PREVIEW_BYTES as usize + 100);
    hub.vault()
        .write_atomic("notes/大.md", 大.as_bytes())
        .unwrap();
    hub.note_trash("notes/大.md").unwrap();
    let t = hub.list_trash().unwrap().remove(0);

    let p = hub.read_trash(&t.batch, &t.rel).unwrap();
    assert!(p.truncated, "大文件预览没标截断");
    assert_eq!(
        p.content.len(),
        note_core::service::TRASH_PREVIEW_BYTES as usize,
        "预览不该把整份文件都读出来"
    );
}

#[test]
fn 回收站的恢复参数不能越出Vault() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    // batch 与 rel 都是从 UI 来的，拼进 trash 路径之前必须过边界校验。
    // 只断言 `is_err` 不够：旧实现把 `a/../../b` 切成 `b`，最后是因为文件不存在
    // 才报错——校验其实没拦住。这里钉住**类型**必须是 OutsideVault。
    for batch in ["..", "a/../../b", "a/b", ".", "", "C:probe.txt"] {
        assert!(
            matches!(
                hub.note_restore(batch, "notes/甲.md"),
                Err(note_core::Error::OutsideVault(_))
            ),
            "batch={batch:?} 没有被路径校验拒绝"
        );
    }
}

#[test]
fn 没有_id_的笔记改名后不留孤儿行() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    // 手写或从 Obsidian 导入的笔记没有 front-matter id，这类才是大多数
    hub.save_note("notes/无id.md", "# 无 id\n\n正文甲\n")
        .unwrap();
    assert_eq!(hub.list_notes(10).unwrap().notes.len(), 1);

    hub.note_rename("notes/无id.md", "换了名字").unwrap();
    let list = hub.list_notes(10).unwrap().notes;
    assert_eq!(list.len(), 1, "改名后残留旧行: {list:?}");
    assert_eq!(hub.drift().unwrap(), 0, "md 与 db 已漂移");
}

#[test]
fn 写路径拒绝落在应用私有目录与非_md_目标() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    hub.save_note(
        "notes/甲.md",
        "正文
",
    )
    .unwrap();
    // 少了这道闸，save_note(".note/index.db") 能把整个索引覆盖掉
    assert!(matches!(
        hub.save_note(".note/index.db", "x"),
        Err(note_core::Error::Invalid(_))
    ));
    assert!(matches!(
        hub.note_move("notes/甲.md", ".note/甲.md"),
        Err(note_core::Error::Invalid(_))
    ));
    assert!(matches!(
        hub.note_move("notes/甲.md", "notes/甲.txt"),
        Err(note_core::Error::Invalid(_))
    ));
    assert!(matches!(
        hub.note_create("   ", None),
        Err(note_core::Error::Invalid(_))
    ));
    // 深层点目录同样不可写：扫描器不索引它，写进去就是一条永远对不上的漂移行
    assert!(matches!(
        hub.save_note("notes/.hidden/甲.md", "x"),
        Err(note_core::Error::Invalid(_))
    ));
    assert!(matches!(
        hub.save_note("node_modules/甲.md", "x"),
        Err(note_core::Error::Invalid(_))
    ));
    // 被拒的操作不能留下任何痕迹
    assert_eq!(hub.list_notes(10).unwrap().notes.len(), 1);
    assert_eq!(hub.drift().unwrap(), 0);
}

#[test]
fn 保存被引用的笔记不能弄丢别人的入链() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    let target = hub.note_create("被引用者", None).unwrap();
    hub.save_note(
        "notes/引用方.md",
        "看 [[被引用者]]。
",
    )
    .unwrap();
    let conn = open_index(&hub);
    assert_eq!(link_stats(&conn), (1, 0), "前置条件：链接已解析");

    // index_file 会先删 notes 行再插回来，而 links.to_note 是 ON DELETE CASCADE
    hub.save_note(
        &target,
        "---
id: n-being001
title: \"被引用者\"
---

改了一版正文
",
    )
    .unwrap();
    assert_eq!(
        link_stats(&conn),
        (1, 0),
        "保存目标笔记之后，引用方的入链不该消失"
    );
}

#[test]
fn 失败的操作不能把索引改坏() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    let target = hub.note_create("被引用者", None).unwrap();
    hub.save_note(
        "notes/引用方.md",
        "看 [[被引用者]]。
",
    )
    .unwrap();
    hub.save_note(
        "notes/占位.md",
        "占着位置的
",
    )
    .unwrap();
    let conn = open_index(&hub);
    assert_eq!(link_stats(&conn), (1, 0));

    // 目标位置已有文件：移动必须失败。失败不该是"先把入链置悬空，再发现动不了"
    assert!(hub.note_move(&target, "notes/占位.md").is_err());
    assert_eq!(link_stats(&conn), (1, 0), "移动失败之后入链仍是悬空态");
    assert_eq!(hub.drift().unwrap(), 0);
    assert!(
        hub.vault().resolve(&target).unwrap().exists(),
        "原文件必须还在"
    );
}

#[test]
fn 下划线不会被当成_like_通配符() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    hub.save_note(
        "notes/a_b.md",
        "带下划线的笔记
",
    )
    .unwrap();
    hub.save_note(
        "notes/引用方.md",
        "指向不存在的 [[axb#^b-zzz]]。
",
    )
    .unwrap();
    let conn = open_index(&hub);
    assert_eq!(link_stats(&conn), (1, 1), "前置：这条链接本来就悬空");

    // 恢复 a_b 时按文件名找"曾经指向它"的链接：`a_b` 当 LIKE 模式会把 `axb` 也捞进来
    hub.note_trash("notes/a_b.md").unwrap();
    let t = hub.list_trash().unwrap();
    hub.note_restore(&t[0].batch, "notes/a_b.md").unwrap();
    assert_eq!(
        link_stats(&conn),
        (1, 1),
        "毫不相干的悬空链接被错接到了 a_b 上"
    );
}

#[test]
fn 锚点写错的链接登记得下来而不是让保存炸掉() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    hub.save_note(
        "notes/存在.md",
        "存在的
",
    )
    .unwrap();
    // 目标笔记存在、锚点不存在：外键不该把整次保存打回去
    hub.save_note(
        "notes/引用方.md",
        "看 [[存在#^b-手滑写错的]]。
",
    )
    .unwrap();
    let conn = open_index(&hub);
    assert_eq!(link_stats(&conn), (1, 0), "笔记接得上，锚点先丢着");
    let to_block: Option<String> = conn
        .query_row("SELECT to_block FROM links LIMIT 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(to_block, None, "不存在的块不该硬写进 to_block");
    drop(conn);
    // 全量重建走的是同一条解析路径，这里也必须活下来
    drop(hub);
    std::fs::remove_file(d.path().join(".note/index.db")).unwrap();
    let hub = hub_in(d.path());
    assert_eq!(hub.list_notes(10).unwrap().notes.len(), 2);
    assert_eq!(hub.drift().unwrap(), 0);
}

/// 前端"未改动的块原样回写"这条契约的地基：把 EditDoc 按
/// front-matter + Σ(gap_before + raw) + trailing_gap 拼回去，必须与源文件逐字节相同。
/// 用 testdata/roundtrip 的真实语法样本（含表格、公式、setext、未识别语法）来验。
#[test]
fn 编辑器的块切片重组后与源文件逐字节相同() {
    let dir = ["../../testdata/roundtrip", "testdata/roundtrip"]
        .iter()
        .find(|p| std::path::Path::new(p).is_dir())
        .unwrap();
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    let mut checked = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().map(|e| e != "md").unwrap_or(true) {
            continue;
        }
        let src = std::fs::read_to_string(&path).unwrap();
        let rel = format!("notes/rt-{}", path.file_name().unwrap().to_string_lossy());
        hub.save_note(&rel, &src).unwrap();
        let doc = hub.note_edit_doc(&rel).unwrap();
        let mut out = doc.front_matter.clone();
        for b in &doc.blocks {
            out.push_str(&b.gap_before);
            out.push_str(&b.raw);
        }
        out.push_str(&doc.trailing_gap);
        assert_eq!(out, src, "{} 的块切片拼不回源文件", path.display());
        // 前端那份夹具是无损测试的输入：解析器一改形状、夹具却还是旧的，
        // vitest 就会拿过期的形状跑全绿。所以顺带把 JSON 也钉住。
        let fix = std::path::Path::new(dir)
            .parent()
            .unwrap()
            .join("editdoc")
            .join(
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .strip_suffix(".md")
                    .unwrap(),
            )
            .with_extension("json");
        assert_eq!(
            serde_json::to_string(&doc).unwrap(),
            std::fs::read_to_string(&fix)
                .unwrap_or_else(|e| panic!(
                    "{} 读不到，用 `note edit-doc` 重新生成：{e}",
                    fix.display()
                ))
                .trim_end(),
            "{} 与 md-kernel 的输出脱节",
            fix.display()
        );
        checked += 1;
    }
    assert!(checked >= 5, "样本没跑全：{checked}");
}

#[test]
fn 两篇笔记共用同一个块锚点也要都能索引() {
    // 模板、复制文件、Obsidian 里另存一份都会造成重复锚点。
    // 曾经库内主键用裸锚点，第二篇直接 INSERT 失败——整库都建不起来。
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    hub.save_note("notes/甲.md", "第一段共用的锚点。 ^b-k3x9m2v7qa\n")
        .unwrap();
    hub.save_note("notes/乙.md", "另一篇也带同一个锚点。 ^b-k3x9m2v7qa\n")
        .unwrap();
    assert_eq!(hub.list_notes(10).unwrap().notes.len(), 2);
    assert_eq!(hub.drift().unwrap(), 0);
    assert!(hub.orphan_counts().unwrap().is_clean());
    // 块级引用仍然精确指向自己那篇的块
    hub.save_note("notes/丙.md", "指回甲：[[甲#^b-k3x9m2v7qa]]\n")
        .unwrap();
    assert_eq!(hub.search_keyword("指回甲", 5).unwrap().len(), 1);
}

#[test]
fn 后台索引握着它那条连接时读命令照常返回() {
    // 钉的是 docs/03 §后端调用纪律 的机制本身：补索引走第二条连接，读命令不排它的锁。
    // 上一版两者共用一把锁，保存 2999 块之后第一个读命令等了 3.26 秒。
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    let c = hub.capture("速记的一条，作为读的目标", None).unwrap();
    hub.index_one(&c.rel).unwrap();

    let bg = hub.indexer();
    let held = bg.lock().unwrap();
    assert_eq!(
        held.count_notes().unwrap(),
        1,
        "第二条连接看到的不是同一个库文件"
    );
    assert_eq!(hub.list_notes(10).unwrap().notes.len(), 1);
    assert!(hub.read_raw(&c.rel).unwrap().content.contains("速记的一条"));
    assert_eq!(hub.search_keyword("读的目标", 10).unwrap().len(), 1);
    drop(held);

    // 反过来：写走第二条连接也得留下一致的状态（否则"后台"只是把漂移挪了个地方）
    let bg = hub.indexer();
    let idx = bg.lock().unwrap();
    reindex_note(hub.vault(), &idx, &c.rel).unwrap();
    drop(idx);
    assert_eq!(hub.drift().unwrap(), 0, "经第二条连接索引后 md 与 db 漂移");
    assert!(hub.orphan_counts().unwrap().is_clean());
}

#[test]
fn 从快照恢复一篇被改坏的笔记() {
    // 验收 ⑨ 的服务层这条路：配置 → 快照 → 改坏 → 恢复。
    // 走的是界面用的那几个方法，不是直接调 snapshot::run。
    let d = tempfile::tempdir().unwrap();
    let backup = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    hub.set_backup(Some(backup.path().to_str().unwrap()), false)
        .unwrap();
    assert!(hub.app_info().unwrap().backup_dir.is_some());

    let original = "# 周记\n\n第一版内容。\n";
    hub.save_note("notes/周记.md", original).unwrap();
    let first = hub.snapshot_now(true).unwrap().expect("该做出第一份");
    assert_eq!(
        hub.app_info().unwrap().backup_last_at.as_deref(),
        Some(first.taken_at.as_str()),
        "界面刷新拿的上次备份时间要走小账本"
    );

    hub.save_note("notes/周记.md", "# 周记\n\n被我改坏了。\n")
        .unwrap();
    hub.snapshot_now(true).unwrap().unwrap();

    let hist = hub.snapshots_of("notes/周记.md").unwrap();
    assert_eq!(hist.len(), 2, "两份快照都该含这一篇: {hist:?}");
    assert_eq!(hist.last().unwrap().id, first.id, "列表要新的在前");

    // 恢复的是"第一份"里那个字节
    hub.snapshot_restore("notes/周记.md", &first.id).unwrap();
    assert_eq!(hub.read_raw("notes/周记.md").unwrap().content, original);
    hub.index_one("notes/周记.md").unwrap();
    assert_eq!(hub.drift().unwrap(), 0, "恢复后 md 与 db 漂移");

    // 被覆盖掉的那一份必须留得下来
    let kept = d.path().join(".note/conflicts/notes/周记.md");
    assert!(
        kept.exists(),
        "恢复是覆盖动作，被覆盖的那份得留在 conflicts 里"
    );
    assert!(std::fs::read_to_string(&kept)
        .unwrap()
        .contains("被我改坏了"));
}

#[test]
fn 换到已有备份目录时把最近时间的账本对齐() {
    // 换机 / 换盘时指向的是一个已经有快照的目录：这里不补账本的话，界面从下一次
    // 刷新起每次都要解析整份清单（两万篇 × 30 份是几十兆），直到下一次快照。
    let d = tempfile::tempdir().unwrap();
    let backup = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    hub.set_backup(Some(backup.path().to_str().unwrap()), false)
        .unwrap();
    hub.save_note("notes/周记.md", "第一版\n").unwrap();
    let first = hub.snapshot_now(true).unwrap().unwrap();

    let dir = note_core::snapshot::vault_dir(hub.vault(), backup.path().to_str().unwrap())
        .expect("备份目录应当在库外面");
    std::fs::remove_file(dir.join("last.json")).unwrap();
    // 账本不在时读命令靠清单兜底，答案仍然对
    assert_eq!(
        hub.app_info().unwrap().backup_last_at.as_deref(),
        Some(first.taken_at.as_str())
    );
    assert!(!dir.join("last.json").exists(), "读命令不该去写账本");

    // 重新选一次同一个（已有快照的）目录 = 对齐账本
    hub.set_backup(Some(backup.path().to_str().unwrap()), false)
        .unwrap();
    assert!(dir.join("last.json").exists(), "换目录时应当把账本对齐");
    assert_eq!(
        hub.app_info().unwrap().backup_last_at.as_deref(),
        Some(first.taken_at.as_str())
    );
}

#[test]
fn 从快照恢复的编号不能越出备份目录() {
    // 恢复入口拿的是界面/CLI 给的编号，不能直接拼路径：`..` 或绝对路径
    // 会读到备份目录以外。编号与 rel 两道都要挡。
    let d = tempfile::tempdir().unwrap();
    let backup = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    hub.set_backup(Some(backup.path().to_str().unwrap()), false)
        .unwrap();
    hub.save_note("notes/周记.md", "第一版\n").unwrap();
    let first = hub.snapshot_now(true).unwrap().unwrap();

    for bad in [
        "..",
        "../..",
        "..\\..",
        &backup.path().join("别处").display().to_string(),
    ] {
        assert!(
            hub.snapshot_restore("notes/周记.md", bad).is_err(),
            "{bad:?} 被当成快照编号读出去了"
        );
    }
    assert!(
        hub.snapshot_restore("../外面.md", &first.id).is_err(),
        "rel 爬出快照目录同样要拒绝"
    );
    // 合法的恢复仍然走得通
    hub.snapshot_restore("notes/周记.md", &first.id).unwrap();
    assert_eq!(hub.read_raw("notes/周记.md").unwrap().content, "第一版\n");
}

#[test]
fn 备份目录没配置时相关命令都是空操作而不是报错() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    hub.capture("没备份的库也该照常能用", None).unwrap();
    assert!(hub.snapshot_now(true).unwrap().is_none());
    assert!(hub.snapshots_recent(10).unwrap().is_empty());
    assert!(hub.snapshots_of("inbox/x.md").unwrap().is_empty());
    // 显式关掉之后 disabled 为真；"还没配 / 已关掉"由前端从 dir + disabled 推出
    hub.set_backup(None, true).unwrap();
    let info = hub.app_info().unwrap();
    assert!(info.backup_disabled);
    assert!(info.backup_dir.is_none());
}

#[test]
fn 备份目录指向库内会被拒绝() {
    let d = tempfile::tempdir().unwrap();
    let hub = hub_in(d.path());
    let inside = d.path().join("backups");
    let err = hub
        .set_backup(Some(inside.to_str().unwrap()), false)
        .unwrap_err();
    assert!(err.to_string().contains("不能放在 Vault 里面"), "{err}");
    // 拒绝的同时不能留下半套配置
    assert!(hub.app_info().unwrap().backup_dir.is_none());
}

#[test]
fn 外部改动的收敛只重算真变了的那几篇() {
    use note_core::service::apply_external;
    use note_core::watch::Change;

    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    let c = hub.capture("最初的一条 关键词阿尔法", None).unwrap();
    let abs = d
        .path()
        .join(c.rel.replace('/', std::path::MAIN_SEPARATOR_STR));

    // 自己刚写完的那一次：监听器一定报，但内容没变，就该什么都不做
    let bg = hub.indexer();
    let idx = bg.lock().unwrap();
    assert_eq!(
        apply_external(hub.vault(), &idx, &[Change::Touched(c.rel.clone())]).unwrap(),
        0,
        "自我写入被 hash 闸门挡住了吗"
    );

    // 外部（Obsidian / 编辑器）改了内容
    std::fs::write(&abs, "改过的一条 关键词贝塔\n").unwrap();
    assert_eq!(
        apply_external(hub.vault(), &idx, &[Change::Touched(c.rel.clone())]).unwrap(),
        1
    );
    drop(idx);
    assert_eq!(
        hub.search_keyword("贝塔", 5).unwrap().len(),
        1,
        "外部改动没刷进索引"
    );
    assert_eq!(hub.search_keyword("阿尔法", 5).unwrap().len(), 0);

    // 外部删了文件：报 Touched 还是 Removed 都该收敛到"摘掉"
    std::fs::remove_file(&abs).unwrap();
    let idx = bg.lock().unwrap();
    assert_eq!(
        apply_external(hub.vault(), &idx, &[Change::Removed(c.rel.clone())]).unwrap(),
        1
    );
    assert_eq!(
        apply_external(
            hub.vault(),
            &idx,
            &[Change::Touched("notes/从没存在过.md".into())]
        )
        .unwrap(),
        0,
        "库里没有、盘上也没有的路径不该动任何东西"
    );
    drop(idx);
    assert_eq!(hub.list_notes(10).unwrap().notes.len(), 0);
    assert_eq!(hub.drift().unwrap(), 0, "摘掉之后 md 与 db 该一致");
    assert!(hub.orphan_counts().unwrap().is_clean());
}

/// 监听器的过滤规则与扫描器的排除规则**不是同一套**：`node_modules/` 下的 `.md`
/// 会报上来，而扫描器不收。收敛必须以扫描器为准，否则索引里多出一行、全库自检从此
/// 报漂移，而且没有别的路径会把它摘掉。
#[test]
fn 收敛不收扫描器排除的路径() {
    use note_core::service::apply_external;
    use note_core::watch::Change;

    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    let c = hub.capture("正经一篇 关键词伽马", None).unwrap();

    std::fs::create_dir_all(d.path().join("node_modules/pkg")).unwrap();
    std::fs::write(
        d.path().join("node_modules/pkg/README.md"),
        "依赖包里的说明 关键词德尔塔\n",
    )
    .unwrap();

    let bg = hub.indexer();
    let idx = bg.lock().unwrap();
    // 一批里好坏混着：被排除的那条不该进索引，也不该影响同批那篇正文的改动
    std::fs::write(
        d.path()
            .join(c.rel.replace('/', std::path::MAIN_SEPARATOR_STR)),
        "外部改过的正经一篇\n",
    )
    .unwrap();
    assert_eq!(
        apply_external(
            hub.vault(),
            &idx,
            &[
                Change::Touched("node_modules/pkg/README.md".into()),
                Change::Touched(c.rel.clone()),
            ]
        )
        .unwrap(),
        1,
        "被排除的路径不该算进动了几篇"
    );
    assert_eq!(hub.search_keyword("德尔塔", 5).unwrap().len(), 0);
    assert_eq!(hub.search_keyword("外部改过", 5).unwrap().len(), 1);
    drop(idx);
    assert_eq!(hub.list_notes(10).unwrap().notes.len(), 1);
    assert_eq!(hub.drift().unwrap(), 0, "排除目录不该造成漂移");
    assert!(hub.orphan_counts().unwrap().is_clean());
}

#[test]
fn 在指定目录里新建笔记落在那一层() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    std::fs::create_dir_all(d.path().join("notes")).unwrap();
    let dir = hub.create_dir("notes", "工作").unwrap();
    let rel = hub.note_create("周报", Some(&dir)).unwrap();
    assert!(rel.starts_with("notes/工作/"), "{rel}");
    assert!(d.path().join(&rel).is_file());
    assert_eq!(hub.read_note(&rel).unwrap().title, "周报");
    assert!(hub.list_dirs().unwrap().contains(&dir));
    // 落点不能挂到视图 / 附件 / 不存在的目录
    assert!(matches!(
        hub.note_create("x", Some("views")),
        Err(note_core::Error::Invalid(_))
    ));
    assert!(matches!(
        hub.note_create("x", Some("attachments")),
        Err(note_core::Error::Invalid(_))
    ));
    assert!(matches!(
        hub.note_create("x", Some("notes/没有")),
        Err(note_core::Error::NotFound(_))
    ));
    assert_eq!(hub.list_notes(10).unwrap().notes.len(), 1);
    assert_eq!(hub.drift().unwrap(), 0, "目录里的笔记不该造成漂移");
}

#[test]
fn 目录改名删名之后tree_toml跟着走() {
    use note_core::tree_order::TreeOrder;
    let d = tempfile::tempdir().unwrap();
    let hub = hub_in(d.path());
    std::fs::create_dir_all(d.path().join("notes")).unwrap();
    hub.create_dir("notes", "旧").unwrap();
    hub.save_tree_order(&[
        TreeOrder {
            parent: "notes".into(),
            names: vec!["旧".into()],
        },
        TreeOrder {
            parent: "notes/旧".into(),
            names: vec!["甲.md".into()],
        },
    ])
    .unwrap();

    assert_eq!(hub.rename_dir("notes/旧", "新").unwrap(), "notes/新");
    let orders = hub.tree_order().unwrap();
    assert_eq!(orders[0].parent, "notes");
    assert_eq!(orders[0].names, vec!["新".to_string()]);
    assert_eq!(orders[1].parent, "notes/新");

    hub.delete_dir("notes/新").unwrap();
    assert!(hub.tree_order().unwrap().is_empty(), "删掉后两层都该没了");
}
