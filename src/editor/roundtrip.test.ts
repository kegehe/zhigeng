import { readFileSync } from "node:fs";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestEditor } from "./testEditor";
import { 分派岛上鼠标 } from "./schema";
import { parseTable } from "./table";
import {
  addColumn,
  applyBlockType,
  cellAt,
  docToMarkdown,
  enterCell,
  insertSourceBlock,
  判粘贴,
  INSERTABLE,
  moveCell,
  replaceBlockWithSource,
  moveBlock,
  moveCurrentBlock,
  pasteGrid,
  reassemble,
  removeColumn,
  removeRow,
  setAlign,
  type BlockTypeId,
  type EditDoc,
} from "./blocks";

/**
 * 字节级往返：编辑器的产出必须等于源文件。
 *
 * 这是行内编辑能不能接上用户文件的唯一门槛。上一轮的失败不是崩溃而是**静默吃掉内容**
 * （658 字节样本存成 410 字节：块 ID 全丢、`##` 降级、嵌套列表拍平、引用/代码/表格整块
 * 消失），所以这里断言的是字节，不是"看起来差不多"。
 *
 * 夹具由 `note edit-doc <file>` 从 Rust 侧导出，与索引走同一个 `md_kernel::parse`；
 * `crates/note-core/tests/service.rs` 里有测试钉住这些夹具不会与解析器脱节。
 */

const SAMPLES = [
  "01-基础",
  "02-列表",
  "03-代码表格与公式",
  "04-引用与标注",
  "05-未识别语法",
  "06-插入骨架", // 工具栏插入的三种结构块，内核必须按字节认回来
] as const;

function load(name: string) {
  const src = readFileSync(`testdata/roundtrip/${name}.md`, "utf8");
  const doc = JSON.parse(
    readFileSync(`testdata/editdoc/${name}.json`, "utf8")
  ) as EditDoc;
  return { src, doc };
}

describe("块编辑器字节级往返", () => {
  for (const name of SAMPLES) {
    const { src, doc } = load(name);

    it(`${name}：Rust 侧的拼装等于源文件`, () => {
      // 契约本身的前提：front-matter + Σ(gap + raw) + 尾部空白
      expect(reassemble(doc)).toBe(src);
    });

    it(`${name}：进编辑器什么都不改，产出等于源文件`, () => {
      const editor = createTestEditor(doc);
      expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
      editor.destroy();
    });

    it(`${name}：改一处再改回去，产出仍然等于源文件`, () => {
      const editor = createTestEditor(doc);
      const { state } = editor;
      // 找第一个带文字的块，在块**内**插一个字符再删掉：内容回到原样，签名也必须回到原样
      let target = -1;
      state.doc.forEach((node, pos) => {
        if (target < 0 && node.textContent.length > 0) target = pos + node.nodeSize - 1;
      });
      expect(target).toBeGreaterThan(0);
      // 直接走 ProseMirror 事务：这就是"敲一个字"在最底层的形状，不借第三方命令封装
      editor.view.dispatch(editor.state.tr.insertText("X", target));
      editor.view.dispatch(editor.state.tr.delete(target, target + 1));
      expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
      editor.destroy();
    });

    it(`${name}：同一篇连算两次产出，第二次不许变样`, () => {
      // 钉住 sigOf 就地删键那个坑：账本属性一旦被抹掉，第二个块就成了"新块"、
      // 整篇重新序列化——上一轮的 `##` 降级、锚点消失就是这么来的。
      const editor = createTestEditor(doc);
      const once = docToMarkdown(editor.state.doc, doc);
      const twice = docToMarkdown(editor.state.doc, doc);
      expect(twice).toBe(once);
      editor.destroy();
    });
  }

  it("空笔记一个字都没碰，保存也不能多出换行", () => {
    const empty: EditDoc = { frontMatter: "", trailingGap: "", blocks: [] };
    const editor = createTestEditor(empty);
    // docToJson 会补一个空段落（ProseMirror 的 doc 至少一个子节点），它不能被当成"新块"写进文件
    expect(docToMarkdown(editor.state.doc, empty)).toBe("");
    editor.destroy();
  });

  it("3000 块的长文档同样逐字节等于源文件", () => {
    // 真机栽过：小样本全绿，3000 块的文档装载后只剩一半（装载路径在大文档上被截断）。
    // 门槛必须在验收 ⑥ 的量级上跑，否则"绿"是骗人的。
    const blocks = Array.from({ length: 3000 }, (_, i) => ({
      kind: i % 20 === 0 ? "heading" : i % 9 === 0 ? "bullet" : "paragraph",
      id: i % 500 === 0 ? `b-long${i}` : null,
      raw:
        (i % 20 === 0 ? "## 小节 " : i % 9 === 0 ? "- 列表项 " : "第 ") +
        i +
        " 段：讲一个足够长的句子来占位，里面有一个 [链接](https://example.com/" +
        i +
        ") 和一点 **强调**。" +
        (i % 500 === 0 ? ` ^b-long${i}` : "") +
        "\n",
      gapBefore: i === 0 ? "\n" : "",
      content:
        (i % 20 === 0 ? "小节 " : i % 9 === 0 ? "列表项 " : "第 ") +
        i +
        " 段：讲一个足够长的句子来占位，里面有一个 [链接](https://example.com/" +
        i +
        ") 和一点 **强调**。",
      level: i % 20 === 0 ? 2 : null,
      checked: null,
      fields: [],
      children: [],
    }));
    const big: EditDoc = { frontMatter: "", trailingGap: "", blocks };
    const src = reassemble(big);
    expect(src.split("\n").filter(Boolean).length).toBe(3000);
    const editor = createTestEditor(big);
    expect(editor.state.doc.childCount).toBe(3000);
    expect(docToMarkdown(editor.state.doc, big)).toBe(src);
    editor.destroy();
  }, 20_000); // 这条量级测试在满载的机器上会跑到秒级（同一份改动实测 0.8–3.2 秒），
  // 默认 5 秒超时会把"机器忙"报成"门禁红"。它慢是真慢，但慢不是坏。

  it("改一个有序项的文字，序号仍按源文件里写的那个数落盘", () => {
    // 序号不是结构化字段，只活在 raw 的前缀里。显示与落盘必须由同一个函数算，
    // 否则改一个字就把 `3.` 落回 `1.`，而屏幕上还写着 3
    const { doc } = load("02-列表");
    const editor = createTestEditor(doc);
    const editNumbered = (needle: string) => {
      let pos = -1;
      editor.state.doc.forEach((node, offset) => {
        if (pos < 0 && node.attrs.mdKind === "numbered" && node.textContent.includes(needle))
          pos = offset;
      });
      expect(pos).toBeGreaterThanOrEqual(0);
      const node = editor.state.doc.nodeAt(pos)!;
      editor.view.dispatch(editor.state.tr.insertText("。", pos + node.nodeSize - 1));
      return docToMarkdown(editor.state.doc, doc);
    };
    const md = editNumbered("第三项");
    expect(md).toContain("3. 第三项");
    expect(md).not.toContain("1. 第三项");
    // 记号本身也不能改：内核把 `1)` 与 `1.` 都认（`Kind::Ordered { marker }` 原样写回），
    // 编辑器把两种都写成 `.` 就是与内核分叉——同一篇经 UI 与经 CLI 落出不同的字节
    const paren = editNumbered("记号不该被写成点");
    expect(paren).toContain("2) 编辑这一项时记号不该被写成点。");
    expect(paren).not.toContain("2. 编辑这一项");
    editor.destroy();
  });

  it("勾选待办必须落到文件里（块的语义属性不算编辑器账本）", () => {
    const { doc, src: original } = load("02-列表");
    const editor = createTestEditor(doc);
    let pos = -1;
    editor.state.doc.forEach((node, offset) => {
      if (pos < 0 && node.attrs.mdKind === "todo" && node.attrs.mdChecked !== true) pos = offset;
    });
    expect(pos).toBeGreaterThanOrEqual(0);
    const node = editor.state.doc.nodeAt(pos)!;
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, mdChecked: true })
    );
    const md = docToMarkdown(editor.state.doc, doc);
    expect(md).not.toBe(original);
    expect(md).toContain("- [x] 把打扰预算定成可配项 due:: 2026-09-30 ^b-q5r8u2x9oa");
    editor.destroy();
  });
});

