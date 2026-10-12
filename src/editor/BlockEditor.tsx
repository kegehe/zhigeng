import { EditorContent, useEditor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  applyBlockType,
  BLOCK_TYPES,
  docToMarkdown,
  docToJson,
  INSERTABLE,
  insertSourceBlock,
  moveBlock,
  replaceBlockWithSource,
  stampSignatures,
  删块在,
  格坐标At,
  type BlockTypeId,
  type EditDoc,
} from "./blocks";
import { 归一 } from "./tableSelect";
import { 改选区, 定锚点, 矩形of, 选区of } from "./tableSelectPlugin";
import { mdExtensions } from "./schema";
import { 工具图标, type 图标名 } from "./icons";
import { LinkEditor, Toolbar } from "./Toolbar";

/** 浮层位置：相对外层容器算，滚动时重算，不让它跟着漂 */
type Float = { top: number; left: number; pos?: number };

/** 选区气泡上的行内标记。图标与常驻工具栏**同一张表**（`icons.tsx`），两处不同就是两副面孔 */
const MARKS: { name: string; 标签: string; 图: 图标名 }[] = [
  { name: "bold", 标签: "加粗", 图: "bold" },
  { name: "italic", 标签: "斜体", 图: "italic" },
  { name: "strike", 标签: "删除线", 图: "strike" },
  { name: "code", 标签: "行内代码", 图: "code" },
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
  onNotice,
  editApi,
}: {
  doc: EditDoc;
  editable: boolean;
  onEdit: () => void;
  /** 浏览态点正文就地转编辑。父组件要把 mode 跟上，否则界面与实例状态分叉 */
  onEditStart: () => void;
  /** 编辑器里发生了一件"什么都没改成"的事（粘的文件不是图片、图存不下）。界面上要说一句 */
  onNotice?: (文本: string) => void;
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
  const noticeRef = useRef(onNotice);
  // 打签名那笔事务不是用户改的。`onCreate` 在 `useEditor` 里同步跑完，所以用一个
  // 一次性闸门把它挡住：不挡，一进编辑态界面就显示"未保存的修改"，800ms 后还白跑
  // 一次 persist（内容一致所以不会写坏文件，但那圈状态是错的）。
  const stamping = useRef(true);
  editRef.current = onEdit;
  startRef.current = onEditStart;
  noticeRef.current = onNotice;
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
   * 格子里按下鼠标：定锚点；拖过别的格子（或 Shift 点另一格）扩成矩形选区。
   *
   * 三条判据：
   * - **pointer 事件而不是 HTML5 拖放**：与块手柄、目录树同一条理由——真机验证只能发
   *   普通鼠标事件，`dragstart` 触发不了，验证不了的交互不该上生产。
   * - **移动超过 5px 才算拖**：否则"在格子里点个光标"会变成"框住一片"，而后者会抢走
   *   `Backspace` 的语义（多格时它是清空整片）。
   * - **只发 meta 事务**：脏标记挂在 `onUpdate`（只在文档变了时触发），选区发文档事务
   *   等于"拖一下鼠标就把笔记标成待保存"。
   */
  useEffect(() => {
    if (!editor) return;
    const view = editor.view;
    const 格在 = (x: number, y: number) => {
      const at = view.posAtCoords({ left: x, top: y });
      if (!at) return null;
      return (
        格坐标At(view.state, at.pos) ??
        (at.inside > 0 ? 格坐标At(view.state, at.inside) : null)
      );
    };
    /**
     * 原生拖拽必须挡掉：格子里是文字，按下再移动会被浏览器判成"拖这段文字"，
     * `dragstart` 一触发 pointermove 流就断了——真机上表现为框到一半冻住，
     * 用户以为选了四格，实际落盘只改两格。这种"少改"比不改更难发现。
     */
    const 拖格中 = { 是: false };
    const onDown = (ev: PointerEvent) => {
      if (ev.button !== 0 || !editor.isEditable) return;
      const 起 = 格在(ev.clientX, ev.clientY);
      if (!起) return;
      /**
       * Shift 点扩选区。**锚点只认同一张表**：`锚` 是表内坐标（行, 列），拿 A 表的第 4 行第 5 列
       * 去框只有 3 列的 B 表，会框出一片 B 表里根本不存在的格子——工具栏与 `Delete` 照它落盘，
       * 于是"在 B 表里 Shift 点一下"变成了删 B 表的行。拖动那条路本来就判了 `到.表 !== 起.表`，
       * Shift 这条路是漏的。
       */
      const 上次 = 选区of(view.state);
      const 锚 = ev.shiftKey && 上次 && 上次.表 === 起.表 ? 上次.锚 : 起;
      if (ev.shiftKey) {
        const 矩 = 归一(锚, 起);
        // 与拖动那条路同一条规矩：**单格不算矩形**，只留锚点。否则跨表 Shift 点
        // （锚被换成点击格自己）会让那一格凭空多一圈框，而它只是有光标
        view.dispatch(
          改选区(view.state, 起.表, 矩.r0 === 矩.r1 && 矩.c0 === 矩.c1 ? null : 矩)
        );
        ev.preventDefault();
        return;
      }
      view.dispatch(定锚点(view.state, 起.表, 起));
      const 手 = { x: ev.clientX, y: ev.clientY };
      let 动过 = false;
      拖格中.是 = true;
      const 落到 = (e2: PointerEvent) => {
        const 到 = 格在(e2.clientX, e2.clientY);
        // 拖出这张表（或拖到表外的空白）就不改：留着上一次的范围比乱跳好
        if (!到 || 到.表 !== 起.表) return;
        const 矩 = 归一(锚, 到);
        // 拖回锚点那一格 = 没有矩形。留着单格矩形会让 Backspace 变成"清空整格"
        view.dispatch(改选区(view.state, 起.表, 矩.r0 === 矩.r1 && 矩.c0 === 矩.c1 ? null : 矩));
        /**
         * 每一拍都清一次原生选区：只在跨过阈值那一下清不够——PM 会把浏览器选区同步回来，
         * 真机上表现为"格子已经框住，格子里的数字还挂着两层蓝"。
         */
        window.getSelection()?.removeAllRanges();
      };
      const move = (e2: PointerEvent) => {
        if (!动过) {
          if (Math.abs(e2.clientY - 手.y) < 5 && Math.abs(e2.clientX - 手.x) < 5) return;
          动过 = true;
          /**
           * 一确认是拖选就关掉正文的 `user-select`：浏览器会跟着鼠标扩选原生文字选区并
           * `scrollIntoView`，格子会在光标底下跑。清选区这件事交给 `落到`（每一拍都清）。
           */
          view.dom.setAttribute("data-md-drag", "");
        }
        落到(e2);
        e2.preventDefault();
      };
      const up = (e2: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        拖格中.是 = false;
        view.dom.removeAttribute("data-md-drag");
        /**
         * 松手这一下也落一次：CDP 连发时最后一拍 `pointermove` 可能被合掉，只靠 move
         * 会让用户框到的比鼠标停下的少几格，而批量动作是按框到的落盘的。
         */
        if (动过) 落到(e2);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    };
    const dom = editor.view.dom;
    const onDragStart = (ev: Event) => {
      if (拖格中.是) ev.preventDefault();
    };
    dom.addEventListener("dragstart", onDragStart);
    dom.addEventListener("pointerdown", onDown);
    return () => {
      拖格中.是 = false;
      dom.removeAttribute("data-md-drag");
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("dragstart", onDragStart);
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
      /**
       * 框了格子就不出选区气泡：那时"选中"的是几**格**，不是几个字，
       * 气泡上的加粗/行内码对着整片格子没有一致的含义（真机上拖完会看见它挂在表右侧）。
       */
      const rect = empty || !editor.isEditable || 矩形of(editor.state) ? null : anchorRect();
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
    /**
     * 拖格子的那几拍不一定有 `selectionUpdate`（PM 选区可以一直不变，变的是我们的矩形），
     * 所以补一条事务订阅。带判据订阅是必须的：不判就每击一次键都多跑一次 `anchorRect`
     * （读 window 选区 + 量矩形），那条是花在打字路径上的。
     */
    const onTr = () => {
      if (矩形of(editor.state)) syncSel();
    };
    editor.on("transaction", onTr);
    const hostEl = wrap.current;
    hostEl?.addEventListener("md-slash", onSlash);
    /**
     * 编辑器抛出来的"什么都没改成"那一类消息（粘的不是图片、图存不下）。
     * 走 DOM 事件而不是把回调穿进扩展：扩展只认 PM 的世界，界面文案归界面层。
     */
    const on提示 = (e: Event) => {
      const 文 = (e as CustomEvent<string>).detail;
      if (文) noticeRef.current?.(文);
    };
    hostEl?.addEventListener("md-notice", on提示);
    window.addEventListener("scroll", syncSel, true);
    return () => {
      editor.off("selectionUpdate", syncSel);
      editor.off("update", closeSlash);
      editor.off("transaction", onTr);
      hostEl?.removeEventListener("md-slash", onSlash);
      hostEl?.removeEventListener("md-notice", on提示);
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
    /**
     * `top` 必须相对 `.editor-wrap`——手柄、落位线、菜单都挂在那儿定位。
     * 以前用的是 `dom.offsetTop`，而它的参考系是 `.ProseMirror`（`base.css` 为了焦点竖线
     * 给它加了 `position: relative`），两者之间还压着一整条 sticky 工具栏：
     * 同一份 CSS 搭的几何夹具量出来，块相对 wrap 是 116px、offsetTop 只有 45px，
     * **手柄比它指的块高 71px**（工具栏 59 + 外边距 12）。选区气泡与 `/` 菜单一直是
     * 按 rect 算的，所以只有这两样错位——也正因为只有它们两个用了另一个参考系。
     */
    const 宿主 = wrap.current?.getBoundingClientRect();
    return {
      top: r.top - (宿主?.top ?? 0),
      height: r.height,
      start,
      index,
      上半: y < r.top + r.height / 2,
    };
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
   * 从 `/` 菜单选了一个结构块。
   *
   * 斜杠触发时那一块里只有一个 `/`，所以**整块换掉**它——往后面插会留下一个空段落，
   * 而且那个 `/` 还得再删一次。手柄菜单（`⋮`）对着的是有内容的块，那里只能"在其后插入"。
   */
  const applyInsert = (kind: string, source: string) => {
    if (!menu) return;
    const { state } = editor;
    const tr =
      menu.dropSlash !== undefined
        ? replaceBlockWithSource(state, menu.start, kind, source)
        : insertSourceBlock(state, kind, source);
    if (tr) editor.view.dispatch(tr.scrollIntoView());
    setMenu(null);
  };

  /**
   * 手柄 / `/` 菜单上的"删掉这一块"。删的是**菜单从哪一块开着的**（`menu.start`），
   * 不是光标所在那一块：手柄跟着鼠标走，插入符可能还停在别的块里，按光标删会删错地方。
   *
   * 为什么是一句提示而不是一个确认框：撤销在同一个编辑器实例里是可靠的（PM 的历史栈），
   * 而"删掉这一块"在 Notion / 语雀 那套肌肉记忆里本来就不该有第二道问。
   */
  const 删块 = () => {
    if (!menu) return;
    const tr = 删块在(editor.state, menu.start);
    setMenu(null);
    if (!tr) return;
    editor.view.dispatch(tr.scrollIntoView());
    noticeRef.current?.("已删掉这一块 · Ctrl+Z 撤销");
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
        if (dom instanceof HTMLElement) {
          // 与 `blockAt` 同一个参考系：菜单要贴在这一块的下沿，就得按 rect 相对 wrap 算
          const r = dom.getBoundingClientRect();
          setMenu({
            top: r.bottom - (wrap.current?.getBoundingClientRect().top ?? 0) + 4,
            left: 0,
            start: from.start,
          });
        }
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
          {MARKS.map((m) => {
            const Icon = 工具图标[m.图];
            return (
              <button
                key={m.name}
                type="button"
                className={editor.isActive(m.name) ? "on" : ""}
                title={m.标签}
                aria-label={m.标签}
                aria-pressed={editor.isActive(m.name) || undefined}
                onClick={() => editor.chain().focus().toggleMark(m.name).run()}
              >
                <Icon />
              </button>
            );
          })}
          <button
            type="button"
            className={editor.isActive("link") ? "on" : ""}
            title="链接"
            aria-label="链接"
            aria-pressed={editor.isActive("link") || undefined}
            onClick={() => {
              if (editor.isActive("link")) {
                editor.chain().focus().unsetMark("link").run();
                setSel(null);
                return;
              }
              setLinking(true);
            }}
          >
            <工具图标.link />
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
          aria-label="块类型与操作"
        >
          <span className="grp">类型</span>
          {BLOCK_TYPES.map((b) => (
            <button key={b.id} type="button" role="menuitem" onClick={() => applyType(b.id)}>
              {b.标签}
            </button>
          ))}
          <span className="grp">插入</span>
          {INSERTABLE.map((b) => (
            <button
              key={b.kind}
              type="button"
              role="menuitem"
              onClick={() => applyInsert(b.kind, b.源文本)}
            >
              {b.标签}
            </button>
          ))}
          {/* 删块在这一排：代码块 / 表格 / 引用这些"整块"的东西，把里面的字删干净
              留下的是空围栏，只有连节点一起删才是没了——而那一条路以前没有入口 */}
          <span className="grp">操作</span>
          <button type="button" role="menuitem" onClick={删块}>
            删掉这一块
          </button>
        </div>
      ) : null}
    </div>
  );
}
