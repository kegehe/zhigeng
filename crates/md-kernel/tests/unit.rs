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
fn 行首的颜色span仍是段落而不是HTML块() {
    // "把一整行上色"存出来就是行首一个 span。按 CommonMark，HTML 块要求整行只有一个
    // 标签，而这种行标签后跟着正文，是段落——不这么判，"上色一行"再打开就变成源码块。
    let doc = parse(
        "<span style=\"color:#e5534b\">整行</span>\n\n<span style=\"background-color:#4a9eff33\">蓝底</span>\n",
    );
    assert_eq!(doc.blocks.len(), 2, "{:?}", doc.blocks.len());
    for b in &doc.blocks {
        assert!(
            matches!(b.kind, Kind::Paragraph),
            "行首的颜色 span 被读成了 {:?}",
            b.kind.as_str()
        );
    }
    assert_eq!(plain_inline(&doc.blocks[0].content), "整行");
    // 别的 HTML 块照旧不接管：宁可少识别，也不替用户猜
    let html = parse("<div>块</div>\n");
    assert!(matches!(html.blocks[0].kind, Kind::Html));
}

#[test]
fn 行首的上下标仍是段落而不是HTML块() {
    let doc = parse("<sup>2</sup> 是平方\n\n<sub>2</sub> 是下标\n");
    assert_eq!(doc.blocks.len(), 2, "{:?}", doc.blocks.len());
    for b in &doc.blocks {
        assert!(
            matches!(b.kind, Kind::Paragraph),
            "行首的上下标被读成了 {:?}",
            b.kind.as_str()
        );
    }
    assert_eq!(plain_inline(&doc.blocks[0].content), "2 是平方");
    // 带属性的标签不是我们产出的形状，照旧按 HTML 块处理
    let html = parse("<sup class=\"x\">2</sup>\n");
    assert!(matches!(html.blocks[0].kind, Kind::Html));
}

