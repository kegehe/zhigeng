#![allow(non_snake_case)]
//! Vault 层测试：目录约定、路径安全、原子写、回收站、冲突判定。

use note_core::vault::{
    classify_change, default_new_rel, is_indexable_rel, kind_of_rel, sanitize_file_stem,
    status_of_rel, Change, NoteKind, NoteStatus, Vault,
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
    assert!(dir.path().join(".note/trash/notes/a.md").exists());
    assert!(!dir.path().join("notes/a.md").exists());
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
