import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useMemo, type RefObject } from "react";
import { docToMarkdown, docToJson, stampSignatures, type EditDoc } from "./blocks";
import { mdExtensions } from "./schema";

/**
 * 所见即所得的正文编辑器：一块一个顶层节点，**没碰过的块按源切片原样回写**。
 *
 * 装载完立刻 `stampSignatures`：签名只能从进入 ProseMirror 之后的活节点上算，
 * 否则"改没改"就变成猜形状——上一轮正是死在这里，一次编辑吃掉 248 字节。
 *
 * **按键上不产出 Markdown**：整篇序列化是 O(块数) 的（3000 块实测 29ms），放在每次
 * 击键上直接把 G6 的 16ms 顶穿。这里只在改过时 `onEdit()` 报一声，落盘那一刻才通过
 * `editApi` 取一次产出——自动保存本来就是停手 800ms 才跑，一次都不许多花。
 */
export function BlockEditor({
  doc,
  onEdit,
  editApi,
}: {
  doc: EditDoc;
  onEdit: () => void;
  editApi: RefObject<(() => string) | null>;
}) {
  // **必须 memo 住**：这是整篇的行内解析，写成 `content: docToJson(doc)` 的话每次渲染都
  // 重新算一遍——CPU profile 实测 3000 块下每次击键 38ms 全花在 parseInline 上。
  const json = useMemo(() => docToJson(doc), [doc]);
  const editor = useEditor({
    extensions: mdExtensions,
    content: json,
    onCreate: ({ editor: e }) => {
      const tr = stampSignatures(e.state);
      if (tr) e.view.dispatch(tr);
    },
    onUpdate: () => onEdit(),
  });
  useEffect(() => {
    if (!editor) return;
    // 只给开发构建留的探针口子：ADR-004 的 3000 块复测要能直接量到实例
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__editor = editor;
    editApi.current = () => docToMarkdown(editor.state.doc, doc);
    return () => {
      editApi.current = null;
    };
  }, [editor, doc, editApi]);
  // 样式由外层的 `.prose-note` 给：与只读浏览同一套排版，切编辑不该跳版
  return <EditorContent editor={editor} />;
}
