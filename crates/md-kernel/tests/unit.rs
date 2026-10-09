#![allow(non_snake_case)] // 测试名用中文短语，读失败信息时更快
//! md-kernel 的单元行为测试（公开 API 视角）。

use md_kernel::*;

#[test]
fn 块ID格式稳定() {
    for _ in 0..500 {
        let a = gen_block_id();
        assert!(is_valid_block_id(&a), "{a}");
        assert_eq!(a.len(), 12, "b- 前缀 + 10 位");
    }
    assert!(!is_valid_block_id("b-short"));
    assert!(!is_valid_block_id("x-abcdefghij"));
    assert!(!is_valid_block_id("b-ABCDEFGHIJ"));
}

#[test]
fn 行内字段只认已知键() {
    let (f, rest) = extract_fields("做一件事 due:: 2026-09-28");
    assert_eq!(rest, "做一件事");
    assert_eq!(f, vec![("due".to_string(), "2026-09-28".to_string())]);

    let (f2, rest2) = extract_fields("普通文本 未知:: 值");
    assert!(f2.is_empty());
    assert_eq!(rest2, "普通文本 未知:: 值");

    let (f3, rest3) = extract_fields("任务 due:: 2026-09-30 done:: 2026-09-28");
    assert_eq!(rest3, "任务");
    assert_eq!(f3.len(), 2);
}

#[test]
fn 纯文本剥离行内语法() {
    assert_eq!(plain_inline("普通 **粗** 与 `code`"), "普通 粗 与 code");
    assert_eq!(plain_inline("[显示名](https://x.cn)"), "显示名");
    assert_eq!(plain_inline("[[笔记|别名]]"), "别名");
    assert_eq!(plain_inline("![[attachments/a.png]]"), "attachments/a.png");
    assert_eq!(
        plain_inline("正文 ^b-k3x9m2v7qa").trim(),
        "正文",
        "块 ID 标记不该进检索文本"
    );
}

#[test]
fn 加粗与行内码被剥离但内容保留() {
    let t = "这是 **重点** 与 `代码片段` 的混排";
    let p = plain_inline(t);
    assert!(!p.contains('*'), "{p}");
    assert!(!p.contains('`'), "{p}");
    assert!(p.contains("重点"), "{p}");
    assert!(p.contains("代码片段"), "{p}");
}

#[test]
fn 非规范形必须回显原文而不是重建() {
    // 有序列表下用三空格嵌套（等于 "1. " 的宽度），我们的规范形是两空格。
    // 这种源文本不能被动过——宁可回显。
    let s = "1. 甲\n   - 乙\n";
    let d = parse(s);
    assert_eq!(&render_exact(&d), s);
    assert_eq!(&render_canonical(&d), s);
}

#[test]
fn 图片与嵌入行不许被规范化加成一个列表项() {
    // docs/02 D9 的白名单里有 image / embed / file。这几类的 `content` 就是那一整行
    // （语法也在里面），所以规范化只能补缩进。曾经它们与 Bullet 共用一支，
    // `![[a.png]]` 被重写成 `- ![[a.png]]` —— 那是把用户的文件改成另一个块类型。
    for s in [
        "![[attachments/a3/x.png]]\n",
        "![[attachments/a3/x.png|今年冬天]]\n",
        "![[去年圣诞.png]]\n", // embed
        "![](../outside.png)\n",
        "[[某篇]]\n",                    // file
        "  ![[attachments/a3/x.png]]\n", // 缩进要留着
    ] {
        let d = parse(s);
        assert_eq!(&render_exact(&d), s, "exact {s}");
        assert_eq!(&render_canonical(&d), s, "canonical {s}");
    }
}

#[test]
fn 松散列表的空行不丢() {
    let s = "- 甲\n\n- 乙\n";
    let d = parse(s);
    assert_eq!(&render_exact(&d), s);
    assert_eq!(&render_canonical(&d), s);
    assert_eq!(d.blocks.len(), 2, "两个条目应为两块");
}

#[test]
fn 行号用于定位与高亮() {
    let s = "---\nid: n-1\n---\n\n# 标题\n\n正文\n";
    let d = parse(s);
    assert_eq!(d.blocks[0].line_start, 5, "标题应在第 5 行");
    assert_eq!(d.blocks[1].line_start, 7, "正文应在第 7 行");
}
