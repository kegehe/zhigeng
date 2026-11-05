import { readFileSync } from "node:fs";
import type { Editor } from "@tiptap/core";
import { DOMParser, DOMSerializer, Fragment, Slice, type Node as PmNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection, type EditorState } from "@tiptap/pm/state";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestEditor } from "./testEditor";
import { 新引用 } from "./asset";
import { 认得语言, 语言清单, 识别 } from "./highlight";
import { renderOpaque } from "./render";
import { 分派岛上鼠标 } from "./schema";
import { parseTable } from "./table";
import { 单格, 归一, type 矩形 } from "./tableSelect";
import { 改选区, 批量 } from "./tableSelectPlugin";
import {
  addColumn,
  applyBlockAlign,
  applyBlockType,
  cellAt,
  docToMarkdown,
  enterCell,
  共同列表,
  共同首行缩进,
  能设首行缩进,
  点在待办前缀,
  点待办前缀,
  切换待办勾选,
  设列表,
  设首行缩进,
  exitTableDown,
  exitOpaqueDown,
  insertSourceBlock,
  带围栏,
  块内范围,
  全选档,
  插图片块,
  图片下出口,
  判粘贴,
  格坐标At,
  INSERTABLE,
  moveCell,
  replaceBlockWithSource,
  moveBlock,
  moveBlockWithSelection,
  moveCurrentBlock,
  pasteGrid,
  reassemble,
  removeColumn,
  removeRow,
  共同对齐,
  有可对齐块,
  对所齐所选,
  填充所选,
  删块在,
  删当前块,
  删所选列,
  删所选行,
  清场所选,
  setAlign,
  type BlockTypeId,
  type EditBlock,
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
  "07-图片", // 图片引用：内核判成 image 的各种写法，接管与不接管各半
  "08-对齐", // 块级对齐：`<div align>` 包裹一块正文 / 标题（docs/02 D40）
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
      // 找**第一个文字节点**，在它末尾插一个字符再删掉：内容回到原样，签名也必须回到原样。
      // 不能按顶层块算：结构化引用的块尾是子节点边界，往那儿插会多出一个段落。
      let target = -1;
      state.doc.descendants((node, pos) => {
        if (target >= 0) return false;
        if (node.isText && node.textContent.length > 0) {
          target = pos + node.nodeSize - 1;
          return false;
        }
        return true;
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
      align: null,
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
    align: null,
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
    // 不透明块拒绝类型切换。引用的可编辑正文是剥了 `>` 的那段，不是源文本本身
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
      { kind: "paragraph", id: "b-p1", raw: "第一段 ^b-p1\n", gapBefore: "", content: "第一段", level: null, checked: null, align: null, fields: [], children: [] },
      { kind: "bullet", id: null, raw: "- 项甲\n", gapBefore: "\n", content: "项甲", level: null, checked: null, align: null, fields: [], children: [] },
      { kind: "bullet", id: null, raw: "- 项乙\n", gapBefore: "", content: "项乙", level: null, checked: null, align: null, fields: [], children: [] },
      { kind: "paragraph", id: "b-p4", raw: "第四段 ^b-p4\n", gapBefore: "\n", content: "第四段", level: null, checked: null, align: null, fields: [], children: [] },
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
      align: null,
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
      align: null,
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

  it("拖完光标跟着被拖的那一块：光标原来在别的块上，也要落到刚挪过的块开头", () => {
    const { doc } = 三块();
    const editor = createTestEditor(doc);
    // 光标停在「丙」，拖的是「甲」——手柄跟着鼠标，插入符经常不在被拖的块里
    const 丙尾 = editor.state.doc.content.size - 1;
    editor.commands.setTextSelection(丙尾);
    expect(editor.state.selection.$from.parent.textContent).toBe("丙");
    const tr = moveBlockWithSelection(editor.state, 0, 2);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("乙\n\n甲\n\n丙\n");
    expect(editor.state.selection.$from.parent.textContent).toBe("甲");
    expect(editor.state.selection.$from.parentOffset).toBe(0);
    editor.destroy();
  });

  it("拖引用块时不把光标放进源文本开头，下一击键不会插在 > 前面", () => {
    const blocks: EditDoc["blocks"] = [
      {
        kind: "quote",
        id: null,
        raw: "> 引用的话\n",
        gapBefore: "",
        content: "引用的话",
        level: null,
        checked: null,
        align: null,
        fields: [],
        children: [],
      },
      {
        kind: "paragraph",
        id: null,
        raw: "正文\n",
        gapBefore: "\n",
        content: "正文",
        level: null,
        checked: null,
        align: null,
        fields: [],
        children: [],
      },
    ];
    const doc: EditDoc = { frontMatter: "", trailingGap: "", blocks };
    const editor = createTestEditor(doc);
    let 正文里 = 0;
    editor.state.doc.forEach((n, off) => {
      if (n.textContent === "正文") 正文里 = off + 1;
    });
    editor.commands.setTextSelection(正文里);
    const tr = moveBlockWithSelection(editor.state, 0, 2);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    const 选 = editor.state.selection;
    expect(选 instanceof NodeSelection).toBe(true);
    expect((选 as NodeSelection).node.type.name).toBe("mdOpaque");
    expect((选 as NodeSelection).node.textContent).toBe("引用的话");
    editor.destroy();
  });

  it("整块选中的引用下移后仍是整块选中", () => {
    const blocks: EditDoc["blocks"] = [
      {
        kind: "paragraph",
        id: null,
        raw: "上面\n",
        gapBefore: "",
        content: "上面",
        level: null,
        checked: null,
        align: null,
        fields: [],
        children: [],
      },
      {
        kind: "quote",
        id: null,
        raw: "> 引用的话\n",
        gapBefore: "\n",
        content: "引用的话",
        level: null,
        checked: null,
        align: null,
        fields: [],
        children: [],
      },
    ];
    const doc: EditDoc = { frontMatter: "", trailingGap: "", blocks };
    const editor = createTestEditor(doc);
    const 位 = editor.state.doc.child(0).nodeSize;
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 位)));
    const tr = moveCurrentBlock(editor.state, -1);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    const 选 = editor.state.selection;
    expect(选 instanceof NodeSelection).toBe(true);
    expect((选 as NodeSelection).node.type.name).toBe("mdOpaque");
    expect(editor.state.doc.child(0).type.name).toBe("mdOpaque");
    editor.destroy();
  });

  it("拖的就是光标所在的块时，块内偏移留在原地", () => {
    const { doc } = 三块();
    const editor = createTestEditor(doc);
    let 甲尾 = 0;
    editor.state.doc.forEach((n, off) => {
      if (n.textContent === "甲") 甲尾 = off + n.nodeSize - 1;
    });
    editor.commands.setTextSelection(甲尾);
    const 偏移 = editor.state.selection.$from.parentOffset;
    expect(偏移).toBeGreaterThan(0);
    const tr = moveBlockWithSelection(editor.state, 0, 3);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("乙\n\n丙\n\n甲\n");
    expect(editor.state.selection.$from.parent.textContent).toBe("甲");
    expect(editor.state.selection.$from.parentOffset).toBe(偏移);
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
      code: "甲\n\n```\n\n```\n\n乙\n\n丙\n",
      table: "甲\n\n| 列 | 列 |\n| --- | --- |\n|  |  |\n\n乙\n\n丙\n",
    };
    for (const kind of ["divider", "quote", "code", "table"]) {
      const editor = createTestEditor(doc);
      editor.commands.setTextSelection(2); // 光标在"甲"
      const tr = insertSourceBlock(editor.state, kind, 骨架(kind));
      expect(tr, kind).not.toBeNull();
      editor.view.dispatch(tr!);
      // 四种都要自带一个空行：紧贴上一行的 `---` 会被读成 setext 标题下划线，
      // 表格、引用与围栏的首行同理会并进上一段
      expect(docToMarkdown(editor.state.doc, doc), kind).toBe(期望[kind]);
      editor.destroy();
    }
  });

  it("插入代码块：光标落在两道围栏之间，第一次打字打的是代码", () => {
    const { doc } = 三块();
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(2);
    const tr = insertSourceBlock(editor.state, "code", "```\n\n```");
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    // 落点在围栏外时，用户第一次打字会把 ` ``` ` 当正文改——产出一份"看着是代码块、
    // 其实围栏被打断"的东西，而这一步界面上完全看不出来
    editor.view.dispatch(editor.state.tr.insertText("let a = 1;"));
    expect(docToMarkdown(editor.state.doc, doc)).toBe(
      "甲\n\n```\nlet a = 1;\n```\n\n乙\n\n丙\n"
    );
    editor.destroy();
  });

  it("斜杠菜单选代码块也是整块替换：不留 /，光标在围栏里", () => {
    const doc: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        { kind: "paragraph", id: null, raw: "/\n", gapBefore: "", content: "/", level: null, checked: null, align: null, fields: [], children: [] },
        { kind: "paragraph", id: null, raw: "乙\n", gapBefore: "\n", content: "乙", level: null, checked: null, align: null, fields: [], children: [] },
      ],
    };
    const editor = createTestEditor(doc);
    const 骨架 = INSERTABLE.find((b) => b.kind === "code")!.源文本;
    const tr = replaceBlockWithSource(editor.state, 0, "code", 骨架);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    editor.view.dispatch(editor.state.tr.insertText("let a = 1;"));
    expect(docToMarkdown(editor.state.doc, doc)).toBe("```\nlet a = 1;\n```\n\n乙\n");
    editor.destroy();
  });

  it("插入的代码块自带落脚点，而落脚点不落盘：文末也能出去", () => {
    const { doc } = 三块();
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(2);
    editor.view.dispatch(insertSourceBlock(editor.state, "code", "```\n\n```")!);
    // 甲 | 代码块 | 空段落落脚点 | 乙 | 丙 —— 没有那个空段落时，文末的代码块只剩鼠标能出去
    expect([...editor.state.doc.children].map((n) => n.type.name).join(","))
      .toBe("mdParagraph,mdOpaque,mdParagraph,mdParagraph,mdParagraph");
    expect(docToMarkdown(editor.state.doc, doc)).toBe(
      "甲\n\n```\n\n```\n\n乙\n\n丙\n"
    );
    editor.destroy();
  });

  it("代码块最后一行按 ↓ 出去；不在最后一行时不出去（↓ 该在块内移动）", () => {
    const d: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        { kind: "code", id: null, raw: "```\nlet a = 1\nlet b = 2\n```\n", gapBefore: "", content: "", level: null, checked: null, align: null, fields: [], children: [] },
        { kind: "paragraph", id: null, raw: "后面一段\n", gapBefore: "\n", content: "后面一段", level: null, checked: null, align: null, fields: [], children: [] },
      ],
    };
    const editor = createTestEditor(d);
    const 块 = editor.state.doc.child(0);
    /**
     * 围栏进了账本、正文只剩两行代码——先钉住这件事本身：节点正文里读不到 ` ``` `。
     * "点进去看到的"与"退出来看到的"是同一份内容，这是本次修改的全部理由。
     */
    expect(块.textContent).toBe("let a = 1\nlet b = 2");
    expect(块.attrs.mdFenceOpen).toBe("```");
    expect(块.attrs.mdFenceClose).toBe("```");
    /**
     * 再逐位置判"在不在最后一行"。正文 19 个字符，顶层第一块从位置 1 起，所以
     * **绝对位置 = 1 + 行内偏移**。位置 10 是第一行行末（还没跨过那个换行），
     * 那里按 ↓ 必须在块内下移，不许跳出去。
     */
    for (const [位, 该出去] of [
      [3, false], // 第一行行中
      [10, false], // 第一行行末
      [11, true], // 第二行行首 = 最后一行
      [20, true], // 块末
    ] as [number, boolean][]) {
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(位)))
      );
      expect([位, exitOpaqueDown(editor.state) !== null]).toEqual([位, 该出去]);
    }
    // 在块末：出去，光标落到下一块
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.near(editor.state.doc.resolve(块.nodeSize - 1)),
      ),
    );
    const tr = exitOpaqueDown(editor.state);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(editor.state.selection.$from.depth).toBe(1);
    expect(editor.state.doc.child(editor.state.selection.$from.index(0)).type.name).toBe(
      "mdParagraph"
    );
    // 出去这一下不改文件一个字节
    expect(docToMarkdown(editor.state.doc, d)).toBe(
      "```\nlet a = 1\nlet b = 2\n```\n\n后面一段\n"
    );
    editor.destroy();
  });

  it("代码块是最后一块时按 ↓：补出落脚点放进去，文件仍不多一个字节", () => {
    const d: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        { kind: "code", id: null, raw: "```\ncode()\n```\n", gapBefore: "", content: "", level: null, checked: null, align: null, fields: [], children: [] },
      ],
    };
    const editor = createTestEditor(d);
    const 块 = editor.state.doc.child(0);
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.near(editor.state.doc.resolve(块.nodeSize - 1)),
      ),
    );
    const tr = exitOpaqueDown(editor.state);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(editor.state.doc.childCount).toBe(2);
    editor.view.dispatch(editor.state.tr.insertText("OUT"));
    // 这正是真机复现过的死局：没有出口时 "OUT" 落进了围栏里面
    expect(docToMarkdown(editor.state.doc, d)).toBe("```\ncode()\n```\n\nOUT\n");
    editor.destroy();
  });

  it("行首 ``` + 空格 → 代码块，与斜杠菜单产出同一份字节", () => {
    const doc: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        { kind: "paragraph", id: null, raw: "```\n", gapBefore: "", content: "```", level: null, checked: null, align: null, fields: [], children: [] },
        { kind: "paragraph", id: null, raw: "乙\n", gapBefore: "\n", content: "乙", level: null, checked: null, align: null, fields: [], children: [] },
      ],
    };
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(4); // 三个反引号之后
    const 接了 = editor.view.someProp("handleTextInput", (f) =>
      // 第 5 个参数是 CompositionTransaction（浏览器组合输入才给），测试里用不到，
      // 但签名要求它是个函数
      f(editor.view, 4, 4, " ", () => editor.state.tr)
    );
    expect(接了).toBe(true);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("```\n\n```\n\n乙\n");
    editor.view.dispatch(editor.state.tr.insertText("let a = 1;"));
    expect(docToMarkdown(editor.state.doc, doc)).toBe("```\nlet a = 1;\n```\n\n乙\n");
    editor.destroy();
  });

  it("斜杠菜单选结构块是整块替换：不留下那个 /，也不留空段落", () => {
    const blocks: EditDoc["blocks"] = [
      { kind: "paragraph", id: null, raw: "/\n", gapBefore: "", content: "/", level: null, checked: null, align: null, fields: [], children: [] },
      { kind: "paragraph", id: null, raw: "乙\n", gapBefore: "\n", content: "乙", level: null, checked: null, align: null, fields: [], children: [] },
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
      align: null,
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
      { kind: "quote", id: null, raw: "> 引用的话\n", gapBefore: "", content: "引用的话", level: null, checked: null, align: null, fields: [], children: [] },
      { kind: "code", id: null, raw: "```\nlet a = 1\n```\n", gapBefore: "\n", content: "", level: null, checked: null, align: null, fields: [], children: [] },
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
    expect(out).toContain("> 引用的话啊");
    expect(out).toContain("```\nlet a = 1\n```");
    editor.destroy();
  });
});

/**
 * 围栏账本（2026-09-30）。
 *
 * 代码块开进来编辑的是**代码本身**：开栏行与闭栏行存在 `mdFenceOpen` / `mdFenceClose`，
 * 节点正文只装围栏之间那段，保存时拼回去。这一组判的全是字节——差一个换行就是改用户的文件。
 */
