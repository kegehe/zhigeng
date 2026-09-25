import { EditorContent, useEditor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { docToMarkdown, docToJson, stampSignatures, type EditDoc } from "./blocks";
import { mdExtensions } from "./schema";

/**
 * 所见即所得的正文：**浏览与编辑是同一个实例**，只是 `editable` 不同。
 *
 * 养第二份退化渲染器就是 #17 的成因（表格与代码被洗成一段、容器子项渲染两遍）。
 * 合一之后"点编辑"从"重新解析整篇 + 重挂载"变成翻一个属性，长文档上这一步才可能进预算。
 *
 * **装载完立刻 `stampSignatures`**：签名只能从进入 ProseMirror 之后的活节点上算，
 * 否则"改没改"就变成猜形状——上一轮正是死在这里，一次编辑吃掉 248 字节。
 *
 * **按键上不产出 Markdown**：整篇序列化是 O(块数) 的（3000 块实测 29ms），放在每次
 * 击键上直接把 G6 的 16ms 顶穿。这里只在改过时 `onEdit()` 报一声，落盘那一刻才通过
 * `editApi` 取一次产出——自动保存本来就是停手 800ms 才跑，一次都不许多花。
 */
export function BlockEditor({
  doc,
  editable,
  onEdit,
  onEditStart,
  editApi,
}: {
  doc: EditDoc;
  editable: boolean;
  onEdit: () => void;
  /** 浏览态点正文就地转编辑。父组件要把 mode 跟上，否则界面与实例状态分叉 */
  onEditStart: () => void;
  editApi: RefObject<(() => string) | null>;
}) {
  // **必须 memo 住**：这是整篇的行内解析，写成 `content: docToJson(doc)` 的话每次渲染都
  // 重新算一遍——CPU profile 实测 3000 块下每次击键 38ms 全花在 parseInline 上。
  const json = useMemo(() => docToJson(doc), [doc]);
  // 装载时打签名的那笔事务会走 onUpdate，而它不是用户改的。`onUpdate` 的闭包只建一次，
  // 所以可编辑状态与 `onEdit` 都得从 ref 上读，不能靠闭包里的初值。
  const editableRef = useRef(editable);
  const editRef = useRef(onEdit);
  const startRef = useRef(onEditStart);
  // 打签名那笔事务不是用户改的。`onCreate` 在 `useEditor` 里同步跑完，所以用一个
  // 一次性闸门把它挡住：不挡，一进编辑态界面就显示"未保存的修改"，800ms 后还白跑
  // 一次 persist（内容一致所以不会写坏文件，但那圈状态是错的）。
  const stamping = useRef(true);
  editRef.current = onEdit;
  startRef.current = onEditStart;

  const editor = useEditor({
    extensions: mdExtensions,
    content: json,
    editable,
    onCreate: ({ editor: e }) => {
      const tr = stampSignatures(e.state);
      if (tr) e.view.dispatch(tr);
      stamping.current = false;
    },
    onUpdate: () => {
      if (editableRef.current && !stamping.current) editRef.current();
    },
  });

  useEffect(() => {
    editableRef.current = editable;
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (!editor) return;
    // 只读时浏览器不会替用户落光标，所以自己算一次位置：点哪编辑哪，
    // 而不是"第一下解锁、第二下才放光标"
    const onMouseDown = (ev: MouseEvent) => {
      if (ev.button !== 0 || editor.isEditable) return;
      editor.setEditable(true);
      editableRef.current = true;
      const at = editor.view.posAtCoords({ left: ev.clientX, top: ev.clientY });
      if (at) {
        // 用 `pos`（按坐标算出的字符位置），不要用 `inside`——后者是文本块的**开头**，
        // 点一行末尾会把光标甩到行首
        const target = at.pos > -1 ? at.pos : at.inside;
        const tr = editor.state.tr.setSelection(
          TextSelection.near(editor.state.doc.resolve(target)),
        );
        editor.view.dispatch(tr.scrollIntoView());
      }
      ev.preventDefault();
      editor.view.focus();
      startRef.current();
    };
    const dom = editor.view.dom;
    dom.addEventListener("mousedown", onMouseDown);
    return () => dom.removeEventListener("mousedown", onMouseDown);
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    // 只给开发构建留的探针口子：ADR-004 的 3000 块复测要能直接量到实例
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__editor = editor;
    editApi.current = () => docToMarkdown(editor.state.doc, doc);
    return () => {
      editApi.current = null;
    };
  }, [editor, doc, editApi]);

  return <EditorContent editor={editor} />;
}
