import { describe, expect, it } from "vitest";
import type { EditBlock } from "../ipc/types";
import { docToMarkdown, exitQuoteDown, applyBlockType, 块转换起点, 列表回车, 列表退格, 引用回车, 引用退格, 点待办前缀 } from "./blocks";
import { 引用接管 } from "./quoteStructured";
import { createTestEditor } from "./testEditor";
import type { EditDoc } from "./blocks";

/**
 * 结构化引用的判据只有一条：**用我们自己的笔把内核给的子块写回去，必须与账本里的正文
 * 逐行相等**。相等才接管；差一个字节就退回源文本面。这组用例钉的就是这条边界，
 * 以及接管之后的键盘行为（引用里的回车是软换行，标题写完回车落到正文）。
 */

const 文 = (over: Partial<EditBlock> = {}): EditBlock => ({
  kind: "paragraph",
  id: null,
  raw: "甲\n",
  gapBefore: "",
  content: "甲",
  level: null,
  checked: null,
  align: null,
  fields: [],
  children: [],
  ...over,
});

const 引 = (over: Partial<EditBlock> = {}): EditBlock => ({
  kind: "quote",
  id: null,
  raw: "> 甲\n",
  gapBefore: "",
  content: "",
  level: null,
  checked: null,
  align: null,
  fields: [],
  children: [文()],
  ...over,
});

const 文档 = (blocks: EditBlock[]): EditDoc => ({
  frontMatter: "",
  trailingGap: "",
  blocks,
});

const 顶层 = (editor: ReturnType<typeof createTestEditor>, 名: string) => {
  let 位 = -1;
  editor.state.doc.forEach((n, off) => {
    if (位 < 0 && n.type.name === 名) 位 = off;
  });
  expect(位, 名).toBeGreaterThanOrEqual(0);
  return 位;
};

