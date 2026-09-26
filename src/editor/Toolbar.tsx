import { undo, redo, undoDepth, redoDepth } from "@tiptap/pm/history";
import type { Editor } from "@tiptap/react";
import { useEffect, useState } from "react";
import { applyBlockType, BLOCK_TYPES, type BlockTypeId } from "./blocks";

/**
 * 常驻顶部工具栏。
 *
 * 为什么单独一个组件、自己订阅编辑器事件：这样事件来了只有它重渲染。放在
 * `BlockEditor` 里 `setState` 的话，每次选区变化都会连带重渲染 `EditorContent`——
 * 打字路径上凭空多一次整棵 React 子树的协调。
 *
 * 只放**序列化器产得出来**的东西：七种块类型 + 四种行内标记 + 撤销重做。字号、居中、
 * 颜色不放——Markdown 没有语法承载，放了就是"点了看着生效，落盘没了"（口径见 [02] D27）。
 * 链接也不在这儿：它需要一个输入框，而选区气泡上已经有，两处各做一份必然分叉。
 */
export function Toolbar({ editor }: { editor: Editor }) {
  const [, bump] = useState(0);

  useEffect(() => {
    const on = () => bump((n) => n + 1);
    editor.on("selectionUpdate", on);
    editor.on("update", on);
    return () => {
      editor.off("selectionUpdate", on);
      editor.off("update", on);
    };
  }, [editor]);

  const { $from } = editor.state.selection;
  const node = $from.depth > 0 ? $from.parent : null;
  const typeName = node ? node.type.name : "";
  const opaque = typeName === "mdOpaque";
  const mdKind = String(node?.attrs.mdKind ?? "paragraph");
  const mdLevel = Number(node?.attrs.mdLevel ?? 0);
  const 当前类型: BlockTypeId =
    typeName === "mdHeading"
      ? (`heading${Math.min(3, Math.max(1, mdLevel))}` as BlockTypeId)
      : typeName === "mdItem"
        ? (mdKind as BlockTypeId)
        : "paragraph";
  const 可选 = typeName === "mdParagraph" || typeName === "mdHeading" || typeName === "mdItem";

  const setType = (id: BlockTypeId) => {
    if (!node) return;
    const start = $from.depth === 0 ? 0 : $from.before(1);
    const tr = applyBlockType(editor.state, start, id);
    // 目标就是当前类型时 applyBlockType 给 null：点了同一项不该产生一次落盘
    if (tr) editor.view.dispatch(tr.scrollIntoView());
  };

  const btn = (name: string, 标签: string, 样例: string) => (
    <button
      key={name}
      type="button"
      title={标签}
      className={editor.isActive(name) ? "on" : ""}
      onClick={() => editor.chain().focus().toggleMark(name).run()}
    >
      {样例}
    </button>
  );

  return (
    <div
      className="toolbar"
      // 点工具栏不该把正文的选区弄丢：焦点一移走，选区就空了，按钮立刻变成"不知道改谁"
      onMouseDown={(e) => e.preventDefault()}
      role="toolbar"
      aria-label="格式与块类型"
    >
      {可选 || opaque ? (
        <select
          aria-label="块类型"
          value={opaque ? "opaque" : 当前类型}
          disabled={opaque}
          onChange={(e) => setType(e.target.value as BlockTypeId)}
        >
          {opaque ? <option value="opaque">不透明块（引用 / 表格 / 代码）</option> : null}
          {BLOCK_TYPES.map((b) => (
            <option key={b.id} value={b.id}>
              {b.标签}
            </option>
          ))}
        </select>
      ) : (
        <select aria-label="块类型" value="none" disabled>
          <option value="none">没有可改的块</option>
        </select>
      )}
      <span className="sep" aria-hidden="true" />
      {btn("bold", "加粗", "B")}
      {btn("italic", "斜体", "I")}
      {btn("strike", "删除线", "S")}
      {btn("code", "行内代码", "{}")}
      <span className="sep" aria-hidden="true" />
      <button
        type="button"
        title="撤销"
        disabled={undoDepth(editor.state) <= 0}
        onClick={() => undo(editor.state, (tr) => editor.view.dispatch(tr))}
      >
        ↶
      </button>
      <button
        type="button"
        title="重做"
        disabled={redoDepth(editor.state) <= 0}
        onClick={() => redo(editor.state, (tr) => editor.view.dispatch(tr))}
      >
        ↷
      </button>
    </div>
  );
}