describe("代码块的围栏账本：编辑代码不碰围栏", () => {
  const 码 = (raw: string, gap = ""): EditDoc["blocks"][number] => ({
    kind: "code",
    id: null,
    raw,
    gapBefore: gap,
    content: "",
    level: null,
    checked: null,
    align: null,
    fields: [],
    children: [],
  });
  const 一段 = (raw: string, gap = "\n"): EditDoc["blocks"][number] => ({
    kind: "paragraph",
    id: null,
    raw,
    gapBefore: gap,
    content: raw.replace(/\n+$/, ""),
    level: null,
    checked: null,
    align: null,
    fields: [],
    children: [],
  });
  const 文档 = (...blocks: EditDoc["blocks"]): EditDoc => ({
    frontMatter: "",
    trailingGap: "",
    blocks,
  });
  /** 代码块正文的起点（顶层第一块 → 位置 1） */
  const 正文起点 = (editor: ReturnType<typeof createTestEditor>) => {
    let 找 = -1;
    editor.state.doc.forEach((n, off) => {
      if (找 < 0 && n.type.name === "mdOpaque") 找 = off + 1;
    });
    return 找;
  };

  it("没编辑的块：各种围栏形状都逐字节回写原样", () => {
    for (const 形 of [
      "```\n甲\n```\n",
      "````\n内含 ``` 的一行\n````\n",
      "~~~\n波浪号\n~~~\n",
      "  ```py\n缩进两格\n  ```\n",
      "```rust // 注释\nfn main() {}\n```\n",
      "```\n```\n",
      "```\n\n```\n",
    ]) {
      const d = 文档(码(形), 一段("尾段\n"));
      const editor = createTestEditor(d);
      expect(docToMarkdown(editor.state.doc, d), 形).toBe(reassemble(d));
      editor.destroy();
    }
  });

  it("编辑正文：新代码配上原来的围栏，闭栏那行的写法一个字都不许变", () => {
    const d = 文档(码("````rust // 注释\nlet a = 1\n    ```\n````\n"), 一段("尾段\n"));
    const editor = createTestEditor(d);
    // 正文里本来就有一道三反引号——它不是闭栏，闭栏是最后那道四反引号的
    expect(editor.state.doc.child(0).textContent).toBe("let a = 1\n    ```");
    editor.view.dispatch(editor.state.tr.insertText("let b = 2\n", 正文起点(editor)));
    expect(docToMarkdown(editor.state.doc, d)).toBe(
      "````rust // 注释\nlet b = 2\nlet a = 1\n    ```\n````\n\n尾段\n"
    );
    editor.destroy();
  });

  it("没闭栏的围栏不接管：正文里带着围栏，编辑也不凭空造一道闭栏", () => {
    const d = 文档(码("```go\nfunc main() {\n"));
    const editor = createTestEditor(d);
    const 块 = editor.state.doc.child(0);
    expect(块.textContent).toBe("```go\nfunc main() {"); // 老形状：围栏就是正文
    expect(块.attrs.mdFenceOpen).toBe("");
    // 在正文末尾接着写：产出的还是"到文末都是代码"，不凭空多出闭栏
    const 尾 = 1 + 块.textContent.length;
    editor.view.dispatch(editor.state.tr.insertText("\n  let x = 1;", 尾));
    expect(docToMarkdown(editor.state.doc, d)).toBe("```go\nfunc main() {\n  let x = 1;\n");
    editor.destroy();
  });

  it("`零行` 与 `一个空行` 两种空代码块各自回写，打字之后都成正常块", () => {
    for (const [形, 打完字] of [
      ["```\n```\n", "```\nx\n```\n"],
      ["```\n\n```\n", "```\nx\n```\n"],
    ] as const) {
      const d = 文档(码(形));
      const editor = createTestEditor(d);
      expect(docToMarkdown(editor.state.doc, d), 形).toBe(形);
      editor.view.dispatch(editor.state.tr.insertText("x", 正文起点(editor)));
      expect(docToMarkdown(editor.state.doc, d), 形).toBe(打完字);
      editor.destroy();
    }
  });

  it("把正文删空：回到「围栏之间那一行」，不会少一行", () => {
    const d = 文档(码("```\nlet a = 1\n```\n"));
    const editor = createTestEditor(d);
    const 块 = editor.state.doc.child(0);
    editor.view.dispatch(
      editor.state.tr.delete(1, 1 + 块.textContent.length)
    );
    expect(editor.state.doc.child(0).textContent).toBe("");
    expect(docToMarkdown(editor.state.doc, d)).toBe("```\n\n```\n");
    editor.destroy();
  });

  it("显示形吃的是拼回围栏的那份（`带围栏`），不是节点正文", () => {
    const d = 文档(码("```js\nconst a = 1;\n```\n"));
    const editor = createTestEditor(d);
    const 块 = editor.state.doc.child(0);
    expect(块.textContent).toBe("const a = 1;");
    expect(带围栏(块)).toBe("```js\nconst a = 1;\n```");
    // 画出来的显示形里不该有围栏，也不该有 Markdown 星号之类的东西
    const 画 = renderOpaque("code", 带围栏(块), document);
    expect(画?.querySelector("code")?.textContent).toBe("const a = 1;");
    expect(画?.querySelector(".lang")?.textContent).toBe("js");
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
 * 链接指向空；`mdKind` 与实际节点类型不一致 → 拆列表项会把两行粘回一个列表项。
 * 列表项里的回车现在改由 `列表回车` 续下一项，守卫仍要挡住别的路径拆出来的错账本。
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
    align: null,
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

  it("列表项末尾回车：续一个同类型项，空项再按才退回正文", () => {
    const blocks: EditDoc["blocks"] = [
      { ...段("- 项甲\n", "", "项甲"), kind: "bullet" },
      { ...段("乙\n", "\n", "乙"), kind: "paragraph" },
    ];
    const { doc, src } = 装(blocks);
    const editor = createTestEditor(doc);
    块端(editor, 0, -1);
    expect(按Enter(editor)).toBe(true);
    editor.view.dispatch(editor.state.tr.insertText("项乙"));
    // 续出来的项和上一项之间没有空行，后面的正文仍隔开，不会被读进列表
    expect(docToMarkdown(editor.state.doc, doc)).toBe("- 项甲\n- 项乙\n\n乙\n");
    editor.destroy();

    const 再 = createTestEditor(doc);
    块端(再, 0, -1);
    expect(按Enter(再)).toBe(true);
    expect(docToMarkdown(再.state.doc, doc)).toBe("- 项甲\n- \n\n乙\n");
    expect(按Enter(再)).toBe(true);
    expect(再.state.selection.$from.parent.type.name).toBe("mdParagraph");
    expect(docToMarkdown(再.state.doc, doc)).toBe(src);
    再.destroy();
  });

  it("项首退格只摘掉记号，不把这一项并进上一块", () => {
    const blocks: EditDoc["blocks"] = [
      { ...段("- 甲\n", "", "甲"), kind: "bullet" },
      { ...段("- 乙\n", "", "乙"), kind: "bullet" },
    ];
    const { doc } = 装(blocks);
    const editor = createTestEditor(doc);
    块端(editor, 1, 0);
    const ev = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    Object.defineProperty(ev, "keyCode", { value: 8 });
    editor.view.dom.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("- 甲\n\n乙\n");
    editor.destroy();
  });

  it("末行不带换行的列表：回车续项另起一行，文件仍不以换行结尾", () => {
    const blocks: EditDoc["blocks"] = [{ ...段("- 甲", "", "甲"), kind: "bullet" }];
    const { doc } = 装(blocks);
    const editor = createTestEditor(doc);
    块端(editor, 0, -1);
    expect(按Enter(editor)).toBe(true);
    editor.view.dispatch(editor.state.tr.insertText("乙"));
    // 上一块原样回写、不补换行。新项若沿用紧排的空 gap，就会粘成 `- 甲- 乙`
    expect(docToMarkdown(editor.state.doc, doc)).toBe("- 甲\n- 乙");
    editor.destroy();

    const 有序 = 装([{ ...段("3. 甲", "", "甲"), kind: "numbered" }]);
    const 再 = createTestEditor(有序.doc);
    块端(再, 0, -1);
    expect(按Enter(再)).toBe(true);
    再.view.dispatch(再.state.tr.insertText("乙"));
    expect(docToMarkdown(再.state.doc, 有序.doc)).toBe("3. 甲\n4. 乙");
    再.destroy();
  });

  it("有序项回车：新项序号加一、分隔符照抄，后面已有的记号不动", () => {
    const blocks: EditDoc["blocks"] = [
      { ...段("3. 甲\n", "", "甲"), kind: "numbered" },
      { ...段("9. 尾\n", "", "尾"), kind: "numbered" },
    ];
    const { doc } = 装(blocks);
    const editor = createTestEditor(doc);
    块端(editor, 0, -1);
    expect(按Enter(editor)).toBe(true);
    const 新 = editor.state.selection.$from.before(1);
    expect((editor.view.nodeDOM(新) as HTMLElement).getAttribute("data-marker")).toBe("4.");
    editor.view.dispatch(editor.state.tr.insertText("新"));
    expect(docToMarkdown(editor.state.doc, doc)).toBe("3. 甲\n4. 新\n9. 尾\n");
    editor.destroy();
  });

  it("右括号记号的有序项，续出来的下一项仍用右括号", () => {
    const blocks: EditDoc["blocks"] = [{ ...段("2) 乙\n", "", "乙"), kind: "numbered" }];
    const { doc } = 装(blocks);
    const editor = createTestEditor(doc);
    块端(editor, 0, -1);
    expect(按Enter(editor)).toBe(true);
    editor.view.dispatch(editor.state.tr.insertText("丙"));
    expect(docToMarkdown(editor.state.doc, doc)).toBe("2) 乙\n3) 丙\n");
    editor.destroy();
  });

  it("续出来的有序项再按回车，序号接着加", () => {
    const blocks: EditDoc["blocks"] = [{ ...段("3. 甲\n", "", "甲"), kind: "numbered" }];
    const { doc } = 装(blocks);
    const editor = createTestEditor(doc);
    块端(editor, 0, -1);
    expect(按Enter(editor)).toBe(true);
    editor.view.dispatch(editor.state.tr.insertText("乙"));
    expect(按Enter(editor)).toBe(true);
    editor.view.dispatch(editor.state.tr.insertText("丙"));
    expect(docToMarkdown(editor.state.doc, doc)).toBe("3. 甲\n4. 乙\n5. 丙\n");
    editor.destroy();
  });

  it("选中项开头的字再按回车：选区删掉，剩下的字落到下一项", () => {
    const blocks: EditDoc["blocks"] = [{ ...段("- 项甲\n", "", "项甲"), kind: "bullet" }];
    const { doc } = 装(blocks);
    const editor = createTestEditor(doc);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 2)));
    expect(按Enter(editor)).toBe(true);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("- \n- 甲\n");
    editor.destroy();
  });

  it("列表项从中间拆开：左半留着原来的序号，右半是下一项", () => {
    const blocks: EditDoc["blocks"] = [{ ...段("3. 项甲\n", "", "项甲"), kind: "numbered" }];
    const { doc } = 装(blocks);
    const editor = createTestEditor(doc);
    // 正文是「项甲」，位置 2 在「项」和「甲」之间
    editor.commands.setTextSelection(2);
    expect(按Enter(editor)).toBe(true);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("3. 项\n4. 甲\n");
    editor.destroy();
  });

  it("选中多段设成有序列表：从 1 往下数；再按一次无序是换类型，再按同类型回到正文", () => {
    const blocks: EditDoc["blocks"] = [
      { ...段("甲\n", "", "甲"), kind: "paragraph" },
      { ...段("乙\n", "\n", "乙"), kind: "paragraph" },
      { ...段("> 引用\n", "\n", ""), kind: "quote" },
    ];
    const { doc } = 装(blocks);
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
    const 一次 = 设列表(editor.state, "numbered");
    expect(一次.跳过).toBe(1);
    editor.view.dispatch(一次.tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("1. 甲\n\n2. 乙\n\n> 引用\n");
    editor.view.dispatch(设列表(editor.state, "bullet").tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("- 甲\n\n- 乙\n\n> 引用\n");
    editor.view.dispatch(设列表(editor.state, "bullet").tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("甲\n\n乙\n\n> 引用\n");
    editor.destroy();
  });

  it("紧跟在 2) 后面转成有序项：序号接着数，分隔符仍是右括号", () => {
    const blocks: EditDoc["blocks"] = [
      { ...段("2) 甲\n", "", "甲"), kind: "numbered" },
      { ...段("乙\n", "\n", "乙"), kind: "paragraph" },
    ];
    const { doc } = 装(blocks);
    const editor = createTestEditor(doc);
    let pos = -1;
    editor.state.doc.forEach((n, off) => {
      if (n.textContent === "乙") pos = off;
    });
    editor.view.dispatch(applyBlockType(editor.state, pos, "numbered")!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("2) 甲\n\n3) 乙\n");
    editor.destroy();
  });

  it("待办末尾回车：下一项是未勾选的待办，上一项的勾留在原处", () => {
    const blocks: EditDoc["blocks"] = [
      {
        ...段("- [x] 已做\n", "", "已做"),
        kind: "todo",
        checked: true,
      },
    ];
    const { doc } = 装(blocks);
    const editor = createTestEditor(doc);
    块端(editor, 0, -1);
    expect(按Enter(editor)).toBe(true);
    editor.view.dispatch(editor.state.tr.insertText("接着"));
    expect(docToMarkdown(editor.state.doc, doc)).toBe("- [x] 已做\n- [ ] 接着\n");
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
    /**
     * 载入之后**只动一下光标**同样不许改。上一版只钉了"载入那一刻"，而 PM 对每一次 apply
     * 都会跑账本守卫，纯光标移动也算一次——不挡就会在这里清掉用户根本没碰过的第二段的账本，
     * 而那笔补出来的事务是 `docChanged` 的：`onUpdate` 跟着响，这篇就被标成未保存，字节却一个
     * 没变（探针实测：`mdRaw` 从 `"甲\n"` 变成 `""`）。界面后果是角标从此下不来，而 `unsaved`
     * 还挡着外部改动重载——Obsidian 改这篇永远看不见。
     */
    let update次数 = 0;
    editor.on("update", () => update次数++);
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(1)))
    );
    expect(editor.state.doc.child(1).attrs.mdRaw).toBe("甲\n");
    expect(update次数).toBe(0);
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    editor.destroy();
  });

  it("相邻两块源切片相同、真改其中一处：另一块的空行与账本都不许动", () => {
    const { doc } = 装([段("甲\n", "", "甲"), 段("甲\n", "\n\n", "甲"), 段("乙\n", "\n", "乙")]);
    const editor = createTestEditor(doc);
    editor.view.dispatch(editor.state.tr.insertText("X", 2));
    // 上一版只凭"与上一块 mdRaw 相同"就认定是拆块产物：这里改的是第一块，第二块根本没被碰，
    // 却会被清账本并压成 gap `""`——作者留的两个空行当场没了
    expect(editor.state.doc.child(1).attrs.mdRaw).toBe("甲\n");
    expect(docToMarkdown(editor.state.doc, doc)).toBe("甲X\n\n\n甲\n\n乙\n");
    editor.destroy();
  });

  it("粘贴一整块：新块按新建处理，不跟原块粘成一段", () => {
    const { doc } = 装([段("甲\n", "", "甲"), 段("乙\n", "\n", "乙")]);
    const editor = createTestEditor(doc);
    const 原 = editor.state.doc.child(0);
    const 末 = editor.state.doc.content.size - 1;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 末)));
    editor.view.dispatch(
      editor.state.tr.replaceSelection(new Slice(Fragment.from(原), 0, 0)),
    );
    // 复制来的账本让新块带着原块的 gap `""`，两块之间没有空行，落盘被读回同一段。
    // 守卫要的正是"新造的 + 另有同源"这两条同时成立，粘贴满足它
    expect(docToMarkdown(editor.state.doc, doc)).toBe("甲\n\n乙\n\n甲\n");
    editor.destroy();
  });

  it("选中多段设成待办：新项不勾选；再点一次回到正文。引用跳过", () => {
    const blocks: EditDoc["blocks"] = [
      { ...段("甲\n", "", "甲"), kind: "paragraph" },
      { ...段("乙\n", "\n", "乙"), kind: "paragraph" },
      { ...段("> 引用\n", "\n", ""), kind: "quote" },
    ];
    const { doc } = 装(blocks);
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
    const 一次 = 设列表(editor.state, "todo");
    expect(一次.跳过).toBe(1);
    editor.view.dispatch(一次.tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("- [ ] 甲\n\n- [ ] 乙\n\n> 引用\n");
    expect(共同列表(editor.state)).toBe("todo");
    editor.view.dispatch(设列表(editor.state, "todo").tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("甲\n\n乙\n\n> 引用\n");
    editor.destroy();
  });

  it("已勾选的待办混在选区里：转待办不改它的勾，再点一次两段都回到正文", () => {
    const blocks: EditDoc["blocks"] = [
      { ...段("- [x] 甲\n", "", "甲"), kind: "todo", checked: true },
      { ...段("乙\n", "\n", "乙"), kind: "paragraph" },
    ];
    const { doc } = 装(blocks);
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
    editor.view.dispatch(设列表(editor.state, "todo").tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("- [x] 甲\n\n- [ ] 乙\n");
    editor.view.dispatch(设列表(editor.state, "todo").tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("甲\n\n乙\n");
    editor.destroy();
  });

  it("下拉里再选一次待办不发事务", () => {
    const { doc } = 装([{ ...段("- [ ] 甲\n", "", "甲"), kind: "todo", checked: false }]);
    const editor = createTestEditor(doc);
    let pos = -1;
    editor.state.doc.forEach((n, off) => {
      if (n.type.name === "mdItem") pos = off;
    });
    expect(applyBlockType(editor.state, pos, "todo")).toBeNull();
    editor.destroy();
  });

  it("点前缀只切换这一项；勾回去后原样的 [X] 还在", () => {
    const blocks: EditDoc["blocks"] = [
      { ...段("- [ ] 甲\n", "", "甲"), kind: "todo", checked: false },
      { ...段("- [X] 乙\n", "", "乙"), kind: "todo", checked: true },
    ];
    const { doc } = 装(blocks);
    const editor = createTestEditor(doc);
    const 项 = [...editor.view.dom.querySelectorAll("[data-md-item='todo']")] as HTMLElement[];
    expect(项).toHaveLength(2);
    const 盒 = () =>
      ({
        left: 0,
        top: 0,
        right: 200,
        bottom: 24,
        width: 200,
        height: 24,
        x: 0,
        y: 0,
        toJSON() {
          return {};
        },
      }) as DOMRect;
    for (const el of 项) {
      el.style.paddingLeft = "24px";
      el.getBoundingClientRect = 盒;
    }
    const 点 = (el: HTMLElement, clientX: number, shiftKey = false) => {
      // 不往编辑器上派发：交回的 mousedown 在 jsdom 里会去调不存在的 elementFromPoint
      let 拦住 = false;
      const 处理了 = 点待办前缀(editor.view, {
        button: 0,
        shiftKey,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        clientX,
        clientY: 8,
        target: el,
        preventDefault() {
          拦住 = true;
        },
      } as unknown as MouseEvent);
      return 处理了 && 拦住;
    };
    expect(点(项[0]!, 40)).toBe(false);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("- [ ] 甲\n- [X] 乙\n");
    expect(点(项[0]!, 8, true)).toBe(false);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("- [ ] 甲\n- [X] 乙\n");
    expect(点(项[0]!, 8)).toBe(true);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("- [x] 甲\n- [X] 乙\n");
    expect(editor.state.doc.child(1).attrs.mdChecked).toBe(true);
    editor.destroy();

    const 再 = createTestEditor(装([blocks[1]!]).doc);
    let pos = -1;
    再.state.doc.forEach((n, off) => {
      if (n.type.name === "mdItem") pos = off;
    });
    再.view.dispatch(切换待办勾选(再.state, pos)!);
    expect(docToMarkdown(再.state.doc, 装([blocks[1]!]).doc)).toBe("- [ ] 乙\n");
    再.view.dispatch(切换待办勾选(再.state, pos)!);
    expect(docToMarkdown(再.state.doc, 装([blocks[1]!]).doc)).toBe("- [X] 乙\n");
    再.destroy();
  });

  it("前缀列按这一项的边框算，不按点中元素的偏移", () => {
    const 盒 = { left: 100, top: 10, bottom: 30, borderLeft: 2, paddingLeft: 24 };
    expect(点在待办前缀(110, 20, 盒)).toBe(true);
    expect(点在待办前缀(126, 20, 盒)).toBe(false);
    expect(点在待办前缀(90, 20, 盒)).toBe(false);
    expect(点在待办前缀(110, 40, 盒)).toBe(false);
  });
});

describe("首行缩进", () => {
  const 缩 = "\u3000\u3000";
  const 段 = (raw: string, gapBefore: string, content: string) => ({
    kind: "paragraph",
    id: null,
    raw,
    gapBefore,
    content,
    level: null,
    checked: null,
    align: null,
    fields: [] as [string, string][],
    children: [],
  });
  const 装 = (blocks: EditDoc["blocks"]) => {
    const doc: EditDoc = { frontMatter: "", trailingGap: "", blocks };
    return { doc, src: reassemble(doc) };
  };
  const 全选 = (editor: ReturnType<typeof createTestEditor>) => {
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
  };

  it("点一次在正文开头加上两个全角空格，再点一次去掉", () => {
    const { doc } = 装([段("甲\n", "", "甲")]);
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(2);
    expect(能设首行缩进(editor.state)).toBe(true);
    expect(共同首行缩进(editor.state)).toBe(false);
    editor.view.dispatch(设首行缩进(editor.state).tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe(`${缩}甲\n`);
    expect(共同首行缩进(editor.state)).toBe(true);
    editor.view.dispatch(设首行缩进(editor.state).tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("甲\n");
    expect(共同首行缩进(editor.state)).toBe(false);
    editor.destroy();
  });

  it("开头已有一个全角空格时，再设一次是在它前面加上两个", () => {
    const { doc } = 装([段("\u3000甲\n", "", "\u3000甲")]);
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(2);
    editor.view.dispatch(设首行缩进(editor.state).tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe(`${缩}\u3000甲\n`);
    editor.destroy();
  });

  it("已经缩进的正文再设一次回到原来的字", () => {
    const { doc } = 装([段(`${缩}甲\n`, "", `${缩}甲`)]);
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(2);
    expect(共同首行缩进(editor.state)).toBe(true);
    editor.view.dispatch(设首行缩进(editor.state).tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("甲\n");
    editor.destroy();
  });

  it("多段里只给还没有的正文加上；列表、标题、引用跳过且源不动", () => {
    const blocks: EditDoc["blocks"] = [
      段("甲\n", "", "甲"),
      { ...段("- 列表\n", "\n", "列表"), kind: "bullet" },
      段(`${缩}乙\n`, "\n", `${缩}乙`),
      { ...段("# 题\n", "\n", "题"), kind: "heading", level: 1 },
      { ...段("> 引用\n", "\n", ""), kind: "quote" },
      段("丙\n", "\n", "丙"),
    ];
    const { doc } = 装(blocks);
    const editor = createTestEditor(doc);
    全选(editor);
    const 一次 = 设首行缩进(editor.state);
    expect(一次.跳过).toBe(3);
    expect(共同首行缩进(editor.state)).toBe(false);
    editor.view.dispatch(一次.tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe(
      `${缩}甲\n\n- 列表\n\n${缩}乙\n\n# 题\n\n> 引用\n\n${缩}丙\n`,
    );
    expect(共同首行缩进(editor.state)).toBe(true);
    const 再 = 设首行缩进(editor.state);
    expect(再.跳过).toBe(3);
    editor.view.dispatch(再.tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe(
      "甲\n\n- 列表\n\n乙\n\n# 题\n\n> 引用\n\n丙\n",
    );
    editor.destroy();
  });

  it("空段落、只剩两个全角空格的段落、标题，都不缩", () => {
    const 空 = createTestEditor(装([段("\n", "", "")]).doc);
    全选(空);
    expect(能设首行缩进(空.state)).toBe(false);
    expect(设首行缩进(空.state).tr).toBeNull();
    空.destroy();

    const 只剩空格 = createTestEditor(装([段(`${缩}\n`, "", 缩)]).doc);
    全选(只剩空格);
    expect(能设首行缩进(只剩空格.state)).toBe(false);
    expect(设首行缩进(只剩空格.state).tr).toBeNull();
    expect(docToMarkdown(只剩空格.state.doc, 装([段(`${缩}\n`, "", 缩)]).doc)).toBe(`${缩}\n`);
    只剩空格.destroy();

    const 标题 = createTestEditor(
      装([{ ...段("# 题\n", "", "题"), kind: "heading", level: 1 }]).doc,
    );
    全选(标题);
    expect(能设首行缩进(标题.state)).toBe(false);
    expect(设首行缩进(标题.state).tr).toBeNull();
    expect(docToMarkdown(标题.state.doc, 装([{ ...段("# 题\n", "", "题"), kind: "heading", level: 1 }]).doc)).toBe(
      "# 题\n",
    );
    标题.destroy();
  });

  it("加上的两个字不跟着旁边的加粗", () => {
    const { doc } = 装([段("**甲**\n", "", "**甲**")]);
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(2);
    editor.view.dispatch(设首行缩进(editor.state).tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe(`${缩}**甲**\n`);
    editor.destroy();
  });

  it("居中的正文把两个全角空格写在包裹里面", () => {
    const 块 = {
      ...段('<div align="center">\n\n甲\n\n</div>\n', "", "甲"),
      align: "center",
    };
    const { doc } = 装([块]);
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(2);
    editor.view.dispatch(设首行缩进(editor.state).tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe(
      `<div align="center">\n\n${缩}甲\n\n</div>\n`,
    );
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

/**
 * 引用了代码块：这个形状超出结构化接管范围（只收段落 / 标题 / 列表），
 * 继续走 `mdOpaque` 的两副面孔。下面这组测试钉的就是那副机制。
 */
const 落回源文本 = (): EditDoc => ({
  frontMatter: "",
  trailingGap: "",
  blocks: [
    {
      kind: "quote",
      id: null,
      raw: "> 引用里的代码：\n>\n> ```\n> let a = 1;\n> ```\n",
      gapBefore: "",
      content: "",
      level: null,
      checked: null,
      align: null,
      fields: [],
      children: [
        {
          kind: "paragraph",
          id: null,
          raw: "引用里的代码：\n",
          gapBefore: "",
          content: "引用里的代码：",
          level: null,
          checked: null,
          align: null,
          fields: [],
          children: [],
        },
        {
          kind: "code",
          id: null,
          raw: "```\nlet a = 1;\n```\n",
          gapBefore: "\n",
          content: "",
          level: null,
          checked: null,
          align: null,
          fields: [],
          children: [],
        },
      ],
    },
    {
      kind: "paragraph",
      id: null,
      raw: "后面的正文。\n",
      gapBefore: "\n",
      content: "后面的正文。",
      level: null,
      checked: null,
      align: null,
      fields: [],
      children: [],
    },
  ],
});

describe("显示形切换不许碰到字节", () => {
  for (const name of SAMPLES) {
    const { src, doc } = load(name);

    it(`${name}：光标逐个进出不透明块，产出仍等于源文件`, () => {
      const editor = createTestEditor(doc);
      const 装载后的文档 = editor.state.doc;
      const 块 = 不透明块(editor);
      // 01 只有一条分隔线（已是原子块）、04 全是结构化引用、08 全是可编辑块：
      // 这几个样本没有不透明块可进出；其余样本必须真有得测，否则这条测试就变成了空转
      if (!["01-基础", "04-引用与标注", "08-对齐"].includes(name)) {
        expect(块.length, name).toBeGreaterThan(0);
      }
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

  it("结构化引用只有一面：光标进出不换 DOM，也不发事务", () => {
    const { doc, src } = load("04-引用与标注");
    const editor = createTestEditor(doc);
    const 文档前 = editor.state.doc;
    const 引们: number[] = [];
    editor.state.doc.forEach((n, off) => {
      if (n.type.name === "mdQuote") 引们.push(off);
    });
    expect(引们).toHaveLength(5);
    for (const 位 of 引们) {
      const 壳 = 面孔(editor, 位)!;
      expect(壳.hasAttribute("data-md-quote"), String(位)).toBe(true);
      expect(壳.querySelector(".md-view, .md-src"), "结构化引用不该有两副面孔").toBeNull();
      放进(editor, 位);
      expect(壳.hasAttribute("data-md-mode"), "点进来也不换面").toBe(false);
      放到文末(editor);
      expect(壳.hasAttribute("data-md-mode")).toBe(false);
    }
    expect(editor.state.doc).toBe(文档前);
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    editor.destroy();
  });

  // 表格被网格节点接管、代码围栏与公式也被账本接管，剩下的两副面孔只在不认得的形状上出现。
  // 这里用一个"引用里嵌代码"的块来钉那套机制：它拼不回结构化正文，必须继续显示源文本。
  it("光标进来退回源文本，交出口变回显示形", () => {
    const doc = 落回源文本();
    const editor = createTestEditor(doc);
    const 引 = 不透明块(editor)[0]!;
    expect(引.kind).toBe("quote");

    expect(面孔(editor, 引.pos)!.dataset["mdMode"]).toBeUndefined();
    expect(面孔(editor, 引.pos)!.querySelector(".md-view > *")).not.toBeNull();
    expect(面孔(editor, 引.pos)!.querySelector(".md-src")).not.toBeNull();

    放进(editor, 引.pos);
    expect(面孔(editor, 引.pos)!.dataset["mdMode"]).toBe("source");
    放到文末(editor);
    expect(面孔(editor, 引.pos)!.dataset["mdMode"]).toBeUndefined();
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

  it("改了源文本，交出口之后显示形跟着变", () => {
    // 重画发生在"交出焦点"那一刻，不在击键路径上。这条钉住两件事：
    // 该重画的时候真的重画了，且它读的是节点正文而不是载入时那份旧字节
    const doc = 落回源文本();
    const editor = createTestEditor(doc);
    const 引 = 不透明块(editor)[0]!;
    放进(editor, 引.pos);
    // 回退块也走前缀账本：节点正文是剥掉 `>` 之后的那段，偏移要按正文算
    const 偏移 = editor.state.doc.nodeAt(引.pos)!.textContent.indexOf("代码");
    editor.view.dispatch(editor.state.tr.insertText("改", 引.pos + 1 + 偏移));
    放到文末(editor);
    expect(面孔(editor, 引.pos)!.querySelector(".quote")!.textContent).toContain("改代码");
    editor.destroy();
  });

  it("显示形在 contentDOM 之外：PM 的解析与剪贴板都读不到它", () => {
    const doc = 落回源文本();
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
    const doc = 落回源文本();
    const editor = createTestEditor(doc);
    const 引 = 不透明块(editor)[0]!;
    const 壳 = 面孔(editor, 引.pos)!;
    expect(壳.dataset["mdMode"]).toBeUndefined();
    壳
      .querySelector(".md-view")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(editor.state.selection.$from.parent.type.name).toBe("mdOpaque");
    expect(editor.state.selection.from).toBe(引.pos + 1);
    expect(面孔(editor, 引.pos)!.dataset["mdMode"]).toBe("source");
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
    const doc = 落回源文本();
    const editor = createTestEditor(doc);
    const 引 = 不透明块(editor)[0]!;
    const 宿主 = 面孔(editor, 引.pos)!.querySelector(".md-view")!;
    const 选区前 = editor.state.selection.from;
    for (const 类 of ["contextmenu", "mouseup", "click"]) {
      宿主.dispatchEvent(new MouseEvent(类, { bubbles: true, button: 2 }));
      宿主.dispatchEvent(new MouseEvent(类, { bubbles: true, button: 0 }));
    }
    expect(editor.state.selection.from).toBe(选区前);
    expect(面孔(editor, 引.pos)!.dataset["mdMode"]).toBeUndefined();
    expect(docToMarkdown(editor.state.doc, doc)).toBe(reassemble(doc));
    editor.destroy();
  });

  it("点 Callout 的类型牌只改折叠态，不动选区也不动文档", () => {
    const { doc, src } = load("04-引用与标注");
    const editor = createTestEditor(doc);
    let 位 = -1;
    editor.state.doc.forEach((n, off) => {
      if (位 < 0 && n.type.name === "mdQuote" && n.attrs.mdKind === "callout") 位 = off;
    });
    expect(位).toBeGreaterThanOrEqual(0);
    const 壳 = 面孔(editor, 位)!;
    const 牌 = 壳.querySelector<HTMLButtonElement>(".cal-badge")!;
    expect(牌).not.toBeNull();
    const 选区前 = editor.state.selection.from;
    const 文档前 = editor.state.doc;
    牌.click();
    expect(壳.dataset["folded"]).toBeTruthy();
    牌.click();
    expect(壳.dataset["folded"]).toBeUndefined();
    expect(editor.state.doc).toBe(文档前);
    expect(editor.state.selection.from).toBe(选区前);
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    editor.destroy();
  });

  it("Callout 的标题是第一个正文节点，折叠态来自账本而不是第二份状态", () => {
    const { doc, src } = load("04-引用与标注");
    const editor = createTestEditor(doc);
    const 标注: number[] = [];
    editor.state.doc.forEach((n, off) => {
      if (n.type.name === "mdQuote" && n.attrs.mdKind === "callout") 标注.push(off);
    });
    expect(标注).toHaveLength(2);

    const 展开 = 面孔(editor, 标注[0]!)!;
    expect(展开.dataset["callout"]).toBe("question");
    expect(展开.querySelector(".cal-badge")!.textContent).toBe("question");
    expect(展开.querySelector("[data-md-quote-head]")!.textContent).toBe("打扰预算是多少？");
    expect(展开.dataset["folded"]).toBeUndefined();

    const 折叠 = 面孔(editor, 标注[1]!)!;
    expect(折叠.dataset["callout"]).toBe("note");
    expect(折叠.querySelector("[data-md-quote-head]")!.textContent).toBe("折叠的提示");
    expect(折叠.dataset["folded"]).toBe("1");
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
 * 代码块**只有一面**（2026-09-30 第二步）。
 *
 * 用户要的是"点进去与不点进去样式一样"。围栏进了账本之后，可编辑的那一面本身就是渲染好的
 * 那张卡片：着色由 `CodeHighlight` 的装饰给（PM 的 DOM 只能这样上色），语言牌由 CSS 从
 * `data-md-lang` 画。所以这一组判的是"两态同一批 DOM"，以及**上色永远不许碰字节**。
 */
describe("代码块单面：着色与语言牌跟着编辑面走", () => {
  const 代码块 = (editor: ReturnType<typeof createTestEditor>) =>
    不透明块(editor).find((b) => b.kind === "code")!;

  it("走围栏账本的那一块没有宿主，可编辑面里就有 hljs 的 span", () => {
    const { doc } = load("03-代码表格与公式");
    const editor = createTestEditor(doc);
    const 码 = 代码块(editor);
    const 壳 = 面孔(editor, 码.pos)!;
    expect(壳.querySelector(".md-view"), "代码块不该再有显示形宿主").toBeNull();
    expect(壳.querySelector(".md-src code span.hljs-keyword")).not.toBeNull();
    expect(壳.getAttribute("data-md-lang")).toBe("rust");
    editor.destroy();
  });

  it("聚焦前后是同一批 DOM：正文与 span 数量都不许变", () => {
    const { doc } = load("03-代码表格与公式");
    const editor = createTestEditor(doc);
    const 码 = 代码块(editor);
    const 前 = () => {
      const 源 = 面孔(editor, 码.pos)!.querySelector(".md-src")!;
      return [源.textContent!, 源.querySelectorAll("span").length] as const;
    };
    const 未聚焦 = 前();
    expect(未聚焦[1]).toBeGreaterThan(0);
    放进(editor, 码.pos);
    expect(前()).toEqual(未聚焦);
    放到文末(editor);
    expect(前()).toEqual(未聚焦);
    editor.destroy();
  });

  it("装饰只可能带 hljs- 开头的类，且不动一个字节", () => {
    const { doc, src } = load("03-代码表格与公式");
    const editor = createTestEditor(doc);
    const 码 = 代码块(editor);
    放进(editor, 码.pos);
    editor.view.dispatch(editor.state.tr.insertText(" // 改一行", 码.pos + 5));
    const 类们 = new Set<string>();
    面孔(editor, 码.pos)!
      .querySelectorAll(".md-src span")
      .forEach((s) => s.className.split(/\s+/).forEach((c) => 类们.add(c)));
    for (const 类 of 类们) expect([类, 类.startsWith("hljs-")]).toEqual([类, true]);
    // 着色是纯显示：产出的字节里不许混进任何 span / class
    const 出 = docToMarkdown(editor.state.doc, doc);
    expect(出).not.toContain("hljs");
    expect(出).toContain(" // 改一行");
    expect(docToMarkdown(editor.state.doc, { ...doc, blocks: doc.blocks })).toBe(出);
    editor.destroy();
    expect(src.length).toBeGreaterThan(0);
  });

  it("没闭栏的围栏仍然两副面孔（那种形状拼不回去，不能假装是代码框）", () => {

    const d: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        { kind: "code", id: null, raw: "```go\nfunc main() {\n", gapBefore: "", content: "", level: null, checked: null, align: null, fields: [], children: [] },
      ],
    };
    const editor = createTestEditor(d);
    const 壳 = 面孔(editor, 0)!;
    expect(壳.querySelector(".md-view")).not.toBeNull();
    expect(壳.querySelector(".md-src")!.textContent).toContain("```go");
    expect(壳.querySelector(".md-src span"), "围栏在正文里，不上色").toBeNull();
    editor.destroy();
  });
});

/**
 * 公式**只有一面**：两道 `$$` 进了账本，可编辑面就是显示形那张居中的公式。
 *
 * 与代码块同一条判据——只接管"首末两行各自只有 `$$`"的形状；单行 `$$ E = mc^2 $$`
 * 拼不回同样的字节，宁可按源文本回显。这里除了"没有宿主"，还要钉住两点：公式不该
 * 长出代码块的语言牌 / 复制键，以及改一行之后落盘的仍是 `$$\n…\n$$`。
 */
describe("公式单面：`$$` 进账本，编辑面就是显示形", () => {
  const 公式块 = (editor: ReturnType<typeof createTestEditor>) =>
    不透明块(editor).find((b) => b.kind === "math")!;

  it("走 `$$` 账本的那一块没有宿主，面上只有公式体", () => {
    const { doc, src } = load("03-代码表格与公式");
    const editor = createTestEditor(doc);
    const 数 = 公式块(editor);
    expect(数).toBeTruthy();
    const 壳 = 面孔(editor, 数.pos)!;
    expect(壳.querySelector(".md-view"), "公式块不该再有显示形宿主").toBeNull();
    expect(壳.hasAttribute("data-md-math")).toBe(true);
    expect(壳.querySelector(".md-src")!.textContent).toBe("E = mc^2");
    expect(壳.querySelector(".md-lang"), "公式没有语言牌").toBeNull();
    expect(壳.querySelector(".md-copy"), "公式没有复制键").toBeNull();
    expect(壳.querySelector(".md-gutter"), "公式不排行号").toBeNull();
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    editor.destroy();
  });

  it("聚焦前后是同一批 DOM，改一行仍按 `$$` 围栏落盘", () => {
    const { doc } = load("03-代码表格与公式");
    const editor = createTestEditor(doc);
    const 数 = 公式块(editor);
    const 源 = () => 面孔(editor, 数.pos)!.querySelector(".md-src")!;
    const 未聚焦 = 源().textContent;
    放进(editor, 数.pos);
    expect(源().textContent).toBe(未聚焦);
    expect(源().querySelectorAll("span")).toHaveLength(0);
    const 尾 = 数.pos + 1 + (未聚焦?.length ?? 0);
    editor.view.dispatch(editor.state.tr.insertText("\nE = mc^3", 尾));
    expect(源().textContent).toBe("E = mc^2\nE = mc^3");
    expect(docToMarkdown(editor.state.doc, doc)).toContain("$$\nE = mc^2\nE = mc^3\n$$");
    放到文末(editor);
    expect(源().textContent).toBe("E = mc^2\nE = mc^3");
    editor.destroy();
  });

  it("单行 `$$ E = mc^2 $$` 拼不回原字节，继续两副面孔", () => {
    const d: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        { kind: "math", id: null, raw: "$$E = mc^2$$\n", gapBefore: "", content: "", level: null, checked: null, align: null, fields: [], children: [] },
      ],
    };
    const editor = createTestEditor(d);
    const 壳 = 面孔(editor, 0)!;
    expect(壳.hasAttribute("data-md-math")).toBe(false);
    expect(壳.querySelector(".md-view"), "显示形还在").not.toBeNull();
    expect(壳.querySelector(".md-src")!.textContent).toContain("$$");
    expect(docToMarkdown(editor.state.doc, d)).toBe("$$E = mc^2$$\n");
    editor.destroy();
  });

  it("空的 `$$` 中间那一行按字节分得清", () => {
    const 文档 = (raw: string): EditDoc => ({
      frontMatter: "",
      trailingGap: "",
      blocks: [
        { kind: "math", id: null, raw, gapBefore: "", content: "", level: null, checked: null, align: null, fields: [], children: [] },
      ],
    });
    for (const raw of ["$$\n$$\n", "$$\n\n$$\n"]) {
      const d = 文档(raw);
      const editor = createTestEditor(d);
      const 壳 = 面孔(editor, 0)!;
      expect(壳.hasAttribute("data-md-math"), raw).toBe(true);
      expect(壳.querySelector(".md-src")!.textContent, raw).toBe("");
      expect(docToMarkdown(editor.state.doc, d), raw).toBe(raw);
      editor.destroy();
    }
  });
});

/**
 * 结构化引用（docs/02 D42 / D43）：`>` 与 `[!type]` 进账本，正文是真正可编辑的
 * 段落 / 标题 / 列表。边界只有一条——拼不回原字节的块不接管，继续两副面孔。
 */
describe("结构化引用：前缀进账本，正文是真正可编辑的段落", () => {
  const 引述们 = (editor: Editor) => {
    const out: { pos: number; node: PmNode }[] = [];
    editor.state.doc.forEach((n, off) => {
      if (n.type.name === "mdQuote") out.push({ pos: off, node: n });
    });
    return out;
  };

  it("夹具 04 的五块引用 / Callout 都结构化接管，正文不带前缀，字节不变", () => {
    const { doc, src } = load("04-引用与标注");
    const editor = createTestEditor(doc);
    const 块们 = 引述们(editor);
    expect(块们).toHaveLength(5);
    expect(块们.filter((b) => b.node.attrs.mdKind === "callout")).toHaveLength(2);
    for (const { node } of 块们) {
      expect(node.attrs.mdQuoteMarks).toBeTruthy();
      expect(node.textContent).not.toMatch(/(^|\n)\s{0,3}>/);
      expect(node.textContent).not.toContain("[!");
      expect(node.textContent).not.toContain("^b-");
      expect(node.firstChild!.type.name).toBe(
        node.attrs.mdKind === "callout" ? "mdQuoteHead" : "mdParagraph",
      );
    }
    // 列表与懒惰续行也进了正文，而不是留在某段源文本里
    expect([...块们[3]!.node.children].map((n) => n.type.name)).toEqual([
      "mdParagraph",
      "mdItem",
      "mdItem",
    ]);
    expect(块们[4]!.node.textContent).toBe("懒惰续行\n仍然属于上面这个引用。");
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    editor.destroy();
  });

  it("改一个字再改回去，前缀与块锚都还在原来的位置", () => {
    const { doc, src } = load("04-引用与标注");
    const editor = createTestEditor(doc);
    const 首 = 引述们(editor)[0]!;
    // 引用 → 段落 → 文字：块起点 +2 才是第一个字符
    editor.view.dispatch(editor.state.tr.insertText("X", 首.pos + 2));
    const 改过 = docToMarkdown(editor.state.doc, doc);
    expect(改过).toContain("> X普通引用的第一行。");
    expect(改过).toContain("^b-x1y2z3a4b5");
    expect(改过.match(/\^b-x1y2z3a4b5/g)).toHaveLength(1);
    editor.view.dispatch(editor.state.tr.delete(首.pos + 2, 首.pos + 3));
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    editor.destroy();
  });

  it("Callout 的标题是正文，`[!type]` 只在账本里，改字不会复制第二份", () => {
    const { doc } = load("04-引用与标注");
    const editor = createTestEditor(doc);
    const 标 = 引述们(editor).find((b) => b.node.attrs.mdKind === "callout")!;
    editor.view.dispatch(editor.state.tr.insertText("X", 标.pos + 2));
    const 出 = docToMarkdown(editor.state.doc, doc);
    expect(出.match(/\[!question\]/g)).toHaveLength(1);
    expect(出).toContain("> [!question] X打扰预算是多少？");
    expect(出).toContain("^b-c6d9f2g5h8");
    editor.destroy();
  });

  it("空引用（只有 `>`）拼不回正文，继续按源文本回显", () => {
    const { doc, src } = load("06-插入骨架");
    const editor = createTestEditor(doc);
    const 空 = 不透明块(editor).find((b) => b.kind === "quote");
    expect(空).toBeTruthy();
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    editor.destroy();
  });

  it("剪贴板认回 mdQuote：类型与标题都在，前缀由序列化器重新起头", () => {
    const { doc } = load("04-引用与标注");
    const editor = createTestEditor(doc);
    const 标 = 引述们(editor).find((b) => b.node.attrs.mdKind === "callout")!;
    const 块 = editor.state.doc.nodeAt(标.pos)!;
    const 包装 = document.createElement("div");
    包装.append(DOMSerializer.fromSchema(editor.state.schema).serializeNode(块));
    const 回 = DOMParser.fromSchema(editor.state.schema).parse(包装);
    const 新 = 回.firstChild!;
    expect(新.type.name).toBe("mdQuote");
    expect(新.attrs.mdKind).toBe("callout");
    expect(新.attrs.mdCalloutType).toBe("question");
    expect(新.attrs.mdCalloutFolded).toBe(false);
    expect(新.firstChild!.type.name).toBe("mdQuoteHead");
    expect(新.firstChild!.textContent).toBe("打扰预算是多少？");
    expect(新.textContent).toBe(块.textContent);
    // 剪贴板不可信：前缀账本与块锚不跟着 HTML 走，粘出来的块按 `[!type]` 与 `> ` 重新起头
    expect(新.attrs.mdQuoteMarks).toBe("");
    expect(新.attrs.mdQuoteAnchor).toBe("");
    editor.destroy();
  });
});

/**
 * 分隔线**只有一面**：它是原子块，屏幕上就是一条线，点上、选中、失焦都不换 DOM。
 *
 * `---` / `***` / `___` 三种写法都认（内核都判成 `divider`），原字节留在 `mdRaw` 里，
 * 没改过的块走"原样回写"那条路。剪贴板也要认回来——否则复制一条线贴到别处就消失了。
 */
describe("分隔线单面：原子块，屏幕上只有一条线", () => {
  it("夹具里的三种写法都是原子块，字节逐字节等于源文件", () => {
    const { doc, src } = load("03-代码表格与公式");
    const editor = createTestEditor(doc);
    const 线们: number[] = [];
    editor.state.doc.forEach((n, off) => {
      if (n.type.name === "mdDivider") 线们.push(off);
    });
    expect(线们).toHaveLength(2);
    for (const 位 of 线们) {
      const dom = editor.view.nodeDOM(位) as HTMLElement;
      expect(dom.tagName).toBe("HR");
      expect(dom.hasAttribute("data-md-divider")).toBe(true);
      expect(dom.querySelector(".md-src, .md-view"), "分隔线没有源码面").toBeNull();
    }
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    editor.destroy();
  });

  it("选中它只有 DOM 标记，不发事务；↓ 从它下面出去", () => {
    const { doc } = load("03-代码表格与公式");
    const editor = createTestEditor(doc);
    let 位 = -1;
    editor.state.doc.forEach((n, off) => {
      if (位 < 0 && n.type.name === "mdDivider") 位 = off;
    });
    const 文档前 = editor.state.doc;
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 位)),
    );
    const dom = editor.view.nodeDOM(位) as HTMLElement;
    expect(dom.hasAttribute("data-md-sel")).toBe(true);
    expect(editor.state.doc).toBe(文档前);
    const tr = 图片下出口(editor.state);
    if (位 + editor.state.doc.nodeAt(位)!.nodeSize < editor.state.doc.content.size) {
      expect(tr).not.toBeNull();
    }
    editor.destroy();
  });

  it("插进来的分隔线是原子块，落盘仍是内核认得的 `---`", () => {
    const { doc } = load("06-插入骨架");
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize - 1);
    const tr = editor.state.tr.insert(
      editor.state.doc.content.size,
      editor.state.schema.nodes.mdDivider!.create({ mdKind: "divider", mdGap: "\n" }),
    );
    editor.view.dispatch(tr);
    let 数 = 0;
    editor.state.doc.forEach((n) => {
      if (n.type.name === "mdDivider") 数++;
    });
    expect(数).toBe(2);
    expect(docToMarkdown(editor.state.doc, doc)).toContain("\n---\n");
    editor.destroy();
  });

  it("带块锚的分隔线把 `^b-…` 放下一行，行内锚会退化成段落", () => {
    const { doc } = load("03-代码表格与公式");
    const editor = createTestEditor(doc);
    let 位 = -1;
    editor.state.doc.forEach((n, off) => {
      if (位 < 0 && n.type.name === "mdDivider") 位 = off;
    });
    const 块 = editor.state.doc.nodeAt(位)!;
    // 清掉签名等于"这块被改过"，逼它走重新序列化那条路
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(位, undefined, {
        ...块.attrs,
        mdId: "b-k3x9m2v7qa",
        mdSig: "",
      }),
    );
    const 产出 = docToMarkdown(editor.state.doc, doc);
    expect(产出).toContain("---\n^b-k3x9m2v7qa");
    expect(产出).not.toContain("--- ^b-k3x9m2v7qa");
    editor.destroy();
  });

  it("走一遍剪贴板的 renderHTML / parseHTML，类型与形状都回得来", () => {
    const { doc } = load("06-插入骨架");
    const editor = createTestEditor(doc);
    let 位 = -1;
    editor.state.doc.forEach((n, off) => {
      if (位 < 0 && n.type.name === "mdDivider") 位 = off;
    });
    const 块 = editor.state.doc.nodeAt(位)!;
    const 包装 = document.createElement("div");
    包装.append(DOMSerializer.fromSchema(editor.state.schema).serializeNode(块));
    const 回 = DOMParser.fromSchema(editor.state.schema).parse(包装);
    expect(回.firstChild?.type.name).toBe("mdDivider");
    expect(回.firstChild?.attrs.mdKind).toBe("divider");
    editor.destroy();
  });
});

/**
 * 自动识别语言 + 块内那个语言下拉（2026-09-30）。
 *
 * 用户拍板的是"识别出来就写进 ``` 后面"。这条与"打开一篇不许动它"顶牛，所以口径是：
 * **猜归猜，只有这一块真要落盘时才把那个词写进去**——没改过的块连一个字节都不许多。
 */
describe("自动识别语言：猜得出来，但不许偷改文件", () => {
  const 代码 = "def f(x):\n    return x * 2  # 注释\n\nclass K:\n    pass\n";
  const 裸 = (raw: string): EditDoc["blocks"][number] => ({
    kind: "code",
    id: null,
    raw,
    gapBefore: "",
    content: "",
    level: null,
    checked: null,
    align: null,
    fields: [],
    children: [],
  });
  const 文档 = (...blocks: EditDoc["blocks"]): EditDoc => ({
    frontMatter: "",
    trailingGap: "",
    blocks,
  });

  it("什么都不改：猜出来的语言不落盘，产出逐字节等于源文件", () => {
    const d = 文档(裸("```\n" + 代码 + "```\n"));
    const editor = createTestEditor(d);
    const 出 = docToMarkdown(editor.state.doc, d);
    expect(出).toBe("```\n" + 代码 + "```\n");
    expect(出).not.toContain("```py");
    editor.destroy();
  });

  it("改过这一块：识别出来的语言写进开栏行，闭栏与正文原样", () => {
    const d = 文档(裸("```\n" + 代码 + "```\n"));
    const editor = createTestEditor(d);
    editor.view.dispatch(editor.state.tr.insertText("z = 1\n", 1));
    const 出 = docToMarkdown(editor.state.doc, d);
    // 认得出 Python 就必须带上那个词；认不出也绝不编——所以这条断言同时钉住"不是别的语言"
    expect(出).toMatch(/^```py/);
    expect(出).toContain("z = 1\ndef f(x):");
    expect(出.endsWith("```\n")).toBe(true);
    editor.destroy();
  });

  it("作者写了语言就永不覆盖，哪怕我们认不出它", () => {
    const d = 文档(裸("```klingon\nnuqDotlh\n```\n"));
    const editor = createTestEditor(d);
    editor.view.dispatch(editor.state.tr.insertText("tlh ", 1));
    const 出 = docToMarkdown(editor.state.doc, d);
    expect(出).toBe("```klingon\ntlh nuqDotlh\n```\n");
    editor.destroy();
  });

  it("太短或纯文字的块不猜：`a=1` 不该被写成 ini", () => {
    const d = 文档(裸("```\na=1\n```\n"));
    const editor = createTestEditor(d);
    editor.view.dispatch(editor.state.tr.insertText("b", 2));
    expect(docToMarkdown(editor.state.doc, d)).toBe("```\nab=1\n```\n");
    editor.destroy();
  });

  it("下拉：选一门语言 = 改开栏行的首词，缩进/围栏长度/后面的注释都留着", () => {
    const d = 文档(裸("  ```rust // 标记\nfn main() {}\n  ```\n"));
    const editor = createTestEditor(d);
    const 壳 = editor.view.nodeDOM(0) as HTMLElement;
    const 牌 = 壳.querySelector<HTMLSelectElement>("select.md-lang")!;
    expect(牌.value).toBe("rust");
    牌.value = "go";
    牌.dispatchEvent(new Event("change", { bubbles: true }));
    const 块 = editor.state.doc.child(0);
    expect(块.attrs.mdFenceOpen).toBe("  ```go // 标记");
    expect(docToMarkdown(editor.state.doc, d)).toBe("  ```go // 标记\nfn main() {}\n  ```\n");
    editor.destroy();
  });

  it("只读：语言下拉也写不进文件（它的 change 不归 PM 管）", () => {
    // 与图注框同一条缺口：`dispatch` 不看 `editable`。演示里下拉若还能被触发，
    // 这一笔会绕过"只读"，而且 `onUpdate` 还会因为不在编辑态而不标脏。
    const 源 = "```rust\nfn main() {}\n```\n";
    const d = 文档(裸(源));
    const editor = createTestEditor(d);
    editor.setEditable(false);
    const 牌 = (editor.view.nodeDOM(0) as HTMLElement).querySelector<HTMLSelectElement>(
      "select.md-lang"
    )!;
    牌.value = "go";
    牌.dispatchEvent(new Event("change", { bubbles: true }));
    expect(docToMarkdown(editor.state.doc, d)).toBe(源);
    editor.destroy();
  });

  it("下拉选「无」把开栏改回光秃秃的 ```，选「纯文本」写 text", () => {
    const d = 文档(裸("```js\nconst a = 1;\n```\n"));
    const editor = createTestEditor(d);
    const 牌 = (editor.view.nodeDOM(0) as HTMLElement).querySelector<HTMLSelectElement>(
      "select.md-lang"
    )!;
    牌.value = "";
    牌.dispatchEvent(new Event("change", { bubbles: true }));
    expect(docToMarkdown(editor.state.doc, d)).toBe("```\nconst a = 1;\n```\n");
    牌.value = "text";
    牌.dispatchEvent(new Event("change", { bubbles: true }));
    expect(docToMarkdown(editor.state.doc, d)).toBe("```text\nconst a = 1;\n```\n");
    editor.destroy();
  });

  it("下拉的每一个选项都真能上色（列一个上不了色的语言等于给个摆设）", () => {
    for (const 项 of 语言清单) {
      // `text` 是唯一一个"故意不上色"的选项：它的意思是"别猜了，这就是纯文本"
      const 该认 = 项.值 === "text" || 项.值 === "" ? true : 认得语言(项.值);
      expect([项.值, 该认]).toEqual([项.值, true]);
    }
  });

  it("识别本身：认不出给 null，绝不编一门语言", () => {
    expect(识别(代码)).toBe("py"); // 子集里给的是别名，回来的就是那个别名（与文件里写的词一致）
    expect(识别("这是一段中文笔记，没有代码结构，真的没有。")).toBeNull();
    expect(识别("a=1")).toBeNull(); // 太短
    expect(识别("const a = 1;")).toBeNull(); // 单行
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
  align: null,
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
        align: null,
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
        { kind: "table", id: null, raw: 异形, gapBefore: "\n", content: "", level: null, checked: null, align: null, fields: [], children: [] },
        { kind: "table", id: null, raw: 异形, gapBefore: "\n", content: "", level: null, checked: null, align: null, fields: [], children: [] },
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

  it("表格是文档最后一块时：↓ 现补一个落脚点，而文件逐字节不变", () => {
    // 用户报的死局：格子里装不下换行、Tab/Enter 只会一路加行，表格在文末就出不去。
    // 出口补的是空段落——`docToMarkdown` 不写空白的块，所以这一条判据是"字节一个字不许变"
    const d = 表doc(规范表);
    const editor = createTestEditor(d);
    进格(editor, 3); // 末行末格（那一行有内容，不与"空行退出"混在一起）
    const tr = exitTableDown(editor.state);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    const $后 = editor.state.selection.$from;
    expect($后.depth).toBe(1);
    expect($后.parent.type.name).toBe("mdParagraph");
    expect([...editor.state.doc.children].map((n) => n.type.name)).toEqual([
      "mdParagraph",
      "mdTable",
      "mdParagraph",
    ]);
    expect(docToMarkdown(editor.state.doc, d)).toBe("前一段\n\n" + 规范表);
    editor.destroy();
  });

  it("非末行按 ↓ 不归我们（交回 PM，格子内该能移动）", () => {
    const d = 表doc(规范表);
    const editor = createTestEditor(d);
    进格(editor, 0); // 表头行
    expect(exitTableDown(editor.state)).toBeNull();
    editor.destroy();
  });

  it("末行整行是空的：Enter 删掉那个空行并把人送出去", () => {
    const 源 = "| A | B |\n| --- | --- |\n| 1 | 2 |\n|  |  |\n";
    const d = 表doc(源);
    const editor = createTestEditor(d);
    进格(editor, 4); // 空末行的第一格（3 行 × 2 列 → 索引 0..5）
    const tr = enterCell(editor.state);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(editor.state.selection.$from.depth).toBe(1);
    // 空行没了：产出回到两行的表，重新解析仍认它
    const 出 = docToMarkdown(editor.state.doc, d);
    expect(出).toBe("前一段\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    expect(parseTable(出.slice(出.indexOf("| A")))!.rows.length).toBe(2);
    editor.destroy();
  });

  it("整张表只剩一行（连表头都是空的）时 Enter 只送人出去，不删表头", () => {
    // GFM 的表必须有表头行：这一行删掉产出的就不是表了，所以"空行退出"在这里只出不删
    const d = 表doc("|  |  |\n| --- | --- |\n");
    const editor = createTestEditor(d);
    进格(editor, 1);
    const tr = enterCell(editor.state);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(editor.state.selection.$from.depth).toBe(1);
    expect(docToMarkdown(editor.state.doc, d)).toBe("前一段\n\n|  |  |\n| --- | --- |\n");
    editor.destroy();
  });

  it("插入与粘贴表格都自带落脚点，且都不多出字节", () => {
    const 骨架 = "| 列 | 列 |\n| --- | --- |\n|  |  |";
    const 一份: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [段("前一段\n", "", "前一段")],
    };
    const editor = createTestEditor(一份);
    进块(editor, 0);
    const tr = insertSourceBlock(editor.state, "table", 骨架);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect([...editor.state.doc.children].map((n) => n.type.name)).toEqual([
      "mdParagraph",
      "mdTable",
      "mdParagraph",
    ]);
    // 落脚点不落盘：产出正好是"前一段 + 一张表"，末尾不多一个空行
    expect(docToMarkdown(editor.state.doc, 一份)).toBe("前一段\n\n" + 骨架 + "\n");
    editor.destroy();

    const 二份: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [段("前一段\n", "", "前一段"), 段("\n", "\n", "")],
    };
    const 二 = createTestEditor(二份);
    进块(二, 1);
    二.view.dispatch(pasteGrid(二.state, "| A | B |\n| --- | --- |\n| 1 | 2 |\n")!);
    expect([...二.state.doc.children].map((n) => n.type.name)).toEqual([
      "mdParagraph",
      "mdTable",
      "mdParagraph",
    ]);
    expect(docToMarkdown(二.state.doc, 二份)).toBe("前一段\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    二.destroy();
  });

  it("末行不带换行的文件：插入结构块要补出空行，且不许改掉文件的结尾习惯", () => {
    // 复查查出来的破坏：未改动的块原样回写（不补 eol），在它后面插一块时只给一个 "\n"，
    // 于是 `末段\n---` 被内核读成 setext 二级标题、`末段\n| 列 |…` 把整张表吞进段落。
    // 而表格后面那个不落盘的落脚点又会让"最后一个 child"判据失效、凭空多一个结尾换行。
    const 不结尾: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [段("前一段\n", "", "前一段"), 段("末段", "\n", "末段")],
    };
    const e = createTestEditor(不结尾);
    e.view.dispatch(e.state.tr.setSelection(TextSelection.atEnd(e.state.doc)));

    const 表 = insertSourceBlock(e.state, "table", "| 列 | 列 |\n| --- | --- |\n|  |  |");
    expect(表).not.toBeNull();
    const 出表 = docToMarkdown(表!.doc, 不结尾);
    expect(出表).toBe("前一段\n\n末段\n\n| 列 | 列 |\n| --- | --- |\n|  |  |");
    expect(出表.endsWith("\n")).toBe(false);

    const 线 = insertSourceBlock(e.state, "divider", "---");
    expect(线).not.toBeNull();
    const 出线 = docToMarkdown(线!.doc, 不结尾);
    expect(出线).toBe("前一段\n\n末段\n\n---");
    // 以换行结尾的文件不受这条影响：该保留的换行还在
    e.destroy();
    const 规矩 = 表doc(规范表);
    const 二 = createTestEditor(规矩);
    二.view.dispatch(二.state.tr.setSelection(TextSelection.atEnd(二.state.doc)));
    const 二表 = insertSourceBlock(二.state, "table", "| A |\n| --- |\n| 1 |");
    expect(docToMarkdown(二表!.doc, 规矩)).toBe(
      "前一段\n\n" + 规范表 + "\n| A |\n| --- |\n| 1 |\n",
    );
    二.destroy();
  });

  it("不以换行结尾的文件：删掉最后一块，不许改动前面那块自带的换行", () => {
    // 上一轮那条"从结尾削掉一个 \n"的补法就是死在这里：判据看的是最后一个 child，
    // 而未改动的块连自己的换行都是文件本来的字节。现在 eol 看"最后写出的块"
    const d: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [段("a\n", "", "a"), 段("b", "\n", "b")], // 文件的最后一行不带换行
    };
    const e = createTestEditor(d);
    expect(docToMarkdown(e.state.doc, d)).toBe("a\n\nb");
    const 末 = e.state.doc.childCount - 1;
    let 起 = 0;
    let i = 0;
    e.state.doc.forEach((n, off) => {
      if (i++ === 末) 起 = off;
    });
    e.view.dispatch(e.state.tr.delete(起, 起 + e.state.doc.child(末).nodeSize));
    // 剩下的那块是"未改动"的，它的 raw 自带换行 —— 必须原样回写
    expect(docToMarkdown(e.state.doc, d)).toBe("a\n");
    e.destroy();
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
        { kind: "table", id: null, raw: 异形, gapBefore: "\n", content: "", level: null, checked: null, align: null, fields: [], children: [] },
        { kind: "table", id: null, raw: 异形, gapBefore: "\n", content: "", level: null, checked: null, align: null, fields: [], children: [] },
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

const 三列 = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n";

describe("矩形选区的批量动作：只动所选格，其余逐字节不动", () => {
  /** 框住第 r0..r1 行、c0..c1 列，并把光标放进左上那一格（与真机拖完的状态一致） */
  function 框住(editor: Editor, 矩: 矩形, 锚n: number) {
    进格(editor, 锚n);
    editor.view.dispatch(改选区(editor.state, 表起点(editor), 矩));
  }

  it("清空所选：四格空了，表头与没选中的那列仍是原样", () => {
    const d = 表doc(三列);
    const editor = createTestEditor(d);
    框住(editor, 归一({ 行: 1, 列: 0 }, { 行: 2, 列: 1 }), 3);
    const tr = 批量(editor.state, 清场所选);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(docToMarkdown(editor.state.doc, d)).toBe(
      "前一段\n\n| A | B | C |\n| --- | --- | --- |\n|  |  | 3 |\n|  |  | 6 |\n"
    );
    editor.destroy();
  });

  it("填充：抄的是矩形左上角那一格，不是光标停着的那一格", () => {
    const d = 表doc(三列);
    const editor = createTestEditor(d);
    // 从右下往左上框（锚点仍是左上 (1,1)="2"），光标最后停在 (2,2)="6"
    框住(editor, 归一({ 行: 2, 列: 2 }, { 行: 1, 列: 1 }), 8);
    editor.view.dispatch(批量(editor.state, 填充所选)!);
    expect(docToMarkdown(editor.state.doc, d)).toBe(
      "前一段\n\n| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 2 |\n| 4 | 2 | 2 |\n"
    );
    editor.destroy();
  });

  it("填充带着 mark 走：抄过去的是加粗的甲，不是一串星号", () => {
    const d = 表doc("| A | B |\n| --- | --- |\n| **甲** |  |\n");
    const editor = createTestEditor(d);
    框住(editor, 归一({ 行: 1, 列: 0 }, { 行: 1, 列: 1 }), 2);
    editor.view.dispatch(批量(editor.state, 填充所选)!);
    const 出 = docToMarkdown(editor.state.doc, d);
    expect(出).toBe("前一段\n\n| A | B |\n| --- | --- |\n| **甲** | **甲** |\n");
    // 屏幕上那一格得真是加粗的，而不是把 `**` 当字面文字塞进去
    const 格们 = [...editor.view.dom.querySelectorAll("[data-md-cell]")];
    expect(格们[3]?.querySelector("strong")).not.toBeNull();
    editor.destroy();
  });

  it("单格不算批量：否则 Backspace 会把「只是光标停在那儿」的一格清空", () => {
    const d = 表doc(三列);
    const editor = createTestEditor(d);
    框住(editor, 单格({ 行: 1, 列: 1 }), 4);
    expect(批量(editor.state, 清场所选)).toBeNull();
    editor.destroy();
  });

  it("连点两次清空：第二次不发事务、不标脏、不重写字节", () => {
    const d = 表doc(三列);
    const editor = createTestEditor(d);
    框住(editor, 归一({ 行: 1, 列: 0 }, { 行: 2, 列: 1 }), 3);
    const 第一次 = 批量(editor.state, 清场所选);
    expect(第一次).not.toBeNull();
    editor.view.dispatch(第一次!);
    // 清空那笔事务把选区交掉了（文档变了），重新框同一片再点一次
    框住(editor, 归一({ 行: 1, 列: 0 }, { 行: 2, 列: 1 }), 3);
    expect(批量(editor.state, 清场所选)).toBeNull();
    editor.destroy();
  });

  it("删所选行：覆盖两行就一起走，表头行永不删", () => {
    const d = 表doc(三列);
    const editor = createTestEditor(d);
    框住(editor, 归一({ 行: 1, 列: 1 }, { 行: 2, 列: 2 }), 4);
    editor.view.dispatch(批量(editor.state, 删所选行)!);
    expect(docToMarkdown(editor.state.doc, d)).toBe(
      "前一段\n\n| A | B | C |\n| --- | --- | --- |\n"
    );
    const 只表头 = createTestEditor(表doc(三列));
    框住(只表头, 归一({ 行: 0, 列: 0 }, { 行: 0, 列: 1 }), 0);
    expect(批量(只表头.state, 删所选行)).toBeNull();
    expect(只表头.state.doc.nodeAt(表起点(只表头))!.childCount).toBe(3);
    只表头.destroy();
    editor.destroy();
  });

  it("删所选列：每行都少这几格，分隔行的位次跟着削", () => {
    const d = 表doc(三列);
    const editor = createTestEditor(d);
    框住(editor, 归一({ 行: 1, 列: 0 }, { 行: 2, 列: 1 }), 3);
    editor.view.dispatch(批量(editor.state, 删所选列)!);
    expect(docToMarkdown(editor.state.doc, d)).toBe(
      "前一段\n\n| C |\n| --- |\n| 3 |\n| 6 |\n"
    );
    editor.destroy();
  });

  it("整张表都是列时删列给 null：空表不是表", () => {
    const editor = createTestEditor(表doc(三列));
    框住(editor, 归一({ 行: 1, 列: 0 }, { 行: 2, 列: 2 }), 3);
    expect(批量(editor.state, 删所选列)).toBeNull();
    editor.destroy();
  });

  it("逐列设对齐：所选覆盖几列就改几列，`mdAligns` 与每格属性一起变", () => {
    const d = 表doc(三列);
    const editor = createTestEditor(d);
    框住(editor, 归一({ 行: 1, 列: 0 }, { 行: 2, 列: 1 }), 3);
    editor.view.dispatch(批量(editor.state, (s, 表, 矩) => 对所齐所选(s, 表, 矩, "center"))!);
    const 出 = docToMarkdown(editor.state.doc, d);
    expect(出).toBe(
      "前一段\n\n| A | B | C |\n| :---: | :---: | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n"
    );
    expect(parseTable(出.slice(出.indexOf("| A")))!.aligns).toEqual([
      "center",
      "center",
      "",
    ]);
    editor.destroy();
  });

  it("矩形越出表头时只改夹住的那几列：分隔行绝不能比表头长", () => {
    /**
     * 越界矩形在真机上**造得出来**：Shift 点扩选区时抄了另一张表的锚点（锚是表内坐标，
     * 五列的表里的第 5 列喂给只有三列的表就越界）。那条路已经堵了，这里钉第二道：
     * 对齐这一路自己必须夹住。分隔行写出 5 段而表头 3 段，内核就不再认它是表——
     * 整块降级成不透明块，用户的表格从网格里消失。
     */
    const d = 表doc(三列);
    const editor = createTestEditor(d);
    框住(editor, { r0: 1, r1: 2, c0: 0, c1: 4 }, 3);
    const tr = 批量(editor.state, (s, 表, 矩) => 对所齐所选(s, 表, 矩, "center"));
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    const 出 = docToMarkdown(editor.state.doc, d);
    expect(出).toBe(
      "前一段\n\n| A | B | C |\n| :---: | :---: | :---: |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n"
    );
    expect(parseTable(出.slice(出.indexOf("| A")))!.aligns).toEqual([
      "center",
      "center",
      "center",
    ]);
    editor.destroy();
  });

  it("批量只重写动过的那张表：旁边那张连分隔行的不规则写法都原样", () => {
    const 异形 = "| A | B | C |\n|:-----|:---:|-----:|\n| 1 | 2 | 3 |\n";
    const d: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        段("前一段\n", "", "前一段"),
        { kind: "table", id: null, raw: 异形, gapBefore: "\n", content: "", level: null, checked: null, align: null, fields: [], children: [] },
        { kind: "table", id: null, raw: 异形, gapBefore: "\n", content: "", level: null, checked: null, align: null, fields: [], children: [] },
      ],
    };
    for (const 做 of [
      (s: EditorState, 表: number, 矩: 矩形) => 清场所选(s, 表, 矩),
      (s: EditorState, 表: number, 矩: 矩形) => 填充所选(s, 表, 矩),
      (s: EditorState, 表: number, 矩: 矩形) => 对所齐所选(s, 表, 矩, "left"),
      (s: EditorState, 表: number, 矩: 矩形) => 删所选行(s, 表, 矩),
      (s: EditorState, 表: number, 矩: 矩形) => 删所选列(s, 表, 矩),
    ]) {
      const editor = createTestEditor(d);
      框住(editor, 归一({ 行: 1, 列: 0 }, { 行: 1, 列: 1 }), 3);
      const tr = 批量(editor.state, 做);
      expect(tr).not.toBeNull();
      editor.view.dispatch(tr!);
      expect(docToMarkdown(editor.state.doc, d).split(异形).length - 1).toBe(1);
      editor.destroy();
    }
  });
});

describe("文档位置 → 格子坐标：真机拖选的第一跳，之前被 jsdom 测试整个绕过", () => {
  it("格子内部与格子之前（边线上）两种位置都认得，行列算得对", () => {
    const editor = createTestEditor(表doc(三列));
    const 表 = 表起点(editor);
    for (let n = 0; n < 9; n++) {
      const 起 = 格起点(editor, n);
      const 期望 = { 表, 行: Math.floor(n / 3), 列: n % 3 };
      expect(格坐标At(editor.state, 起 + 1)).toEqual(期望); // 落在格子的文字里
      expect(格坐标At(editor.state, 起)).toEqual(期望); // 落在格子的边线 / 内边距上
    }
    editor.destroy();
  });

  it("表外的位置、以及行末之外都给 null", () => {
    const editor = createTestEditor(表doc(三列));
    expect(格坐标At(editor.state, 1)).toBeNull(); // 前面那个段落里
    const 表 = editor.state.doc.nodeAt(表起点(editor))!;
    expect(格坐标At(editor.state, 表起点(editor) + 表.nodeSize - 1)).toBeNull(); // 末行行末之外
    editor.destroy();
  });
});

/**
 * 第五轮复查（2026-10-08）抓到的四类：账本过不了剪贴板、块锚被吃掉、CRLF 整篇不接管、
 * 牌与下拉的状态与文件脱钩。共同点是**只有真把节点交出去一遍才看得见**——
 * 光测"装载 → 逐字节回写"那一段全都绿。
 */
const 一块 = (过: Partial<EditBlock>): EditDoc => ({
  frontMatter: "",
  trailingGap: "",
  blocks: [
    {
      kind: "code",
      id: null,
      raw: "",
      gapBefore: "",
      content: "",
      level: null,
      checked: null,
      align: null,
      fields: [],
      children: [],
      ...过,
    },
  ],
});

describe("围栏账本的三条死角", () => {
  it("块锚跟着代码块走：编辑这一块不许把 `^b-…` 从文件里抹掉", () => {
    // 内核把代码块的锚点单起一行写在闭栏之后。装载时为了判"闭栏在末行"要先摘掉它，
    // 忘了补回来就是：改一次代码 → 反链指过来的那个块 ID 消失。
    const 源 = "```rust\nfn a() {}\n```\n^b-f3g6j9l2mn\n";
    const doc = 一块({ kind: "code", id: "b-f3g6j9l2mn", raw: 源 });
    const editor = createTestEditor(doc);
    const 码 = 不透明块(editor)[0]!;
    expect(docToMarkdown(editor.state.doc, doc), "什么都不改").toBe(源);
    const 节点 = editor.state.doc.nodeAt(码.pos)!;
    editor.view.dispatch(
      editor.state.tr.insertText("b", 码.pos + 1 + 节点.textContent.length)
    );
    expect(docToMarkdown(editor.state.doc, doc), "改完锚点还在，且跟着这一块").toBe(
      "```rust\nfn a() {}b\n```\n^b-f3g6j9l2mn\n"
    );
    editor.destroy();
  });

  it("CRLF 的文件照样接管成单面，且回写仍是 CRLF", () => {
    const 源 = "```js\r\nlet a = 1;\r\n```\r\n";
    const doc = 一块({ kind: "code", raw: 源 });
    const editor = createTestEditor(doc);
    const 码 = 不透明块(editor)[0]!;
    const 壳 = 面孔(editor, 码.pos)!;
    expect(壳.querySelector(".md-view"), "CRLF 那块该是单面卡片").toBeNull();
    expect(壳.getAttribute("data-md-lang")).toBe("js");
    expect(docToMarkdown(editor.state.doc, doc)).toBe(源);
    editor.destroy();
  });

  it("复制粘贴走一遍 PM 的 DOM，围栏与类型都还在", () => {
    // PM 的剪贴板就是 `renderHTML` → `parseHTML`。围栏住在 attrs 里，不跟着进 DOM 就会
    // 贴出一堆裸行——`# 这行不是标题` 那样的内容直接变成真标题。
    const { doc } = load("03-代码表格与公式");
    const editor = createTestEditor(doc);
    const 码 = 不透明块(editor).find((b) => b.kind === "code")!;
    const 节点 = editor.state.doc.nodeAt(码.pos)!;
    const 包装 = document.createElement("div");
    包装.append(DOMSerializer.fromSchema(editor.state.schema).serializeNode(节点));
    const 贴回 = DOMParser.fromSchema(editor.state.schema).parseSlice(包装, {
      preserveWhitespace: true,
    });
    const 新 = 贴回.content.firstChild!;
    expect(新.attrs.mdFenceOpen).toBe(节点.attrs.mdFenceOpen);
    expect(新.attrs.mdFenceClose).toBe(节点.attrs.mdFenceClose);
    expect(新.attrs.mdKind, "类型丢了就退回两副面孔").toBe("code");
    expect(新.textContent).toBe(节点.textContent);
    editor.destroy();
  });
});

describe("语言牌与文件必须说同一句话", () => {
  const 带牌 = (开栏: string) => {
    const doc = 一块({ kind: "code", raw: `${开栏}\nlet a = 1;\n\`\`\`\n` });
    const editor = createTestEditor(doc);
    return { doc, editor, 码: 不透明块(editor)[0]! };
  };
  const 牌of = (editor: Editor, pos: number) =>
    (面孔(editor, pos)!.querySelector(".md-lang") as HTMLSelectElement | null)!;

  it("清单外的语言：反复进出不许攒出一堆重复选项", () => {
    const { editor, 码 } = 带牌("```klingon");
    const 牌 = 牌of(editor, 码.pos);
    const 基 = 牌.options.length;
    for (let 次 = 0; 次 < 6; 次++) {
      放进(editor, 码.pos);
      放到文末(editor);
    }
    expect(牌.options.length, "每进出一遍多一行一模一样的 klingon").toBe(基);
    expect([...牌.options].filter((o) => o.value === "klingon").length).toBe(1);
    editor.destroy();
  });

  it("选了又撤销：牌跟着回退，不许留着撤销前那个值", () => {
    const { editor, 码 } = 带牌("```js");
    const 牌 = 牌of(editor, 码.pos);
    牌.value = "go";
    牌.dispatchEvent(new Event("change", { bubbles: true }));
    expect(牌of(editor, 码.pos).value).toBe("go");
    // 撤销在文档层面就是一次 setNodeMarkup（history 也是发这个），焦点全程没动
    const 位 = 码.pos;
    const 现 = editor.state.doc.nodeAt(位)!;
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(位, undefined, { ...现.attrs, mdFenceOpen: "```js" })
    );
    expect(牌of(editor, 码.pos).value, "文件回到 js，牌还写着 go").toBe("js");
    expect(面孔(editor, 位)!.getAttribute("data-md-lang")).toBe("js");
    editor.destroy();
  });

  it("猜出来的词必须是清单里那一门：不许把 hljs 的内部名写进围栏", () => {
    // `短写` 认不出的一律不写。真写出去会是 ```` ```Batch file (DOS) ````——带空格的信息串
    // 下一份文件根本解析不回代码块。
    const { doc, editor, 码 } = 带牌("```");
    const 节点 = editor.state.doc.nodeAt(码.pos)!;
    const 假 = editor.state.schema.nodes.mdOpaque!.create(
      { ...节点.attrs, mdFenceOpen: "```" },
      [editor.state.schema.text("def f():\n    return 1")]
    );
    editor.view.dispatch(editor.state.tr.replaceWith(码.pos, 码.pos + 节点.nodeSize, 假));
    const 出 = docToMarkdown(editor.state.doc, doc);
    const 首行 = 出.split("\n")[0]!;
    expect(首行.startsWith("```")).toBe(true);
    expect(首行.split(/\s/).length, `写出来的是 ${首行}`).toBeLessThanOrEqual(2);
    if (首行 !== "```") expect(语言清单.some((l) => l.值 === 首行.slice(3))).toBe(true);
    editor.destroy();
  });
});

describe("代码块三件事：块内全选 / 行号 / 复制", () => {
  /** 走注册好的 keymap 按 Ctrl+A，返回有没有被接管 */
  const 按全选 = (editor: Editor) =>
    editor.view.someProp("handleKeyDown", (f) =>
      f(editor.view, new KeyboardEvent("keydown", { key: "a", code: "KeyA", ctrlKey: true }))
    ) === true;

  const 五行 = "```py\ndef a():\n    return 1\n\n\n# 尾行\n```\n";
  const 节点字数 = (editor: Editor, 起: number) => editor.state.doc.nodeAt(起)!.textContent.length;

  it("判据：不透明块里 → 块；整块已包住 → 全文；段落与表格交回默认", () => {
    const doc = 一块({ kind: "code", raw: 五行 });
    const editor = createTestEditor(doc);
    const 块起 = 不透明块(editor)[0]!.pos;
    editor.commands.setTextSelection(块起 + 2);
    expect(全选档(editor.state)).toBe("块");
    // 只选半截仍算"没选全"，下一档还是把整块包住
    editor.commands.setTextSelection({ from: 块起 + 2, to: 块起 + 8 });
    expect(全选档(editor.state)).toBe("块");
    editor.commands.setTextSelection({ from: 块起 + 1, to: 块起 + 1 + 节点字数(editor, 块起) });
    expect(全选档(editor.state)).toBe("全文");
    // 全选整篇之后 `$from` 落在文档开头（depth 0），这条判据直接交回默认：
    // 第三下 Ctrl+A 由浏览器再选一次整篇，不许把选区缩回块里
    editor.commands.selectAll();
    expect(全选档(editor.state)).toBeNull();
    editor.destroy();
  });

  it("普通段落与表格里的 Ctrl+A 不许被接管", () => {
    // 段落里用户要的就是全选整篇；表格有自己的格子矩形选区（tableSelectPlugin），
    // 抢下 Mod-a 会把那套判据整个绕开。这两类都必须交回默认，判据是"返回 null"。
    const { doc } = load("03-代码表格与公式");
    const editor = createTestEditor(doc);
    let 段 = -1;
    let 表 = -1;
    editor.state.doc.forEach((n, off) => {
      if (段 < 0 && n.type.name === "mdParagraph") 段 = off;
      if (表 < 0 && n.type.name === "mdTable") 表 = off;
    });
    expect(段).toBeGreaterThan(-1);
    editor.commands.setTextSelection(段 + 2);
    expect(全选档(editor.state)).toBeNull();
    expect(块内范围(editor.state)).toBeNull();
    expect(表).toBeGreaterThan(-1);
    editor.commands.setTextSelection(表 + 3);
    expect(全选档(editor.state)).toBeNull();
    editor.destroy();
  });

  it("Ctrl+A 两级：第一下正好是那块的正文，第二下才是整篇", () => {
    const editor = createTestEditor(一块({ kind: "code", raw: 五行 }));
    const 块起 = 不透明块(editor)[0]!.pos;
    editor.view.focus();
    editor.commands.setTextSelection(块起 + 2);
    expect(按全选(editor), "Ctrl+A 该被接管").toBe(true);
    let s = editor.state.selection;
    expect([s.from, s.to]).toEqual([块起 + 1, 块起 + 1 + 节点字数(editor, 块起)]);
    expect(按全选(editor)).toBe(true);
    s = editor.state.selection;
    expect([s.from, s.to]).toEqual([0, editor.state.doc.content.size]);
    // 第三下不许把选区缩回块里（否则全选整篇这条路就断了）
    expect(按全选(editor)).toBe(true);
    expect([editor.state.selection.from, editor.state.selection.to]).toEqual([
      0,
      editor.state.doc.content.size,
    ]);
    editor.destroy();
  });

  it("两行以上才有行号，且行号一个字节都进不了文件", () => {
    const 单 = createTestEditor(一块({ kind: "code", raw: "```js\nlet a = 1;\n```\n" }));
    expect(面孔(单, 不透明块(单)[0]!.pos)!.querySelector(".md-gutter"), "单行块不该挂个 1").toBeNull();
    单.destroy();

    const editor = createTestEditor(一块({ kind: "code", raw: 五行 }));
    const 起 = 不透明块(editor)[0]!.pos;
    const 槽 = () => 面孔(editor, 起)!.querySelector(".md-gutter");
    expect(槽()!.textContent).toBe("1\n2\n3\n4\n5");
    expect(槽()!.getAttribute("aria-hidden"), "读屏不该念一串数字").toBe("true");
    // 在正文末尾敲一个回车：行号跟着长，而产出里不许出现号码
    const 尾 = 起 + 1 + 节点字数(editor, 起);
    editor.view.dispatch(editor.state.tr.insertText("\n加一行", 尾));
    expect(槽()!.textContent!.split("\n").length).toBe(6);
    const 出 = docToMarkdown(editor.state.doc, 一块({ kind: "code", raw: 五行 }));
    expect(出).toContain("def a():");
    expect(出, "行号混进正文就是改用户字节").not.toMatch(/^1\n2\n/m);
    expect(出.split("\n").filter((l) => /^\d+$/.test(l))).toEqual([]);
    editor.destroy();
  });

  it("复制按钮抄的是围栏之间那段：不带围栏、不带行号、也不甩走插入符", () => {
    const 交: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: (s: string) => Promise.resolve(交.push(s)) },
      configurable: true,
    });
    const editor = createTestEditor(一块({ kind: "code", raw: 五行 }));
    const 起 = 不透明块(editor)[0]!.pos;
    const 卡 = 面孔(editor, 起)!;
    const 钮 = 卡.querySelector<HTMLButtonElement>(".md-copy")!;
    expect(钮, "单面代码块该有复制钮").toBeTruthy();
    expect(钮.getAttribute("aria-label")).toBe("复制代码");
    editor.view.focus();
    editor.commands.setTextSelection(起 + 3);
    钮.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    钮.click();
    return Promise.resolve().then(async () => {
      await Promise.resolve();
      expect(交[0]).toBe("def a():\n    return 1\n\n\n# 尾行");
      expect(交[0]).not.toContain("```");
      expect(卡.hasAttribute("data-copied"), "抄上了要给一眼看得见的回显").toBe(true);
      expect(editor.state.selection.from, "点复制不该把插入符甩进块里").toBe(起 + 3);
      editor.destroy();
    });
  });

  it("两副面孔的块（没闭栏）不给复制钮：它正文里就躺着围栏", () => {
    const editor = createTestEditor(一块({ kind: "code", raw: "```sh\n没有闭栏\n" }));
    const 卡 = 面孔(editor, 不透明块(editor)[0]!.pos)!;
    expect(卡.querySelector(".md-copy")).toBeNull();
    expect(卡.querySelector(".md-gutter"), "两面的卡片不套网格").toBeNull();
    editor.destroy();
  });
});

/**
 * 图片块。三件事各自都曾被当成"加个节点就行"，实际都得有判据：
 * 1. **哪些写法能接管**。原子块没有正文，那一行引用就是全部字节，拼不回去就是改用户文件；
 * 2. **单面**。代码块那一轮立下的杆子：光标进来不许换一副样子；
 * 3. **键盘出路**。图片是原子块，插入符进不去，块占了文末又不给出口，就是用户报过两次的那个死局。
 */
describe("图片块", () => {
  const 图片位 = (editor: Editor): number[] => {
    const 位: number[] = [];
    editor.state.doc.forEach((n, off) => {
      if (n.type.name === "mdImage") 位.push(off);
    });
    return 位;
  };
  const 图 = (editor: Editor, 位: number) => 面孔(editor, 位)!.querySelector(".md-img-alt")!;

  it("夹具 07：够格的接管，不够格的一个都不许接管", () => {
    const { doc } = load("07-图片");
    const editor = createTestEditor(doc);
    expect(图片位(editor)).toHaveLength(7);
    // 裸文件名、相对路径、带标题的那三种仍是 image 类型的不透明块（显示源文本）
    expect(不透明块(editor).filter((b) => b.kind === "image")).toHaveLength(3);

    const 们 = 图片位(editor).map((p) => editor.state.doc.nodeAt(p)!);
    expect(们[1]!.attrs.mdAlt, "别名进了 attrs，屏幕上才画得出图注").toBe("今年冬天");
    expect(们[0]!.attrs.mdNamed).toBe(false);
    expect(们[2]!.attrs.mdNamed, "![[x.png|]] 那根竖线是用户打的字").toBe(true);
    expect(
      String(们[3]!.attrs.mdSrc),
      "根相对的写法要照原样留着"
    ).toMatch(/^\/attachments\//);
    expect(们[4]!.attrs.mdWiki, "作者写的是 Markdown 形，落盘就还是 Markdown 形").toBe(false);
    expect(们[5]!.attrs.mdLead, "行首缩进是字节").toBe("  ");
    expect(们[6]!.attrs.mdId, "锚点跟着这一块").toBe("b-h3j5k7l9m0");
    editor.destroy();
  });

  it("单面：聚焦、选中、失焦都是同一批 DOM，屏幕上永远没有 ![[", () => {
    const doc = 一块({ kind: "image", raw: "![[attachments/a3/x.png]]\n" });
    const editor = createTestEditor(doc);
    const 位 = 图片位(editor)[0]!;
    const 壳 = 面孔(editor, 位)!;
    expect(壳.querySelector("img"), "屏幕上那一颗图就是内容").not.toBeNull();
    expect(壳.textContent).not.toContain("![[");

    editor.view.focus();
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 位))
    );
    expect(面孔(editor, 位), "选中不许换 DOM——换了就是又开一副面孔").toBe(壳);
    expect(壳.hasAttribute("data-md-sel")).toBe(true);
    expect(壳.querySelector("img")).not.toBeNull();
    expect(壳.textContent).not.toContain("![[");

    editor.view.dom.blur();
    expect(面孔(editor, 位)).toBe(壳);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("![[attachments/a3/x.png]]\n");
    editor.destroy();
  });

  it("图注是真输入框：打进去的字就是文件里的别名", () => {
    const doc = 一块({ kind: "image", raw: "![[attachments/a3/x.png]]\n" });
    const editor = createTestEditor(doc);
    const 框 = 图(editor, 图片位(editor)[0]!) as HTMLInputElement;
    框.value = "雪后的院子";
    框.dispatchEvent(new Event("change", { bubbles: true }));
    expect(docToMarkdown(editor.state.doc, doc)).toBe(
      "![[attachments/a3/x.png|雪后的院子]]\n"
    );
    editor.destroy();
  });

  it("清空图注：那根竖线一起收掉，不留 ![[x.png|]]", () => {
    const doc = 一块({ kind: "image", raw: "![[attachments/a3/x.png|院子]]\n" });
    const editor = createTestEditor(doc);
    const 框 = 图(editor, 图片位(editor)[0]!) as HTMLInputElement;
    框.value = "";
    框.dispatchEvent(new Event("change", { bubbles: true }));
    expect(docToMarkdown(editor.state.doc, doc)).toBe("![[attachments/a3/x.png]]\n");
    editor.destroy();
  });

  it("只是聚焦看一眼：一个字都不许多", () => {
    const doc = 一块({ kind: "image", raw: "![[attachments/a3/x.png|]]\n" });
    const editor = createTestEditor(doc);
    const 框 = 图(editor, 图片位(editor)[0]!) as HTMLInputElement;
    expect(框.value).toBe("");
    // 没改就不发 change。就算发了，空别名 + 原本有竖线也要原样回去
    框.dispatchEvent(new Event("change", { bubbles: true }));
    expect(docToMarkdown(editor.state.doc, doc)).toBe("![[attachments/a3/x.png|]]\n");
    editor.destroy();
  });

  it("CRLF 与锚点：改完图注，行尾回车仍然排在锚点之后", () => {
    const 源 = "![[attachments/a3/x.png]] ^b-f3g6j9l2mn\r\n";
    const doc = 一块({ kind: "image", id: "b-f3g6j9l2mn", raw: 源 });
    const editor = createTestEditor(doc);
    expect(docToMarkdown(editor.state.doc, doc), "什么都不改").toBe(源);
    const 框 = 图(editor, 图片位(editor)[0]!) as HTMLInputElement;
    框.value = "院子";
    框.dispatchEvent(new Event("change", { bubbles: true }));
    expect(docToMarkdown(editor.state.doc, doc)).toBe(
      "![[attachments/a3/x.png|院子]] ^b-f3g6j9l2mn\r\n"
    );
    editor.destroy();
  });

  it("接管不了的写法：一个字节都不动，也一颗图都不画", () => {
    for (const 源 of [
      "![[去年圣诞.png]]\n", // 裸文件名要的是全库解析
      "![](../outside.png)\n", // 相对路径同上
      '![x](attachments/i3/y.png "标题")\n', // 标题没搬进 attrs
    ]) {
      const doc = 一块({ kind: "image", raw: 源 });
      const editor = createTestEditor(doc);
      expect(图片位(editor), 源).toHaveLength(0);
      expect(不透明块(editor)[0]!.kind, 源).toBe("image");
      expect(docToMarkdown(editor.state.doc, doc), 源).toBe(源);
      editor.destroy();
    }
  });

  it("复制粘贴走一遍 PM 的 DOM，路径与图注都还在", () => {
    // PM 的剪贴板就是 renderHTML → parseHTML。路径不跟着进 DOM，贴出去就是没有图的一块
    const doc = 一块({ kind: "image", raw: "![[attachments/a3/x.png|院子]]\n" });
    const editor = createTestEditor(doc);
    const 位 = 图片位(editor)[0]!;
    const 节点 = editor.state.doc.nodeAt(位)!;
    const 包装 = document.createElement("div");
    包装.append(DOMSerializer.fromSchema(editor.state.schema).serializeNode(节点));
    const 新 = DOMParser.fromSchema(editor.state.schema)
      .parseSlice(包装, { preserveWhitespace: true })
      .content.child(0);
    expect(新.type.name).toBe("mdImage");
    expect(新.attrs.mdSrc).toBe(节点.attrs.mdSrc);
    expect(新.attrs.mdAlt).toBe(节点.attrs.mdAlt);
    expect(新.attrs.mdKind, "类型丢了就画不出图").toBe("image");
    editor.destroy();
  });

  it("粘两张图：空段落被换成图，后面跟着一个不落盘的落脚点", () => {
    const doc = 一块({ kind: "paragraph", raw: "" });
    const editor = createTestEditor(doc);
    const tr = 插图片块(editor.state, [
      新引用("attachments/a3/x.png"),
      新引用("attachments/b3/y.jpg"),
    ]);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    const 型们: string[] = [];
    editor.state.doc.forEach((n) => 型们.push(n.type.name));
    expect(型们).toEqual(["mdImage", "mdImage", "mdParagraph"]);
    expect(docToMarkdown(editor.state.doc, doc)).toBe(
      "![[attachments/a3/x.png]]\n\n![[attachments/b3/y.jpg]]"
    );
    // 粘完插入符在图片下面那一行：用户的下一件事是继续打字
    expect(editor.state.selection.$from.depth).toBe(1);
    expect(editor.state.doc.nodeAt(editor.state.selection.$from.before(1))!.type.name).toBe(
      "mdParagraph"
    );
    editor.destroy();
  });

  it("文末只有一张图时按 ↓：送出去，且文件一个字都没多", () => {
    const doc = 一块({ kind: "image", raw: "![[attachments/a3/x.png]]\n" });
    const editor = createTestEditor(doc);
    const 位 = 图片位(editor)[0]!;
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 位))
    );
    const tr = 图片下出口(editor.state);
    expect(tr, "图片是原子块，不给这条键就是死局").not.toBeNull();
    editor.view.dispatch(tr!);
    expect(editor.state.selection.$from.depth).toBe(1);
    expect(editor.state.doc.childCount).toBe(2);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("![[attachments/a3/x.png]]\n");
    editor.destroy();
  });

  it("光标不在图片上时那条键位不接管（别把 ↓ 抢成无关的事）", () => {
    const doc = 一块({ kind: "paragraph", raw: "一句话\n" });
    const editor = createTestEditor(doc);
    expect(图片下出口(editor.state)).toBeNull();
    editor.destroy();
  });

  it("浏览态只读：图注那个输入框也不许写进文件", () => {
    // 输入框不归 PM 管（它在 contentDOM 之外），所以 `editable=false` 不会自动挡住它。
    // 不自己上这道闸，"只是打开看一眼"就能把图注写进用户的文件。
    const 源 = "![[attachments/a3/x.png]]\n";
    const doc = 一块({ kind: "image", raw: 源 });
    const editor = createTestEditor(doc);
    editor.setEditable(false);
    const 框 = 图(editor, 图片位(editor)[0]!) as HTMLInputElement;
    框.value = "浏览态里打的字";
    框.dispatchEvent(new Event("change", { bubbles: true }));
    expect(docToMarkdown(editor.state.doc, doc)).toBe(源);
    editor.destroy();
  });
});

describe("图片块的整块移动", () => {
  it("选中一张图按 Alt+↓：块真的挪了，选区还跟着它", () => {
    const doc: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        {
          kind: "paragraph",
          id: null,
          raw: "上面一行\n",
          gapBefore: "",
          content: "上面一行",
          level: null,
          checked: null,
          align: null,
          fields: [],
          children: [],
        },
        {
          kind: "image",
          id: null,
          raw: "![[attachments/a3/x.png]]\n",
          gapBefore: "\n",
          content: "",
          level: null,
          checked: null,
          align: null,
          fields: [],
          children: [],
        },
      ],
    };
    const editor = createTestEditor(doc);
    // 图片是第二块：它的起点就是第一块的 nodeSize
    const 图位 = editor.state.doc.child(0).nodeSize;
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 图位))
    );
    const tr = moveCurrentBlock(editor.state, -1);
    expect(tr, "图片是原子块，不接这一支就是能看不能做").not.toBeNull();
    editor.view.dispatch(tr!);
    const 型们: string[] = [];
    editor.state.doc.forEach((n) => 型们.push(n.type.name));
    expect(型们).toEqual(["mdImage", "mdParagraph"]);
    const 选 = editor.state.selection;
    expect(选 instanceof NodeSelection, "选区要跟着块走，连按两次移的才是同一块").toBe(true);
    expect((选 as NodeSelection).node.type.name).toBe("mdImage");
    // 整串断言，不是 toContain：移动改的是**块间空白**，只查内容在不在等于没钉
    expect(docToMarkdown(editor.state.doc, doc)).toBe(
      "![[attachments/a3/x.png]]\n\n上面一行\n"
    );
    editor.destroy();
  });
});

/**
 * 第六轮复查照出来的六条。它们共同的形状是：**读侧有判据、写侧没有**，
 * 或者"界面看着没事、字节已经不对"。每一条都先用一个能跑红的用例钉住再修。
 */
describe("图片块：写侧必须跑同一份判据（第六轮复查）", () => {
  const 图块位 = (editor: Editor) => {
    const 位: number[] = [];
    editor.state.doc.forEach((n, off) => {
      if (n.type.name === "mdImage") 位.push(off);
    });
    return 位;
  };
  const 从剪贴板 = (editor: Editor, html: string) => {
    const 宿 = document.createElement("div");
    宿.innerHTML = html;
    return DOMParser.fromSchema(editor.state.schema).parseSlice(宿, { preserveWhitespace: true });
  };

  it("剪贴板里那个 data-md-src 想写什么就写什么？不行", () => {
    const editor = createTestEditor(一块({ kind: "paragraph", raw: "" }));
    // 注入面：目标里塞方括号与换行，拼回去就成了三个块
    const 坏 = 从剪贴板(
      editor,
      '<img data-md-src="a.png]]\n\n# 注入的标题\n![[b" data-md-alt="">'
    );
    expect(坏.content.firstChild, "这一份不该建成图片节点").toBeNull();
    // 越出库的相对路径同样不许进来
    expect(
      从剪贴板(editor, '<img data-md-src="../../../Windows/win.ini">').content.firstChild
    ).toBeNull();
    // 裸文件名不是我们管的形状（装载侧同一条判据）
    expect(从剪贴板(editor, '<img data-md-src="去年圣诞.png">').content.firstChild).toBeNull();
    // 合法的照旧进得来，且那根竖线跟着走一趟
    const 好 = 从剪贴板(
      editor,
      '<img data-md-src="attachments/a3/x.png" data-md-alt="" data-md-wiki="1" data-md-named="1">'
    ).content.child(0);
    expect(好.type.name).toBe("mdImage");
    expect(好.attrs.mdNamed, "复制粘贴一趟不该把用户打的竖线弄丢").toBe(true);
    editor.destroy();
  });

  it("选中一张图再粘：换掉它，而不是什么都不发生", () => {
    const doc = 一块({ kind: "image", raw: "![[attachments/a3/x.png]]\n" });
    const editor = createTestEditor(doc);
    const 位 = 图块位(editor)[0]!;
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 位))
    );
    const tr = 插图片块(editor.state, [新引用("attachments/b3/y.jpg")]);
    expect(tr, "字节已经落盘了，这一路返回 null 就是静默吞掉粘贴").not.toBeNull();
    editor.view.dispatch(tr!);
    const 们 = 图块位(editor).map((p) => String(editor.state.doc.nodeAt(p)!.attrs.mdSrc));
    expect(们).toEqual(["attachments/b3/y.jpg"]);
    editor.destroy();
  });

  it("图注里打竖线：落盘那一行下次还得接管得回来", () => {
    const doc = 一块({ kind: "image", raw: "![[attachments/a3/x.png]]\n" });
    const editor = createTestEditor(doc);
    const 框 = 面孔(editor, 图块位(editor)[0]!)!.querySelector(".md-img-alt") as HTMLInputElement;
    框.value = "左|右";
    框.dispatchEvent(new Event("change", { bubbles: true }));
    const 出 = docToMarkdown(editor.state.doc, doc);
    expect(出).toBe("![[attachments/a3/x.png|左|右]]\n");
    // 关键不是这行长什么样，而是它重新装载之后**还是图片块**（单面这根杆子不能被自己写的字节打破）
    const 二 = createTestEditor({ ...doc, blocks: [{ ...doc.blocks[0]!, raw: 出 }] });
    expect(图块位(二)).toHaveLength(1);
    expect(二.state.doc.firstChild!.attrs.mdAlt).toBe("左|右");
    editor.destroy();
    二.destroy();
  });

  it("图注里打方括号：收掉，且屏幕上写的与文件里落的是同一句", () => {
    const doc = 一块({ kind: "image", raw: "![[attachments/a3/x.png]]\n" });
    const editor = createTestEditor(doc);
    const 壳 = 面孔(editor, 图块位(editor)[0]!)!;
    const 框 = 壳.querySelector(".md-img-alt") as HTMLInputElement;
    框.value = "甲]乙\n丙";
    框.dispatchEvent(new Event("change", { bubbles: true }));
    const 出 = docToMarkdown(editor.state.doc, doc);
    expect(出).toBe("![[attachments/a3/x.png|甲乙丙]]\n");
    expect(框.value, "被打掉的字符不许留在框里骗人").toBe("甲乙丙");
    editor.destroy();
  });

  it("值没变：一个事务都不发（不然整篇被顶成未保存）", () => {
    const doc = 一块({ kind: "image", raw: "![[attachments/a3/x.png|]]\n" });
    const editor = createTestEditor(doc);
    const 框 = 面孔(editor, 图块位(editor)[0]!)!.querySelector(".md-img-alt") as HTMLInputElement;
    let 次 = 0;
    editor.on("transaction", () => 次++);
    框.dispatchEvent(new Event("change", { bubbles: true }));
    expect(次, "空事务照样走 onUpdate，而脏判据是 inlineRev > 0").toBe(0);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("![[attachments/a3/x.png|]]\n");
    editor.destroy();
  });

  it("撤销之后图注框跟着回退（焦点还在框里也一样）", () => {
    const doc = 一块({ kind: "image", raw: "![[attachments/a3/x.png]]\n" });
    const editor = createTestEditor(doc);
    const 壳 = 面孔(editor, 图块位(editor)[0]!)!;
    const 框 = 壳.querySelector(".md-img-alt") as HTMLInputElement;
    框.focus();
    框.value = "先打一个字";
    框.dispatchEvent(new Event("input", { bubbles: true }));
    框.dispatchEvent(new Event("change", { bubbles: true }));
    expect(框.value).toBe("先打一个字");
    框.focus();
    editor.view.someProp("handleKeyDown", (f) =>
      f(editor.view, new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true }))
    );
    expect(框.value, "撤销完框里还写着撤销前的值，用户一 blur 就把旧内容写回文件").toBe("");
    editor.destroy();
  });

  it("读不到地址就是读不到：直接进那一面，不等 error 事件", () => {
    // jsdom 里 `资产地址` 永远给空串（不在 Tauri），正好是这条判据的天然样本。
    // 浏览器不会因为 src 被摘掉而抛 error，所以"等 error"的写法会留下一个既没图也没名牌的空框
    const editor = createTestEditor(一块({ kind: "image", raw: "![[attachments/a3/x.png]]\n" }));
    const 壳 = 面孔(editor, 图块位(editor)[0]!)!;
    expect(壳.hasAttribute("data-md-miss")).toBe(true);
    expect(壳.querySelector(".md-img-miss")!.textContent).toBe("x.png");
    editor.destroy();
  });
});