describe("引用接管的判据：拼得回原字节才接管", () => {
  it("普通引用：段落、前缀进账本", () => {
    const 出 = 引用接管(引());
    expect(出?.type).toBe("mdQuote");
    expect(出?.attrs?.mdKind).toBe("quote");
    expect(出?.attrs?.mdQuoteMarks).toBe("> ");
    expect(出?.attrs?.mdQuoteAnchor).toBe("");
    expect(出?.content?.map((n) => n.type)).toEqual(["mdParagraph"]);
  });

  it("行尾块锚摘进账本，子块带同一枚 ID 才算数", () => {
    const id = "b-x1y2z3a4b5";
    const 出 = 引用接管(
      引({
        id,
        raw: `> 甲 ^${id}\n`,
        children: [文({ id })],
      }),
    );
    expect(出?.attrs?.mdQuoteAnchor).toBe(` ^${id}`);
    expect(引用接管(引({ id, raw: `> 甲 ^${id}\n`, children: [文({ id: "b-other1" })] }))).toBeNull();
  });

  it("行内语法按规范化写法拼：`__粗__` 会变成 `**粗**`，不接管", () => {
    expect(引用接管(引({ raw: "> __粗__\n", children: [文({ content: "__粗__" })] }))).toBeNull();
  });

  it("列表只认自己写得出的记号：`*` / `+` 不接管，`- [x]` 与 `3)` 接管", () => {
    const 星 = { kind: "bullet", raw: "* 甲\n", content: "甲", gapBefore: "" } as EditBlock;
    expect(引用接管(引({ raw: "> * 甲\n", children: [{ ...文(), ...星 }] }))).toBeNull();

    const 待办 = 引用接管(
      引({
        raw: "> - [x] 甲\n",
        children: [
          {
            ...文(),
            kind: "todo",
            raw: "- [x] 甲\n",
            content: "甲",
            checked: true,
          },
        ],
      }),
    );
    expect(待办?.content?.[0]?.attrs?.mdKind).toBe("todo");
    expect(待办?.content?.[0]?.attrs?.mdChecked).toBe(true);

    const 有序 = 引用接管(
      引({
        raw: "> 3) 甲\n",
        children: [
          {
            ...文(),
            kind: "numbered",
            raw: "3) 甲\n",
            content: "甲",
          },
        ],
      }),
    );
    expect(有序?.content?.[0]?.attrs?.mdMarker).toBe("3)");
  });

  it("代码、带子项的列表项、对齐块都不接管：这些形状拼不回我们写出的行", () => {
    const 码 = {
      ...文(),
      kind: "code",
      raw: "```\nlet a = 1;\n```\n",
      content: "",
    } as EditBlock;
    expect(引用接管(引({ raw: "> ```\n> let a = 1;\n> ```\n", children: [码] }))).toBeNull();

    const 套 = { ...文(), kind: "bullet", raw: "- 甲\n", children: [文()] } as EditBlock;
    expect(引用接管(引({ raw: "> - 甲\n", children: [套] }))).toBeNull();

    expect(
      引用接管(引({ raw: "> 甲\n", children: [文({ align: "center" })] })),
    ).toBeNull();
  });

  it("子块之间的空行记在下一块的 mdGap 里", () => {
    const 出 = 引用接管(
      引({
        raw: "> 甲\n>\n> 乙\n",
        children: [文(), 文({ raw: "乙\n", content: "乙", gapBefore: "\n" })],
      }),
    );
    expect(出?.content?.map((n) => n.type)).toEqual(["mdParagraph", "mdParagraph"]);
    expect(出?.content?.[1]?.attrs?.mdGap).toBe("\n");
  });

  it("Callout：标题是第一个正文节点，类型与折叠标记进账本", () => {
    const 出 = 引用接管({
      ...引(),
      kind: "callout",
      raw: "> [!note]- 标题\n> 甲\n",
      children: [文()],
    });
    expect(出?.attrs?.mdCalloutType).toBe("note");
    expect(出?.attrs?.mdCalloutFolded).toBe(true);
    expect(出?.content?.[0]).toMatchObject({ type: "mdQuoteHead" });
    expect(出?.content?.[1]?.type).toBe("mdParagraph");
  });

  it("CRLF 记进账本，子块正文仍然只认 `\\n`", () => {
    const 出 = 引用接管({
      ...引(),
      raw: "> 甲\r\n> 乙\r\n",
      children: [文({ content: "甲\n乙" })],
    });
    expect(出?.attrs?.mdQuoteEol).toBe("\r\n");
    expect(出?.attrs?.mdQuoteTail).toBe("\r");
  });
});

describe("结构化引用的落盘：账本拼回原字节", () => {
  it("清掉签名逼它重新序列化，列表 / 空行 / 前缀一行不差", () => {
    const raw = "> 引用里嵌列表：\n>\n> - 甲\n> - 乙\n";
    const doc = 文档([
      引({
        raw,
        children: [
          文({ raw: "引用里嵌列表：\n", content: "引用里嵌列表：" }),
          {
            ...文(),
            kind: "bullet",
            raw: "- 甲\n",
            content: "甲",
            gapBefore: "\n",
          },
          { ...文(), kind: "bullet", raw: "- 乙\n", content: "乙" },
        ],
      }),
    ]);
    const editor = createTestEditor(doc);
    const 块 = editor.state.doc.firstChild!;
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(0, undefined, { ...块.attrs, mdSig: "" }),
    );
    expect(docToMarkdown(editor.state.doc, doc)).toBe(raw);
    editor.destroy();
  });

  it("改一个字：前缀、空行与块锚都在原来的位置，改回去逐字节复原", () => {
    const id = "b-x1y2z3a4b5";
    const raw = `> 甲\n>\n> 乙 ^${id}\n`;
    const doc = 文档([
      引({
        id,
        raw,
        children: [
          文({ raw: "甲\n", content: "甲" }),
          文({ raw: `乙 ^${id}\n`, id, content: "乙", gapBefore: "\n" }),
        ],
      }),
    ]);
    const editor = createTestEditor(doc);
    editor.view.dispatch(editor.state.tr.insertText("X", 2));
    const 出 = docToMarkdown(editor.state.doc, doc);
    expect(出).toContain("> X甲\n");
    expect(出).toContain("^" + id);
    expect(出.match(new RegExp("\\^" + id, "g"))).toHaveLength(1);
    editor.view.dispatch(editor.state.tr.delete(2, 3));
    expect(docToMarkdown(editor.state.doc, doc)).toBe(raw);
    editor.destroy();
  });

  it("CRLF 文件改一个字，行尾仍然是 CRLF", () => {
    const raw = "> 甲\r\n> 乙\r\n";
    const doc = 文档([
      引({ raw, children: [文({ raw: "甲\r\n乙\r\n", content: "甲\n乙" })] }),
    ]);
    const editor = createTestEditor(doc);
    editor.view.dispatch(editor.state.tr.insertText("X", 2));
    expect(docToMarkdown(editor.state.doc, doc)).toBe("> X甲\r\n> 乙\r\n");
    editor.destroy();
  });
});

