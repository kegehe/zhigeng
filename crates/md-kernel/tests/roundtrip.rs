#![allow(non_snake_case)] // 测试名用中文短语，读失败信息时更快
//! G5 无损往返的回归闸门。
//!
//! 两层保证：
//! 1. `render_exact` 恒等于源文本 —— 由构造成立，用来抓解析器的簿记错误；
//! 2. `render_canonical` 对"规范写法"的文档字节相等 —— 这才是真正难的那条，
//!    它证明编辑器改写一个块后重新序列化不会吃掉语法。
//!
//! 已知限制（故意不在本文件里掩盖）：有序列表项下的嵌套条目，规范缩进为 2 空格，
//! 若源文本用 3 空格（`1. ` 的宽度）则重建时会改成 2 空格。规范形以 2 空格为准。

use std::path::{Path, PathBuf};

use md_kernel::{parse, render_canonical, render_exact, Kind};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("testdata")
        .join("roundtrip")
}

fn fixtures() -> Vec<(PathBuf, String)> {
    let dir = fixture_dir();
    assert!(dir.is_dir(), "找不到 fixture 目录 {}", dir.display());
    let mut out = Vec::new();
    let mut entries: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().map(|x| x == "md").unwrap_or(false))
        .collect();
    entries.sort();
    for p in entries {
        let src = std::fs::read_to_string(&p).unwrap();
        out.push((p, src));
    }
    assert!(out.len() >= 5, "fixture 太少，起不到回归作用");
    out
}

#[test]
fn 精确重建与源文本字节相等() {
    for (path, src) in fixtures() {
        let doc = parse(&src);
        let got = render_exact(&doc);
        assert_eq!(got, src, "render_exact 破坏了 {}", path.display());
    }
}

#[test]
fn 规范重建对规范写法字节相等() {
    for (path, src) in fixtures() {
        let doc = parse(&src);
        let got = render_canonical(&doc);
        if got != src {
            let a: Vec<&str> = src.lines().collect();
            let b: Vec<&str> = got.lines().collect();
            let mut msg = format!(
                "canonical 与源文本不一致：{}\n  行数 {} -> {}",
                path.display(),
                a.len(),
                b.len()
            );
            for i in 0..a.len().max(b.len()) {
                let x = a.get(i).copied().unwrap_or("<无>");
                let y = b.get(i).copied().unwrap_or("<无>");
                if x != y {
                    msg.push_str(&format!(
                        "\n  第 {} 行\n    源: {:?}\n    重: {:?}",
                        i + 1,
                        x,
                        y
                    ));
                    break;
                }
            }
            panic!("{msg}");
        }
    }
}

#[test]
fn 结构被正确分类而非糊成一团() {
    let src = fixtures()
        .into_iter()
        .find(|(p, _)| p.file_name().unwrap() == "02-列表.md")
        .unwrap()
        .1;
    let doc = parse(&src);
    let flat = doc.blocks_flat();

    let todos: Vec<_> = flat
        .iter()
        .filter(|b| matches!(b.kind, Kind::Todo { checked: false }))
        .collect();
    assert!(todos.len() >= 2, "待办识别不足: {}", todos.len());

    let done = flat
        .iter()
        .find(|b| matches!(b.kind, Kind::Todo { checked: true }))
        .expect("没有识别出已完成待办");
    assert_eq!(
        done.fields.first().map(|(k, _)| k.as_str()),
        Some("done"),
        "done:: 字段没被提取: {:?}",
        done.fields
    );
    assert_eq!(done.content, "已经确认过的一件事");

    let with_due = flat
        .iter()
        .find(|b| b.fields.iter().any(|(k, _)| k == "due"))
        .expect("due:: 字段没被提取");
    assert_eq!(with_due.fields[0].1, "2026-09-28");
    assert!(
        !with_due.content.contains("due::"),
        "字段仍留在正文里: {:?}",
        with_due.content
    );

    let nested = flat
        .iter()
        .find(|b| !b.children.is_empty() && matches!(b.kind, Kind::Bullet))
        .expect("没有识别出嵌套列表");
    assert!(nested
        .children
        .iter()
        .all(|c| matches!(c.kind, Kind::Bullet)));

    // `- [文字](链接)` 不是待办：方括号里必须恰为一个空格或 x/X
    let linky = flat
        .iter()
        .find(|b| b.content.contains("example.com"))
        .expect("找不到以方括号链接开头的条目");
    assert!(
        matches!(linky.kind, Kind::Bullet),
        "把行内链接误判成了 {:?}",
        linky.kind
    );

    assert!(
        flat.iter().any(|b| b.id.as_deref() == Some("b-w1c4v7b0ui")),
        "列表项的块 ID 丢了"
    );
}