/**
 * 整块删除。用户报的是"选不中代码块，删不掉"，量出来的根因是：`mdOpaque` 不是 atom，
 * 但 PM 允许给它发 NodeSelection，而**没有任何交互会发**——点哪儿都落回插入符，
 * 于是"删掉这一块"只剩"把字删干净"那条路，留下一个空围栏。
 * 这组测试钉的就是那三件事：删干净、留落脚点、别在跨块选区上乱删。
 */
describe("整块删除：点到卡片身上与手柄菜单那一项", () => {
  const 三块 = (): EditDoc => ({
    frontMatter: "",
    trailingGap: "",
    blocks: [
      { kind: "paragraph", id: null, raw: "上面那句\n", gapBefore: "", content: "上面那句", level: null, checked: null, align: null, fields: [], children: [] },
      { kind: "code", id: null, raw: "```py\nx = 1\n```\n", gapBefore: "\n", content: "x = 1", level: null, checked: null, align: null, fields: [], children: [] },
      { kind: "paragraph", id: null, raw: "下面那句\n", gapBefore: "\n", content: "下面那句", level: null, checked: null, align: null, fields: [], children: [] },
    ],
  });

  it("夹具合法：装载后逐字节等于源文件", () => {
    const d = 三块();
    const editor = createTestEditor(d);
    expect(docToMarkdown(editor.state.doc, d)).toBe(reassemble(d));
    editor.destroy();
  });

  it("反面：把块里的字删干净，留下的还是空围栏——所以要的是删块，不是删字", () => {
    const d = 三块();
    const editor = createTestEditor(d);
    const 块 = 不透明块(editor)[0]!;
    放进(editor, 块.pos);
    const 范 = 块内范围(editor.state)!;
    editor.view.dispatch(
      editor.state.tr.setSelection(
        new TextSelection(editor.state.doc.resolve(范.起), editor.state.doc.resolve(范.止))
      )
    );
    editor.commands.deleteSelection();
    const 出 = docToMarkdown(editor.state.doc, d);
    expect(出).toContain("```py");
    expect(出).not.toContain("x = 1");
    editor.destroy();
  });

  it("删块在：围栏整块走，前后两块逐字节不动", () => {
    const d = 三块();
    const editor = createTestEditor(d);
    const 块 = 不透明块(editor)[0]!;
    const tr = 删块在(editor.state, 块.pos);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(docToMarkdown(editor.state.doc, d)).toBe("上面那句\n\n下面那句\n");
    expect(editor.state.selection.$from.depth, "删完光标要站在某个块里").toBeGreaterThan(0);
    editor.destroy();
  });

  it("删的是文档里最后一块：留一个空段落当落脚点，不给键盘死局", () => {
    const d = 一块({ kind: "code", raw: "```py\nx = 1\n```\n" });
    const editor = createTestEditor(d);
    const tr = 删块在(editor.state, 不透明块(editor)[0]!.pos)!;
    editor.view.dispatch(tr);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.child(0).type.name).toBe("mdParagraph");
    expect(editor.state.selection.$from.depth).toBeGreaterThan(0);
    expect(docToMarkdown(editor.state.doc, d)).toBe("");
    editor.destroy();
  });

  it("整块选中（NodeSelection）之后：删当前块删的就是那一块", () => {
    const d = 三块();
    const editor = createTestEditor(d);
    const 块 = 不透明块(editor)[0]!;
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 块.pos))
    );
    const tr = 删当前块(editor.state);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(docToMarkdown(editor.state.doc, d)).toBe("上面那句\n\n下面那句\n");
    editor.destroy();
  });

  it("选区是一段跨块的文字：删当前块返回 null，不猜要删几块", () => {
    const d = 三块();
    const editor = createTestEditor(d);
    editor.commands.setTextSelection({ from: 3, to: editor.state.doc.content.size - 3 });
    expect(删当前块(editor.state)).toBeNull();
    editor.destroy();
  });

  it("点在卡片头那一行 = 选中整块；点在代码文字上不会被抢成整块", () => {
    const d = 三块();
    const editor = createTestEditor(d);
    const 块 = 不透明块(editor)[0]!;
    const 壳 = 面孔(editor, 块.pos)!;
    const 按 = (元: Element | null) =>
      元!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    按(壳.querySelector(".md-card-head"));
    expect(editor.state.selection, "点到卡片身上就该是整块").toBeInstanceOf(NodeSelection);
    expect((editor.state.selection as NodeSelection).from).toBe(块.pos);
    /**
     * 选区对了还不算——**必须在 DOM 上留得下标记**，否则没有一条 CSS 认得出"这块被选了"，
     * 用户看到的就是"选中是选中了，但什么都没变"。PM 的默认做法是加
     * `ProseMirror-selectednode` 那个类，而配套样式表我们没 import，所以那条路是空的：
     * 这一条断言钉的是 `OpaqueView.selectNode` 真的被 PM 调到了。
     */
    expect(壳.hasAttribute("data-md-sel"), "选中没在 DOM 上留标记 = 看不见的那一档").toBe(true);
    /**
     * 反面：点在 `<pre>` 上要的还是插入符。jsdom 没有 `elementFromPoint`，PM 的默认
     * mousedown 一路会撞上去（异常从 jsdom 的事件派发里漏出来，测试收不到），所以这里
     * 把它桩成"量不到坐标"——PM 什么都不做，于是这一条判的是**我们有没有抢这一击**：
     * 先把选区放成文字光标，再点一次，它必须还是文字光标。
     */
    (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => null;
    放进(editor, 块.pos);
    按(壳.querySelector(".md-src"));
    expect(editor.state.selection, "点正文不该变成整块选中").not.toBeInstanceOf(NodeSelection);
    expect(editor.state.selection.$from.depth).toBeGreaterThan(0);
    expect(壳.hasAttribute("data-md-sel"), "换回文字光标就得把标记摘掉，不然它永远亮着").toBe(false);
    editor.destroy();
  });
});