describe("结构化引用里的键盘", () => {
  const 首引 = (editor: ReturnType<typeof createTestEditor>) => {
    const 位 = 顶层(editor, "mdQuote");
    return { 位, 块: editor.state.doc.nodeAt(位)! };
  };

  it("正文里的回车是软换行：块数不变，落盘多一行 `>`", () => {
    const doc = 文档([引({ raw: "> 甲\n> 乙\n", children: [文({ content: "甲\n乙" })] })]);
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(2);
    const tr = 引用回车(editor.state);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(editor.state.doc.firstChild!.childCount).toBe(1);
    expect(editor.state.doc.firstChild!.firstChild!.textContent).toBe("\n甲\n乙");
    expect(docToMarkdown(editor.state.doc, doc)).toBe("> \n> 甲\n> 乙\n");
    editor.destroy();
  });

  it("Callout 标题写完回车：落出一个正文段落，接着打的字在正文里", () => {
    const doc = 文档([
      引({
        kind: "callout",
        raw: "> [!question] 标题\n> 甲\n",
        children: [文()],
      }),
    ]);
    const editor = createTestEditor(doc);
    const 位 = 顶层(editor, "mdQuote");
    // 引用 → 标题节点 → 文字：起点 +2 是第一个字
    editor.commands.setTextSelection(位 + 2 + "标题".length);
    editor.view.dispatch(引用回车(editor.state)!);
    const 块 = editor.state.doc.firstChild!;
    expect([...块.children].map((n) => n.type.name)).toEqual(["mdQuoteHead", "mdParagraph", "mdParagraph"]);
    editor.view.dispatch(editor.state.tr.insertText("补一句"));
    expect(docToMarkdown(editor.state.doc, doc)).toBe(
      "> [!question] 标题\n> 补一句\n> 甲\n",
    );
    editor.destroy();
  });

  it("引用里的标题回车也落到正文，标题那一行不与正文并在一起", () => {
    const doc = 文档([
      引({
        raw: "> # 标题\n> 正文\n",
        children: [
          { ...文(), kind: "heading", raw: "# 标题\n", content: "标题", level: 1 },
          文({ raw: "正文\n", content: "正文" }),
        ],
      }),
    ]);
    const editor = createTestEditor(doc);
    const 位 = 顶层(editor, "mdQuote");
    editor.commands.setTextSelection(位 + 2 + "标题".length);
    editor.view.dispatch(引用回车(editor.state)!);
    editor.view.dispatch(editor.state.tr.insertText("补"));
    expect(docToMarkdown(editor.state.doc, doc)).toBe("> # 标题\n> 补\n> 正文\n");
    editor.destroy();
  });

  it("↓ 在最后一个正文块末尾：离开引用；中间的行交回 PM", () => {
    const editor = createTestEditor(
      文档([
        引({ raw: "> 甲\n> 乙\n", children: [文({ content: "甲\n乙" })] }),
        文({ raw: "后面\n", content: "后面", gapBefore: "\n" }),
      ]),
    );
    const 位 = 顶层(editor, "mdQuote");
    const 块 = editor.state.doc.nodeAt(位)!;
    // 中间（第一行的末尾）不出去
    editor.commands.setTextSelection(位 + 2 + 1);
    expect(exitQuoteDown(editor.state)).toBeNull();
    // 最后一行末尾才出去（块尾 -1 落在段落与引用闭合之间，那不是正文位置）
    editor.commands.setTextSelection(位 + 块.nodeSize - 2);
    const tr = exitQuoteDown(editor.state);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(editor.state.selection.from).toBeGreaterThan(位 + 块.nodeSize);
    editor.destroy();
  });

  it("Callout 标题开头与紧跟标题的正文开头，退格不吃掉标题", () => {
    const editor = createTestEditor(
      文档([
        引({
           kind: "callout",
           raw: "> [!note] 标题\n> 甲\n",
           children: [文()],
         }),
       ]),
    );
    const 位 = 顶层(editor, "mdQuote");
    editor.commands.setTextSelection(位 + 2);
    const 标题退 = 引用退格(editor.state);
    expect(标题退?.docChanged).toBe(false);
    // 标题节点：head 起点 +1 是文字，head 的 nodeSize 之后才是正文
    const 头 = editor.state.doc.firstChild!.firstChild!;
    editor.commands.setTextSelection(位 + 1 + 头.nodeSize + 1);
    const 正文退 = 引用退格(editor.state);
    expect(正文退?.docChanged).toBe(false);
    editor.destroy();
  });

  it("引用里的列表：回车拆出下一项，项首退格只摘记号", () => {
    const doc = 文档([
      引({
        raw: "> - 甲\n",
        children: [{ ...文(), kind: "bullet", raw: "- 甲\n", content: "甲" }],
      }),
    ]);
    const editor = createTestEditor(doc);
    const 位 = 顶层(editor, "mdQuote");
    editor.commands.setTextSelection(位 + 2 + 1);
    const 回车 = 列表回车(editor.state);
    expect(回车).not.toBeNull();
    editor.view.dispatch(回车!);
    expect([...editor.state.doc.firstChild!.children].map((n) => n.type.name)).toEqual([
      "mdItem",
      "mdItem",
    ]);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("> - 甲\n> - \n");

    // 第二项项首退格：退回正文，记号摘掉，字还在
    editor.commands.setTextSelection(位 + editor.state.doc.firstChild!.child(0).nodeSize + 2);
    const 退 = 列表退格(editor.state);
    expect(退).not.toBeNull();
    editor.view.dispatch(退!);
    expect(editor.state.doc.firstChild!.child(1).type.name).toBe("mdParagraph");
    editor.destroy();
  });
});