/** 一份手工搭的块树：段落 + 一个紧密列表 + 带锚点的段落，够测类型切换与重排 */
const 样本 = () => {
  const b = (
    kind: string,
    raw: string,
    gapBefore: string,
    content: string,
    extra: Partial<{ id: string | null; level: number | null; checked: boolean | null }> = {},
  ) => ({
    kind,
    id: null,
    raw,
    gapBefore,
    content,
    level: null,
    checked: null,
    fields: [],
    children: [],
    ...extra,
  });
  const blocks: EditDoc["blocks"] = [
    b("paragraph", "正文一段。\n", "", "正文一段。"),
    b("heading", "## 一个二级标题 ^b-h2\n", "\n", "一个二级标题", { id: "b-h2", level: 2 }),
    b("quote", "> 引用的话\n", "\n", "引用的话"),
  ];
  const doc: EditDoc = { frontMatter: "", trailingGap: "", blocks };
  return { doc, src: reassemble(doc) };
};

/** 按谓词找一个顶层块的位置（顶层块的 offset 就是绝对位置） */
function 位置(editor: ReturnType<typeof createTestEditor>, 找: (n: { textContent: string }) => boolean) {
  let pos = -1;
  editor.state.doc.forEach((node, offset) => {
    if (pos < 0 && 找(node)) pos = offset;
  });
  expect(pos).toBeGreaterThanOrEqual(0);
  return pos;
}

/** 同一个谓词改成块序号（`moveBlock` 按序号说话） */
function 序号(editor: ReturnType<typeof createTestEditor>, 找: (n: { textContent: string }) => boolean) {
  let hit = -1;
  let i = 0;
  editor.state.doc.forEach((node) => {
    if (hit < 0 && 找(node)) hit = i;
    i++;
  });
  expect(hit).toBeGreaterThanOrEqual(0);
  return hit;
}

/**
 * 块类型切换：`#` 输入规则、`/` 斜杠菜单、顶部常驻工具栏**共用 `applyBlockType`**，
 * 所以这里绿一次，三处入口都绿一次。分叉过一次教训：显示用一套、落盘用另一套，
 * 用户看到的就是"改了没生效"或者"改一个字洗掉一片格式"。
 */
describe("块类型切换的产出仍是字节级正确的 Markdown", () => {
  it("段落 → 标题 3：加前缀，其余块一个字节不动", () => {
    const { doc, src } = 样本();
    const editor = createTestEditor(doc);
    const pos = 位置(editor, (n) => n.textContent === "正文一段。");
    editor.view.dispatch(applyBlockType(editor.state, pos, "heading3")!);
    const out = docToMarkdown(editor.state.doc, doc);
    expect(out.startsWith("### 正文一段。\n")).toBe(true);
    // 第一块的 gap 不能被重算成 "\n"——那会在文件开头凭空多一个空行
    expect(out).toBe(src.replace("正文一段。", "### 正文一段。"));
    editor.destroy();
  });

  it("标题 → 正文：前缀摘掉，块锚点仍然在原位", () => {
    const { doc } = 样本();
    const editor = createTestEditor(doc);
    const pos = 位置(editor, (n) => n.textContent === "一个二级标题");
    editor.view.dispatch(applyBlockType(editor.state, pos, "paragraph")!);
    const out = docToMarkdown(editor.state.doc, doc);
    expect(out).toContain("一个二级标题 ^b-h2\n");
    expect(out).not.toContain("## 一个二级标题");
    editor.destroy();
  });

  it("段落 → 无序 → 待办 → 正文，绕一圈回来必须等于源文件", () => {
    const { doc, src } = 样本();
    const editor = createTestEditor(doc);
    const pos = 位置(editor, (n) => n.textContent === "正文一段。");
    for (const id of ["bullet", "todo", "paragraph"] as BlockTypeId[]) {
      const tr = applyBlockType(editor.state, pos, id);
      if (tr) editor.view.dispatch(tr);
    }
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    editor.destroy();
  });

  it("目标就是当前类型时不给事务：点了同一项不该产生一次落盘", () => {
    const { doc } = 样本();
    const editor = createTestEditor(doc);
    const pos = 位置(editor, (n) => n.textContent === "正文一段。");
    expect(applyBlockType(editor.state, pos, "paragraph")).toBeNull();
    const h = 位置(editor, (n) => n.textContent === "一个二级标题");
    expect(applyBlockType(editor.state, h, "heading2")).toBeNull();
    editor.destroy();
  });

  it("不透明块拒绝切换：引用 / 表格 / 代码不会被洗成段落", () => {
    const { doc, src } = 样本();
    const editor = createTestEditor(doc);
    // 不透明块的节点内容就是它自己的源文本（`> 引用的话`），不是剥了前缀的正文
    const pos = 位置(editor, (n) => n.textContent.includes("引用的话"));
    for (const id of ["heading2", "bullet", "paragraph"] as BlockTypeId[]) {
      expect(applyBlockType(editor.state, pos, id)).toBeNull();
    }
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    editor.destroy();
  });

  it("改中间一块的文字，不该动它前后的空行", () => {
    const { doc, src } = 样本();
    const editor = createTestEditor(doc);
    const pos = 位置(editor, (n) => n.textContent === "一个二级标题");
    const node = editor.state.doc.nodeAt(pos)!;
    // 块内末尾插一个字：这是"改内容"，不是"换块"，gap 必须原样保留
    editor.view.dispatch(editor.state.tr.insertText("啊", pos + node.nodeSize - 1));
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src.replace("二级标题", "二级标题啊"));
    editor.destroy();
  });
});

/**
 * 拖拽重排。这里测的不是"能不能拖动"，而是**换位之后文件还是不是一篇合法的
 * Markdown**：块间空白编码的就是"谁跟在谁后面"，段落挪到列表项后面却不补空行，
 * Markdown 会把它读成那个列表项的续行——内容一个字节没丢，语义丢了。
 */
