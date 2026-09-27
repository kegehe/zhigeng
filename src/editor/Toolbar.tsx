import { undo, redo, undoDepth, redoDepth } from "@tiptap/pm/history";
import type { Editor } from "@tiptap/react";
import { useEffect, useState } from "react";
import { applyBlockType, insertDividerAfter, moveCurrentBlock, BLOCK_TYPES, type BlockTypeId } from "./blocks";

/**
 * 常驻顶部工具栏。
 *
 * **只放序列化器真能产出的操作**——这条限制不是偷懒，是产品的命根子：Markdown 是唯一
 * 真相（G1），编辑器与文件必须字节级往返（G5）。所以这里没有字号、居中、颜色、缩进、
 * 引用、代码块：前三个在 Markdown 里没有语法，后三个要动 md-kernel 的容器/围栏模型，
 * 不是加个按钮的量级。给了按钮就是给用户一个"点了会丢"的陷阱。
 *
 * 单独一个组件、自己订阅编辑器事件：放在 `BlockEditor` 里 `setState` 的话，每次选区变化
 * 都会连带重渲染 `EditorContent`，等于在打字路径上凭空加一次整棵子树的协调。
 */
export function Toolbar({ editor }: { editor: Editor }) {
  const [, bump] = useState(0);
  const [linking, setLinking] = useState(false);

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
  const 当前类型: BlockTypeId =
    typeName === "mdHeading"
      ? (`heading${Math.min(3, Math.max(1, Number(node?.attrs.mdLevel ?? 1)))}` as BlockTypeId)
      : typeName === "mdItem"
        ? (String(node?.attrs.mdKind) as BlockTypeId)
        : "paragraph";
  const 可选块 = typeName === "mdParagraph" || typeName === "mdHeading" || typeName === "mdItem";

  const setType = (id: BlockTypeId) => {
    if (!$from.depth) return;
    const tr = applyBlockType(editor.state, $from.before(1), id);
    if (tr) editor.view.dispatch(tr.scrollIntoView());
  };
  const move = (delta: number) => {
    const tr = moveCurrentBlock(editor.state, delta);
    if (tr) editor.view.dispatch(tr.scrollIntoView());
  };

  const btn = (
    key: string,
    标签: string,
    样例: string,
    做: () => void,
    开着 = false,
    禁用 = false,
  ) => (
    <button
      key={key}
      type="button"
      title={标签}
      className={开着 ? "on" : ""}
      disabled={禁用}
      onClick={做}
    >
      {样例}
    </button>
  );

  return (
    <div
      className="toolbar"
      // 点工具栏不该把正文的选区弄丢：焦点一走选区就空，按钮立刻变成"不知道在改谁"
      onMouseDown={(e) => e.preventDefault()}
      role="toolbar"
      aria-label="格式与块操作"
    >
      {可选块 || opaque ? (
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
      {btn("bold", "加粗 Ctrl+B", "B", () => editor.chain().focus().toggleMark("bold").run(), editor.isActive("bold"))}
      {btn("italic", "斜体 Ctrl+I", "I", () => editor.chain().focus().toggleMark("italic").run(), editor.isActive("italic"))}
      {btn("strike", "删除线", "S", () => editor.chain().focus().toggleMark("strike").run(), editor.isActive("strike"))}
      {btn("code", "行内代码", "{}", () => editor.chain().focus().toggleMark("code").run(), editor.isActive("code"))}
      {btn("link", "链接", "链", () => setLinking((v) => !v), editor.isActive("link"))}
      {linking ? <LinkEditor editor={editor} onDone={() => setLinking(false)} /> : null}
      {btn(
        "clear",
        "清除格式（回到正文，去掉加粗 / 斜体 / 删除线 / 行内码；链接保留）",
        "清",
        () => {
          // 只去行内样式，**留着链接**：`unsetAllMarks` 会把 link 一起抹掉，而"清除格式"
          // 在 Notion / 语雀 里都不该顺手删掉用户挂上去的链接
          editor
            .chain()
            .focus()
            .unsetMark("bold")
            .unsetMark("italic")
            .unsetMark("strike")
            .unsetMark("code")
            .run();
          setType("paragraph");
        },
        false,
        !node,
      )}
      <span className="sep" aria-hidden="true" />
      {btn("divider", "在下面插入分隔线", "—", () => {
        const tr = insertDividerAfter(editor.state);
        if (tr) editor.view.dispatch(tr);
      }, false, !$from.depth)}
      {btn("up", "上移这一块 Alt+↑", "↑", () => move(-1), false, !$from.depth)}
      {btn("down", "下移这一块 Alt+↓", "↓", () => move(1), false, !$from.depth)}
      <span className="sep" aria-hidden="true" />
      {btn("undo", "撤销", "↶", () => undo(editor.state, (tr) => editor.view.dispatch(tr)), false, undoDepth(editor.state) <= 0)}
      {btn("redo", "重做", "↷", () => redo(editor.state, (tr) => editor.view.dispatch(tr)), false, redoDepth(editor.state) <= 0)}
    </div>
  );
}

/**
 * 链接输入框。工具栏与选区气泡**共用这一个实现**：两处各写一份的话，早晚一处改了
 * `extendMarkRange` 另一处没改，链接就会吃掉或漏掉半个词。
 */
export function LinkEditor({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const [href, setHref] = useState("");
  const 应用 = () => {
    const url = href.trim();
    onDone();
    if (!url) return;
    editor.chain().focus().extendMarkRange("link").setMark("link", { href: url }).run();
  };
  return (
    <span className="link-input">
      <input
        autoFocus
        value={href}
        placeholder="https://…"
        spellCheck={false}
        onChange={(e) => setHref(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") 应用();
          else if (e.key === "Escape") onDone();
        }}
      />
      <button type="button" onClick={应用}>
        好
      </button>
    </span>
  );
}
