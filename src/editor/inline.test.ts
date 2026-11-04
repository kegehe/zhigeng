import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { 底色of, 调色板 } from "./colors";
import { inlineToJson, parseInline, serializeInline, 序列化行内文本 } from "./inline";
import { mdExtensions } from "./schema";

// 用例里的色值从调色板取，不写字面量：两者不同源的话，"界面上是红的、落盘是另一个红"
// 这种事只能靠打开 .md 才发现（也顺带避开样式护栏对字面量颜色的禁令）
const [红, 橙] = [调色板[0]!.hex, 调色板[1]!.hex];
const [绿, 蓝, 紫] = [调色板[2]!.hex, 调色板[3]!.hex, 调色板[4]!.hex];

/**
 * 颜色 / 高亮的**字节级往返**。判据只有一条：解析认得的写法，序列化必须一字不差地还原——
 * 不满足这一条的语法就不许进工具栏，否则"点一下变个颜色"会顺手把这一块的字节洗掉（G5）。
 *
 * 走真编辑器装载而不是手搭 JSON：属性在装载那一步丢过一次（Docs/02 D27 那个坑），
 * 假 doc 测不出来。
 */

const 编辑器: Editor[] = [];

afterEach(() => {
  for (const e of 编辑器.splice(0)) e.destroy();
});

/** 把一段行内源文本装进一个正文块，再按序列化器产出一次 */
function 成环(src: string): string {
  const el = document.createElement("div");
  document.body.append(el);
  const editor = new Editor({
    element: el,
    extensions: mdExtensions,
    content: {
      type: "doc",
      content: [{ type: "mdParagraph", content: inlineToJson(src) }],
    } as never,
  });
  编辑器.push(editor);
  return serializeInline(editor.state.doc.firstChild!);
}

describe("颜色与高亮", () => {
  it("高亮 ==…== 原样往返", () => {
    expect(成环("这段 ==要跳出来== 了")).toBe("这段 ==要跳出来== 了");
  });

  it("高亮体内可以有空格", () => {
    expect(成环("==两个 词==")).toBe("==两个 词==");
  });

  it("上标 / 下标的精确标签原样往返", () => {
    expect(成环("<sup>2</sup>")).toBe("<sup>2</sup>");
    expect(成环("H<sub>2</sub>O")).toBe("H<sub>2</sub>O");
  });

  it("带属性的 sup / sub 仍当字面文字", () => {
    expect(成环('<sup class="x">2</sup>')).toBe('<sup class="x">2</sup>');
    expect(成环("<sub style=\"x\">2</sub>")).toBe("<sub style=\"x\">2</sub>");
  });

  it("上下标与颜色 / 高亮叠加：固定层序，字节稳定", () => {
    // 上标在最外层，颜色 / 高亮的记号留在标签内部
    expect(成环(`<span style="color:${红}"><sup>2</sup></span>`)).toBe(
      `<sup><span style="color:${红}">2</span></sup>`,
    );
    expect(成环("<sup>==字==</sup>")).toBe("<sup>==字==</sup>");
  });

  it("体内再出现上下标标签时按字面留下，不把两对配成一对", () => {
    // 只开了没闭的 `<sup>` 若被收成语法，会与后面真正的收口配成一对，中间的字整段消失
    expect(成环("用 <sup> 说明：x<sup>2</sup>")).toBe("用 <sup> 说明：x<sup>2</sup>");
    // 手写的嵌套在 PM 里表达不出来（sup / sub 互斥），逐段按字面留下才能字节还原
    expect(成环("10<sup>2<sub>3</sub></sup>")).toBe("10<sup>2<sub>3</sub></sup>");
    // 空标签收下去生不出文字节点，序列化会把它整条丢掉
    expect(成环("<sup></sup>")).toBe("<sup></sup>");
  });

  it("上标与下标互斥：后加的那个替换先加的", () => {
    const el = document.createElement("div");
    document.body.append(el);
    const editor = new Editor({
      element: el,
      extensions: mdExtensions,
      content: {
        type: "doc",
        content: [{ type: "mdParagraph", content: inlineToJson("<sub>2</sub>") }],
      } as never,
    });
    编辑器.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 2 });
    editor.commands.toggleMark("sup");
    expect(serializeInline(editor.state.doc.firstChild!)).toBe("<sup>2</sup>");
  });

  it("文字色按 span 落盘", () => {
    const s = `前<span style="color:${红}">红字</span>后`;
    expect(成环(s)).toBe(s);
  });

  it("底色是 8 位十六进制（带 alpha），主题切换不用存第二份", () => {
    const s = `<span style="background-color:${底色of(蓝)}">蓝底</span>`;
    expect(成环(s)).toBe(s);
  });

  it("颜色套加粗：结构往返，不吞字也不多标", () => {
    const s = `<span style="color:${绿}">**粗**</span>`;
    expect(成环(s)).toBe(s);
  });

  it("两层颜色互相嵌套也认得（底色 + 文字色可以叠在同一段字上）", () => {
    const s = `<span style="background-color:${底色of(橙)}"><span style="color:${紫}">紫字黄底</span></span>`;
    expect(成环(s)).toBe(s);
  });

  it("不是我们写的那两种 HTML 一律当字面文字", () => {
    expect(成环("<b>粗</b> 与 <span class=\"x\">别的</span>")).toBe(
      "<b>粗</b> 与 <span class=\"x\">别的</span>",
    );
  });

  it("公式里的 == 不被当成高亮", () => {
    expect(成环("当 a == b 成立时")).toBe("当 a == b 成立时");
  });

  it("原有的四种行内标记不受影响", () => {
    expect(成环("**粗** *斜* ~~删~~ `码`")).toBe("**粗** *斜* ~~删~~ `码`");
    expect(成环("[字](https://x.cn)")).toBe("[字](https://x.cn)");
  });

  it("下划线只在词边界上才是斜体：a_b_c 与路径原样", () => {
    expect(成环("notes/a_b_c.md")).toBe("notes/a_b_c.md");
    expect(parseInline("a_b_c").map((n) => [n.text, n.marks])).toEqual([["a_b_c", []]]);
    expect(parseInline("_斜_")).toEqual([{ text: "斜", marks: [{ name: "italic" }] }]);
    expect(parseInline("前 _斜_ 后").map((n) => n.text)).toEqual(["前 ", "斜", " 后"]);
  });

  it("链接目标里成对的括号算作 URL 的一部分", () => {
    const 段 = parseInline("[字](https://x.cn/a_(b))");
    expect(段).toHaveLength(1);
    expect(段[0]!.marks[0]).toEqual({ name: "link", href: "https://x.cn/a_(b)" });
    expect(成环("[字](https://x.cn/a_(b))")).toBe("[字](https://x.cn/a_(b))");
  });

  it("解析出的标记挂对了名字", () => {
    const 段 = parseInline(`a==高==<span style="color:${红}">红</span>`);
    expect(段.map((n) => [n.text, n.marks.map((m) => m.name)])).toEqual([
      ["a", []],
      ["高", ["highlight"]],
      ["红", ["textColor"]],
    ]);
    expect(段[2]!.marks[0]!.color).toBe(红);
  });
});