#[test]
fn 颜色与高亮的语法不进检索文本() {
    // 颜色落成 `<span style="…">`（docs/02 D35）。标签必须剥掉：留着的话搜 "span"
    // 能搜出一堆笔记，AI 的上下文里也全是 CSS；而字一个都不能少。
    assert_eq!(
        plain_inline("前<span style=\"color:#e5534b\">红字</span>后"),
        "前红字后"
    );
    assert_eq!(
        plain_inline("<span style=\"background-color:#4a9eff33\">蓝底</span>"),
        "蓝底"
    );
    // 两层（色 + 底）也得配对剥干净
    assert_eq!(
        plain_inline(
            "<span style=\"background-color:#d2992233\"><span style=\"color:#a371f7\">紫</span></span>"
        ),
        "紫"
    );
    assert_eq!(plain_inline("这段 ==要跳出来== 了"), "这段 要跳出来 了");
    // 数学写法里的 == 不动：`a == b` 只剩一个 ==，没有收口
    assert_eq!(plain_inline("当 a == b 成立时"), "当 a == b 成立时");
    // 上下标标签剥掉，字留下；没有开标签的收尾标签按字面留着
    assert_eq!(plain_inline("H<sub>2</sub>O 与 x<sup>2</sup>"), "H2O 与 x2");
    assert_eq!(plain_inline("字面 </sup> 留着"), "字面 </sup> 留着");
    // **只开没闭**的也按字面留着：前面那个 `<sup>` 不能与后面真正的收口配成一对，
    // 否则"用 <sup> 说明：x<sup>2</sup>"里的说明文字会整段消失
    assert_eq!(
        plain_inline("用 <sup> 说明：x<sup>2</sup>"),
        "用 <sup> 说明：x2"
    );
    assert_eq!(plain_inline("10<sup>2"), "10<sup>2");
    // 手写嵌套里配对的照样剥掉，只留没配上的那个
    assert_eq!(plain_inline("10<sup>2<sub>3</sub>"), "10<sup>23");
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
fn 对齐包裹被识别为正文块并原样回显() {
    // docs/02 D40 的精确形状：开标签、空行、一块正文、空行、收尾标签。
    for (src, kind, level, body) in [
        (
            "<div align=\"center\">\n\n居中的一段\n\n</div>\n",
            "paragraph",
            0,
            "居中的一段",
        ),
        (
            "<div align=\"right\">\n\n## 右对齐标题\n\n</div>\n",
            "heading",
            2,
            "右对齐标题",
        ),
        (
            "<div align=\"justify\">\n\n两端对齐\n\n</div>\n",
            "paragraph",
            0,
            "两端对齐",
        ),
    ] {
        let d = parse(src);
        assert_eq!(d.blocks.len(), 1, "{src:?} 应是一块");
        let b = &d.blocks[0];
        assert_eq!(b.kind.as_str(), kind, "{src:?}");
        if level > 0 {
            assert!(
                matches!(b.kind, Kind::Heading { level: l, .. } if l == level),
                "{src:?} -> {:?}",
                b.kind
            );
        }
        assert_eq!(b.content, body);
        assert_eq!(b.align.as_deref(), Some(src.split('"').nth(1).unwrap()));
        assert!(!b.simple(), "对齐块必须回显 raw，不能按裸正文重建");
        // 检索只吃正文，包裹标签不该进 FTS / 嵌入
        assert_eq!(b.plain_text(), body);
        assert_eq!(render_exact(&d), src);
        assert_eq!(render_canonical(&d), src);
    }
}

#[test]
fn 对齐包裹的CRLF与前后空行不丢() {
    let src = "上文\n\n<div align=\"center\">\r\n\r\n段落\r\n\r\n</div>\r\n\r\n下文\n";
    let d = parse(src);
    assert_eq!(d.blocks.len(), 3);
    assert_eq!(d.blocks[1].align.as_deref(), Some("center"));
    assert_eq!(d.blocks[1].content, "段落");
    assert_eq!(render_exact(&d), src);
    assert_eq!(render_canonical(&d), src);
}

#[test]
fn 非精确对齐形状仍当不透明HTML块() {
    // 多块、内部空行、别的 align 值、收尾前没有空行：都不是我们产出的形状，
    // 一律留给 Html 块原样回显（宁可少识别，也不替用户改他手写的 HTML）。
    for src in [
        "<div align=\"center\">\n\n甲\n\n乙\n\n</div>\n",
        "<div align=\"left\">\n\n段落\n\n</div>\n",
        "<div align=\"center\">\n\n段落\n</div>\n",
        "<div align=\"center\">\n\n- 列表项\n\n</div>\n",
        "<div align=\"center\">\n\n</div>\n",
        "<div align=\"center\">\n\n段落\n\n",
    ] {
        let d = parse(src);
        assert_eq!(render_exact(&d), src, "exact {src:?}");
        assert_eq!(render_canonical(&d), src, "canonical {src:?}");
        assert!(
            d.blocks.iter().any(|b| matches!(b.kind, Kind::Html)),
            "{src:?} 不该被认成对齐块"
        );
        assert!(d.blocks.iter().all(|b| b.align.is_none()), "{src:?}");
    }
}

#[test]
fn 段落开头的全角空格留在正文里() {
    let s = "\u{3000}\u{3000}甲\n";
    let d = parse(s);
    assert_eq!(d.blocks.len(), 1);
    assert_eq!(d.blocks[0].kind.as_str(), "paragraph");
    assert_eq!(d.blocks[0].indent, "");
    assert_eq!(d.blocks[0].content, "\u{3000}\u{3000}甲");
    assert_eq!(render_exact(&d), s);
    assert_eq!(render_canonical(&d), s);
    // 检索文本仍按原有 trim 丢掉一段开头的空白；字本身留在 content 里
    assert_eq!(d.blocks[0].plain_text(), "甲");
}

#[test]
fn 半角缩进后面的全角空格仍留在正文() {
    let s = "  \u{3000}\u{3000}甲\n";
    let d = parse(s);
    assert_eq!(d.blocks[0].indent, "  ");
    assert_eq!(d.blocks[0].content, "\u{3000}\u{3000}甲");
    assert_eq!(render_exact(&d), s);
    assert_eq!(render_canonical(&d), s);
}

#[test]
fn 多行段落只在整段开头留全角空格() {
    let s = "\u{3000}\u{3000}甲\n乙\n";
    let d = parse(s);
    assert_eq!(d.blocks.len(), 1);
    assert_eq!(d.blocks[0].content, "\u{3000}\u{3000}甲\n乙");
    assert_eq!(render_canonical(&d), s);
}

#[test]
fn 带全角空格的段落行尾字段仍能剥出() {
    let s = "\u{3000}\u{3000}甲 due:: 2026-11-04\n";
    let d = parse(s);
    assert_eq!(d.blocks[0].content, "\u{3000}\u{3000}甲");
    assert_eq!(
        d.blocks[0].fields,
        vec![("due".to_string(), "2026-11-04".to_string())]
    );
    assert_eq!(render_canonical(&d), s);
}

#[test]
fn 普通段落不变_标题开头的全角空格仍被剪掉() {
    let d = parse("甲\n");
    assert_eq!(d.blocks[0].content, "甲");
    assert_eq!(render_canonical(&d), "甲\n");

    let indented = parse("  甲\n");
    assert_eq!(indented.blocks[0].indent, "  ");
    assert_eq!(indented.blocks[0].content, "甲");
    assert_eq!(render_canonical(&indented), "  甲\n");

    // 标题仍整段 trim。全角空格不进标题正文，精确回写也不改源字节。
    let src = "# \u{3000}\u{3000}题\n";
    let h = parse(src);
    assert_eq!(h.blocks[0].content, "题");
    assert_eq!(render_exact(&h), src);
}

#[test]
fn 行号用于定位与高亮() {
    let s = "---\nid: n-1\n---\n\n# 标题\n\n正文\n";
    let d = parse(s);
    assert_eq!(d.blocks[0].line_start, 5, "标题应在第 5 行");
    assert_eq!(d.blocks[1].line_start, 7, "正文应在第 7 行");
}