describe("块级对齐（docs/02 D40）", () => {
  it("居中落成 div + 空行包裹；清掉时签名回到装载时的形状，逐字节回写", () => {
    const { src, doc } = load("08-对齐");
    const editor = createTestEditor(doc);
    let pos = -1;
    editor.state.doc.forEach((n, p) => {
      if (n.textContent === "普通段落。") pos = p;
    });
    expect(pos).toBeGreaterThan(0);
    editor.commands.setTextSelection(pos + 1);

    const r1 = applyBlockAlign(editor.state, "center");
    expect(r1.跳过).toBe(0);
    expect(r1.tr).not.toBeNull();
    editor.view.dispatch(r1.tr!);
    const 产出 = docToMarkdown(editor.state.doc, doc);
    // 空行是语法的一部分：没有它们，别家阅读器会把里面的 Markdown 当字面文字
    expect(产出).toContain('<div align="center">\n\n普通段落。\n\n</div>');
    // 屏幕上也得是这一档：data-md-align 是 CSS 的唯一入口。按块取 DOM——
    // 样本里还有别的居中块，全篇 querySelector 分不出改的是不是这一块
    const 这一块 = () => editor.view.nodeDOM(pos) as HTMLElement;
    expect(这一块().getAttribute("data-md-align")).toBe("center");

    // 连点两次居中不该产生事务（否则这篇被标成待保存）
    expect(applyBlockAlign(editor.state, "center").tr).toBeNull();

    const r2 = applyBlockAlign(editor.state, "left");
    expect(r2.tr).not.toBeNull();
    editor.view.dispatch(r2.tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toBe(src);
    expect(这一块().hasAttribute("data-md-align")).toBe(false);
    editor.destroy();
  });

  it("标题也能对齐：包裹里仍是 ATX 标题", () => {
    const { doc } = load("08-对齐");
    const editor = createTestEditor(doc);
    let pos = -1;
    editor.state.doc.forEach((n, p) => {
      if (n.textContent === "右对齐标题") pos = p;
    });
    editor.commands.setTextSelection(pos + 1);
    const { tr } = applyBlockAlign(editor.state, "justify");
    editor.view.dispatch(tr!);
    expect(docToMarkdown(editor.state.doc, doc)).toContain(
      '<div align="justify">\n\n## 右对齐标题\n\n</div>',
    );
    editor.destroy();
  });

  it("居中块转成列表时清掉对齐账本，转回正文不会复活", () => {
    const { doc } = load("08-对齐");
    const editor = createTestEditor(doc);
    let pos = -1;
    editor.state.doc.forEach((n, p) => {
      if (n.textContent.startsWith("居中的一段")) pos = p;
    });
    expect(pos).toBeGreaterThan(0);
    expect(editor.state.doc.nodeAt(pos)!.attrs.mdAlign).toBe("center");
    editor.view.dispatch(applyBlockType(editor.state, pos, "bullet")!);
    expect(editor.state.doc.nodeAt(pos)!.attrs.mdAlign).toBe("");
    editor.view.dispatch(applyBlockType(editor.state, pos, "paragraph")!);
    expect(editor.state.doc.nodeAt(pos)!.attrs.mdAlign).toBe("");
    editor.destroy();
  });

  it("列表不参与：没有事务，跳过的块数报出来", () => {
    const doc: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        {
          kind: "bullet",
          id: null,
          raw: "- 列表项\n",
          gapBefore: "",
          content: "列表项",
          level: null,
          checked: null,
          align: null,
          fields: [],
          children: [],
        },
      ],
    };
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(2);
    const r = applyBlockAlign(editor.state, "center");
    expect(r.tr).toBeNull();
    expect(r.跳过).toBe(1);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("- 列表项\n");
    editor.destroy();
  });

  it("混选：只改正文与标题，列表原样，跳过的块数报出来", () => {
    const doc: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        {
          kind: "paragraph",
          id: null,
          raw: "正文\n",
          gapBefore: "",
          content: "正文",
          level: null,
          checked: null,
          align: null,
          fields: [],
          children: [],
        },
        {
          kind: "bullet",
          id: null,
          raw: "- 列表项\n",
          gapBefore: "",
          content: "列表项",
          level: null,
          checked: null,
          align: null,
          fields: [],
          children: [],
        },
      ],
    };
    const editor = createTestEditor(doc);
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 1, editor.state.doc.content.size - 1),
      ),
    );
    const r = applyBlockAlign(editor.state, "right");
    expect(r.跳过).toBe(1);
    expect(r.tr).not.toBeNull();
    editor.view.dispatch(r.tr!);
    const out = docToMarkdown(editor.state.doc, doc);
    expect(out).toContain('<div align="right">\n\n正文\n\n</div>');
    expect(out).toContain("- 列表项\n");
    editor.destroy();
  });

  it("setext 标题不开放对齐：判据为假，调用也不发事务", () => {
    const doc: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        {
          kind: "heading",
          id: null,
          raw: "标题\n===\n",
          gapBefore: "",
          content: "标题",
          level: 1,
          checked: null,
          align: null,
          fields: [],
          children: [],
        },
      ],
    };
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(2);
    // 点一下对齐不该把 `标题\n===` 悄悄落成 `# 标题`（D40 只认包裹里的 ATX）
    expect(有可对齐块(editor.state)).toBe(false);
    const r = applyBlockAlign(editor.state, "center");
    expect(r.tr).toBeNull();
    expect(r.跳过).toBe(1);
    expect(docToMarkdown(editor.state.doc, doc)).toBe("标题\n===\n");
    editor.destroy();
  });

  it("混选里的 setext 标题与列表一样跳过，正文照改", () => {
    const doc: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        {
          kind: "heading",
          id: null,
          raw: "标题\n===\n",
          gapBefore: "",
          content: "标题",
          level: 1,
          checked: null,
          align: null,
          fields: [],
          children: [],
        },
        {
          kind: "paragraph",
          id: null,
          raw: "正文\n",
          gapBefore: "\n",
          content: "正文",
          level: null,
          checked: null,
          align: null,
          fields: [],
          children: [],
        },
      ],
    };
    const editor = createTestEditor(doc);
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 1, editor.state.doc.content.size - 1),
      ),
    );
    const r = applyBlockAlign(editor.state, "center");
    expect(r.跳过).toBe(1);
    expect(r.tr).not.toBeNull();
    editor.view.dispatch(r.tr!);
    const out = docToMarkdown(editor.state.doc, doc);
    expect(out).toContain("标题\n===\n");
    expect(out).toContain('<div align="center">\n\n正文\n\n</div>');
    editor.destroy();
  });

  it("空段落设对齐不落字节：mdAlign 记住，等用户真打字才写出包裹", () => {
    const doc: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        {
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
        },
        {
          kind: "paragraph",
          id: null,
          raw: "",
          gapBefore: "\n",
          content: "",
          level: null,
          checked: null,
          align: null,
          fields: [],
          children: [],
        },
      ],
    };
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const r = applyBlockAlign(editor.state, "center");
    expect(r.tr).not.toBeNull();
    editor.view.dispatch(r.tr!);
    expect(editor.state.doc.lastChild!.attrs.mdAlign).toBe("center");
    // Markdown 没有"空段落"：这一笔在盘上不占字节，下一次打字才变成包裹
    expect(docToMarkdown(editor.state.doc, doc)).toBe("甲\n");
    editor.destroy();
  });

  it("多块共同档：不同档时给 null，统一后跟着变；列表不参与", () => {
    const doc: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        {
          kind: "paragraph",
          id: null,
          raw: '<div align="center">\n\n甲\n\n</div>\n',
          gapBefore: "",
          content: "甲",
          level: null,
          checked: null,
          align: "center",
          fields: [],
          children: [],
        },
        {
          kind: "paragraph",
          id: null,
          raw: "乙\n",
          gapBefore: "\n",
          content: "乙",
          level: null,
          checked: null,
          align: null,
          fields: [],
          children: [],
        },
        {
          kind: "bullet",
          id: null,
          raw: "- 丙\n",
          gapBefore: "\n",
          content: "丙",
          level: null,
          checked: null,
          align: null,
          fields: [],
          children: [],
        },
      ],
    };
    const editor = createTestEditor(doc);
    const 全选 = () =>
      editor.view.dispatch(
        editor.state.tr.setSelection(
          TextSelection.create(editor.state.doc, 1, editor.state.doc.content.size - 1),
        ),
      );
    全选();
    // 甲居中、乙靠左：按钮一盏都不该亮
    expect(共同对齐(editor.state)).toBeNull();
    const r = applyBlockAlign(editor.state, "center");
    expect(r.跳过).toBe(1);
    editor.view.dispatch(r.tr!);
    全选();
    // 列表不在可对齐名单里，不把共同档拉成 null
    expect(共同对齐(editor.state)).toBe("center");
    editor.destroy();
  });

  it("剪贴板 HTML 里的 data-md-align 能读回，非法值不接", () => {
    const doc: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        {
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
        },
      ],
    };
    const editor = createTestEditor(doc);
    // 粘贴走的也是 schema 的 parseHTML，直接喂同一份解析器，省得在 jsdom 里造 ClipboardEvent
    const 解析 = (html: string) => {
      const 壳 = document.createElement("div");
      壳.innerHTML = html;
      return DOMParser.fromSchema(editor.schema).parse(壳);
    };
    expect(解析('<p data-md-align="center">粘</p>').firstChild?.attrs.mdAlign).toBe("center");
    expect(解析('<p data-md-align="middle">歪</p>').firstChild?.attrs.mdAlign).toBe("");
    editor.destroy();
  });

  it("对齐块带独占锚点行：编辑后锚点仍在，只是挪进包裹", () => {
    const doc: EditDoc = {
      frontMatter: "",
      trailingGap: "",
      blocks: [
        {
          kind: "paragraph",
          id: "b-abc",
          raw: '<div align="center">\n\n正文\n\n</div>\n^b-abc\n',
          gapBefore: "",
          content: "正文",
          level: null,
          checked: null,
          align: "center",
          fields: [],
          children: [],
        },
      ],
    };
    const editor = createTestEditor(doc);
    editor.commands.setTextSelection(3);
    editor.commands.insertContent("新");
    expect(docToMarkdown(editor.state.doc, doc)).toContain(
      '<div align="center">\n\n正文新 ^b-abc\n\n</div>',
    );
    editor.destroy();
  });
});