describe("拖拽重排：空白按 Markdown 的规矩重算，锚点跟着自己的块走", () => {
  const 重排样本 = () => {
    const blocks: EditDoc["blocks"] = [
      { kind: "paragraph", id: "b-p1", raw: "第一段 ^b-p1\n", gapBefore: "", content: "第一段", level: null, checked: null, fields: [], children: [] },
      { kind: "bullet", id: null, raw: "- 项甲\n", gapBefore: "\n", content: "项甲", level: null, checked: null, fields: [], children: [] },
      { kind: "bullet", id: null, raw: "- 项乙\n", gapBefore: "", content: "项乙", level: null, checked: null, fields: [], children: [] },
      { kind: "paragraph", id: "b-p4", raw: "第四段 ^b-p4\n", gapBefore: "\n", content: "第四段", level: null, checked: null, fields: [], children: [] },
    ];
    const doc: EditDoc = { frontMatter: "", trailingGap: "", blocks };
    return { doc, src: reassemble(doc) };
  };

  it("把开头的段落拖到列表后面：它前面必须补出一个空行", () => {
    const { doc } = 重排样本();
    const editor = createTestEditor(doc);
    const from = 序号(editor, (n) => n.textContent === "第一段");
    editor.view.dispatch(moveBlock(editor.state, from, 4)!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe(
      "- 项甲\n- 项乙\n\n第四段 ^b-p4\n\n第一段 ^b-p1\n",
    );
    editor.destroy();
  });

  it("拖到文档最前面的那块，不该把空行带到文件开头", () => {
    const { doc } = 重排样本();
    const editor = createTestEditor(doc);
    const from = 序号(editor, (n) => n.textContent === "第四段");
    editor.view.dispatch(moveBlock(editor.state, from, 0)!);
    const out = docToMarkdown(editor.state.doc, doc);
    expect(out.startsWith("第四段 ^b-p4\n")).toBe(true);
    expect(out).toBe("第四段 ^b-p4\n\n第一段 ^b-p1\n\n- 项甲\n- 项乙\n");
    editor.destroy();
  });

  it("交换两个带锚点的块：锚点跟着自己那块走，链接指向不会漂", () => {
    const { doc } = 重排样本();
    const editor = createTestEditor(doc);
    const from = 序号(editor, (n) => n.textContent === "第一段");
    editor.view.dispatch(moveBlock(editor.state, from, 4)!);
    const out = docToMarkdown(editor.state.doc, doc);
    // `^b-p1` 仍然贴在"第一段"那一行、`^b-p4` 仍然贴在"第四段"那一行
    expect(out).toContain("第一段 ^b-p1\n");
    expect(out).toContain("第四段 ^b-p4\n");
    expect(out.indexOf("第四段")).toBeLessThan(out.indexOf("第一段"));
    editor.destroy();
  });

  it("原地不动不给事务：拖回自己原来的位置不该产生一次落盘", () => {
    const { doc } = 重排样本();
    const editor = createTestEditor(doc);
    const from = 序号(editor, (n) => n.textContent === "项甲");
    expect(moveBlock(editor.state, from, from)).toBeNull();
    expect(moveBlock(editor.state, from, from + 1)).toBeNull();
    editor.destroy();
  });

  it("重排不改任何块的正文：逐行集合与原来完全相等", () => {    const { doc, src } = 重排样本();
    const editor = createTestEditor(doc);
    const from = 序号(editor, (n) => n.textContent === "第一段");
    editor.view.dispatch(moveBlock(editor.state, from, 4)!);
    const 内容行 = (s: string) => s.split("\n").filter((l) => l.trim()).sort();
    expect(内容行(docToMarkdown(editor.state.doc, doc))).toEqual(内容行(src));
    editor.destroy();
  });
});

/**
 * 键盘通路。测的是**按键本身有没有绑上**——直接调命令测不到这件事，
 * 而手柄 `⋮` 是鼠标 affordance，没有键盘等价形式就是"能看不能做"。
 */
describe("块操作的键盘快捷键", () => {
  const 键盘样本 = () => {
    const b = (raw: string, gapBefore: string, content: string, id: string | null = null) => ({
      kind: "paragraph",
      id,
      raw,
      gapBefore,
      content,
      level: null,
      checked: null,
      fields: [],
      children: [],
    });
    const blocks: EditDoc["blocks"] = [
      b("第一段 ^b-p1\n", "", "第一段", "b-p1"),
      b("第二段 ^b-p2\n", "\n", "第二段", "b-p2"),
      b("第三段 ^b-p3\n", "\n", "第三段", "b-p3"),
    ];
    const doc: EditDoc = { frontMatter: "", trailingGap: "", blocks };
    return { doc, src: reassemble(doc) };
  };

  /** 走真实分发：快捷键挂在 ProseMirror 的 handleKeyDown 上 */
  const KEY_CODES: Record<string, number> = { ArrowDown: 40, ArrowUp: 38 };
  beforeAll(() => {
    // jsdom 没实现 `getClientRects`。快捷键**没接住**的那个键会落到 ProseMirror 自己的
    // 上下键选区逻辑，那里要量几何 ⇒ 直接抛 `TypeError`。补一个空实现，让这条测试测的
    // 是"这个键没被绑上"，而不是 jsdom 的洞。
    const 零矩形 = () => Object.assign([], { item: () => null });
    const 零盒 = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 });
    for (const proto of [Range.prototype, Element.prototype] as unknown as Array<Record<string, unknown>>) {
      if (typeof proto.getClientRects !== "function") proto.getClientRects = 零矩形;
      if (typeof proto.getBoundingClientRect !== "function") proto.getBoundingClientRect = 零盒;
    }
  });
  const 按键 = (
    editor: ReturnType<typeof createTestEditor>,
    key: string,
    修饰: { alt?: boolean; ctrl?: boolean; shift?: boolean } = {},
  ) => {
    const ev = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      altKey: !!修饰.alt,
      ctrlKey: !!修饰.ctrl,
      shiftKey: !!修饰.shift,
    });
    // `KeyboardEvent` 构造器不收 `keyCode`（已废弃），但按键解析要看它——真实浏览器里
    // 这两个字段都有值。不补就等于在测一个真机上不存在的按键形状。
    const code = key.length === 1 ? key.toUpperCase().charCodeAt(0) : KEY_CODES[key] ?? 0;
    Object.defineProperty(ev, "keyCode", { value: code });
    Object.defineProperty(ev, "which", { value: code });
    editor.view.dom.dispatchEvent(ev);
    return ev.defaultPrevented;
  };

  const 光标在 = (editor: ReturnType<typeof createTestEditor>) =>
    editor.state.selection.$from.parent.textContent;

  it("Alt+↓ 把当前块下移，**光标跟着块走**（连按两次移的还是同一块）", () => {
    const { doc } = 键盘样本();
    const editor = createTestEditor(doc);
    // 光标放进第一块
    editor.commands.setTextSelection(2);
    expect(按键(editor, "ArrowDown", { alt: true })).toBe(true);
    expect(光标在(editor)).toBe("第一段");
    expect(按键(editor, "ArrowDown", { alt: true })).toBe(true);
    expect(光标在(editor)).toBe("第一段");
    expect(docToMarkdown(editor.state.doc, doc)).toBe("第二段 ^b-p2\n\n第三段 ^b-p3\n\n第一段 ^b-p1\n");
    editor.destroy();
  });

  it("Alt+↑ 到顶之后不再动（不给空事务，也就不产生一次落盘）", () => {
    const { doc, src } = 键盘样本();
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(2); // 已经在第一块，上面就是边界
    expect(按键(editor, "ArrowUp", { alt: true })).toBe(false);
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    editor.destroy();
  });

  it("Ctrl+Alt+2 变二级标题、Ctrl+Shift+8 变列表项，落盘就是那两个前缀", () => {
    const { doc } = 键盘样本();
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(2);
    expect(按键(editor, "2", { ctrl: true, alt: true })).toBe(true);
    expect(docToMarkdown(editor.state.doc, doc).startsWith("## 第一段 ^b-p1\n")).toBe(true);
    expect(按键(editor, "8", { ctrl: true, shift: true })).toBe(true);
    expect(docToMarkdown(editor.state.doc, doc).startsWith("- 第一段 ^b-p1\n")).toBe(true);
    editor.destroy();
  });

  it("标题 4–6 也有键：下拉里能选到的类型，键盘不许漏", () => {
    const { doc } = 键盘样本();
    const 前缀: Record<string, string> = { "4": "#### ", "5": "##### ", "6": "###### " };
    for (const 键 of ["4", "5", "6"]) {
      const editor = createTestEditor(doc);
      editor.commands.setTextSelection(2);
      expect(按键(editor, 键, { ctrl: true, alt: true }), 键).toBe(true);
      expect(docToMarkdown(editor.state.doc, doc).startsWith(前缀[键] + "第一段 ^b-p1\n"), 键).toBe(true);
      editor.destroy();
    }
  });

  it("Ctrl+Alt+0 回到正文：绕一圈仍然等于源文件", () => {
    const { doc, src } = 键盘样本();
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(2);
    按键(editor, "2", { ctrl: true, alt: true });
    按键(editor, "8", { ctrl: true, shift: true });
    expect(按键(editor, "0", { ctrl: true, alt: true })).toBe(true);
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    editor.destroy();
  });

  it("Ctrl+Z / Ctrl+Y 真的绑上了：撤销回到源文件，重做再变回去", () => {
    const { doc, src } = 键盘样本();
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(2);
    editor.view.dispatch(editor.state.tr.insertText("啊"));
    expect(docToMarkdown(editor.state.doc, doc)).not.toBe(src);
    // 只有工具栏那个 ↶ 不算数：contenteditable 里不接管 Ctrl+Z，浏览器会去撤销它自己的
    // DOM 输入记录，文档与历史栈就此分叉
    expect(按键(editor, "z", { ctrl: true })).toBe(true);
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    expect(按键(editor, "y", { ctrl: true })).toBe(true);
    expect(docToMarkdown(editor.state.doc, doc)).not.toBe(src);
    editor.destroy();
  });
});

/**
 * 工具栏独有的两件事：上下移按钮、插入分隔线。它们与快捷键共用同一个函数，
 * 所以这里测的是那个函数的性质（选区跟不跟着走、空白补没补对），不是按钮样式。
 */
