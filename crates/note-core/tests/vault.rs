#![allow(non_snake_case)]
//! Vault 层测试：目录约定、路径安全、原子写、回收站、冲突判定。

use note_core::vault::{
    check_dir_name, classify_change, default_new_rel, is_indexable_rel, is_tree_dir, kind_of_rel,
    norm_rel, sanitize_file_stem, status_of_rel, Change, NoteKind, NoteStatus, Vault,
};
use std::path::Path;

fn touch(v: &Vault, rel: &str, body: &str) {
    v.write_atomic(rel, body.as_bytes()).unwrap();
}

fn tmp_vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("notes")).unwrap();
    dir
}

#[test]
fn 扫描排除规则把应用私有目录挡在外面() {
    let dir = tmp_vault();
    let v = Vault::open(dir.path()).unwrap();
    touch(&v, "notes/a.md", "正文\n");
    touch(&v, "notes/.hidden/b.md", "不该出现\n");
    touch(&v, ".note/trash/notes/a.md", "回收站里的\n");
    touch(&v, ".note/conflicts/notes/c.md", "冲突副本\n");
    touch(&v, ".note/versions/x.gz", "快照\n");
    touch(&v, "attachments/ab/abcdef.png", "PNG");
    touch(&v, "node_modules/x.md", "依赖里的\n");
    std::fs::create_dir_all(dir.path().join("notes/sub")).unwrap();
    touch(&v, "notes/sub/c.markdown", "另一种扩展名\n");

    let found: Vec<String> = v.scan().unwrap().into_iter().map(|f| f.rel).collect();
    assert_eq!(
        found,
        vec!["notes/a.md", "notes/sub/c.markdown"],
        "{found:?}"
    );
    assert!(
        !found.iter().any(|r| r.starts_with(".note")),
        "回收站被索引了"
    );
}

#[test]
fn 状态由目录推导而不是frontmatter() {
    assert_eq!(status_of_rel("inbox/x.md"), Some(NoteStatus::Inbox));
    assert_eq!(
        status_of_rel("archive/2024/x.md"),
        Some(NoteStatus::Archived)
    );
    assert_eq!(status_of_rel("notes/x.md"), Some(NoteStatus::Active));
    assert_eq!(status_of_rel(".note/trash/x.md"), None);
    assert_eq!(kind_of_rel("views/待补清单.md"), NoteKind::View);
    assert_eq!(kind_of_rel("notes/a.md"), NoteKind::Note);
    assert!(is_indexable_rel("notes/a.md"));
    assert!(!is_indexable_rel("attachments/a1/b2.png"));
    assert!(!is_indexable_rel(".note/index.db"));
}

#[test]
fn 路径越界一律拒绝() {
    let dir = tmp_vault();
    let v = Vault::open(dir.path()).unwrap();
    for bad in [
        "../outside.md",
        "notes/../../outside.md",
        "notes/../notes/ok.md", // 含 .. 一律拒绝：不做事后规范化
        "C:/Windows/x.md",
        "a:/b.md",
    ] {
        assert!(
            v.resolve(bad).is_err(),
            "{bad} 竟然被接受了: {:?}",
            v.resolve(bad)
        );
    }
    // 前导 / 是 Vault 根相对（docs/02 §资产引用格式），不是文件系统根
    let rootrel = v.resolve("/attachments/ab/x.png").unwrap();
    assert!(rootrel.starts_with(v.root()), "{rootrel:?}");
    // 单个点与重复斜杠是良性写法，规范化后仍在 Vault 内
    assert!(v.resolve("notes/./ok.md").is_ok());
    assert!(v.resolve("notes//sub//ok.md").is_ok());
}

