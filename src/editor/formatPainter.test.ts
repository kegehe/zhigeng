import { undo } from "@tiptap/pm/history";
import type { Transaction } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import { docToMarkdown, reassemble, type EditBlock, type EditDoc } from "./blocks";
import { 调色板 } from "./colors";
import {
  关格式刷,
  取格式,
  开格式刷,
  应用格式刷,
  格式刷状态of,
  能开格式刷,
} from "./formatPainter";
import { 改选区 } from "./tableSelectPlugin";
import { createTestEditor } from "./testEditor";

/**
 * 格式刷：**抄的是能往返的那一层**（行内 marks + 块类型），不是"屏幕上看得到的一切"。
 *
 * 这里钉三件事：
 * 1. 落盘字节是源格式叠到目标上的结果，不是"看起来差不多"；
 * 2. 目标自己的链接必须留着（它不在可刷名单里），代码 / 表格 / 图片要**说一句再跳过**；
 * 3. 开格式刷本身不许把笔记标脏（只带 meta 的事务），刷完只留一笔可撤销事务。
 */

function 块(content: string, rest: Partial<EditBlock> = {}): EditBlock {
  const kind = rest.kind ?? "paragraph";
  const raw =
    rest.raw ??
    (kind === "heading"
      ? `${"#".repeat(rest.level ?? 1)} ${content}\n`
      : `${content}\n`);
  return {
    kind,
    id: null,
    raw,
    gapBefore: "",
    content,
    level: kind === "heading" ? (rest.level ?? 1) : null,
    checked: null,
    align: null,
    fields: [],
    children: [],
    ...rest,
  };
}

function 篇(...blocks: EditBlock[]): EditDoc {
  return {
    frontMatter: "",
    trailingGap: "",
    blocks: blocks.map((b, i) => ({ ...b, gapBefore: b.gapBefore || (i ? "\n" : "") })),
  };
}

function 找(editor: ReturnType<typeof createTestEditor>, 字: string): number {
  let 位 = -1;
  editor.state.doc.descendants((node, pos) => {
    if (位 >= 0) return false;
    if (!node.isText || !node.text) return true;
    const i = node.text.indexOf(字);
    if (i < 0) return true;
    位 = pos + i;
    return false;
  });
  if (位 < 0) throw new Error(`夹具里找不到「${字}」`);
  return 位;
}

function 选中(editor: ReturnType<typeof createTestEditor>, from: number, to: number) {
  editor.commands.setTextSelection({ from, to });
}

function 表格起点(editor: ReturnType<typeof createTestEditor>): number {
  let p = -1;
  editor.state.doc.forEach((n, off) => {
    if (n.type.name === "mdTable") p = off;
  });
  return p;
}

/** 表里第 n 个格子（文档序，0 起）的绝对起点 */
function 格起点(editor: ReturnType<typeof createTestEditor>, n: number): number {
  const 表起 = 表格起点(editor);
  const 表 = editor.state.doc.nodeAt(表起)!;
  let i = 0;
  let 找 = -1;
  表.forEach((行, 行偏) =>
    行.forEach((_格, 格偏) => {
      if (i++ === n) 找 = 表起 + 1 + 行偏 + 1 + 格偏;
    }),
  );
  return 找;
}

function 进格(editor: ReturnType<typeof createTestEditor>, n: number): void {
  editor.commands.setTextSelection(格起点(editor, n) + 1);
}

const 粗 = (editor: ReturnType<typeof createTestEditor>) => editor.state.schema.marks.bold!.create();
const 斜 = (editor: ReturnType<typeof createTestEditor>) => editor.state.schema.marks.italic!.create();