describe("工具栏的移动与分隔线", () => {
  const 三块 = () => {
    const b = (raw: string, gapBefore: string, content: string) => ({
      kind: "paragraph",
      id: null,
      raw,
      gapBefore,
      content,
      level: null,
      checked: null,
      fields: [],
      children: [],
    });
    const blocks: EditDoc["blocks"] = [b("甲\n", "", "甲"), b("乙\n", "\n", "乙"), b("丙\n", "\n", "丙")];
    const doc: EditDoc = { frontMatter: "", trailingGap: "", blocks };
    return { doc, src: reassemble(doc) };
  };

  it("moveCurrentBlock 下移一格，并把选区放回那一块（按钮与快捷键都靠它）", () => {
    const { doc } = 三块();
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(2); // 光标在"甲"里
    const tr = moveCurrentBlock(editor.state, 1);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("乙\n\n甲\n\n丙\n");
    // 选区必须还在"甲"那一块：否则连点两次按钮移的就不是同一块
    expect(editor.state.selection.$from.parent.textContent).toBe("甲");
    editor.destroy();
  });

  it("已经在最上面时不给事务：按钮点了不该吞事件也不该白标一次脏", () => {
    const { doc, src } = 三块();
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(2);
    expect(moveCurrentBlock(editor.state, -1)).toBeNull();
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    editor.destroy();
  });

  it("插入结构块：产出的源文本必须与内核认得的骨架一字不差", () => {
    const { doc } = 三块();
    const 骨架 = (kind: string) => INSERTABLE.find((b) => b.kind === kind)!.源文本;
    const 期望: Record<string, string> = {
      divider: "甲\n\n---\n\n乙\n\n丙\n",
      quote: "甲\n\n> \n\n乙\n\n丙\n",
      table: "甲\n\n| 列 | 列 |\n| --- | --- |\n|  |  |\n\n乙\n\n丙\n",
    };
    for (const kind of ["divider", "quote", "table"]) {
      const editor = createTestEditor(doc);
      editor.commands.setTextSelection(2); // 光标在"甲"
      const tr = insertSourceBlock(editor.state, kind, 骨架(kind));
      expect(tr, kind).not.toBeNull();
      editor.view.dispatch(tr!);
      // 三种都要自带一个空行：紧贴上一行的 `---` 会被读成 setext 标题下划线，
      // 表格与引用的首行同理会并进上一段
      expect(docToMarkdown(editor.state.doc, doc), kind).toBe(期望[kind]);
      editor.destroy();
    }
  });

  it("斜杠菜单选结构块是整块替换：不留下那个 /，也不留空段落", () => {
    const blocks: EditDoc["blocks"] = [
      { kind: "paragraph", id: null, raw: "/\n", gapBefore: "", content: "/", level: null, checked: null, fields: [], children: [] },
      { kind: "paragraph", id: null, raw: "乙\n", gapBefore: "\n", content: "乙", level: null, checked: null, fields: [], children: [] },
    ];
    const doc: EditDoc = { frontMatter: "", trailingGap: "", blocks };
    const editor = createTestEditor(doc);
    const tr = replaceBlockWithSource(
      editor.state,
      0,
      "table",
      INSERTABLE.find((b) => b.kind === "table")!.源文本,
    );
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe(
      "| 列 | 列 |\n| --- | --- |\n|  |  |\n\n乙\n",
    );
    editor.destroy();
  });

  it("标题给到 1–6 级：内核收 6 级，前端不许自己砍到 3", () => {
    const { doc } = 三块();
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(2);
    const 前缀: Record<string, string> = { heading4: "#### ", heading5: "##### ", heading6: "###### " };
    for (const id of ["heading4", "heading5", "heading6"] as BlockTypeId[]) {
      const tr = applyBlockType(editor.state, 0, id);
      expect(tr, id).not.toBeNull();
      editor.view.dispatch(tr!);
      expect(docToMarkdown(editor.state.doc, doc).startsWith(前缀[id] + "甲\n"), id).toBe(true);
    }
    editor.destroy();
  });

  it("带 frontmatter 的文档把某块挪到最前面：那个空行还得在", () => {
    const b = (raw: string, gapBefore: string, content: string) => ({
      kind: "paragraph",
      id: null,
      raw,
      gapBefore,
      content,
      level: null,
      checked: null,
      fields: [],
      children: [],
    });
    const blocks: EditDoc["blocks"] = [b("甲\n", "\n", "甲"), b("乙\n", "\n", "乙")];
    const doc: EditDoc = { frontMatter: "---\nid: n-x\n---\n", trailingGap: "", blocks };
    const editor = createTestEditor(doc);
    const tr = moveBlock(editor.state, 1, 0);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    // 写死 "" 会产出 `---\n乙\n`：frontmatter 与正文粘连，内核下一轮读不回 frontmatter
    expect(docToMarkdown(editor.state.doc, doc)).toBe("---\nid: n-x\n---\n\n乙\n\n甲\n");
    editor.destroy();
  });
});

/**
 * 不透明块（引用 / 代码 / 表格 / 公式）的可编辑性。
 *
 * 这条测试是补出来的窟窿：`serializeNode` 一度写的是 `node.text ?? ""`，而 ProseMirror
 * 的**块节点没有 `.text` 字段**（那是 `TextNode` 才有的），于是 `?? ""` 永远兜到空串——
 * 用户编辑一次代码块，那一整块就存成空。文档里"改动后按用户输入的文本原样落盘"那句
 * 当时是假的，而它看起来无害，因为**只有改过的那一块**会空，其余字节全对。
 */
describe("编辑不透明块不许把整块写成空", () => {
  it("在引用块末尾加一个字：那块内容仍在，未动的代码块逐字节不变", () => {
    const blocks: EditDoc["blocks"] = [
      { kind: "quote", id: null, raw: "> 引用的话\n", gapBefore: "", content: "引用的话", level: null, checked: null, fields: [], children: [] },
      { kind: "code", id: null, raw: "```\nlet a = 1\n```\n", gapBefore: "\n", content: "", level: null, checked: null, fields: [], children: [] },
    ];
    const doc: EditDoc = { frontMatter: "", trailingGap: "", blocks };
    const editor = createTestEditor(doc);
    let pos = -1;
    editor.state.doc.forEach((n, off) => {
      if (pos < 0 && n.type.name === "mdOpaque") pos = off + n.nodeSize - 1;
    });
    expect(pos).toBeGreaterThan(0);
    editor.view.dispatch(editor.state.tr.insertText("啊", pos));
    const out = docToMarkdown(editor.state.doc, doc);
    expect(out).toContain("引用的话啊");
    expect(out).toContain("```\nlet a = 1\n```");
    editor.destroy();
  });
});

/**
 * 回车拆段。
 *
 * ProseMirror 拆块时把 attrs 复制给两半，于是新块带着原块的**账本**（`mdRaw` /
 * `mdGap` / `mdId` / `mdSig` / `mdKind`）。四条后果全部有证据（前两条真机、后两条
 * 由这组测试钉住）：新块沿用原块的 gap → 没有 front-matter 的文件里第一块的 gap 是
 * `""`，拆出来的两块之间没有空行，重新解析并回一段（"回车等于没按"）；锚点落在文档序
 * 靠前那一半 → 段首回车时 ` ^b-xxx` 挂到新产生的空块上，正文那块反而没了 ID，反向
 * 链接指向空；`mdKind` 与实际节点类型不一致 → 拆列表项会把两行粘回一个列表项；
 * 空块还多挤出一个空行。守卫是 `schema.ts` 的 `LedgerGuard`。
 */