describe("D43 复查：引用内的边界", () => {
  it("段落末尾回车拆子块：空行不落盘，接着打字才占一行", () => {
    const doc = 文档([引({ raw: "> 甲\n", children: [文()] })]);
    const editor = createTestEditor(doc);
    const 位 = 顶层(editor, "mdQuote");
    // 引用 → 段落 → 文字：+2 是第一个字，+1 到段尾
    editor.commands.setTextSelection(位 + 2 + 1);
    const tr = 引用回车(editor.state);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(editor.state.doc.firstChild!.childCount).toBe(2);
    expect(editor.state.doc.firstChild!.child(1).textContent).toBe("");
    // 空段落不写字节：文件里不该多出一条 `> `
    expect(docToMarkdown(editor.state.doc, doc)).toBe("> 甲\n");
    // 光标在新段里，接着打的字落在新的一行
    editor.view.dispatch(editor.state.tr.insertText("乙"));
    expect(docToMarkdown(editor.state.doc, doc)).toBe("> 甲\n> 乙\n");
    editor.destroy();
  });

  it("段中回车仍是软换行；跨行加粗按行拆开，落盘可读回", () => {
    const doc = 文档([引({ raw: "> 甲乙\n", children: [文({ raw: "甲乙\n", content: "甲乙" })] })]);
    const editor = createTestEditor(doc);
    const 位 = 顶层(editor, "mdQuote");
    const 粗 = editor.state.schema.marks.bold!.create();
    editor.view.dispatch(editor.state.tr.addMark(位 + 2, 位 + 4, 粗));
    editor.commands.setTextSelection(位 + 2 + 1);
    editor.view.dispatch(引用回车(editor.state)!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("> **甲**\n> **乙**\n");
    editor.destroy();
  });

  it("引用里的子块能换类型；整段引用本身不换，也不抛错", () => {
    const doc = 文档([引({ raw: "> 甲\n", children: [文()] })]);
    const editor = createTestEditor(doc);
    const 位 = 顶层(editor, "mdQuote");
    editor.commands.setTextSelection(位 + 2);
    const 标 = 块转换起点(editor.state)!;
    const tr = applyBlockType(editor.state, 标, "heading1");
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("> # 甲\n");
    expect(applyBlockType(editor.state, 位, "heading1")).toBeNull();
    editor.destroy();
  });

  it("引用行首 `# ` 输入规则落到子块上，不再抛 RangeError", () => {
    const doc = 文档([引({ raw: "> #\n", children: [文({ raw: "#\n", content: "#" })] })]);
    const editor = createTestEditor(doc);
    const 位 = 顶层(editor, "mdQuote");
    editor.commands.setTextSelection(位 + 2 + 1);
    const 接了 = editor.view.someProp("handleTextInput", (f) =>
      f(editor.view, 位 + 2 + 1, 位 + 2 + 1, " ", () => editor.state.tr),
    );
    expect(接了).toBe(true);
    expect(editor.state.doc.firstChild!.firstChild!.type.name).toBe("mdHeading");
    editor.destroy();
  });

  it("引用里的待办项：点前缀能勾选", () => {
    const doc = 文档([
      引({
        raw: "> - [ ] 甲\n",
        children: [{ ...文(), kind: "todo", raw: "- [ ] 甲\n", content: "甲", checked: false }],
      }),
    ]);
    const editor = createTestEditor(doc);
    const 项 = editor.view.dom.querySelector("[data-md-item='todo']") as HTMLElement;
    expect(项).not.toBeNull();
    项.style.paddingLeft = "24px";
    项.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 24, width: 200, height: 24, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    let 拦住 = false;
    const 处理了 = 点待办前缀(editor.view, {
      button: 0,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      clientX: 8,
      clientY: 8,
      target: 项,
      preventDefault() {
        拦住 = true;
      },
    } as unknown as MouseEvent);
    expect(处理了 && 拦住).toBe(true);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("> - [x] 甲\n");
    editor.destroy();
  });

  it("Callout 标题行删掉：整块退回普通引用，正文不接任标题", () => {
    const doc = 文档([
      引({ kind: "callout", raw: "> [!note] 标题\n> 甲\n", children: [文()] }),
    ]);
    const editor = createTestEditor(doc);
    const 位 = 顶层(editor, "mdQuote");
    const 头 = editor.state.doc.firstChild!.firstChild!;
    expect(头.type.name).toBe("mdQuoteHead");
    editor.view.dispatch(editor.state.tr.delete(位 + 1, 位 + 1 + 头.nodeSize));
    const 块 = editor.state.doc.firstChild!;
    expect(块.attrs.mdKind).toBe("quote");
    expect(String(块.attrs.mdCalloutType)).toBe("");
    expect(docToMarkdown(editor.state.doc, doc)).toBe("> 甲\n");
    editor.destroy();
  });
});