describe("取格式", () => {
  it("取第一个有字的字符，连它所在的块类型一起记下", () => {
    const editor = createTestEditor(篇(块("**源文字**", { kind: "heading", level: 2 }), 块("目标")));
    const 位 = 找(editor, "源文字");
    选中(editor, 位, 位 + 2);
    expect(能开格式刷(editor.state)).toBe(true);
    const 快照 = 取格式(editor.state)!;
    expect(快照.block).toBe("heading2");
    expect(快照.marks).toEqual([{ type: "bold", attrs: {} }]);
    editor.destroy();
  });

  it("代码块里的文字不能当源：能开判否，开也开不起来", () => {
    const editor = createTestEditor(
      篇(块("const a = 1;", { kind: "code", raw: "```\nconst a = 1;\n```\n" })),
    );
    const 位 = 找(editor, "const");
    选中(editor, 位, 位 + 5);
    expect(能开格式刷(editor.state)).toBe(false);
    expect(取格式(editor.state)).toBeNull();
    expect(开格式刷(editor)).toBe(false);
    expect(格式刷状态of(editor.state)).toBeNull();
    editor.destroy();
  });

  it("只选到空白字符时开不起来：按钮亮灭与取快照同一判据，不是亮着没反应", () => {
    const editor = createTestEditor(篇(块("   "), 块("目标")));
    const 位 = 找(editor, " ");
    选中(editor, 位, 位 + 3);
    expect(能开格式刷(editor.state)).toBe(false);
    expect(取格式(editor.state)).toBeNull();
    expect(开格式刷(editor)).toBe(false);
    expect(格式刷状态of(editor.state)).toBeNull();
    editor.destroy();
  });

  it("源在表格格子里：只抄行内格式，块类型为 null", () => {
    const 表 = ["| A | B |", "| --- | --- |", "| **甲** | 乙 |"].join("\n");
    const editor = createTestEditor(篇(块("", { kind: "table", raw: 表 + "\n" })));
    进格(editor, 2);
    const 位 = 格起点(editor, 2) + 1;
    选中(editor, 位, 位 + 1);
    const 快照 = 取格式(editor.state)!;
    expect(快照.block).toBeNull();
    expect(快照.marks).toEqual([{ type: "bold", attrs: {} }]);
    editor.destroy();
  });
});