/**
 * 软换行（结构化引用里回车插的那个 `\n`）可以落在带标记的文字里。开闭符号不能被
 * 换行劈开——`**甲\n乙**` 我们自己的解析器不认，保存一次加粗就没了（D43）。
 */
describe("软换行与行内标记", () => {
  function 装段(内容: unknown[]): Editor {
    const el = document.createElement("div");
    document.body.append(el);
    const editor = new Editor({
      element: el,
      extensions: mdExtensions,
      content: { type: "doc", content: [{ type: "mdParagraph", content: 内容 }] } as never,
    });
    编辑器.push(editor);
    return editor;
  }

  it("跨行的加粗按行拆开，换行留在标记外", () => {
    const editor = 装段([{ type: "text", marks: [{ type: "bold" }], text: "甲\n乙" }]);
    const 出 = serializeInline(editor.state.doc.firstChild!);
    expect(出).toBe("**甲**\n**乙**");
    expect(parseInline(出).map((n) => [n.text, n.marks.map((m) => m.name)])).toEqual([
      ["甲", ["bold"]],
      ["\n", []],
      ["乙", ["bold"]],
    ]);
    expect(序列化行内文本(出)).toBe(出);
  });

  it("行尾换行也拆开：不会写出收口在下一行的 `**甲乙\n**`", () => {
    const editor = 装段([{ type: "text", marks: [{ type: "bold" }], text: "甲乙\n" }]);
    expect(serializeInline(editor.state.doc.firstChild!)).toBe("**甲乙**\n");
  });

  it("同一段字上的颜色 / 高亮同样按行拆", () => {
    const editor = 装段([
      {
        type: "text",
        marks: [
          { type: "highlight" },
          { type: "textColor", attrs: { color: 红 } },
        ],
        text: "甲\n乙",
      },
    ]);
    expect(serializeInline(editor.state.doc.firstChild!)).toBe(
      `<span style="color:${红}">==甲==</span>\n<span style="color:${红}">==乙==</span>`,
    );
  });
});