describe("回车拆段不许把原块的账本留给新块", () => {
  const 段 = (raw: string, gapBefore: string, content: string, id: string | null = null) => ({
    kind: "paragraph",
    id,
    raw,
    gapBefore,
    content,
    level: null,
    checked: null,
    fields: [],
    children: [],
  });
  const 装 = (blocks: EditDoc["blocks"], frontMatter = "") => {
    const doc: EditDoc = { frontMatter, trailingGap: "", blocks };
    return { doc, src: reassemble(doc) };
  };
  const 按Enter = (editor: ReturnType<typeof createTestEditor>) => {
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    // jsdom 的 KeyboardEvent 不收 keyCode，但 PM 认键要看它——不补就是在测一个真机上不存在的按键形状
    Object.defineProperty(ev, "keyCode", { value: 13 });
    Object.defineProperty(ev, "which", { value: 13 });
    editor.view.dom.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  /** 第 `i` 块的开头（0）或末尾（-1） */
  const 块端 = (editor: ReturnType<typeof createTestEditor>, i: number, 端: 0 | -1) => {
    let 目标 = -1;
    let 计 = 0;
    editor.state.doc.forEach((n, off) => {
      if (计++ === i) 目标 = 端 === 0 ? off + 1 : off + n.nodeSize - 1;
    });
    editor.commands.setTextSelection(目标);
  };

  it("第一段末尾回车并打字：新段落自己占一行，不并回上一段", () => {
    const { doc } = 装([段("甲\n", "", "甲"), 段("乙\n", "\n", "乙")]);
    const editor = createTestEditor(doc);
    块端(editor, 0, -1);
    expect(按Enter(editor)).toBe(true);
    editor.view.dispatch(editor.state.tr.insertText("新"));
    // 守卫没生效时这里会是 "甲\n新\n\n乙\n"：新块继承了 gap `""`，内核把两行读成同一段
    expect(docToMarkdown(editor.state.doc, doc)).toBe("甲\n\n新\n\n乙\n");
    editor.destroy();
  });

  it("段首回车：锚点跟着正文那一半，空的那半不落任何字节", () => {
    const { doc, src } = 装([段("甲段 ^b-p1\n", "", "甲段", "b-p1"), 段("乙\n", "\n", "乙")]);
    const editor = createTestEditor(doc);
    块端(editor, 0, 0);
    expect(按Enter(editor)).toBe(true);
    const 出 = docToMarkdown(editor.state.doc, doc);
    // 守卫没生效时：` ^b-p1` 独占一行挂在**空块**上，正文那块反而没了 ID——指向它的
    // 反向链接从此指向空。空块本身在 Markdown 里不存在，所以整篇应当等于源文件。
    expect(出).toContain("甲段 ^b-p1\n");
    expect(出).not.toMatch(/^\s*\^b-p1\s*$/m);
    expect(出).toBe(src);
    editor.destroy();
  });

  it("拆列表项：新块不许顶着上一项的 kind，否则两行粘回一个列表项", () => {
    const blocks: EditDoc["blocks"] = [
      { ...段("- 项甲\n", "", "项甲"), kind: "bullet" },
      { ...段("乙\n", "\n", "乙"), kind: "paragraph" },
    ];
    const { doc } = 装(blocks);
    const editor = createTestEditor(doc);
    块端(editor, 0, -1);
    expect(按Enter(editor)).toBe(true);
    editor.view.dispatch(editor.state.tr.insertText("项乙"));
    // PM 拆 mdItem 产出的是 mdParagraph，而复制来的 mdKind 还写着 bullet。序列化器照
    // mdKind 判断"是不是同一个列表的延续"，于是 gap 给成 ""——`- 项甲\n项乙\n` 会被
    // 内核读成**一个**列表项。守卫把 kind 与实际节点类型对齐，两块之间才有那行空行。
    // （"回车在列表项里应该续一个项"是另一回事，见 docs/05 的未决条目）
    expect(docToMarkdown(editor.state.doc, doc)).toBe("- 项甲\n\n项乙\n\n乙\n");
    editor.destroy();
  });

  it("回车之后什么都不打：文件一个字节都不许多", () => {
    const { doc, src } = 装([段("甲\n", "", "甲"), 段("乙\n", "\n", "乙")]);
    const editor = createTestEditor(doc);
    块端(editor, 0, -1);
    expect(按Enter(editor)).toBe(true);
    // Markdown 里没有"空段落"这个东西。落一个空行进去，用户按一次回车文件就长一行
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    editor.destroy();
  });

  it("载入时相邻两块的源切片本来就相同：不算拆块产物，一个字都不许动", () => {
    const { doc, src } = 装([段("甲\n", "", "甲"), 段("甲\n", "\n\n", "甲")]);
    const editor = createTestEditor(doc);
    // 作者留了两个空行。整树替换（载入 / 打签名）里出现的相同源切片是文件本来的样子，
    // 照"拆块产物"去清账本，就会把这两个空行改没——那是另一种改用户内容
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    editor.destroy();
  });
});

/**
 * 档 2 的回归线：显示形可以画错，但不许碰到字节。
 *
 * `render.ts` 的产物只往 DOM 里放，`docToMarkdown` 读的是 `mdRaw` 与节点正文。这组测试
 * 钉的就是这条边界——**它红了比渲染画歪了严重得多**：前者是改用户文件，后者只是难看。
 */

/** 顶层不透明块的位置（按文档序）。显示形只挂在这一层 */
function 不透明块(editor: Editor): { pos: number; kind: string }[] {
  const 位: { pos: number; kind: string }[] = [];
  editor.state.doc.forEach((n, off) => {
    if (n.type.name === "mdOpaque") 位.push({ pos: off, kind: String(n.attrs.mdKind ?? "raw") });
  });
  return 位;
}

const 面孔 = (editor: Editor, pos: number) =>
  editor.view.nodeDOM(pos) as HTMLElement | null;

/** 光标进块 = 编辑器有焦点 + 选区落在那一块。缺了焦点就不该翻成源码形（见下面那条测试） */
const 放进 = (editor: Editor, pos: number) => {
  editor.view.focus();
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos + 1))),
  );
};

const 放到文末 = (editor: Editor) =>
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)),
  );