#[test]
fn 代码块内部语法不被误认() {
    let src = fixtures()
        .into_iter()
        .find(|(p, _)| p.file_name().unwrap() == "03-代码表格与公式.md")
        .unwrap()
        .1;
    let doc = parse(&src);
    let flat = doc.blocks_flat();
    let code = flat
        .iter()
        .find(|b| matches!(b.kind, Kind::Code { .. }))
        .expect("没识别出代码块");
    assert_eq!(
        code.kind,
        Kind::Code {
            fence: "```".into(),
            info: "rust".into()
        }
    );
    // 独占成行的 ID 归给了代码块
    assert_eq!(code.id.as_deref(), Some("b-f3g6j9l2mn"));
    assert!(
        !flat
            .iter()
            .any(|b| matches!(b.kind, Kind::Divider) && b.raw.contains('#')),
        "代码块里的注释被当成了别的块"
    );
    assert!(flat.iter().any(|b| matches!(b.kind, Kind::Math)));
    assert!(flat.iter().any(|b| matches!(b.kind, Kind::Table)));
    let dividers = flat
        .iter()
        .filter(|b| matches!(b.kind, Kind::Divider))
        .count();
    assert!(dividers >= 2, "分隔符识别过少: {dividers}");
}

#[test]
fn 引用与标注() {
    let src = fixtures()
        .into_iter()
        .find(|(p, _)| p.file_name().unwrap() == "04-引用与标注.md")
        .unwrap()
        .1;
    let doc = parse(&src);
    let flat = doc.blocks_flat();
    let callout = flat
        .iter()
        .find(|b| matches!(b.kind, Kind::Callout { .. }))
        .expect("没识别出 callout");
    assert_eq!(callout.title.as_deref(), Some("打扰预算是多少？"));
    let folded = flat
        .iter()
        .any(|b| matches!(b.kind, Kind::Callout { folded: true, .. }));
    assert!(folded, "折叠标记没识别出来");
    assert!(
        flat.iter()
            .any(|b| matches!(b.kind, Kind::Quote) && b.id.is_some()),
        "引用内部的块 ID 丢了"
    );
}

#[test]
fn 未识别语法降级但不丢内容() {
    let (path, src) = fixtures()
        .into_iter()
        .find(|(p, _)| p.file_name().unwrap() == "05-未识别语法.md")
        .unwrap();
    let doc = parse(&src);
    assert!(
        doc.unrecognized_count() > 0,
        "异常语法应至少留下一个非简单块：{}",
        path.display()
    );
    for b in doc.blocks_flat() {
        assert!(
            b.simple() || !b.raw.trim().is_empty(),
            "出现既不能重建又为空的块，内容可能被吞"
        );
    }
    // 非规范缩进必须回显原文而不是被"整理"掉
    assert_eq!(render_canonical(&doc), src);
}

// ---------------------------------------------------------------------------
// 边界情况
// ---------------------------------------------------------------------------

#[test]
fn 边界_空与只有frontmatter() {
    for s in ["", "\n", "---\nid: n-1\n---\n", "---\nid: n-1\n---"] {
        let d = parse(s);
        assert_eq!(&render_exact(&d), s, "边界情形破坏了 {s:?}");
    }
}

#[test]
fn 边界_crlf保持原样() {
    let s = "---\nid: n-1\n---\r\n\r\n# 标题 ^b-abcdefghij\r\n\r\n- 甲\r\n- 乙\r\n";
    let d = parse(s);
    assert_eq!(&render_exact(&d), s);
    assert_eq!(&render_canonical(&d), s, "CRLF 必须逐行保持");
    assert!(d.blocks.iter().any(|b| b.line_start > 0));
}

