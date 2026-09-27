import { EditorContent, useEditor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  applyBlockType,
  BLOCK_TYPES,
  docToMarkdown,
  docToJson,
  moveBlock,
  stampSignatures,
  type BlockTypeId,
  type EditDoc,
} from "./blocks";
import { mdExtensions } from "./schema";
import { LinkEditor, Toolbar } from "./Toolbar";

/** 浮层位置：相对外层容器算，滚动时重算，不让它跟着漂 */
type Float = { top: number; left: number; pos?: number };

const MARKS: { name: string; 标签: string; 样例: string }[] = [
  { name: "bold", 标签: "加粗", 样例: "B" },
  { name: "italic", 标签: "斜体", 样例: "I" },
  { name: "strike", 标签: "删除线", 样例: "S" },
  { name: "code", 标签: "行内代码", 样例: "{}" },
];

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
  const wrap = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Float | null>(null);
  /** 块菜单：`/` 与行首手柄共用同一个浮层。`dropSlash` 是选中后要删掉的那个 `/` 的位置 */
  const [menu, setMenu] = useState<{ top: number; left: number; start: number; dropSlash?: number } | null>(null);
  /** 鼠标停在哪个顶层块上（手柄跟着它走） */
  const [hover, setHover] = useState<{ top: number; height: number; start: number; index: number } | null>(null);
  /** 拖拽时的落位指示线 */
  const [drop, setDrop] = useState<{ top: number; index: number } | null>(null);
  const dropRef = useRef<{ top: number; index: number } | null>(null);
  const [linking, setLinking] = useState(false);

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

  // 鼠标停在哪个块上，手柄就贴到那一块旁边。只在块或位置真的变了时 setState——
  // mousemove 的频率比击键还高，每下都渲染等于把 G6 的预算花在画一个 ⋮ 上
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onMove = (ev: MouseEvent) => {
      const b = blockAt(ev.clientX, ev.clientY);
      setHover((h) => (b ? (h && h.start === b.start && h.top === b.top ? h : b) : null));
    };
    const onLeave = () => setHover(null);
    dom.addEventListener("mousemove", onMove);
    dom.addEventListener("mouseleave", onLeave);
    return () => {
      dom.removeEventListener("mousemove", onMove);
      dom.removeEventListener("mouseleave", onLeave);
    };
  }, [editor]);

  /**
   * 选中文字 → 气泡工具条；插件抛的 `md-slash` DOM 事件 → 块菜单。
   *
   * 两个浮层**都不写文档**：气泡只读选区，斜杠只读 DOM 事件。走"发事务"那条路会经
   * `onUpdate` → 标脏 → 停手 800ms 把"只是选了个词 / 打了个斜杠"的一篇写盘。
   */
  useEffect(() => {
    if (!editor) return;
    const anchorRect = () => {
      const s = window.getSelection();
      if (!s || !s.rangeCount) return null;
      const r = s.getRangeAt(0).getBoundingClientRect();
      return r.width || r.height ? r : null;
    };
    const syncSel = () => {
      const { from, empty } = editor.state.selection;
      const host = wrap.current?.getBoundingClientRect();
      const rect = empty || !editor.isEditable ? null : anchorRect();
      if (!host || !rect) {
        setSel(null);
        return;
      }
      setSel({ top: rect.top - host.top - 34, left: rect.left - host.left + rect.width / 2, pos: from });
    };
    const onSlash = (ev: Event) => {
      const { pos } = (ev as CustomEvent<{ pos: number }>).detail;
      const host = wrap.current?.getBoundingClientRect();
      if (!host) return;
      const c = editor.view.coordsAtPos(pos);
      const $p = editor.state.doc.resolve(pos);
      setMenu({
        top: c.bottom - host.top + 6,
        left: c.left - host.left,
        start: $p.depth ? $p.before(1) : 0,
        dropSlash: pos,
      });
    };
    // 继续打字就把菜单关掉：块里不再是光秃秃一个 `/` 时，留着它只会挡路
    const closeSlash = () => {
      const { $from } = editor.state.selection;
      if ($from.parentOffset !== 1 || $from.parent.textContent !== "/") setMenu(null);
    };
    editor.on("selectionUpdate", syncSel);
    editor.on("update", closeSlash);
    const hostEl = wrap.current;
    hostEl?.addEventListener("md-slash", onSlash);
    window.addEventListener("scroll", syncSel, true);
    return () => {
      editor.off("selectionUpdate", syncSel);
      editor.off("update", closeSlash);
      hostEl?.removeEventListener("md-slash", onSlash);
      window.removeEventListener("scroll", syncSel, true);
    };
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

  if (!editor) return null;

  /** 屏幕坐标 → 那个顶层块的信息。手柄跟谁、拖到哪，都问 ProseMirror 的几何，不自己算布局 */
  const blockAt = (x: number, y: number) => {
    // **x 要夹进正文列内**：手柄本身就画在左页边的空白里，不夹的话"按住手柄往下拖"
    // 这一路问出来的坐标全在编辑器外面，`posAtCoords` 返回 null，落位线永远不出现
    // （真机第一轮就是这样，拖了个空）。
    const rect = editor.view.dom.getBoundingClientRect();
    const cx = Math.min(Math.max(x, rect.left + 2), rect.right - 2);
    const at = editor.view.posAtCoords({ left: cx, top: y });
    if (!at) return null;
    const p = at.pos > -1 ? at.pos : at.inside;
    if (p < 0) return null;
    const $p = editor.state.doc.resolve(p);
    if (!$p.depth) return null;
    const start = $p.before(1);
    const dom = editor.view.nodeDOM(start);
    if (!(dom instanceof HTMLElement)) return null;
    let index = 0;
    editor.state.doc.forEach((_n, off, i) => {
      if (off === start) index = i;
    });
    const r = dom.getBoundingClientRect();
    return { top: dom.offsetTop, height: dom.offsetHeight, start, index, 上半: y < r.top + r.height / 2 };
  };

  const applyType = (id: BlockTypeId) => {
    if (!menu) return;
    const { state } = editor;
    // 与输入规则、顶部工具栏共用 applyBlockType。`/` 是菜单的触发符，选中类型后就是
    // 垃圾字符必须吃掉；它在记录位置的**后面**，删错方向就等于删块边界。
    let tr = applyBlockType(state, menu.start, id) ?? state.tr;
    const p = menu.dropSlash;
    if (p !== undefined && state.doc.textBetween(p, p + 1) === "/") tr = tr.delete(p, p + 1);
    if (tr.docChanged) editor.view.dispatch(tr.scrollIntoView());
    setMenu(null);
  };

  /**
   * 手柄按下：挪动超过 5px 算拖拽，否则算点击开类型菜单。
   *
   * 用 pointer 事件而不是 HTML5 拖放：一是拖放要在 contenteditable 里和 ProseMirror
   * 自己的 drop 处理抢事件，二是真机验证只能用 CDP 发普通鼠标事件，`dragstart` 那套
   * 它根本触发不了——验证不了的交互不该上生产。
   */
  const onHandleDown = (e: React.PointerEvent, from: { index: number; start: number }) => {
    e.preventDefault();
    const originY = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - originY) < 5) return;
      moved = true;
      const b = blockAt(ev.clientX, ev.clientY);
      const next = b ? { top: b.top + (b.上半 ? 0 : b.height), index: b.上半 ? b.index : b.index + 1 } : null;
      dropRef.current = next;
      setDrop(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const target = dropRef.current;
      dropRef.current = null;
      setDrop(null);
      if (!moved) {
        const dom = editor.view.nodeDOM(from.start);
        if (dom instanceof HTMLElement) setMenu({ top: dom.offsetTop + dom.offsetHeight + 4, left: 0, start: from.start });
        return;
      }
      if (!target) return;
      const tr = moveBlock(editor.state, from.index, target.index);
      if (tr) editor.view.dispatch(tr);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };



  return (
    <div className="editor-wrap" ref={wrap}>
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
      {sel ? (
        <div
          className="bubble"
          style={{ top: sel.top, left: sel.left }}
          // 浮层不能抢走正文焦点：焦点一走选区就空，工具条自己就消失了
          onMouseDown={(e) => e.preventDefault()}
          role="toolbar"
          aria-label="选区格式"
        >
          {MARKS.map((m) => (
            <button
              key={m.name}
              type="button"
              className={editor.isActive(m.name) ? "on" : ""}
              title={m.标签}
              onClick={() => editor.chain().focus().toggleMark(m.name).run()}
            >
              {m.样例}
            </button>
          ))}
          <button
            type="button"
            className={editor.isActive("link") ? "on" : ""}
            title="链接"
            onClick={() => {
              if (editor.isActive("link")) {
                editor.chain().focus().unsetMark("link").run();
                setSel(null);
                return;
              }
              setLinking(true);
            }}
          >
            链
          </button>
          {linking ? (
            // 输入框用工具栏那份实现：两处各写一份，早晚一处改了 `extendMarkRange`
            // 另一处没改，链接就会吃掉或漏掉半个词
            <LinkEditor editor={editor} onDone={() => setLinking(false)} />
          ) : null}
        </div>
      ) : null}
      {hover && !drop ? (
        <div
          className="handle"
          style={{ top: hover.top }}
          title="拖拽排序 · 点击改类型"
          role="button"
          tabIndex={-1}
          onPointerDown={(e) => onHandleDown(e, { index: hover.index, start: hover.start })}
        >
          ⋮
        </div>
      ) : null}
      {drop ? <div className="drop-line" style={{ top: drop.top }} aria-hidden="true" /> : null}
      {menu ? (
        <div
          className="slash"
          style={{ top: menu.top, left: menu.left }}
          onMouseDown={(e) => e.preventDefault()}
          role="menu"
          aria-label="块类型"
        >
          {BLOCK_TYPES.map((b) => (
            <button key={b.id} type="button" role="menuitem" onClick={() => applyType(b.id)}>
              {b.标签}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
