#![allow(non_snake_case)]
//! 导入外部 Markdown。验收 ②（"导入 1000 篇真实 Vault，块 ID 分配与链接图零错乱"）
//! 的证据都在这里，而不是"手工导一次看看"。
//!
//! 改名规则本身在 `import.rs` 里单测——Windows 的文件系统本身就拒绝 `a:b?.md`
//! 这种名字，集成测试根本造不出来。

use std::fs;
use std::path::Path;

use note_core::import::{self, DEFAULT_INTO};
use note_core::index::Index;
use note_core::vault::Vault;

/// 一个"像 Obsidian 那样"的源库：嵌套目录、wikilink 的四种写法、附件、私有目录、
/// CRLF 与 BOM，以及一个会被 sanitizer 折叠掉多余空格的名字。
fn fake_vault(root: &Path) {
    fs::create_dir_all(root.join("子目录")).unwrap();
    fs::create_dir_all(root.join(".obsidian")).unwrap();
    fs::create_dir_all(root.join(".trash")).unwrap();

    fs::write(
        root.join("笔记甲.md"),
        "---\ntitle: 笔记甲\n---\n\n指向 [[笔记乙]]，也指到小节 [[笔记乙#某标题]] 与块 \
         [[笔记乙#^b-k3x9m2v7qa]]，还有别名 [[笔记乙|乙那篇]]。\r\n带 CRLF 的一行。\r\n",
    )
    .unwrap();
    fs::write(
        root.join("子目录/笔记乙.md"),
        "\u{feff}## 某标题\n\n有锚点的一段。 ^b-k3x9m2v7qa\n\n图在 ![[图.png]]\n",
    )
    .unwrap();
    fs::write(
        root.join("图.png"),
        [0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
    )
    .unwrap();
    fs::write(root.join("两  个空格.md"), "中间两个空格，会被折成一个\n").unwrap();
    fs::write(root.join(".obsidian/app.json"), "{\"theme\":\"dark\"}").unwrap();
    fs::write(
        root.join(".trash/被丢掉的.md"),
        "用户在 Obsidian 里已经删了\n",
    )
    .unwrap();
}

fn open(dir: &Path) -> (Vault, Index) {
    let v = Vault::open(dir).unwrap();
    let i = Index::open(&v).unwrap();
    (v, i)
}

#[test]
fn 导入保留目录结构并且内容一个字节都不改() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    fake_vault(src.path());
    let (v, _idx) = open(dst.path());

    let r = import::run(&v, src.path(), DEFAULT_INTO, false).unwrap();
    assert_eq!(r.notes.len(), 3, "三篇 md: {:?}", r.notes);
    assert_eq!(r.assets, vec!["notes/图.png".to_string()]);
    assert!(v.read("notes/笔记甲.md").is_ok());
    assert!(
        v.read("notes/子目录/笔记乙.md").is_ok(),
        "子目录结构要保留，否则一堆同名笔记挤在一层里"
    );

    // 字节级一致：CRLF 与 BOM 都不许被"顺手规范化"
    for (dest, from) in [
        ("notes/笔记甲.md", "笔记甲.md"),
        ("notes/子目录/笔记乙.md", "子目录/笔记乙.md"),
        ("notes/图.png", "图.png"),
    ] {
        assert_eq!(
            fs::read(
                v.root()
                    .join(dest.replace('/', std::path::MAIN_SEPARATOR_STR))
            )
            .unwrap(),
            fs::read(
                src.path()
                    .join(from.replace('/', std::path::MAIN_SEPARATOR_STR))
            )
            .unwrap(),
            "{dest} 的内容被动过"
        );
    }

    // 私有目录不收
    assert!(
        r.notes.iter().all(|n| !n.contains(".obsidian")),
        "{:?}",
        r.notes
    );
    assert!(
        r.notes.iter().all(|n| !n.contains("被丢掉")),
        "Obsidian 回收站里的东西不该回来"
    );
    assert!(!v.root().join("notes").join(".obsidian").exists());
}

