import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestEditor } from "./testEditor";
import {
  applyBlockType,
  docToMarkdown,
  insertSourceBlock,
  INSERTABLE,
  replaceBlockWithSource,
  moveBlock,
  moveCurrentBlock,
  reassemble,
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
  });

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