#[test]
fn 原子写不留临时文件且内容正确() {
    let dir = tmp_vault();
    let v = Vault::open(dir.path()).unwrap();
    let h1 = touch_hash(&v, "notes/a.md", "第一版\n");
    let h2 = touch_hash(&v, "notes/a.md", "第二版\n");
    assert_ne!(h1, h2);
    assert_eq!(
        String::from_utf8(v.read("notes/a.md").unwrap()).unwrap(),
        "第二版\n"
    );
    let leftovers: Vec<String> = std::fs::read_dir(dir.path().join("notes"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "残留临时文件: {leftovers:?}");
}

fn touch_hash(v: &Vault, rel: &str, body: &str) -> String {
    v.write_atomic(rel, body.as_bytes()).unwrap()
}

#[test]
fn 回收站移动与恢复() {
    let dir = tmp_vault();
    let v = Vault::open(dir.path()).unwrap();
    touch(&v, "notes/a.md", "甲\n");
    assert_eq!(v.scan().unwrap().len(), 1);
    v.move_to_trash("notes/a.md").unwrap();
    assert_eq!(v.scan().unwrap().len(), 0, "回收站内容不应被索引");
    assert!(!dir.path().join("notes/a.md").exists());

    // 批次目录：同一路径删两次不能互相覆盖，所以清单要能报出恢复目标
    let trash = v.list_trash().unwrap();
    assert_eq!(trash.len(), 1, "{trash:?}");
    assert_eq!(trash[0].rel, "notes/a.md");
    assert_eq!(
        String::from_utf8_lossy(&v.read_from_trash(&trash[0].batch, "notes/a.md").unwrap()),
        "甲\n"
    );

    v.restore_from_trash(&trash[0].batch, "notes/a.md").unwrap();
    assert!(v.list_trash().unwrap().is_empty());
    assert_eq!(v.scan().unwrap().len(), 1, "恢复后要重新被扫描到");
}

#[test]
fn 外部修改三情形判定() {
    let (a, b, c) = ("hashA", "hashB", "hashC");
    assert_eq!(
        classify_change(a, a, None),
        Change::Ignore,
        "仅 mtime 变化应忽略"
    );
    assert_eq!(
        classify_change(a, b, None),
        Change::Reload,
        "本地无改动应重解析"
    );
    assert_eq!(
        classify_change(a, b, Some(c)),
        Change::Conflict,
        "双方都改过必须报冲突，绝不静默覆盖"
    );
    assert_eq!(
        classify_change(a, b, Some(b)),
        Change::Reload,
        "本地未保存改动其实等于磁盘内容 → 无冲突"
    );
}

#[test]
fn 冲突副本落盘不覆盖笔记() {
    let dir = tmp_vault();
    let v = Vault::open(dir.path()).unwrap();
    touch(&v, "notes/a.md", "本地内容\n");
    let disk = "外部编辑器改过的内容\n".as_bytes();
    v.keep_conflict("notes/a.md", disk).unwrap();
    assert_eq!(v.read("notes/a.md").unwrap(), "本地内容\n".as_bytes());
    assert!(
        dir.path().join(".note/conflicts/notes").exists() || {
            // 单层文件名也算
            Path::new(&dir.path().join(".note/conflicts")).exists()
        }
    );
}

#[test]
fn 文件名清洗挡住Windows保留名与非法字符() {
    assert_eq!(sanitize_file_stem("a/b:c*d?e"), "a b c d e");
    assert_eq!(sanitize_file_stem("CON"), "_CON");
    assert_eq!(sanitize_file_stem("nul.txt"), "_nul.txt");
    assert_eq!(sanitize_file_stem("  尾部的点.  "), "尾部的点");
    assert_eq!(sanitize_file_stem(""), "未命名");
    let cn = sanitize_file_stem("中文标题 with english");
    assert_eq!(cn, "中文标题 with english");
}

#[test]
fn 新笔记默认落点不覆盖已有文件() {
    let dir = tmp_vault();
    let v = Vault::open(dir.path()).unwrap();
    touch(&v, "notes/甲.md", "x\n");
    let rel = default_new_rel(v.root(), "甲");
    assert_eq!(rel, "notes/甲-1.md", "{rel}");
    assert!(!v.root().join(&rel).exists());
}

#[test]
fn 目录判据把应用私有与资产视图树挡在外面() {
    assert!(is_tree_dir("notes"));
    assert!(is_tree_dir("notes/工作/深层"));
    assert!(is_tree_dir("项目"));
    for bad in [
        "",
        "/",
        ".note",
        "notes/.hidden",
        "../notes",
        "notes/../x",
        "node_modules/包",
        "notes/target",
        "attachments",
        "attachments/ab",
        "views",
        "views/日报",
    ] {
        assert!(!is_tree_dir(bad), "{bad} 不该算笔记目录");
    }
    assert_eq!(norm_rel(r"\notes\工作\"), "notes/工作");
}

#[test]
fn 目录名只拒不改() {
    assert_eq!(check_dir_name(" 工作 ").unwrap(), "工作");
    assert_eq!(check_dir_name("2026 Q4").unwrap(), "2026 Q4");
    for bad in [
        "",
        ".",
        "..",
        ".草稿",
        "a/b",
        r"a\b",
        "a:b",
        "a?b",
        "工作.",
        "node_modules",
        "Target",
        "CON",
        "nul.txt",
    ] {
        assert!(check_dir_name(bad).is_err(), "{bad} 不该被接受");
    }
    assert!(check_dir_name(&"长".repeat(81)).is_err(), "超长目录名该拒");
}

#[test]
fn 建目录只能在笔记树里且父目录得先存在() {
    let dir = tmp_vault();
    let v = Vault::open(dir.path()).unwrap();
    assert_eq!(v.create_dir("notes", "工作").unwrap(), "notes/工作");
    assert_eq!(
        v.create_dir("notes/工作", "子目录").unwrap(),
        "notes/工作/子目录"
    );
    assert_eq!(v.create_dir("", "项目").unwrap(), "项目");
    assert!(v.create_dir("notes", "工作").is_err(), "同名该报冲突");
    assert!(matches!(
        v.create_dir("notes/没有", "x"),
        Err(note_core::Error::NotFound(_))
    ));
    // 附件与视图那两棵树不收笔记目录，也不能在里面建
    assert!(matches!(
        v.create_dir("attachments", "x"),
        Err(note_core::Error::Invalid(_))
    ));
    assert!(matches!(
        v.create_dir("views", "x"),
        Err(note_core::Error::Invalid(_))
    ));
    // 顶层的保留名不能拿来新建
    assert!(matches!(
        v.create_dir("", "notes"),
        Err(note_core::Error::Invalid(_))
    ));
    assert!(matches!(
        v.create_dir("notes", "../外面"),
        Err(note_core::Error::Invalid(_))
    ));
}

#[test]
fn 列目录包含空目录并排除树外() {
    let dir = tmp_vault();
    let v = Vault::open(dir.path()).unwrap();
    for rel in [
        "notes/工作",
        "notes/空/更深",
        "inbox/待办",
        "archive/2024",
        "attachments/ab",
        "views/日报",
        "node_modules/包",
        ".note/trash",
    ] {
        std::fs::create_dir_all(dir.path().join(rel)).unwrap();
    }
    assert_eq!(
        v.list_dirs().unwrap(),
        vec![
            "archive",
            "archive/2024",
            "inbox",
            "inbox/待办",
            "notes",
            "notes/工作",
            "notes/空",
            "notes/空/更深",
        ]
    );
    // 顶层自建目录也要出现（中文按码位排在 ASCII 之后）
    v.create_dir("", "项目").unwrap();
    let got = v.list_dirs().unwrap();
    assert_eq!(got.last().map(String::as_str), Some("项目"), "{got:?}");
}

#[test]
fn 空目录能改名能删非空一律拒() {
    let dir = tmp_vault();
    let v = Vault::open(dir.path()).unwrap();
    v.create_dir("notes", "旧名").unwrap();
    assert_eq!(v.rename_dir("notes/旧名", "新名").unwrap(), "notes/新名");
    assert!(dir.path().join("notes/新名").is_dir());
    assert!(!dir.path().join("notes/旧名").exists());

    // 非空按**物理空**判：隐藏文件也算占着位置
    std::fs::write(dir.path().join("notes/新名/.keep"), "x").unwrap();
    assert!(matches!(
        v.rename_dir("notes/新名", "另一个"),
        Err(note_core::Error::Invalid(_))
    ));
    assert!(matches!(
        v.remove_dir("notes/新名"),
        Err(note_core::Error::Invalid(_))
    ));
    std::fs::remove_file(dir.path().join("notes/新名/.keep")).unwrap();
    v.remove_dir("notes/新名").unwrap();
    assert!(!dir.path().join("notes/新名").exists());

    // 保留目录既不能改名也不能删；树外目录同样不行
    for rel in ["notes", "inbox", "archive"] {
        assert!(matches!(
            v.rename_dir(rel, "别的"),
            Err(note_core::Error::Invalid(_))
        ));
        assert!(matches!(
            v.remove_dir(rel),
            Err(note_core::Error::Invalid(_))
        ));
    }
    std::fs::create_dir_all(dir.path().join("attachments/ab")).unwrap();
    assert!(v.remove_dir("attachments/ab").is_err());
}

#[test]
fn 改名撞上同级同名目录要报冲突() {
    let dir = tmp_vault();
    let v = Vault::open(dir.path()).unwrap();
    v.create_dir("notes", "甲").unwrap();
    v.create_dir("notes", "乙").unwrap();
    assert!(matches!(
        v.rename_dir("notes/甲", "乙"),
        Err(note_core::Error::Conflict(_))
    ));
    assert_eq!(v.rename_dir("notes/甲", "甲").unwrap(), "notes/甲");
}

#[test]
fn 新建笔记的父目录必须是存在的笔记目录() {
    let dir = tmp_vault();
    let v = Vault::open(dir.path()).unwrap();
    v.create_dir("notes", "工作").unwrap();
    assert_eq!(v.check_note_parent("notes/工作").unwrap(), "notes/工作");
    assert_eq!(v.check_note_parent(r"notes\工作\").unwrap(), "notes/工作");
    for bad in ["", "views", "attachments", ".note", "notes/../外面"] {
        assert!(v.check_note_parent(bad).is_err(), "{bad} 不该能挂笔记");
    }
    assert!(matches!(
        v.check_note_parent("notes/没有"),
        Err(note_core::Error::NotFound(_))
    ));
}

#[cfg(windows)]
#[test]
fn canonicalize_的_扩展长度前缀_不会漏进_root() {
    // 前缀一旦漏出去，标题栏就会显示 `\\?\D:\Notes`，last-vault.txt 也会带上它
    let dir = tmp_vault();
    let verbatim = std::path::PathBuf::from(format!(r"\\?\{}", dir.path().display()));
    let v = Vault::open(&verbatim).unwrap();
    let shown = v.root().display().to_string();
    assert!(!shown.contains(r"\\?\"), "root 仍带前缀：{shown}");
    assert!(v.root().is_dir(), "{shown}");
}