describe("刷格式", () => {
  it("字节就是源格式叠到目标上的结果；撤销一步回到原样", () => {
    const doc = 篇(块("**源**"), 块("目标"));
    const editor = createTestEditor(doc);
    const 源 = 找(editor, "源");
    选中(editor, 源, 源 + 1);
    expect(开格式刷(editor)).toBe(true);

    const 目标 = 找(editor, "目标");
    选中(editor, 目标, 目标 + 2);
    const 果 = 应用格式刷(editor);
    expect(果.刷了).toBe(true);
    expect(果.跳过).toBe(0);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("**源**\n\n**目标**\n");

    expect(undo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true);
    expect(docToMarkdown(editor.state.doc, doc)).toBe(reassemble(doc));
    editor.destroy();
  });

  it("上标 / 下标也在可刷名单里：抄过去，目标的旧上下标会被摘掉", () => {
    const doc = 篇(块("<sup>源</sup>"), 块("<sub>目标</sub>"));
    const editor = createTestEditor(doc);
    const 源 = 找(editor, "源");
    选中(editor, 源, 源 + 1);
    开格式刷(editor);

    const 目标 = 找(editor, "目标");
    选中(editor, 目标, 目标 + 2);
    const 果 = 应用格式刷(editor);
    expect(果.刷了).toBe(true);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("<sup>源</sup>\n\n<sup>目标</sup>\n");
    editor.destroy();
  });

  it("块类型刷到选区碰到的每一块；目标自己的链接留着", () => {
    const doc = 篇(
      块("**源**", { kind: "heading", level: 2 }),
      块("[链](https://example.com/1)"),
      块("尾"),
    );
    const editor = createTestEditor(doc);
    const 源 = 找(editor, "源");
    选中(editor, 源, 源 + 1);
    开格式刷(editor);

    const 链位 = 找(editor, "链");
    const 尾 = 找(editor, "尾");
    选中(editor, 链位, 尾 + 1);
    const 果 = 应用格式刷(editor);
    expect(果.刷了).toBe(true);

    expect(editor.state.doc.rangeHasMark(链位, 链位 + 1, 粗(editor))).toBe(true);
    // 精确字节是链接仍然在的最硬证据：href 不在可刷名单里，刷完还得是原来那一条
    expect(docToMarkdown(editor.state.doc, doc)).toBe(
      "## **源**\n\n## [**链**](https://example.com/1)\n\n## **尾**\n",
    );
    editor.destroy();
  });

  it("先摘后加：目标原有的斜体被换成源的加粗，选区外的字不动", () => {
    const doc = 篇(块("**源**"), 块("*斜体* 保留"));
    const editor = createTestEditor(doc);
    const 源 = 找(editor, "源");
    选中(editor, 源, 源 + 1);
    开格式刷(editor);

    const 斜位 = 找(editor, "斜体");
    选中(editor, 斜位, 斜位 + 2);
    应用格式刷(editor);

    expect(editor.state.doc.rangeHasMark(斜位, 斜位 + 2, 斜(editor))).toBe(false);
    expect(editor.state.doc.rangeHasMark(斜位, 斜位 + 2, 粗(editor))).toBe(true);
    expect(editor.state.doc.rangeHasMark(斜位 + 2, 斜位 + 4, 粗(editor))).toBe(false);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("**源**\n\n**斜体** 保留\n");
    editor.destroy();
  });

  it("目标本来就是同一种格式：不发文档事务，单次档收起", () => {
    const editor = createTestEditor(篇(块("**源**"), 块("**目标**")));
    const 源 = 找(editor, "源");
    选中(editor, 源, 源 + 1);
    开格式刷(editor);

    const 事: Transaction[] = [];
    editor.on("transaction", ({ transaction }) => 事.push(transaction));
    const 目标 = 找(editor, "目标");
    选中(editor, 目标, 目标 + 2);
    const 果 = 应用格式刷(editor);
    expect(果.刷了).toBe(false);
    expect(事.every((tr) => !tr.docChanged)).toBe(true);
    expect(格式刷状态of(editor.state)).toBeNull();
    editor.destroy();
  });

  it("代码 / 引用这类整块不刷，但要说出来；单次档收起", () => {
    const editor = createTestEditor(
      篇(块("**源**"), 块("const a = 1;", { kind: "code", raw: "```\nconst a = 1;\n```\n" })),
    );
    const 源 = 找(editor, "源");
    选中(editor, 源, 源 + 1);
    开格式刷(editor);

    const 提示: string[] = [];
    const 收 = (e: Event) => 提示.push((e as CustomEvent<string>).detail);
    editor.view.dom.addEventListener("md-notice", 收);

    const 位 = 找(editor, "const");
    选中(editor, 位, 位 + 5);
    const 果 = 应用格式刷(editor);
    expect(果.刷了).toBe(false);
    expect(果.跳过).toBe(1);
    expect(提示).toHaveLength(1);
    expect(格式刷状态of(editor.state)).toBeNull();
    editor.view.dom.removeEventListener("md-notice", 收);
    editor.destroy();
  });

  it("目标在表格里：格内文字照样刷行内格式，且不报“整块没动”", () => {
    const 表 = ["| 列A | 列B |", "| --- | --- |", "| 甲 | 乙 |"].join("\n");
    const doc = 篇(块("**源**"), 块("", { kind: "table", raw: 表 + "\n" }));
    const editor = createTestEditor(doc);
    const 源 = 找(editor, "源");
    选中(editor, 源, 源 + 1);
    开格式刷(editor);

    const 提示: string[] = [];
    const 收 = (e: Event) => 提示.push((e as CustomEvent<string>).detail);
    editor.view.dom.addEventListener("md-notice", 收);

    const 甲 = 找(editor, "甲");
    选中(editor, 甲, 甲 + 1);
    const 果 = 应用格式刷(editor);
    expect(果.刷了).toBe(true);
    // 块类型不转是结构使然，格内文字确实刷了——报成“跳过”会让用户以为没刷上
    expect(果.跳过).toBe(0);
    expect(提示).toHaveLength(0);
    expect(editor.state.doc.rangeHasMark(甲, 甲 + 1, 粗(editor))).toBe(true);
    // 表格照 GFM 重新拼，但没有把整张表洗成段落
    expect(docToMarkdown(editor.state.doc, doc)).toContain("| **甲** | 乙 |");
    editor.view.dom.removeEventListener("md-notice", 收);
    editor.destroy();
  });

  it("表格矩形选区：框到的每一格都刷行内格式，一笔事务", () => {
    const 表 = ["| A | B |", "| --- | --- |", "| 甲 | 乙 |"].join("\n");
    const doc = 篇(块("**源**"), 块("", { kind: "table", raw: 表 + "\n" }));
    const editor = createTestEditor(doc);
    const 源 = 找(editor, "源");
    选中(editor, 源, 源 + 1);
    开格式刷(editor);

    进格(editor, 2);
    editor.view.dispatch(改选区(editor.state, 表格起点(editor), { r0: 1, c0: 0, r1: 1, c1: 1 }));
    const 果 = 应用格式刷(editor);
    expect(果.刷了).toBe(true);
    const 甲 = 找(editor, "甲");
    const 乙 = 找(editor, "乙");
    expect(editor.state.doc.rangeHasMark(甲, 甲 + 1, 粗(editor))).toBe(true);
    expect(editor.state.doc.rangeHasMark(乙, 乙 + 1, 粗(editor))).toBe(true);
    expect(docToMarkdown(editor.state.doc, doc)).toContain("| **甲** | **乙** |");
    editor.destroy();
  });

  it("字色与高亮连同 attrs 一起抄", () => {
    const doc = 篇(块("源"), 块("目标"));
    const editor = createTestEditor(doc);
    const 源位 = 找(editor, "源");
    const 标 = editor.state.schema.marks;
    editor.view.dispatch(
      editor.state.tr
        .addMark(源位, 源位 + 1, 标.textColor!.create({ color: 调色板[0]!.hex }))
        .addMark(源位, 源位 + 1, 标.highlight!.create()),
    );
    选中(editor, 源位, 源位 + 1);
    开格式刷(editor);

    const 目标 = 找(editor, "目标");
    选中(editor, 目标, 目标 + 2);
    应用格式刷(editor);
    expect(
      editor.state.doc.rangeHasMark(目标, 目标 + 1, 标.textColor!.create({ color: 调色板[0]!.hex })),
    ).toBe(true);
    expect(editor.state.doc.rangeHasMark(目标, 目标 + 1, 标.highlight!.create())).toBe(true);
    editor.destroy();
  });

  it("目标选回源自己 / 光标没选区：什么都不发，刷子也不收", () => {
    const editor = createTestEditor(篇(块("**源**"), 块("目标")));
    const 源 = 找(editor, "源");
    选中(editor, 源, 源 + 1);
    开格式刷(editor);

    选中(editor, 源, 源 + 1);
    expect(应用格式刷(editor).刷了).toBe(false);
    expect(格式刷状态of(editor.state)).not.toBeNull();

    选中(editor, 源 + 1, 源 + 1);
    expect(应用格式刷(editor).刷了).toBe(false);
    expect(格式刷状态of(editor.state)).not.toBeNull();
    editor.destroy();
  });
});

