#![allow(non_snake_case)]
//! 资产入库的真盘测试：内容寻址、去重、以及"被拒的东西不许留下半个文件"。
//!
//! 单元测试（`src/assets.rs`）管判据，这里管**磁盘上到底长什么样**——
//! 去重那条只在真文件系统上才测得出来。

use note_core::assets::{save_bytes, AssetOut};
use note_core::vault::Vault;

fn png(种子: u8) -> Vec<u8> {
    let mut v = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    v.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R']);
    v.push(种子);
    v.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 7]);
    v
}

fn 数一数资产目录(dir: &std::path::Path) -> usize {
    let 根 = dir.join("attachments");
    let mut 个 = 0;
    let mut 栈 = vec![根];
    while let Some(d) = 栈.pop() {
        let Ok(条) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in 条.flatten() {
            if e.path().is_dir() {
                栈.push(e.path());
            } else {
                个 += 1;
            }
        }
    }
    个
}

#[test]
fn 同一张图粘两次只落一份字节() {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(dir.path()).unwrap();
    let 图 = png(1);

    let 第一次: AssetOut = save_bytes(&v, &图).unwrap();
    let 第二次 = save_bytes(&v, &图).unwrap();
    assert_eq!(
        第一次.rel, 第二次.rel,
        "同 sha 必须同路径，否则去重无从谈起"
    );
    assert!(!第一次.existed, "第一次该真写下去");
    assert!(第二次.existed, "第二次该认出已有，不再写第二份");
    assert_eq!(数一数资产目录(dir.path()), 1, "盘上攒出了第二份");

    // 落盘的字节必须与输入一字不差——缩略图、旋转、重编码都不在这一档的承诺里，
    // 所以"存进去等于原样"是唯一正确的行为
    let 回 = v.read(&第一次.rel).unwrap();
    assert_eq!(回, 图);
}

#[test]
fn 不同内容各自一份且互不覆盖() {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(dir.path()).unwrap();
    let a = save_bytes(&v, &png(1)).unwrap();
    let b = save_bytes(&v, &png(2)).unwrap();
    assert_ne!(a.rel, b.rel);
    assert_eq!(数一数资产目录(dir.path()), 2);
    assert_eq!(v.read(&a.rel).unwrap(), png(1), "两张图串了内容");
}

#[test]
fn 被拒的不许留下半个文件() {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(dir.path()).unwrap();
    assert!(save_bytes(&v, b"").is_err());
    assert!(save_bytes(&v, "这不是图".as_bytes()).is_err());
    assert!(save_bytes(&v, "<html><body>不是 svg".as_bytes()).is_err());
    assert_eq!(数一数资产目录(dir.path()), 0, "拒绝的东西在盘上留了痕迹");
}

#[test]
fn 路径形状守住资产引用约定() {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(dir.path()).unwrap();
    let a = save_bytes(&v, &png(3)).unwrap();
    // attachments/<sha 前两位>/<完整 sha>.<ext>：三层、前缀分桶、扩展名来自**字节本身**
    let 段: Vec<&str> = a.rel.split('/').collect();
    assert_eq!(段.len(), 3, "{:?}", a.rel);
    assert_eq!(段[0], "attachments");
    assert_eq!(段[1].len(), 2);
    assert!(a.sha256.starts_with(段[1]), "{:?}", a.rel);
    assert!(段[2].starts_with(&a.sha256), "{:?}", a.rel);
    assert!(段[2].ends_with(".png"), "{:?}", a.rel);
    assert_eq!(a.mime, "image/png");
    assert_eq!(a.size, png(3).len() as u64);
}