#[test]
fn 只有真被改动的名字才进改名清单() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    fake_vault(src.path());
    let (v, _idx) = open(dst.path());

    let r = import::run(&v, src.path(), DEFAULT_INTO, false).unwrap();
    assert!(
        r.renamed
            .iter()
            .any(|(from, to)| from == "两  个空格.md" && to == "notes/两 个空格.md"),
        "该改名的没登记: {:?}",
        r.renamed
    );
    // 关键：加了 `notes/` 前缀不算改名。把每个文件都报成改名，用户就看不出哪个链接真断了
    assert!(
        !r.renamed.iter().any(|(from, _)| from == "笔记甲.md"),
        "合法名字不该出现在改名清单: {:?}",
        r.renamed
    );
}

#[test]
fn 链接图在导入后解析得出来且不悬空() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    fake_vault(src.path());
    let (v, idx) = open(dst.path());
    let r = import::import_and_index(&v, &idx, src.path(), DEFAULT_INTO, false).unwrap();
    assert_eq!(r.notes.len(), 3);

    // 同一段里的四条 `[[乙...]]` 必须各留各的锚点。旧主键会把它们塌成一行，
    // 块级引用就退化成"指向整篇"——AI 引用溯源依赖这一条。
    let 甲的暂存链接: i64 = idx
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM link_targets lt JOIN blocks b ON b.id=lt.from_block
             WHERE b.markdown LIKE '%[[笔记乙#^b-%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        甲的暂存链接, 3,
        "无锚点/小节锚点/块锚点 该各一条: {甲的暂存链接}"
    );

    let 指到块的: i64 = idx
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM links WHERE to_block IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(指到块的 >= 1, "[[乙#^b-xxx]] 没解析到具体块");

    // 站内引用不许悬空（目标都在这一批里）。附件嵌入 `![[图.png]]` 是例外：
    // 附件不是笔记，现在解析不了——记在 [05] 的反链那一项里。
    let 引用悬空: i64 = idx
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM links WHERE broken=1 AND kind='ref'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(引用悬空, 0, "目标都在库里，不该有悬空");
    assert_eq!(idx.drift(&v).unwrap(), 0, "导入后 md 与 db 漂移");
    assert!(idx.orphan_counts().unwrap().is_clean());
}

#[test]
fn 重复导入是幂等的而且绝不覆盖已有内容() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    fake_vault(src.path());
    let (v, idx) = open(dst.path());

    let 第一次 = import::import_and_index(&v, &idx, src.path(), DEFAULT_INTO, false).unwrap();
    let 甲 = fs::read(v.root().join("notes").join("笔记甲.md")).unwrap();
    let 第二次 = import::import_and_index(&v, &idx, src.path(), DEFAULT_INTO, false).unwrap();
    assert!(
        第二次.notes.is_empty(),
        "第二次不该再写: {:?}",
        第二次.notes
    );
    assert_eq!(
        第二次.skipped.len(),
        第一次.notes.len() + 第一次.assets.len(),
        "{第二次:?}"
    );
    assert_eq!(
        fs::read(v.root().join("notes").join("笔记甲.md")).unwrap(),
        甲,
        "幂等导入不该碰文件"
    );

    // 库里同名但内容不同：另存一份，绝不覆盖用户已有的那篇
    fs::write(v.root().join("notes").join("笔记甲.md"), "我自己写的内容\n").unwrap();
    note_core::service::reindex_note(&v, &idx, "notes/笔记甲.md").unwrap();
    let 第三次 = import::import_and_index(&v, &idx, src.path(), DEFAULT_INTO, false).unwrap();
    assert!(
        第三次
            .notes
            .iter()
            .any(|n| n.starts_with("notes/笔记甲-") && n != "notes/笔记甲.md"),
        "该避让成 -2: {:?}",
        第三次.notes
    );
    assert_eq!(
        fs::read(v.root().join("notes").join("笔记甲.md")).unwrap(),
        "我自己写的内容\n".as_bytes(),
        "覆盖用户内容是不可原谅的"
    );
    assert_eq!(idx.drift(&v).unwrap(), 0, "避让出来的那篇也要在库里");
}