#[test]
fn 边界_无尾换行与未闭合围栏() {
    let s = "段落一\n\n```rust\nlet x = 1;";
    let d = parse(s);
    assert_eq!(&render_exact(&d), s);
    assert_eq!(&render_canonical(&d), s, "未闭合围栏应原样回显");

    let t = "段落一\n\n结尾没有换行";
    let d2 = parse(t);
    assert_eq!(&render_exact(&d2), t);
    assert_eq!(&render_canonical(&d2), t);
}

#[test]
fn 边界_分隔符三义性() {
    // front-matter 边界
    let fm = parse("---\nid: n-1\n---\n正文\n");
    assert!(fm.front_matter.is_some());
    assert_eq!(fm.blocks.len(), 1);
    // 段落之后紧跟 --- 应升格为 setext 标题（保持 GFM 行为）
    let setext = parse("标题文字\n---\n");
    assert!(
        matches!(setext.blocks[0].kind, Kind::Heading { level: 2, .. }),
        "{:?}",
        setext.blocks[0].kind
    );
    // 独立成段且前后为空行 → divider
    let hr = parse("上文\n\n---\n\n下文\n");
    assert_eq!(hr.blocks.len(), 3);
    assert!(matches!(hr.blocks[1].kind, Kind::Divider));
    assert_eq!(&render_canonical(&hr), "上文\n\n---\n\n下文\n");
}

#[test]
fn 分节按标题层级切分() {
    let s = "# A\n\n一\n\n## B\n\n二\n\n### C\n\n三\n\n# D\n\n四\n";
    let d = parse(s);
    let secs = d.heading_sections();
    assert!(secs.len() >= 3, "{secs:?}");
    assert!(secs.iter().any(|x| x.level == 1));
    assert!(secs
        .iter()
        .all(|x| x.range.start < x.range.end || x.range.is_empty()));
}

// ---------------------------------------------------------------------------
// property：随机生成的"规范写法"文档必须恒等往返
// ---------------------------------------------------------------------------

use proptest::prelude::*;

/// 不含任何 Markdown 元字符的正文，避免生成出我们无法处理的输入。
fn body_text() -> impl Strategy<Value = String> {
    "[A-Za-z0-9\\u{4e00}-\\u{9fa5}]{1,18}"
}

fn maybe_id() -> impl Strategy<Value = String> {
    maybe_id_tag()
}

fn maybe_id_tag() -> impl Strategy<Value = String> {
    prop::option::weighted(0.5, "[a-z0-9]{10}").prop_map(|o| match o {
        Some(s) => format!(" ^b-{s}"),
        None => String::new(),
    })
}

#[derive(Clone, Debug)]
enum Piece {
    Para(String, String),
    Head(u8, String, String),
    Bullet(String, String),
    Ordered(u32, String, String),
    Todo(bool, String, String),
}

fn piece() -> impl Strategy<Value = Piece> {
    (0..5u8, body_text(), any::<bool>(), any::<u8>(), maybe_id()).prop_map(
        |(which, text, checked, level, id)| match which {
            0 => Piece::Para(text, id),
            1 => Piece::Head(1 + level % 6, text, id),
            2 => Piece::Bullet(text, id),
            3 => Piece::Ordered(1 + u32::from(level) % 9, text, id),
            _ => Piece::Todo(checked, text, id),
        },
    )
}

fn render_pieces(pieces: &[Piece]) -> String {
    let mut out = String::new();
    for (i, p) in pieces.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        match p {
            Piece::Para(t, id) => out.push_str(&format!("{t}{id}\n")),
            Piece::Head(l, t, id) => {
                out.push_str(&format!("{} {t}{id}\n", "#".repeat(*l as usize)))
            }
            Piece::Bullet(t, id) => out.push_str(&format!("- {t}{id}\n")),
            Piece::Ordered(n, t, id) => out.push_str(&format!("{n}. {t}{id}\n")),
            Piece::Todo(c, t, id) => {
                out.push_str(&format!("- [{}] {t}{id}\n", if *c { "x" } else { " " }))
            }
        }
    }
    out
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    #[test]
    fn 随机规范文档恒等往返(pieces in prop::collection::vec(piece(), 1..14)) {
        let src = render_pieces(&pieces);
        let doc = parse(&src);
        prop_assert_eq!(&render_exact(&doc), &src);
        prop_assert_eq!(&render_canonical(&doc), &src);
        prop_assert_eq!(doc.blocks.len(), pieces.len());
    }
}