describe("显示形切换不许碰到字节", () => {
  for (const name of SAMPLES) {
    const { src, doc } = load(name);

    it(`${name}：光标逐个进出不透明块，产出仍等于源文件`, () => {
      const editor = createTestEditor(doc);
      const 装载后的文档 = editor.state.doc;
      const 块 = 不透明块(editor);
      expect(块.length, name).toBeGreaterThan(0);
      for (const b of 块) {
        放进(editor, b.pos);
        放到文末(editor);
      }
      // 只写 DOM 属性、不发事务：doc 还是同一个对象，说明整趟焦点移动没经过事务通道
      expect(editor.state.doc).toBe(装载后的文档);
      expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
      editor.destroy();
    });
  }

  // 表格现在被网格节点接管了（见下面的表格用例），所以这一组"两副面孔"的测试改用代码块：
  // 代码块仍然是不透明块，两副面孔的机制在它身上和引用/公式完全一样
  it("光标进来退回源文本，交出口变回显示形", () => {
    const { doc } = load("03-代码表格与公式");
    const editor = createTestEditor(doc);
    const 码 = 不透明块(editor).find((b) => b.kind === "code")!;
    expect(码).toBeTruthy();

    expect(面孔(editor, 码.pos)!.dataset["mdMode"]).toBeUndefined();
    expect(面孔(editor, 码.pos)!.querySelector(".codeblock")).not.toBeNull();
    expect(面孔(editor, 码.pos)!.querySelector(".md-src")).not.toBeNull();

    放进(editor, 码.pos);
    expect(面孔(editor, 码.pos)!.dataset["mdMode"]).toBe("source");
    放到文末(editor);
    expect(面孔(editor, 码.pos)!.dataset["mdMode"]).toBeUndefined();
    editor.destroy();
  });

  it("编辑器没焦点时不显示源码形", () => {
    // 打开一篇时 PM 的选区可能落在文末。那时候没有焦点、没有插入符，
    // 让最后一块顶着 ``` 围栏示人只会让人以为渲染坏了（真机就是这个样子）
    const { doc } = load("03-代码表格与公式");
    const editor = createTestEditor(doc);
    const 码 = 不透明块(editor).find((b) => b.kind === "code")!;
    放进(editor, 码.pos);
    expect(面孔(editor, 码.pos)!.dataset["mdMode"]).toBe("source");
    editor.view.dom.blur(); // 真 blur：PM 的 hasFocus() 问的是 activeElement，合成事件改不了它
    expect(面孔(editor, 码.pos)!.dataset["mdMode"]).toBeUndefined();
    editor.destroy();
  });

  it("改了代码块的源文本，交出口之后显示形跟着变", () => {
    // 重画发生在"交出焦点"那一刻，不在击键路径上。这条钉住两件事：
    // 该重画的时候真的重画了，且它读的是节点正文而不是载入时那份旧字节
    const { doc } = load("03-代码表格与公式");
    const editor = createTestEditor(doc);
    const 码 = 不透明块(editor).find((b) => b.kind === "code")!;
    放进(editor, 码.pos);
    const 块 = editor.state.doc.nodeAt(码.pos)!;
    // 插在开栏那一行之后：动围栏会让这块不再是合法代码块，那就测不到"重画"了
    const 正文起 = 码.pos + 1 + 块.textContent.indexOf("\n") + 1;
    editor.view.dispatch(editor.state.tr.insertText("改", 正文起));
    放到文末(editor);
    expect(面孔(editor, 码.pos)!.querySelector(".codeblock code")!.textContent).toContain("改");
    editor.destroy();
  });

  it("显示形在 contentDOM 之外：PM 的解析与剪贴板都读不到它", () => {
    const { doc } = load("04-引用与标注");
    const editor = createTestEditor(doc);
    const 引 = 不透明块(editor)[0]!;
    const 壳 = 面孔(editor, 引.pos)!;
    const 宿主 = 壳.querySelector<HTMLElement>(".md-view")!;
    const 源 = 壳.querySelector(".md-src")!;
    expect(宿主.contentEditable).toBe("false");
    expect(源.contains(宿主)).toBe(false);
    // 宿主排在源文本前面：PM 按"点击元素在 contentDOM 之前"把落点判给块首
    expect(壳.compareDocumentPosition(源) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    editor.destroy();
  });

  it("点显示形要真的把光标放进来", () => {
    // 真机抓的：Chromium 不会把插入符放进 `contenteditable=false` 的岛里，点了什么也不发生。
    // 所以这一下必须由 NodeView 自己发选区——不接管的话"点一下改源码"整条路是死的。
    const { doc } = load("03-代码表格与公式");
    const editor = createTestEditor(doc);
    const 码 = 不透明块(editor).find((b) => b.kind === "code")!;
    const 壳 = 面孔(editor, 码.pos)!;
    expect(壳.dataset["mdMode"]).toBeUndefined();
    壳
      .querySelector(".md-view")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(editor.state.selection.$from.parent.type.name).toBe("mdOpaque");
    expect(editor.state.selection.from).toBe(码.pos + 1);
    expect(面孔(editor, 码.pos)!.dataset["mdMode"]).toBe("source");
    editor.destroy();
  });

  it("岛上的事件只有『左键无修饰键的 mousedown』归我们", () => {
    // 从前 stopEvent 对宿主子树里的每个事件都 return true，等于把右键菜单、双击选词、
    // shift-点击扩选区一起吞掉——PM 收不到，浏览器也不再把默认行为当"已被处理"。
    const 派 = (init: MouseEventInit & { type?: string }) =>
      分派岛上鼠标(new MouseEvent(init.type ?? "mousedown", init));
    expect(派({ button: 0 })).toBe("退源码");
    expect(派({ button: 0, shiftKey: true })).toBe("扩选");
    expect(派({ button: 2 })).toBe("交回");
    expect(派({ button: 1 })).toBe("交回");
    expect(派({ button: 0, ctrlKey: true })).toBe("交回");
    expect(派({ button: 0, metaKey: true })).toBe("交回");
    expect(派({ button: 0, altKey: true })).toBe("交回");
    expect(派({ button: 0, type: "mouseup" })).toBe("交回");
    expect(派({ button: 0, type: "dblclick" })).toBe("交回");
    expect(派({ button: 0, type: "contextmenu" })).toBe("交回");
  });

  it("右键菜单与 mouseup 落在显示形上：选区、面孔、字节都不许动", () => {
    // jsdom 里没有 `elementFromPoint`，交回 PM 的 `mousedown` 会在 PM 内部抛——那是环境的
    // 限制不是产品的问题（WebView2 有这个方法）。所以这里只喂不走坐标计算的事件类型，
    // "右键那一下该交回"由上面那条判据断言，效果在真机上验。
    const { doc, src } = load("03-代码表格与公式");
    const editor = createTestEditor(doc);
    const 码 = 不透明块(editor).find((b) => b.kind === "code")!;
    const 宿主 = 面孔(editor, 码.pos)!.querySelector(".md-view")!;
    const 选区前 = editor.state.selection.from;
    for (const 类 of ["contextmenu", "mouseup", "click"]) {
      宿主.dispatchEvent(new MouseEvent(类, { bubbles: true, button: 2 }));
      宿主.dispatchEvent(new MouseEvent(类, { bubbles: true, button: 0 }));
    }
    expect(editor.state.selection.from).toBe(选区前);
    expect(面孔(editor, 码.pos)!.dataset["mdMode"]).toBeUndefined();
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    editor.destroy();
  });

  it("点 Callout 标题只改折叠态，不动选区也不动文档", () => {
    const { doc, src } = load("04-引用与标注");
    const editor = createTestEditor(doc);
    const 折 = 不透明块(editor).find((b) => b.kind === "callout")!;
    const 壳 = 面孔(editor, 折.pos)!;
    const 头 = 壳.querySelector(".cal-head")!;
    const 选区前 = editor.state.selection.from;
    const 文档前 = editor.state.doc;
    头.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(壳.querySelector<HTMLElement>(".callout")!.dataset["folded"]).toBeTruthy();
    头.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(壳.querySelector<HTMLElement>(".callout")!.dataset["folded"]).toBeUndefined();
    expect(editor.state.doc).toBe(文档前);
    expect(editor.state.selection.from).toBe(选区前);
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    editor.destroy();
  });

  it("画不来的块不许被藏起来：明确降级，源文本继续在屏幕上", () => {
    const { doc, src } = load("05-未识别语法");
    const editor = createTestEditor(doc);
    const 块 = 不透明块(editor);
    expect(块.length).toBeGreaterThan(0);
    for (const b of 块) {
      const 壳 = 面孔(editor, b.pos)!;
      expect(壳.dataset["mdView"], b.kind).toBe("none");
      expect(壳.querySelector(".md-src")!.textContent!.trim(), b.kind).toBeTruthy();
    }
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    editor.destroy();
  });
});

/**
 * 表格网格化的字节判据。
 *
 * 表格是唯一"渲染出来还直接在原地改"的块，所以它也是这一档里唯一会**重写整块字节**的
 * 编辑路径：动一个格子，`serializeNode` 就要把整张表按规范形重拼一遍。这条路能不能上，
 * 全看下面这些断言——尤其是"没动的块一个字节都不许变"和"看不准的形状根本不接管"。
 */
const 段 = (raw: string, gapBefore: string, content: string) => ({
  kind: "paragraph",
  id: null,
  raw,
  gapBefore,
  content,
  level: null,
  checked: null,
  fields: [],
  children: [],
});

function 表doc(表源: string): EditDoc {
  return {
    frontMatter: "",
    trailingGap: "",
    blocks: [
      段("前一段\n", "", "前一段"),
      {
        kind: "table",
        id: null,
        raw: 表源,
        gapBefore: "\n",
        content: "",
        level: null,
        checked: null,
        fields: [],
        children: [],
      },
    ],
  };
}

/** 表格块的绝对起点 */
function 表起点(editor: Editor): number {
  let p = -1;
  editor.state.doc.forEach((n, off) => {
    if (n.type.name === "mdTable") p = off;
  });
  return p;
}

/** 表里第 n 个格子（文档序，0 起）的绝对起点 */
function 格起点(editor: Editor, n: number): number {
  const 表 = editor.state.doc.nodeAt(表起点(editor))!;
  let i = 0;
  let 找 = -1;
  表.forEach((r, ro) =>
    r.forEach((_c, co) => {
      if (i++ === n) 找 = 表起点(editor) + 1 + ro + 1 + co;
    }),
  );
  return 找;
}

/** 把光标放进第 n 个顶层块（有焦点，与真机一致） */
function 进块(editor: Editor, n: number): void {
  editor.view.focus();
  let 起 = -1;
  let i = 0;
  editor.state.doc.forEach((node, off) => {
    if (i++ === n) 起 = off;
  });
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(起 + 1))),
  );
}

/** 把光标放进第 n 个格子（有焦点，与真机一致） */
function 进格(editor: Editor, n: number): void {
  editor.view.focus();
  const 起 = 格起点(editor, n);
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(起 + 1))),
  );
}

const 规范表 = "| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |\n";