#[test]
fn 预览不写盘() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    fake_vault(src.path());
    let (v, idx) = open(dst.path());

    let 计划 = import::plan(&v, src.path(), DEFAULT_INTO).unwrap();
    assert_eq!(
        计划.len(),
        4,
        "{:?}",
        计划.iter().map(|e| &e.src_rel).collect::<Vec<_>>()
    );
    assert!(计划
        .iter()
        .any(|e| e.markdown && e.dest_rel == "notes/笔记甲.md"));
    let r = import::import_and_index(&v, &idx, src.path(), DEFAULT_INTO, true).unwrap();
    assert_eq!(r.notes.len(), 3);
    assert!(
        !v.root().join("notes").join("笔记甲.md").exists(),
        "dry-run 写盘了"
    );
    assert_eq!(idx.count_notes().unwrap(), 0);
}

#[test]
fn 源目录在库里面直接拒绝() {
    let dst = tempfile::tempdir().unwrap();
    let (v, _idx) = open(dst.path());
    fs::create_dir_all(v.root().join("要导进来的")).unwrap();
    fs::write(v.root().join("要导进来的/甲.md"), "x\n").unwrap();
    let err = import::run(&v, &v.root().join("要导进来的"), DEFAULT_INTO, false).unwrap_err();
    assert!(err.to_string().contains("不能是 Vault 自己"), "{err}");
    // 库自己作为源也拒绝（往自己里面复制自己）
    let err = import::run(&v, v.root(), DEFAULT_INTO, false).unwrap_err();
    assert!(err.to_string().contains("不能是 Vault 自己"), "{err}");
}

#[test]
fn 一千篇导入后块与链接图零错乱() {
    // 验收 ② 的规模口径
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    fs::create_dir_all(src.path().join("领域/A")).unwrap();
    for i in 0..1000 {
        let 目录 = if i % 3 == 0 { "领域/A" } else { "." };
        fs::write(
            src.path().join(目录).join(format!("笔记{i}.md")),
            format!(
                "---\nid: n-dup\n---\n\n# 笔记{i}\n\n内容 {i}，指向 [[笔记{}]]。\n",
                (i + 1) % 1000
            ),
        )
        .unwrap();
    }
    let (v, idx) = open(dst.path());
    let t = std::time::Instant::now();
    let r = import::import_and_index(&v, &idx, src.path(), DEFAULT_INTO, false).unwrap();
    let secs = t.elapsed().as_secs_f64();
    assert_eq!(r.notes.len(), 1000);
    assert_eq!(idx.count_notes().unwrap(), 1000, "有一篇没进库");

    // 每篇都带同一个 front-matter id（模板另存的最坏情况）：主键必须各不相同
    let 不同主键: i64 = idx
        .conn()
        .query_row("SELECT COUNT(DISTINCT id) FROM notes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(不同主键, 1000, "撞主键会让索引静默少一篇");

    let 块数: i64 = idx
        .conn()
        .query_row("SELECT COUNT(DISTINCT id) FROM blocks", [], |r| r.get(0))
        .unwrap();
    let 块行数: i64 = idx
        .conn()
        .query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(块数, 块行数, "块 ID 有重复");
    assert_eq!(idx.drift(&v).unwrap(), 0);
    assert!(idx.orphan_counts().unwrap().is_clean());
    let 悬空: i64 = idx
        .conn()
        .query_row("SELECT COUNT(*) FROM links WHERE broken=1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(悬空, 0, "1000 条站内链接的目标都在库里");
    println!("1000 篇导入 + 索引 {secs:.2}s");
}
