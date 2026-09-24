import { Editor } from "@tiptap/core";
import { docToJson, stampSignatures, type EditDoc } from "./blocks";
import { mdExtensions } from "./schema";

/**
 * 造一个真编辑器（jsdom 里），与桌面端装载文档走同一条路径。
 *
 * 这里刻意不搭一个"更简单"的假 doc：上一轮的教训就是**属性在 TipTap 装载 JSON 的
 * 那一步被静默丢掉**（同名节点被 StarterKit 顶掉 ⇒ schema 里没有 md* ⇒ 全判已改 ⇒
 * 整篇重写），而只有真装载才能复现它。
 */
export function createTestEditor(doc: EditDoc, onReady?: (editor: Editor) => void): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: mdExtensions,
    content: docToJson(doc) as never,
  });
  // 签名必须在装载之后打：两边都由 sigOf 从活节点算，不去猜 PM 的 toJSON 形状
  const tr = stampSignatures(editor.state);
  if (tr) editor.view.dispatch(tr);
  onReady?.(editor);
  return editor;
}