describe("表格网格化的字节判据", () => {
  it("接管了：03 与 06 的表变成 mdTable 节点，而产出仍逐字节等于源文件", () => {
    for (const 名 of ["03-代码表格与公式", "06-插入骨架"]) {
      const { src, doc } = load(名);
      const editor = createTestEditor(doc);
      expect(editor.state.doc.children.some((n) => n.type.name === "mdTable"), 名).toBe(true);
      expect(docToMarkdown(editor.state.doc, doc), 名).toBe(src);
      editor.destroy();
    }
  });

  it("没动过：逐字节等于源文件（含工具栏那张骨架的空格子）", () => {
    const d = 表doc(规范表);
    const editor = createTestEditor(d);
    expect(docToMarkdown(editor.state.doc, d)).toBe("前一段\n\n" + 规范表);
    editor.destroy();
  });

  it("改一个格子：只有那一格变，前后段与表头一字不动", () => {
    const d = 表doc(规范表);
    const editor = createTestEditor(d);
    进格(editor, 2); // 数据行第一格
    editor.view.dispatch(editor.state.tr.insertText("改", editor.state.selection.from));
    expect(docToMarkdown(editor.state.doc, d)).toBe(
      "前一段\n\n| 列 A | 列 B |\n| --- | --- |\n| 改1 | 2 |\n",
    );
    editor.destroy();
  });

  it("格子里打竖线要转义，产出的表不能因为一个 | 就裂成三列", () => {
    const d = 表doc(规范表);
    const editor = createTestEditor(d);
    进格(editor, 2);
    editor.view.dispatch(editor.state.tr.insertText("|", editor.state.selection.from));
    const 出 = docToMarkdown(editor.state.doc, d);
    expect(出).toBe("前一段\n\n| 列 A | 列 B |\n| --- | --- |\n| \\|1 | 2 |\n");
    // 产出的那份重新解析仍是两列——转义没做对的话这里会多出第三列
    const 重读 = parseTable(出.slice(出.indexOf("| 列")))!;
    expect(重读.rows[1]).toEqual(["|1", "2"]);
  });

  it("格子里混进换行要折成空格：产出的行数与列数都不许变", () => {
    const d = 表doc(规范表);
    const editor = createTestEditor(d);
    进格(editor, 2);
    editor.view.dispatch(editor.state.tr.insertText("甲\n乙", editor.state.selection.from));
    const 出 = docToMarkdown(editor.state.doc, d);
    // 换行漏进盘子这张表就从 3 行变 4 行，列数对不上——下一次打开它根本不是表了
    expect(出).toBe("前一段\n\n| 列 A | 列 B |\n| --- | --- |\n| 甲 乙1 | 2 |\n");
    expect(出.slice(出.indexOf("| 列"), 出.lastIndexOf("\n")).split("\n")).toHaveLength(3);
    const 重读 = parseTable(出.slice(出.indexOf("| 列")))!;
    expect(重读.rows.map((r) => r.length)).toEqual([2, 2]);
    editor.destroy();
  });

  it("末格按 Tab 加一行；Enter 在末行同样加一行", () => {
    const d = 表doc(规范表);
    const editor = createTestEditor(d);
    进格(editor, 3); // 最后一格
    expect(moveCell(editor.state, 1)).not.toBeNull();
    editor.view.dispatch(moveCell(editor.state, 1)!);
    expect(docToMarkdown(editor.state.doc, d)).toBe(
      "前一段\n\n| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |\n|  |  |\n",
    );
    // Enter 在末行也是加一行，而不是拆块（GFM 格子里装不下换行）
    const 二 = createTestEditor(d);
    进格(二, 3);
    const tr = enterCell(二.state);
    expect(tr).not.toBeNull();
    二.view.dispatch(tr!);
    expect(docToMarkdown(二.state.doc, d)).toBe(
      "前一段\n\n| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |\n|  |  |\n",
    );
    editor.destroy();
    二.destroy();
  });

  it("第一格 Shift+Tab 不动（不许跳出表格把光标甩到上一块）", () => {
    const d = 表doc(规范表);
    const editor = createTestEditor(d);
    进格(editor, 0);
    expect(moveCell(editor.state, -1)).toBeNull();
    expect(docToMarkdown(editor.state.doc, d)).toBe("前一段\n\n" + 规范表);
    editor.destroy();
  });

  it("加一列：每行多一格且分隔行跟着长，重新解析列数对得上", () => {
    const d = 表doc(规范表);
    const editor = createTestEditor(d);
    进格(editor, 0);
    const tr = addColumn(editor.state, 表起点(editor));
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    const 出 = docToMarkdown(editor.state.doc, d);
    expect(出).toBe("前一段\n\n| 列 A | 列 B |  |\n| --- | --- | --- |\n| 1 | 2 |  |\n");
    editor.destroy();
  });

  it("加完一列光标还在原来那一格（否则工具栏那两个按钮自己消失了）", () => {
    const d = 表doc(规范表);
    const editor = createTestEditor(d);
    进格(editor, 3); // 数据行第二格（2×2 的表里第 4 个格子，索引到 3 为止）
    const tr = addColumn(editor.state, 表起点(editor));
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(cellAt(editor.state)?.行).toBe(1);
    expect(cellAt(editor.state)?.列).toBe(1);
    editor.destroy();
  });

  it("对齐是数据：改一个格子之后 :--- 与 ---: 还在", () => {
    const d = 表doc("| A | B | C |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n");
    const editor = createTestEditor(d);
    进格(editor, 5); // 最后一格（右对齐那列）
    editor.view.dispatch(editor.state.tr.insertText("x", editor.state.selection.from));
    // 产出 = 前一段 + 空行 + 表头 + 分隔行 ⇒ 分隔行在第 4 行
    expect(docToMarkdown(editor.state.doc, d).split("\n")[3]).toBe("| :--- | :---: | ---: |");
    expect(docToMarkdown(editor.state.doc, d)).toContain("| x3 |");
    editor.destroy();
  });

  it("删一行：产出的表少一行，前后段一字不动，光标落进顶上来的那一行", () => {
    const d = 表doc("| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n");
    const editor = createTestEditor(d);
    进格(editor, 4); // 第一条数据行的中间那格
    const tr = removeRow(editor.state, 表起点(editor));
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(docToMarkdown(editor.state.doc, d)).toBe(
      "前一段\n\n| A | B | C |\n| --- | --- | --- |\n| 4 | 5 | 6 |\n",
    );
    expect(cellAt(editor.state)?.行).toBe(1);
    expect(cellAt(editor.state)?.列).toBe(1);
    editor.destroy();
  });

  it("删掉末行也钳得回来；表头与只剩表头都不给删", () => {
    const d = 表doc(规范表); // 表头 + 一条数据行
    const editor = createTestEditor(d);
    进格(editor, 0); // 表头
    expect(removeRow(editor.state, 表起点(editor))).toBeNull();
    expect(docToMarkdown(editor.state.doc, d)).toBe("前一段\n\n" + 规范表);
    进格(editor, 2); // 唯一的数据行
    editor.view.dispatch(removeRow(editor.state, 表起点(editor))!);
    // 表头 + 分隔行仍是合法 GFM，重新解析仍认它是表
    const 出 = docToMarkdown(editor.state.doc, d);
    expect(出).toBe("前一段\n\n| 列 A | 列 B |\n| --- | --- |\n");
    expect(parseTable(出.slice(出.indexOf("| 列")))!.rows).toEqual([["列 A", "列 B"]]);
    expect(removeRow(editor.state, 表起点(editor))).toBeNull();
    expect(docToMarkdown(editor.state.doc, d)).toBe(出);
    editor.destroy();
  });

  it("删一列：每行都少一格、分隔行同位次少一段，别的列的对齐跟着挪过来", () => {
    const d = 表doc("| A | B | C |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n");
    const editor = createTestEditor(d);
    进格(editor, 4); // 中间那一列（B / 居中）
    const tr = removeColumn(editor.state, 表起点(editor));
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    const 出 = docToMarkdown(editor.state.doc, d);
    expect(出).toBe("前一段\n\n| A | C |\n| :--- | ---: |\n| 1 | 3 |\n");
    expect(parseTable(出.slice(出.indexOf("| A")))!.aligns).toEqual(["left", "right"]);
    expect(cellAt(editor.state)?.列).toBe(1);
    editor.destroy();
  });

  it("最后一列不给删：空表不是表", () => {
    const d = 表doc("| A |\n| --- |\n| 1 |\n");
    const editor = createTestEditor(d);
    进格(editor, 1);
    expect(removeColumn(editor.state, 表起点(editor))).toBeNull();
    expect(docToMarkdown(editor.state.doc, d)).toBe("前一段\n\n| A |\n| --- |\n| 1 |\n");
    editor.destroy();
  });

  it("设对齐：分隔行与每格的样子一起变，只改一边就是「看得见却落不下去」", () => {
    const d = 表doc(规范表);
    const editor = createTestEditor(d);
    进格(editor, 1); // 第二列
    const tr = setAlign(editor.state, 表起点(editor), "center");
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    const 出 = docToMarkdown(editor.state.doc, d);
    expect(出).toBe("前一段\n\n| 列 A | 列 B |\n| --- | :---: |\n| 1 | 2 |\n");
    expect(parseTable(出.slice(出.indexOf("| 列")))!.aligns).toEqual(["", "center"]);
    const 格们 = [...editor.view.dom.querySelectorAll("[data-md-cell]")];
    expect(格们[1]?.getAttribute("data-align")).toBe("center");
    expect(格们[3]?.getAttribute("data-align")).toBe("center");
    expect(cellAt(editor.state)?.列).toBe(1);
    editor.destroy();
  });

  it("同一档连点两次不设第二遍：不发事务、不标脏、不重写字节", () => {
    const d = 表doc("| A | B |\n| --- | :---: |\n| 1 | 2 |\n");
    const editor = createTestEditor(d);
    进格(editor, 1);
    expect(setAlign(editor.state, 表起点(editor), "center")).toBeNull();
    expect(setAlign(editor.state, 表起点(editor), "left")).not.toBeNull();
    editor.destroy();
  });

  it("删列 / 设对齐都只重写动过的那张表：旁边那张一字未动", () => {
    const 异形 = "| A | B | C |\n|:-----|:---:|-----:|\n| 1 | 2 | 3 |\n";
    const d: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        段("前一段\n", "", "前一段"),
        { kind: "table", id: null, raw: 异形, gapBefore: "\n", content: "", level: null, checked: null, fields: [], children: [] },
        { kind: "table", id: null, raw: 异形, gapBefore: "\n", content: "", level: null, checked: null, fields: [], children: [] },
      ],
    };
    for (const 做 of [
      (e: Editor) => removeColumn(e.state, 表起点(e)),
      (e: Editor) => setAlign(e.state, 表起点(e), "left"),
      (e: Editor) => removeRow(e.state, 表起点(e)),
    ]) {
      const editor = createTestEditor(d);
      进格(editor, 4); // 第一张表的数据格
      const tr = 做(editor);
      expect(tr).not.toBeNull();
      editor.view.dispatch(tr!);
      const 出 = docToMarkdown(editor.state.doc, d);
      // 第二张表必须逐字节还是原样：分隔行仍带着 `|:-----|` 那种不规则写法
      expect(出.split(异形).length - 1).toBe(1);
      editor.destroy();
    }
  });

  it("粘贴 Markdown 表：空段落变成网格，产出的正是规范形那几个字节", () => {
    const d: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [段("前一段\n", "", "前一段"), 段("\n", "\n", "")],
    };
    const editor = createTestEditor(d);
    进块(editor, 1);
    const tr = pasteGrid(editor.state, "| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(docToMarkdown(editor.state.doc, d)).toBe(
      "前一段\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n",
    );
    // 粘完光标就在第一格里，用户下一件事是打字而不是再点一下
    expect(cellAt(editor.state)?.行).toBe(0);
    expect(cellAt(editor.state)?.列).toBe(0);
    editor.destroy();
  });

  it("粘贴电子表格的 TSV：落成同一套 GFM 字节，第一行按格式要求当表头", () => {
    const d: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [段("前一段\n", "", "前一段"), 段("\n", "\n", "")],
    };
    const editor = createTestEditor(d);
    进块(editor, 1);
    editor.view.dispatch(pasteGrid(editor.state, "指标\t目标\r\n打字\t16ms\r\n")!);
    const 出 = docToMarkdown(editor.state.doc, d);
    expect(出).toBe("前一段\n\n| 指标 | 目标 |\n| --- | --- |\n| 打字 | 16ms |\n");
    // 产出的那份重新解析仍是这张表（粘进来与库里存的走同一条判据）
    expect(parseTable(出.slice(出.indexOf("| 指标")))!.rows[1]).toEqual(["打字", "16ms"]);
    editor.destroy();
  });

  it("粘进去的格子里带竖线：重新产出必须再转义回去", () => {
    const d: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [段("前一段\n", "", "前一段"), 段("\n", "\n", "")],
    };
    const editor = createTestEditor(d);
    进块(editor, 1);
    editor.view.dispatch(
      pasteGrid(editor.state, "| A \\| B | C |\n| --- | --- |\n| 1 | 2 |\n")!,
    );
    const 出 = docToMarkdown(editor.state.doc, d);
    expect(出).toBe("前一段\n\n| A \\| B | C |\n| --- | --- |\n| 1 | 2 |\n");
    expect(parseTable(出.slice(出.indexOf("| A")))!.rows[0]).toEqual(["A | B", "C"]);
    editor.destroy();
  });

  it("不接的三种粘贴：写着字的段落、别人的格子、以及一段普通的话", () => {
    const 表文 = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    const d = 表doc(规范表);
    const editor = createTestEditor(d);
    // ① 光标在表格里：往格子里粘贴就是填那一格，不许在表里再套一张表
    进格(editor, 2);
    expect(pasteGrid(editor.state, 表文)).toBeNull();
    editor.destroy();

    // ② 段落里有字：粘贴是往那句话里插字，不是把整段换掉
    const 有字 = createTestEditor({
      frontMatter: "",
      trailingGap: "",
      blocks: [段("前一段\n", "", "前一段")],
    });
    进块(有字, 0);
    expect(pasteGrid(有字.state, 表文)).toBeNull();
    有字.destroy();

    // ③ 空段落里粘的内容本身不像表：CSV 与两句话都不接，字节一个不动
    const 空的源: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [段("前一段\n", "", "前一段"), 段("\n", "\n", "")],
    };
    const 空的 = createTestEditor(空的源);
    进块(空的, 1);
    expect(pasteGrid(空的.state, "甲,乙,丙\n1,2,3")).toBeNull();
    expect(pasteGrid(空的.state, "今天想把一件事记下来\n另一行接着说")).toBeNull();
    expect(docToMarkdown(空的.state.doc, 空的源)).toContain("前一段");
    空的.destroy();
  });

  it("格子里粘多行：判据要摊平，不许把这张表顶成两半（真机抓到的破坏）", () => {
    const d = 表doc(规范表);
    const editor = createTestEditor(d);
    进格(editor, 2);
    const 块数前 = editor.state.doc.childCount;
    // 多行 → 摊平；单行 → 交回（行内样式的默认粘贴不该被抢走）
    expect(判粘贴(editor.state, "甲\n乙")).toEqual({ 做: "摊平", 文: "甲 乙" });
    expect(判粘贴(editor.state, "单行")).toEqual({ 做: "交回" });
    expect(判粘贴(editor.state, "\n\n")).toEqual({ 做: "摊平", 文: "" });
    // 照着做：顶层块数不变＝表格没被顶开，落盘的仍是这一格里的字
    const 判 = 判粘贴(editor.state, "甲\n乙");
    expect(判.做).toBe("摊平");
    if (判.做 === "摊平" && 判.文) editor.view.dispatch(editor.state.tr.insertText(判.文));
    expect(editor.state.doc.childCount).toBe(块数前);
    expect(docToMarkdown(editor.state.doc, d)).toBe(
      "前一段\n\n| 列 A | 列 B |\n| --- | --- |\n| 甲 乙1 | 2 |\n",
    );
    // 整串都是换行：判据给"摊平"而文是空，动作什么也不发——文档对象还是同一个
    const 落字后 = editor.state.doc;
    const 空判 = 判粘贴(editor.state, "\n\n");
    expect(空判).toEqual({ 做: "摊平", 文: "" });
    if (空判.做 === "摊平" && 空判.文) editor.view.dispatch(editor.state.tr.insertText(空判.文));
    expect(editor.state.doc).toBe(落字后);
    editor.destroy();
  });

  it("两张相邻且源文本相同的表：改第一张不许重写第二张", () => {
    // 复查查出来的字节级缺陷。账本守卫的判据是"相邻两块 mdRaw 相同 ⇒ 拆块产物，清掉后一块"，
    // 它的前提是"重新序列化等于原字节"。表格是唯一不满足这个前提的块（产的是规范形），
    // 所以清完账本，用户没碰过的那张表会从 `|:-----|` 变成 `| :--- |`
    const 异形 = "| A | B |\n|:-----|-----:|\n| 1 | 2 |\n";
    const d: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        段("前一段\n", "", "前一段"),
        { kind: "table", id: null, raw: 异形, gapBefore: "\n", content: "", level: null, checked: null, fields: [], children: [] },
        { kind: "table", id: null, raw: 异形, gapBefore: "\n", content: "", level: null, checked: null, fields: [], children: [] },
      ],
    };
    const 源 = "前一段\n\n" + 异形 + "\n" + 异形;
    const editor = createTestEditor(d);
    expect(docToMarkdown(editor.state.doc, d)).toBe(源);
    进格(editor, 2); // 第一张表的数据格
    const 起点 = 表起点(editor);
    editor.view.dispatch(addColumn(editor.state, 起点)!);
    const 出 = docToMarkdown(editor.state.doc, d);
    // 第二张表必须逐字节还是那三份字节：它的分隔行仍是 `|:-----|-----:|`
    expect(出.split(异形).length - 1).toBe(1);
    expect(出).toContain("|:-----|-----:|");
    editor.destroy();
  });

  it("看不准的形状一律不接管：列数不齐 / 带块锚 / 有缩进都还是源文本块", () => {
    const 不接管 = [
      "| 甲 | 乙 |\n| --- |\n| 1 | 2 | 3 |\n",
      "| A | B |\n|---|---|\n| 1 | 2 |\n^b-f3g6j9l2mn\n",
      "| A | B |\n|---|---|\n| 1 | 2 | ^b-k3x9m2v7qa\n",
      "  | A | B |\n  |---|---|\n",
    ];
    for (const 源 of 不接管) {
      const d = 表doc(源);
      const editor = createTestEditor(d);
      expect(editor.state.doc.children.some((n) => n.type.name === "mdTable"), 源).toBe(false);
      // 不接管 ⇒ 原样回写，一个字节都不许多
      expect(docToMarkdown(editor.state.doc, d), 源).toBe("前一段\n\n" + 源);
      editor.destroy();
    }
  });

  it("接管过的表编辑之后不会凭空造出块锚：产出里没有 ^b-", () => {
    const d = 表doc(规范表);
    const editor = createTestEditor(d);
    进格(editor, 2);
    editor.view.dispatch(editor.state.tr.insertText("字", editor.state.selection.from));
    expect(docToMarkdown(editor.state.doc, d)).not.toContain("^b-");
    editor.destroy();
  });

  it("表格不给块类型切换：选了也不发事务（产不出把表变成段落的字节）", () => {
    const d = 表doc(规范表);
    const editor = createTestEditor(d);
    进格(editor, 0);
    const 前 = docToMarkdown(editor.state.doc, d);
    const tr = applyBlockType(editor.state, 表起点(editor), "paragraph");
    expect(tr).toBeNull();
    expect(docToMarkdown(editor.state.doc, d)).toBe(前);
    editor.destroy();
  });
});
