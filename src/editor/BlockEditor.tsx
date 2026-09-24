import { EditorContent, useEditor } from "@tiptap/react";
import { docToMarkdown, docToJson, stampSignatures, type EditDoc } from "./blocks";
import { mdExtensions } from "./schema";

/**
 * 所见即所得的正文编辑器：一块一个顶层节点，**没碰过的块按源切片原样回写**。
 *
 * 产出交给上层当草稿用（自动保存那条链路与整篇源码模式共用同一个入口），这里不碰落盘。
 * 装载完立刻 `stampSignatures`：签名只能从进入 ProseMirror 之后的活节点上算，
 * 否则"改没改"就变成猜形状——上一轮正是死在这里，一次编辑吃掉 248 字节。
 */
export function BlockEditor({
  doc,
  onMarkdown,
}: {
  doc: EditDoc;
  onMarkdown: (md: string) => void;
}) {
  const editor = useEditor({
    extensions: mdExtensions,
    content: docToJson(doc),
    onCreate: ({ editor: e }) => {
      const tr = stampSignatures(e.state);
      if (tr) e.view.dispatch(tr);
    },
    onUpdate: ({ editor: e }) => onMarkdown(docToMarkdown(e.state.doc, doc)),
  });
  // 样式由外层的 `.prose-note` 给：与只读浏览同一套排版，切编辑不该跳版
  return <EditorContent editor={editor} />;
}
