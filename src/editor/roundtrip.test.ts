import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestEditor } from "./testEditor";
import { docToMarkdown, reassemble, type EditDoc } from "./blocks";

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
