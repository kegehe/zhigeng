#![allow(non_snake_case)]
//! 服务层端到端：README 里写的那条命令流程，这里跑一遍同样的路径。
//! 手工跑一次才发现的"正文被写两遍"这类问题，必须留在测试里。

use note_core::service::Hub;

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
fn 新建改名归档删除恢复全程索引不漂() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());

    let rel = hub.note_create("周会纪要").unwrap();
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
    let archived = format!("archive/{file}");
    hub.note_move(&renamed, &archived).unwrap();
    let row = hub.list_notes(10).unwrap().notes.remove(0);
    assert_eq!((row.rel.as_str(), row.status.as_str()), (archived.as_str(), "archived"));

    hub.note_trash(&archived).unwrap();
    assert_eq!(hub.list_notes(10).unwrap().notes.len(), 0);
    let trash = hub.list_trash().unwrap();
    assert_eq!(trash.len(), 1, "{trash:?}");
    assert_eq!(trash[0].rel, archived, "回收站要记得恢复目标路径");

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
    let target = hub.note_create("目标笔记").unwrap();
    hub.save_note("notes/引用者.md", "看 [[目标笔记]] 那篇。\n").unwrap();

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
fn 同名笔记删两次在回收站里不互相覆盖() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    let rel = hub.note_create("同名").unwrap();
    hub.save_note(&rel, "---\nid: n-keep0001\ntitle: \"同名\"\n---\n\n第一条内容\n")
        .unwrap();
    hub.note_trash(&rel).unwrap();
    hub.save_note(&rel, "---\nid: n-keep0002\ntitle: \"同名\"\n---\n\n第二条内容\n")
        .unwrap();
    hub.note_trash(&rel).unwrap();

    let trash = hub.list_trash().unwrap();
    assert_eq!(trash.len(), 2, "镜像存放会把第二次覆盖到第一次上: {trash:?}");
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
fn 回收站的恢复参数不能越出Vault() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    // batch 与 rel 都是从 UI 来的，拼进 trash 路径之前必须过边界校验
    assert!(hub.note_restore("..", "../outside.md").is_err());
    assert!(hub.note_restore("a/../../b", "notes/甲.md").is_err());
}

#[test]
fn 没有_id_的笔记改名后不留孤儿行() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    // 手写或从 Obsidian 导入的笔记没有 front-matter id，这类才是大多数
    hub.save_note("notes/无id.md", "# 无 id\n\n正文甲\n").unwrap();
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
    hub.save_note("notes/甲.md", "正文
").unwrap();
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
    assert!(matches!(hub.note_create("   "), Err(note_core::Error::Invalid(_))));
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
    let target = hub.note_create("被引用者").unwrap();
    hub.save_note("notes/引用方.md", "看 [[被引用者]]。
").unwrap();
    let conn = open_index(&hub);
    assert_eq!(link_stats(&conn), (1, 0), "前置条件：链接已解析");

    // index_file 会先删 notes 行再插回来，而 links.to_note 是 ON DELETE CASCADE
    hub.save_note(&target, "---
id: n-being001
title: \"被引用者\"
---

改了一版正文
")
        .unwrap();
    assert_eq!(link_stats(&conn), (1, 0), "保存目标笔记之后，引用方的入链不该消失");
}

#[test]
fn 失败的操作不能把索引改坏() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    let target = hub.note_create("被引用者").unwrap();
    hub.save_note("notes/引用方.md", "看 [[被引用者]]。
").unwrap();
    hub.save_note("notes/占位.md", "占着位置的
").unwrap();
    let conn = open_index(&hub);
    assert_eq!(link_stats(&conn), (1, 0));

    // 目标位置已有文件：移动必须失败。失败不该是"先把入链置悬空，再发现动不了"
    assert!(hub.note_move(&target, "notes/占位.md").is_err());
    assert_eq!(link_stats(&conn), (1, 0), "移动失败之后入链仍是悬空态");
    assert_eq!(hub.drift().unwrap(), 0);
    assert!(hub.vault().resolve(&target).unwrap().exists(), "原文件必须还在");
}

#[test]
fn 下划线不会被当成_like_通配符() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    hub.save_note("notes/a_b.md", "带下划线的笔记
").unwrap();
    hub.save_note("notes/引用方.md", "指向不存在的 [[axb#^b-zzz]]。
")
        .unwrap();
    let conn = open_index(&hub);
    assert_eq!(link_stats(&conn), (1, 1), "前置：这条链接本来就悬空");

    // 恢复 a_b 时按文件名找"曾经指向它"的链接：`a_b` 当 LIKE 模式会把 `axb` 也捞进来
    hub.note_trash("notes/a_b.md").unwrap();
    let t = hub.list_trash().unwrap();
    hub.note_restore(&t[0].batch, "notes/a_b.md").unwrap();
    assert_eq!(link_stats(&conn), (1, 1), "毫不相干的悬空链接被错接到了 a_b 上");
}

#[test]
fn 锚点写错的链接登记得下来而不是让保存炸掉() {
    let d = tempfile::tempdir().unwrap();
    let mut hub = hub_in(d.path());
    hub.save_note("notes/存在.md", "存在的
").unwrap();
    // 目标笔记存在、锚点不存在：外键不该把整次保存打回去
    hub.save_note("notes/引用方.md", "看 [[存在#^b-手滑写错的]]。
").unwrap();
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
