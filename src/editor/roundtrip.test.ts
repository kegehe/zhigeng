import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestEditor } from "./testEditor";
import { applyBlockType, docToMarkdown, reassemble, type BlockTypeId, type EditDoc } from "./blocks";

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

/**
 * 块类型切换：`#` 输入规则、`/` 斜杠菜单、气泡里的类型菜单**共用 `applyBlockType`**，
 * 所以这里绿一次，三处入口都绿一次。分叉过一次教训：显示用一套、落盘用另一套，
 * 用户看到的就是"改了没生效"或者"改一个字洗掉一片格式"。
 */
describe("块类型切换的产出仍是字节级正确的 Markdown", () => {
  const 样本 = () => {
    const blocks: EditDoc["blocks"] = [
      {
        kind: "paragraph",
        id: null,
        raw: "正文一段。\n",
        gapBefore: "",
        content: "正文一段。",
        level: null,
        checked: null,
        fields: [],
        children: [],
      },
      {
        kind: "heading",
        id: "b-h2",
        raw: "## 一个二级标题 ^b-h2\n",
        gapBefore: "\n",
        content: "一个二级标题",
        level: 2,
        checked: null,
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
        fields: [],
        children: [],
      },
    ];
    const doc: EditDoc = { frontMatter: "", trailingGap: "", blocks };
    return { doc, src: reassemble(doc) };
  };

  /** 按谓词找一个顶层块的位置（顶层块的 offset 就是绝对位置） */
  const 位置 = (editor: ReturnType<typeof createTestEditor>, 找: (n: { attrs: Record<string, unknown>; textContent: string }) => boolean) => {
    let pos = -1;
    editor.state.doc.forEach((node, offset) => {
      if (pos < 0 && 找(node as never)) pos = offset;
    });
    expect(pos).toBeGreaterThanOrEqual(0);
    return pos;
  };

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
    const { doc, src } = 样本();
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