describe("开关与手势", () => {
  it("开格式刷只发一条 meta 事务：文档没变、不进撤销栈", () => {
    const doc = 篇(块("**源**"), 块("目标"));
    const editor = createTestEditor(doc);
    const 源 = 找(editor, "源");
    选中(editor, 源, 源 + 1);

    const 事: Transaction[] = [];
    editor.on("transaction", ({ transaction }) => 事.push(transaction));
    expect(开格式刷(editor)).toBe(true);
    expect(事).toHaveLength(1);
    expect(事[0]!.docChanged).toBe(false);
    expect(事[0]!.getMeta("addToHistory")).toBe(false);
    expect(docToMarkdown(editor.state.doc, doc)).toBe(reassemble(doc));
    expect(editor.view.dom.hasAttribute("data-md-paint")).toBe(true);
    editor.destroy();
  });

  it("拖选结束时才刷：mouseup 之后目标才带上格式，单次档随即收起", async () => {
    const editor = createTestEditor(篇(块("**源**"), 块("目标")));
    const 源 = 找(editor, "源");
    选中(editor, 源, 源 + 1);
    开格式刷(editor);

    const 目标 = 找(editor, "目标");
    选中(editor, 目标, 目标 + 2);
    // 选中的那一刻还不许动文档：否则拖到一半就刷了前半截
    expect(editor.state.doc.rangeHasMark(目标, 目标 + 2, 粗(editor))).toBe(false);

    editor.view.dom.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await Promise.resolve();
    expect(editor.state.doc.rangeHasMark(目标, 目标 + 2, 粗(editor))).toBe(true);
    expect(格式刷状态of(editor.state)).toBeNull();
    editor.destroy();
  });

  it("在正文外面松手也算手势结束：托到边缘外再松不会白框一场", async () => {
    const editor = createTestEditor(篇(块("**源**"), 块("目标")));
    const 源 = 找(editor, "源");
    选中(editor, 源, 源 + 1);
    开格式刷(editor);

    const 目标 = 找(editor, "目标");
    选中(editor, 目标, 目标 + 2);
    document.body.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
    await Promise.resolve();
    expect(editor.state.doc.rangeHasMark(目标, 目标 + 2, 粗(editor))).toBe(true);
    editor.destroy();
  });

  it("右键松手不刷，也不吃掉单次档", async () => {
    const editor = createTestEditor(篇(块("**源**"), 块("目标")));
    const 源 = 找(editor, "源");
    选中(editor, 源, 源 + 1);
    开格式刷(editor);

    const 目标 = 找(editor, "目标");
    选中(editor, 目标, 目标 + 2);
    editor.view.dom.dispatchEvent(new MouseEvent("mouseup", { button: 2, bubbles: true }));
    await Promise.resolve();
    expect(editor.state.doc.rangeHasMark(目标, 目标 + 2, 粗(editor))).toBe(false);
    expect(格式刷状态of(editor.state)).not.toBeNull();
    editor.destroy();
  });

  it("键盘连按方向键：松开方向键不落笔，松开 Shift 才刷", async () => {
    const editor = createTestEditor(篇(块("**源**"), 块("目标")));
    const 源 = 找(editor, "源");
    选中(editor, 源, 源 + 1);
    开格式刷(editor);

    const 目标 = 找(editor, "目标");
    选中(editor, 目标, 目标 + 1);
    editor.view.dom.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
    await Promise.resolve();
    expect(editor.state.doc.rangeHasMark(目标, 目标 + 1, 粗(editor))).toBe(false);

    选中(editor, 目标, 目标 + 2);
    editor.view.dom.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
    await Promise.resolve();
    expect(editor.state.doc.rangeHasMark(目标, 目标 + 2, 粗(editor))).toBe(true);
    expect(格式刷状态of(editor.state)).toBeNull();
    editor.destroy();
  });

  it("双击那一档刷完还在，Esc 才收起", () => {
    const editor = createTestEditor(篇(块("**源**"), 块("一"), 块("二")));
    const 源 = 找(editor, "源");
    选中(editor, 源, 源 + 1);
    expect(开格式刷(editor, true)).toBe(true);

    const 一 = 找(editor, "一");
    选中(editor, 一, 一 + 1);
    应用格式刷(editor);
    expect(editor.state.doc.rangeHasMark(一, 一 + 1, 粗(editor))).toBe(true);
    expect(格式刷状态of(editor.state)?.锁定).toBe(true);

    const 二 = 找(editor, "二");
    选中(editor, 二, 二 + 1);
    应用格式刷(editor);
    expect(editor.state.doc.rangeHasMark(二, 二 + 1, 粗(editor))).toBe(true);

    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(格式刷状态of(editor.state)).toBeNull();
    editor.destroy();
  });

  it("焦点停在工具栏上时 Esc 也能收起：不靠编辑器自己的键盘处理", () => {
    const editor = createTestEditor(篇(块("**源**"), 块("目标")));
    const 源 = 找(editor, "源");
    选中(editor, 源, 源 + 1);
    开格式刷(editor);

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(格式刷状态of(editor.state)).toBeNull();
    editor.destroy();
  });

  it("关格式刷也只是一条 meta 事务", () => {
    const doc = 篇(块("**源**"), 块("目标"));
    const editor = createTestEditor(doc);
    const 源 = 找(editor, "源");
    选中(editor, 源, 源 + 1);
    开格式刷(editor);
    const 事: Transaction[] = [];
    editor.on("transaction", ({ transaction }) => 事.push(transaction));
    关格式刷(editor);
    expect(事).toHaveLength(1);
    expect(事[0]!.docChanged).toBe(false);
    expect(格式刷状态of(editor.state)).toBeNull();
    expect(docToMarkdown(editor.state.doc, doc)).toBe(reassemble(doc));
    editor.destroy();
  });
});
