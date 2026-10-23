import { Extension, type Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * 引用落点。**顶层块序号**来自索引的 `chunks.start_block`，不是 `chunks.id`：
 * 编辑器一篇文章只装顶层块，嵌套子项的字节在父块 `raw` 里，所以两者不能用同一个序号。
 */
type 区间 = { from: number; to: number };

export const 引用高亮键 = new PluginKey<区间 | null>("mdCiteFocus");

/**
 * 高亮只活到下一次文档改动。用户开始编辑就清掉——否则那段底色会像"这一块还没保存"，
 * 而它只是上一次引用的痕迹。选区变化不清：点引用后滚过去、再点一下别处，底色还在。
 */
const 引用高亮插件 = new Plugin<区间 | null>({
  key: 引用高亮键,
  state: {
    init: () => null,
    apply(tr, 旧) {
      const 指定 = tr.getMeta(引用高亮键) as 区间 | null | undefined;
      if (指定 !== undefined) return 指定;
      return tr.docChanged ? null : 旧;
    },
  },
  props: {
    decorations(state) {
      const 区 = 引用高亮键.getState(state);
      if (!区) return null;
      return DecorationSet.create(state.doc, [
        Decoration.node(区.from, 区.to, { class: "cite-hit" }),
      ]);
    },
  },
});

export const 引用高亮扩展 = Extension.create({
  name: "citeFocus",
  addProseMirrorPlugins() {
    return [引用高亮插件];
  },
});

/** 第 `ordinal` 个顶层块的文档区间。序号超出范围返回 null（旧引用指向已删的块）。 */
export function 顶层块区(doc: PmNode, ordinal: number): 区间 | null {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > doc.childCount) return null;
  let from = 0;
  for (let i = 0; i < ordinal - 1; i += 1) from += doc.child(i).nodeSize;
  return { from, to: from + doc.child(ordinal - 1).nodeSize };
}

/**
 * 定位到第 `ordinal` 个顶层块：选中它、滚进视口、挂上高亮。
 * 返回 false 表示这一版文档里已经没有那一块（引用过期），调用方不必报错。
 */
export function 标出引用块(editor: Editor, ordinal: number): boolean {
  const 区 = 顶层块区(editor.state.doc, ordinal);
  if (!区) return false;
  const 节 = editor.state.doc.nodeAt(区.from);
  const tr = editor.state.tr.setMeta(引用高亮键, 区);
  if (节?.isAtom) {
    tr.setSelection(NodeSelection.create(editor.state.doc, 区.from));
  } else {
    tr.setSelection(TextSelection.near(editor.state.doc.resolve(区.from + 1)));
  }
  editor.view.dispatch(tr.scrollIntoView());
  // PM 的 scrollToSelection 读 DOM 选区：点引用时焦点还在问答按钮上，新挂载的编辑器
  // 选区没落进去，它会跳过滚动。按块节点自己滚一次，"跳过去"就不取决于此刻有没有焦点。
  const dom = editor.view.nodeDOM(区.from);
  if (dom instanceof HTMLElement && typeof dom.scrollIntoView === "function") {
    dom.scrollIntoView({ block: "center", inline: "nearest" });
  }
  editor.view.focus();
  return true;
}

/**
 * 等首次 `create` 之后再标出。TipTap v3 把 create 推到 `setTimeout(0)`，
 * 而 `onCreate` 里要 `stampSignatures`（整篇 replaceWith，docChanged）。
 * 在 create 之前标，高亮会被那笔事务清掉、选区被映射到文末——真机第一轮就是这样。
 *
 * `create` 监听在构造时的 `onCreate` 之后注册，所以打签名总在定位之前跑完。
 */
export function 就绪后标出(editor: Editor, ordinal: number): () => void {
  if (editor.isInitialized) {
    标出引用块(editor, ordinal);
    return () => {};
  }
  const 标 = () => {
    标出引用块(editor, ordinal);
  };
  editor.on("create", 标);
  return () => {
    editor.off("create", 标);
  };
}
