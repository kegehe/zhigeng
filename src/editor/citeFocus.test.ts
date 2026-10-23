import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { createTestEditor } from "./testEditor";
import { 顶层块区, 标出引用块, 就绪后标出 } from "./citeFocus";
import { docToJson, stampSignatures, type EditBlock, type EditDoc } from "./blocks";
import { mdExtensions } from "./schema";

function 块(
  raw: string,
  kind = "paragraph",
  content = raw.trim(),
  children: EditBlock[] = [],
): EditBlock {
  return {
    kind,
    id: null,
    raw,
    gapBefore: "\n",
    content,
    level: kind === "heading" ? 1 : null,
    checked: null,
    fields: [],
    children,
  };
}

const 一份: EditDoc = {
  frontMatter: "",
  trailingGap: "",
  blocks: [
    块("# 标题\n", "heading", "标题"),
    // 子块在 md-kernel 里是父块的一部分，渲染成一个顶层节点；不能让它多占一个序号
    块("- 甲\n  - 子\n", "bullet", "甲", [块("  - 子\n", "bullet", "子")]),
    块("尾段\n"),
  ],
};

describe("引用落点", () => {
  it("序号数的是顶层块，嵌套子块不占位", () => {
    const editor = createTestEditor(一份);
    expect(editor.state.doc.childCount).toBe(3);
    const 区 = 顶层块区(editor.state.doc, 2);
    expect(区).not.toBeNull();
    expect(editor.state.doc.textBetween(区!.from, 区!.to)).toContain("甲");
    expect(editor.state.doc.textBetween(区!.from, 区!.to)).not.toContain("尾段");
    editor.destroy();
  });

  it("标出后正文里有高亮，第一次改动就清掉", () => {
    const editor = createTestEditor(一份);
    expect(标出引用块(editor, 2)).toBe(true);
    expect(editor.view.dom.querySelectorAll(".cite-hit")).toHaveLength(1);

    editor.commands.insertContentAt(1, "改");
    expect(editor.view.dom.querySelectorAll(".cite-hit")).toHaveLength(0);
    editor.destroy();
  });

  it("旧引用指向已不存在的块时不报错也不乱标", () => {
    const editor = createTestEditor(一份);
    expect(标出引用块(editor, 99)).toBe(false);
    expect(editor.view.dom.querySelectorAll(".cite-hit")).toHaveLength(0);
    editor.destroy();
  });

  /**
   * TipTap v3 的 `create` 是 `setTimeout(0)` 之后才发的，`onCreate` 里打的签名事务
   * 会把整篇 replaceWith 一遍。在 create 之前标，高亮会被那笔事务清掉、选区被映射到文末。
   */
  it("create 之前不标，等打签名的那一步跑完再标", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    let stamped = false;
    const editor = new Editor({
      element: el,
      extensions: mdExtensions,
      content: docToJson(一份) as never,
      onCreate: ({ editor: e }) => {
        const tr = stampSignatures(e.state);
        if (tr) e.view.dispatch(tr);
        stamped = true;
      },
    });
    expect(editor.isInitialized).toBe(false);

    const 撤 = 就绪后标出(editor, 2);
    expect(editor.view.dom.querySelectorAll(".cite-hit")).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 30));
    expect(stamped).toBe(true);
    expect(editor.view.dom.querySelectorAll(".cite-hit")).toHaveLength(1);
    expect(editor.view.dom.querySelector(".cite-hit")?.textContent).toContain("甲");
    撤();
    editor.destroy();
  });
});
