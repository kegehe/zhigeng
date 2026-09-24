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
