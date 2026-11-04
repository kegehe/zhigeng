import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  applyBlockAlign,
  applyBlockType,
  BLOCK_ALIGNS,
  BLOCK_TYPES,
  cellAt,
  docToMarkdown,
  docToJson,
  INSERTABLE,
  insertSourceBlock,
  moveBlockWithSelection,
  replaceBlockWithSource,
  stampSignatures,
  共同对齐,
  共同列表,
  共同首行缩进,
  列表跳过说明,
  删块在,
  设列表,
  设首行缩进,
  能设列表,
  能设首行缩进,
  缩进跳过说明,
  有可对齐块,
  格坐标At,
  type BlockAlign,
  type BlockTypeId,
  type EditDoc,
} from "./blocks";
import { 归一 } from "./tableSelect";
import { 改选区, 定锚点, 矩形of, 选区of } from "./tableSelectPlugin";
import { 起手势, 取消手势, 跟手, 松手势 } from "./blockDrag";
import { mdExtensions } from "./schema";
import { 关格式刷, 开格式刷, 能开格式刷, 格式刷状态of } from "./formatPainter";
import { 就绪后标出 } from "./citeFocus";
import {
  查找,
  查找键,
  查找快捷键,
  全部替换,
  含换行,
  就近命中,
  替换一处,
  替换之后,
  选区种子,
  装查找,
  type 查找状态,
} from "./findReplace";
import { 工具图标, type 图标名 } from "./icons";
import { 对齐图, LinkEditor, Toolbar } from "./Toolbar";

/** 气泡位置：相对外层容器算，滚动时重算，不让它跟着漂 */
type Float = {
  top: number;
  left: number;
  pos?: number;
};

/** 气泡顶在选区顶上方这么多。只在这一处用：气泡是唯一一个"挂在选区上沿"的浮层 */
const 气泡高 = 34;

/** 选区气泡上的行内标记。图标与常驻工具栏**同一张表**（`icons.tsx`），两处不同就是两副面孔 */
const MARKS: { name: string; 标签: string; 图: 图标名 }[] = [
  { name: "bold", 标签: "加粗", 图: "bold" },
  { name: "italic", 标签: "斜体", 图: "italic" },
  { name: "strike", 标签: "删除线", 图: "strike" },
  { name: "code", 标签: "行内代码", 图: "code" },
  { name: "sup", 标签: "上标", 图: "sup" },
  { name: "sub", 标签: "下标", 图: "sub" },
];

/**
 * 块节点上多出来的属性，ProseMirror 的 DOM 观察器会读回去，当成用户改了这篇。
 * 停一下再写，写完再开。观察器停着的时候发生的变动不会补记。
 */
function 不惊动观察器(view: object, 改: () => void) {
  const 观察 = (view as { domObserver?: { stop(): void; start(): void } }).domObserver;
  观察?.stop();
  try {
    改();
  } finally {
    观察?.start();
  }
}

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
  focusBlock,
  onEditorChange,
}: {
  doc: EditDoc;
  editable: boolean;
  onEdit: () => void;
  /** 浏览态点正文就地转编辑。父组件要把 mode 跟上，否则界面与实例状态分叉 */
  onEditStart: () => void;
  /** 编辑器里发生了一件"什么都没改成"的事（粘的文件不是图片、图存不下）。界面上要说一句 */
  onNotice?: (文本: string) => void;
  editApi: RefObject<(() => string) | null>;
  /** 引用落点：顶层块序号 + 每次点击递增的 nonce（同一块再点一次也要重新滚） */
  focusBlock?: { ordinal: number; nonce: number } | null;
  /**
   * 编辑器实例的出口（布局三的大纲栏在 App 主区里，需要这份实例）。
   * 传 setter 就行——挂载时给新实例，卸载/换篇重建时给 null，App 那侧不用自己管清理。
   */
  onEditorChange?: (editor: Editor | null) => void;
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
  const [menu, setMenu] = useState<{
    top: number;
    left: number;
    start: number;
    dropSlash?: number;
  } | null>(null);
  /** 鼠标停在哪个顶层块上（手柄跟着它走） */
  const [hover, setHover] = useState<{
    top: number;
    height: number;
    start: number;
    index: number;
  } | null>(null);
  /** 拖拽时的落位指示线。松手不读它：落点在抬起那一刻重新量。 */
  const [drop, setDrop] = useState<{ top: number; index: number } | null>(null);
  /** 抓取光标写在 className 里。直接 classList 加上去，下一次 setDrop 重绘会把类名抹掉。 */
  const [拖着, set拖着] = useState(false);
  /** 进行中的手势。卸掉编辑器时必须拆监听、摘掉浮层，否则副本留在 body 上。 */
  const 收拖拽 = useRef<(() => void) | null>(null);
  const 落地计时 = useRef(0);
  const [linking, setLinking] = useState(false);
  // 格式刷开关走只带 meta 的事务，既不触发 selectionUpdate 也不触发 update；
  // 这个 tick 只用来让气泡上的按扣跟着重渲染（比较引用，见下面的 onTr）
  const [, set刷Tick] = useState(0);
  const [查找开, set查找开] = useState(false);
  const [要替换, set要替换] = useState(false);
  const [查询, set查询] = useState("");
  const [替换文, set替换文] = useState("");
  const [区分大小写, set区分大小写] = useState(false);
  const [查找态, set查找态] = useState<查找状态 | null>(null);
  const 查询框 = useRef<HTMLInputElement>(null);
  const 替换框 = useRef<HTMLTextAreaElement>(null);
  const 组字 = useRef(false);
  const 待焦点 = useRef<{ 框: "查询" | "替换"; 全选: boolean } | null>(null);
  const [焦点拍, set焦点拍] = useState(0);
  const 查询Ref = useRef(查询);
  const 区分Ref = useRef(区分大小写);
  const 打开查找Ref = useRef<(替换行: boolean) => void>(() => {});
  查询Ref.current = 查询;
  区分Ref.current = 区分大小写;

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

  // 实例出口。走 ref 而不直接用闭包：回调是 App 传来的 setState，本来就近乎稳定，
  // 但卸载那笔清理发生在最后一次渲染之后，读 ref 才不会把旧闭包里的旧 setter 放出来
  const outRef = useRef(onEditorChange);
  outRef.current = onEditorChange;
  useEffect(() => {
    if (!editor) return;
    outRef.current?.(editor);
    return () => outRef.current?.(null);
  }, [editor]);

  useEffect(() => {
    if (!editor || !focusBlock) return;
    return 就绪后标出(editor, focusBlock.ordinal);
  }, [editor, focusBlock]);

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

  // 鼠标停在哪个块上，手柄就贴到那一块左边。只在块或位置真的变了时 setState——
  // mousemove 的频率比击键还高，每下都渲染等于把 G6 的预算花在画一个 ⋮ 上。
  // 不能只听 ProseMirror 的 mouseleave：手柄画在正文盒子外面，鼠标移过去会先离开正文。
  // 离开的瞬间若把 hover 清掉，手柄在到达之前就被卸掉。改听窗口坐标，页边 28px 内仍算这一块。
  useEffect(() => {
    if (!editor) return;
    const onMove = (ev: MouseEvent) => {
      const 目标 = ev.target;
      if (目标 instanceof Element && 目标.closest(".handle")) return;
      const rect = editor.view.dom.getBoundingClientRect();
      const 在列内 =
        ev.clientX >= rect.left - 28 &&
        ev.clientX <= rect.right &&
        ev.clientY >= rect.top &&
        ev.clientY <= rect.bottom;
      if (!在列内) {
        setHover(null);
        return;
      }
      const b = blockAt(ev.clientX, ev.clientY);
      setHover((h) => (b ? (h && h.start === b.start && h.top === b.top ? h : b) : null));
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [editor]);

  useEffect(() => {
    return () => {
      收拖拽.current?.();
      if (落地计时.current) window.clearTimeout(落地计时.current);
    };
  }, []);

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
        格坐标At(view.state, at.pos) ?? (at.inside > 0 ? 格坐标At(view.state, at.inside) : null)
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
        view.dispatch(改选区(view.state, 起.表, 矩.r0 === 矩.r1 && 矩.c0 === 矩.c1 ? null : 矩));
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
      // 查找栏拿着焦点时，选区气泡会量到输入框上，挂错地方
      if (查找键.getState(editor.state)) {
        setSel(null);
        return;
      }
      const { from, empty } = editor.state.selection;
      const host = wrap.current?.getBoundingClientRect();
      /**
       * 框了格子、或**整块被选中**时都不出选区气泡：那时"选中"的是几**格**或一整块，
       * 不是几个字，气泡上的加粗 / 行内码对着它没有一致的含义。整块选中时浏览器留下的
       * 那段 DOM 选区还在上一行文字上，量出来的位置会挂在**别的那一块**上面
       * （真机截图照出来过：气泡压在代码卡上方那一段的中缝里）。
       */
      const 不是字 =
        empty ||
        !editor.isEditable ||
        矩形of(editor.state) ||
        editor.state.selection instanceof NodeSelection;
      const rect = 不是字 ? null : anchorRect();
      if (!host || !rect) {
        setSel(null);
        return;
      }
      setSel({
        top: rect.top - host.top - 气泡高,
        left: rect.left - host.left + rect.width / 2,
        pos: from,
      });
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
    let 键刷 = 格式刷状态of(editor.state);
    let 找 = 查找键.getState(editor.state);
    const onTr = () => {
      const 下找 = 查找键.getState(editor.state);
      if (矩形of(editor.state) || 下找 !== 找) {
        找 = 下找;
        syncSel();
      }
      const 刷 = 格式刷状态of(editor.state);
      if (刷 !== 键刷) {
        键刷 = 刷;
        set刷Tick((n) => n + 1);
      }
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

  const 发布查找 = (tr: Transaction, 滚动: boolean) => {
    if (!editor) return;
    const 原来 = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const 在栏 = !!原来?.closest(".find-bar");
    const 可复原 = 原来 instanceof HTMLInputElement || 原来 instanceof HTMLTextAreaElement;
    const 起 = 可复原 ? 原来.selectionStart : null;
    const 止 = 可复原 ? 原来.selectionEnd : null;
    // 输入框拿着焦点时，ProseMirror 的 scrollIntoView 发现选区不在编辑器里，直接什么都不滚
    editor.view.dispatch(滚动 && !在栏 ? tr.scrollIntoView() : tr);
    if (滚动) {
      const 当前 = editor.view.dom.querySelector(".find-hit.current");
      if (当前 && typeof 当前.scrollIntoView === "function") {
        当前.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }
    if (在栏 && 原来 && document.activeElement !== 原来) {
      原来.focus();
      if (
        (原来 instanceof HTMLInputElement || 原来 instanceof HTMLTextAreaElement) &&
        起 != null &&
        止 != null
      ) {
        原来.setSelectionRange(起, 止);
      }
    }
  };

  const 应用查询 = (q: string, 区分 = 区分Ref.current, 滚动 = false) => {
    if (!editor) return;
    if (!q) {
      editor.view.dispatch(editor.state.tr.setMeta(查找键, null));
      return;
    }
    const 命中 = 查找(editor.state.doc, q, 区分);
    发布查找(
      装查找(editor.state.tr, {
        查询: q,
        区分大小写: 区分,
        命中,
        当前: 就近命中(命中, editor.state.selection.from),
      }),
      滚动,
    );
  };

  const 打开查找 = (替换行: boolean) => {
    if (!editor) return;
    const seed = 选区种子(editor.state);
    const q = seed ?? 查询Ref.current;
    if (seed !== null) {
      set查询(seed);
      查询Ref.current = seed;
    }
    set要替换((v) => 替换行 || v);
    set查找开(true);
    const 进替换 = 替换行 && !!q;
    待焦点.current = { 框: 进替换 ? "替换" : "查询", 全选: !进替换 };
    set焦点拍((n) => n + 1);
    应用查询(q, 区分Ref.current, true);
  };
  打开查找Ref.current = 打开查找;

  const 关闭查找 = () => {
    set查找开(false);
    if (!editor) return;
    // 先交回焦点，清查找态那笔事务里的选区气泡才能量到正文。
    // 反过来的话，事务发生时焦点还在查找框，量到的是输入框，气泡就回不来。
    if (editor.isEditable) editor.view.focus();
    else editor.view.dom.focus({ preventScroll: true });
    editor.view.dispatch(editor.state.tr.setMeta(查找键, null));
  };

  const 跳查找 = (步: number, 回: "查询" | "替换" = "查询") => {
    if (!editor) return;
    const 态 = 查找键.getState(editor.state);
    if (!态?.命中.length) return;
    const 当前 = 态.当前 < 0 ? 0 : (态.当前 + 步 + 态.命中.length) % 态.命中.length;
    发布查找(装查找(editor.state.tr, { ...态, 当前 }), true);
    待焦点.current = { 框: 回, 全选: false };
    set焦点拍((n) => n + 1);
  };

  const 换当前 = () => {
    if (!editor?.isEditable) {
      noticeRef.current?.("现在是浏览，不能替换");
      return;
    }
    if (含换行(替换文)) {
      noticeRef.current?.("替换内容里不能有换行");
      return;
    }
    const 态 = 查找键.getState(editor.state);
    const h = 态 && 态.当前 >= 0 ? 态.命中[态.当前] : undefined;
    if (!态 || !h) {
      noticeRef.current?.("没有匹配");
      return;
    }
    const tr = 替换一处(editor.state, h.from, h.to, 替换文);
    if (!tr) return;
    const 命中 = 查找(tr.doc, 态.查询, 态.区分大小写);
    发布查找(
      装查找(tr, { ...态, 命中, 当前: 替换之后(命中, h.from + 替换文.length) }),
      true,
    );
    待焦点.current = { 框: "替换", 全选: false };
    set焦点拍((n) => n + 1);
  };

  const 换全部 = () => {
    if (!editor?.isEditable) {
      noticeRef.current?.("现在是浏览，不能替换");
      return;
    }
    if (含换行(替换文)) {
      noticeRef.current?.("替换内容里不能有换行");
      return;
    }
    const 态 = 查找键.getState(editor.state);
    if (!态?.命中.length) {
      noticeRef.current?.("没有匹配");
      return;
    }
    const n = 态.命中.length;
    const tr = 全部替换(editor.state, 态.命中, 替换文);
    if (!tr) return;
    const 改了 = tr.docChanged;
    const 命中 = 查找(tr.doc, 态.查询, 态.区分大小写);
    发布查找(装查找(tr, { ...态, 命中, 当前: 命中.length ? 0 : -1 }), true);
    if (改了) noticeRef.current?.(`已替换 ${n} 处`);
    待焦点.current = { 框: "替换", 全选: false };
    set焦点拍((n) => n + 1);
  };

  useEffect(() => {
    if (!editor) return;
    const 同步 = () => set查找态(查找键.getState(editor.state) ?? null);
    editor.on("transaction", 同步);
    return () => {
      editor.off("transaction", 同步);
    };
  }, [editor]);

  useEffect(() => {
    if (!查找开) return;
    const 哪 = 待焦点.current;
    if (!哪) return;
    待焦点.current = null;
    const el = 哪.框 === "替换" ? 替换框.current : 查询框.current;
    el?.focus();
    if (哪.全选) el?.select();
  }, [焦点拍, 查找开, 要替换]);

  useEffect(() => {
    if (!editor) return;
    const on键 = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      const 在查找栏 = !!el?.closest(".find-bar");
      const 在别的输入 =
        !在查找栏 &&
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          (el.isContentEditable && !editor.view.dom.contains(el)));
      const 做 = 查找快捷键({
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        isComposing: e.isComposing,
        keyCode: e.keyCode,
        在查找栏,
        在别的输入,
      });
      if (!做) return;
      e.preventDefault();
      if (做 === "选中查询") {
        查询框.current?.focus();
        查询框.current?.select();
        return;
      }
      if (做 === "展开替换") {
        set要替换(true);
        const 有查询 = !!查询Ref.current;
        待焦点.current = { 框: 有查询 ? "替换" : "查询", 全选: !有查询 };
        set焦点拍((n) => n + 1);
        return;
      }
      打开查找Ref.current(做 === "替换");
    };
    window.addEventListener("keydown", on键);
    return () => window.removeEventListener("keydown", on键);
  }, [editor]);

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

  /** 气泡上亮哪一盏：与工具栏共用同一条"可对齐块共同档"判据 */
  const 选区对齐 = 共同对齐(editor.state);

  /** 选区气泡上的块级对齐（与顶部工具栏共用 `applyBlockAlign`，一次一笔事务） */
  const 做块对齐 = (对: BlockAlign) => {
    const { tr, 跳过 } = applyBlockAlign(editor.state, 对);
    if (tr) editor.view.dispatch(tr.scrollIntoView());
    if (跳过 > 0) noticeRef.current?.(`对齐只作用于正文与标题，已跳过 ${跳过} 个块`);
  };
  const 列表档 = 共同列表(editor.state);
  const 做列表 = (id: "bullet" | "numbered" | "todo") => {
    const { tr, 跳过 } = 设列表(editor.state, id);
    if (tr) editor.view.dispatch(tr.scrollIntoView());
    const 说明 = tr ? 列表跳过说明(跳过) : null;
    if (说明) noticeRef.current?.(说明);
  };
  const 缩进开着 = 共同首行缩进(editor.state);
  const 做缩进 = () => {
    const { tr, 跳过 } = 设首行缩进(editor.state);
    if (tr) editor.view.dispatch(tr.scrollIntoView());
    const 说明 = tr ? 缩进跳过说明(跳过) : null;
    if (说明) noticeRef.current?.(说明);
  };

  /**
   * 手柄按下：挪动超过 5px 算拖拽，否则算点击开类型菜单。
   *
   * 用 pointer 事件而不是 HTML5 拖放：一是拖放要在 contenteditable 里和 ProseMirror
   * 自己的 drop 处理抢事件，二是真机验证只能用 CDP 发普通鼠标事件，`dragstart` 那套
   * 它根本触发不了——验证不了的交互不该上生产。
   *
   * 三个出口与目录树同一套：`pointerup` 用松手这一刻重新量的落点落子，
   * `pointercancel` 放弃（触摸被系统抢走时只有 cancel、没有 up），别的 `pointerId` 不理。
   */
  const onHandleDown = (e: React.PointerEvent, from: { index: number; start: number }) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    // 点正文会先进入编辑。手柄画在正文外面，不走那条 mousedown。
    // 不在这里打开编辑，onUpdate 看到 editableRef 仍是 false，拖完这篇不会标脏。
    if (!editableRef.current) {
      editableRef.current = true;
      editor.setEditable(true);
      startRef.current();
    }
    // 上一根指针还没结束（比如点在窗口外松的手）先拆掉，避免两套监听一起落子
    收拖拽.current?.();
    let 手势 = 起手势(e.pointerId, from.index, e.clientY);
    const 量落点 = (x: number, y: number) => {
      const b = blockAt(x, y);
      if (!b) return null;
      return {
        top: b.top + (b.上半 ? 0 : b.height),
        index: b.上半 ? b.index : b.index + 1,
      };
    };
    const 打开菜单 = () => {
      const dom = editor.view.nodeDOM(from.start);
      if (!(dom instanceof HTMLElement)) return;
      // 与 `blockAt` 同一个参考系：菜单要贴在这一块的下沿，就得按 rect 相对 wrap 算
      const r = dom.getBoundingClientRect();
      setMenu({
        top: r.bottom - (wrap.current?.getBoundingClientRect().top ?? 0) + 4,
        left: 0,
        start: from.start,
      });
    };
    const 源块 = () => {
      const dom = editor.view.nodeDOM(from.start);
      return dom instanceof HTMLElement ? dom : null;
    };
    let 浮层: HTMLElement | null = null;
    const 放下浮层 = () => {
      浮层?.remove();
      浮层 = null;
    };
    // 捕获挂在 wrap 上，不挂在手柄上：一拖过 5px 手柄就会卸掉，捕获跟着没了，
    // 在窗口外松手就收不到 pointerup，浮层会留在屏幕上。
    const 释放 = () => {
      const 宿主 = wrap.current;
      if (!宿主) return;
      try {
        if (宿主.hasPointerCapture(e.pointerId)) 宿主.releasePointerCapture(e.pointerId);
      } catch {
        // 指针已经结束时再问捕获，浏览器抛 NotFoundError
      }
    };
    /** 整块的一份副本跟着指针走，样式必须和正文里看到的一样，所以套回同一套
     *  `.prose-note` / `.block-editor` / `.ProseMirror`，不能挂到 body 上裸奔。 */
    const 拿起 = () => {
      if (浮层) return;
      const 源 = 源块();
      if (!源) return;
      const r = 源.getBoundingClientRect();
      const 壳 = document.createElement("div");
      壳.className = "block-drag-ghost prose-note block-editor";
      壳.setAttribute("aria-hidden", "true");
      const 镜 = document.createElement("div");
      镜.className = "ProseMirror";
      const 克隆 = 源.cloneNode(true);
      if (克隆 instanceof HTMLElement) {
        克隆.removeAttribute("id");
        克隆.removeAttribute("data-md-landed");
        克隆.contentEditable = "false";
        // 外边距是块与块之间的缝，不属于这块看起来的样子。边框盒已经按源块对齐。
        克隆.style.margin = "0";
        克隆.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
        克隆.querySelectorAll("[contenteditable]").forEach((n) => {
          if (n instanceof HTMLElement) n.contentEditable = "false";
        });
        镜.appendChild(克隆);
      }
      壳.appendChild(镜);
      壳.style.left = `${r.left}px`;
      壳.style.top = `${r.top}px`;
      壳.style.width = `${r.width}px`;
      document.body.appendChild(壳);
      浮层 = 壳;
    };
    const 跟着 = (clientY: number) => {
      if (!浮层) return;
      浮层.style.transform = `translate3d(0, ${clientY - 手势.原点Y}px, 0)`;
    };
    const 收场 = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", 取消, true);
      放下浮层();
      释放();
      if (收拖拽.current === 收场) 收拖拽.current = null;
      set拖着(false);
      setDrop(null);
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== 手势.指针) return;
      手势 = 跟手(手势, ev.pointerId, ev.clientY);
      if (!手势.拖过) return;
      set拖着(true);
      拿起();
      跟着(ev.clientY);
      const 落 = 量落点(ev.clientX, ev.clientY);
      // from 与 from+1 是原地：线画了松手也不动，不如不画
      const 有效 = 落 !== null && 落.index !== from.index && 落.index !== from.index + 1;
      const 下一 = 有效 && 落 ? { top: 落.top, index: 落.index } : { top: -1, index: -1 };
      setDrop((prev) =>
        prev && prev.top === 下一.top && prev.index === 下一.index ? prev : 下一,
      );
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== 手势.指针) return;
      // 先量再拆：拆的时候会摘掉浮层。量的途中若视图已经卸了，也得把浮层摘掉。
      let 结果: ReturnType<typeof 松手势> = { 种类: "放弃" };
      try {
        const 此刻 = 量落点(ev.clientX, ev.clientY);
        结果 = 松手势(手势, 此刻?.index ?? null);
      } finally {
        收场();
      }
      if (结果.种类 === "点击") {
        打开菜单();
        return;
      }
      if (结果.种类 !== "放下") return;
      const tr = moveBlockWithSelection(editor.state, 结果.from, 结果.to);
      if (!tr) return;
      editor.view.dispatch(tr.scrollIntoView());
      editor.view.focus();
      const 选 = editor.state.selection;
      const 起点 =
        选 instanceof NodeSelection ? 选.from : 选.$from.depth > 0 ? 选.$from.before(1) : -1;
      if (起点 < 0) return;
      const 落到 = editor.view.nodeDOM(起点);
      if (!(落到 instanceof HTMLElement)) return;
      if (落地计时.current) window.clearTimeout(落地计时.current);
      // 属性写在块节点上。观察器开着时，它会把这一下读成文档改动。
      不惊动观察器(editor.view, () => 落到.setAttribute("data-md-landed", ""));
      落地计时.current = window.setTimeout(() => {
        落地计时.current = 0;
        if (!落到.isConnected) return;
        不惊动观察器(editor.view, () => 落到.removeAttribute("data-md-landed"));
      }, 240);
    };
    const 取消 = (ev: PointerEvent) => {
      if (ev.pointerId !== 手势.指针) return;
      // 被系统抢走的手势只有 cancel、没有 up。这里必须走「放弃」，不能再落子。
      if (取消手势().种类 === "放弃") 收场();
    };
    收拖拽.current = 收场;
    try {
      wrap.current?.setPointerCapture(e.pointerId);
    } catch {
      // 指针在按下和捕获之间已经失效
    }
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", 取消, true);
  };

  return (
    <div className={拖着 ? "editor-wrap is-dragging" : "editor-wrap"} ref={wrap}>
      <div className="editor-tools">
        <Toolbar editor={editor} />
        {查找开 ? (
          <div
            className="find-bar"
            role="search"
            aria-label="在本文查找"
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                关闭查找();
                return;
              }
              if (e.key !== "Enter") return;
              const 在查询 = e.target === 查询框.current;
              const 在替换 = e.target === 替换框.current;
              // 按钮上的 Enter 留给按钮自己的 click。这里再跳一次，就会连走两处。
              if (!在查询 && !在替换) return;
              e.preventDefault();
              if (在替换 && !e.shiftKey) 换当前();
              else 跳查找(e.shiftKey ? -1 : 1, 在替换 ? "替换" : "查询");
            }}
          >
            <input
              ref={查询框}
              value={查询}
              spellCheck={false}
              autoComplete="off"
              aria-label="查找"
              placeholder="查找"
              onCompositionStart={() => {
                组字.current = true;
              }}
              onCompositionEnd={(e) => {
                组字.current = false;
                const v = e.currentTarget.value;
                set查询(v);
                查询Ref.current = v;
                应用查询(v);
              }}
              onChange={(e) => {
                const v = e.target.value;
                set查询(v);
                查询Ref.current = v;
                if (!组字.current) 应用查询(v);
              }}
            />
            <span className="find-count" aria-live="polite">
              {!查询 || !查找态 || 查找态.查询 !== 查询
                ? ""
                : 查找态.命中.length === 0
                  ? "无匹配"
                  : `${查找态.当前 + 1}/${查找态.命中.length}`}
            </span>
            <button type="button" aria-label="上一处" title="上一处（Shift+Enter）" onClick={() => 跳查找(-1)}>
              <工具图标.chevronUp />
            </button>
            <button type="button" aria-label="下一处" title="下一处（Enter）" onClick={() => 跳查找(1)}>
              <工具图标.chevronDown />
            </button>
            <button
              type="button"
              className={区分大小写 ? "on" : undefined}
              aria-pressed={区分大小写}
              aria-label="区分大小写"
              title="区分大小写"
              onClick={() => {
                const 下 = !区分Ref.current;
                set区分大小写(下);
                区分Ref.current = 下;
                应用查询(查询Ref.current, 下);
                待焦点.current = { 框: "查询", 全选: false };
                set焦点拍((n) => n + 1);
              }}
            >
              Aa
            </button>
            {要替换 ? (
              <>
                <textarea
                  ref={替换框}
                  value={替换文}
                  rows={1}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="替换为"
                  placeholder="替换为"
                  onChange={(e) => set替换文(e.target.value)}
                />
                <button type="button" disabled={!editor.isEditable} onClick={换当前}>
                  替换
                </button>
                <button type="button" disabled={!editor.isEditable} onClick={换全部}>
                  全部替换
                </button>
              </>
            ) : (
              <button
                type="button"
                aria-expanded={false}
                title="替换（Ctrl+H）"
                onClick={() => {
                  set要替换(true);
                  待焦点.current = { 框: 查询 ? "替换" : "查询", 全选: !查询 };
                  set焦点拍((n) => n + 1);
                }}
              >
                替换
              </button>
            )}
            <button type="button" aria-label="关闭查找" title="关闭（Esc）" onClick={关闭查找}>
              ×
            </button>
          </div>
        ) : null}
      </div>
      <EditorContent editor={editor} />
      {sel ? (
        <div
          className="bubble"
          style={{ top: sel.top, left: sel.left }}
          // 浮层不能抢走正文焦点：焦点一走选区就空，工具条自己就消失了
          onMouseDown={(e) => e.preventDefault()}
          role="toolbar"
          aria-label="选区工具"
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
          {(() => {
            const 刷态 = 格式刷状态of(editor.state);
            return (
              <button
                type="button"
                className={刷态 ? "on" : ""}
                title={
                  刷态
                    ? "格式刷已开：拖选目标文字；Esc 取消"
                    : "格式刷（双击连续刷，Esc 取消）"
                }
                aria-label="格式刷"
                aria-pressed={刷态 ? true : undefined}
                disabled={!刷态 && !能开格式刷(editor.state)}
                onClick={() => (刷态 ? 关格式刷(editor) : 开格式刷(editor))}
                onDoubleClick={() => 开格式刷(editor, true)}
              >
                <工具图标.paintbrush />
              </button>
            );
          })()}
          {cellAt(editor.state) === null && 能设列表(editor.state)
            ? (
                [
                  ["bullet", "无序列表", "list"],
                  ["numbered", "有序列表", "listOrdered"],
                  ["todo", "待办", "listTodo"],
                ] as const
              ).map(([id, 标签, 图]) => {
                const Icon = 工具图标[图];
                const 开着 = 列表档 === id;
                return (
                  <button
                    key={"list-" + id}
                    type="button"
                    className={开着 ? "on" : ""}
                    title={标签}
                    aria-label={标签}
                    aria-pressed={开着 || undefined}
                    onClick={() => 做列表(id)}
                  >
                    <Icon />
                  </button>
                );
              })
            : null}
          {cellAt(editor.state) === null && 能设首行缩进(editor.state) ? (
            <button
              type="button"
              className={缩进开着 ? "on" : ""}
              title="首行缩进"
              aria-label="首行缩进"
              aria-pressed={缩进开着 || undefined}
              onClick={做缩进}
            >
              <工具图标.firstIndent />
            </button>
          ) : null}
          {/* 块级对齐：选中的文字所在（或跨过的）正文 / 标题一起改。表格格子里有自己的
              列对齐，列表 / 引用 / 代码 / 图片根本落不成包裹——这几种干脆不出现，
              免得按下去只换来一句"没改成" */}
          {cellAt(editor.state) === null && 有可对齐块(editor.state)
            ? BLOCK_ALIGNS.map((a) => {
                const Icon = 工具图标[对齐图[a.id]];
                // 与工具栏同一条判据：多块混选不同档时一盏都不亮
                const 开着 = a.id !== "left" && 选区对齐 === a.id;
                return (
                  <button
                    key={"ba-" + a.id}
                    type="button"
                    className={开着 ? "on" : ""}
                    title={a.标签}
                    aria-label={a.标签}
                    aria-pressed={开着 || undefined}
                    onClick={() => 做块对齐(a.id)}
                  >
                    <Icon />
                  </button>
                );
              })
            : null}
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
          <span className="grip" aria-hidden="true">
            ⋮
          </span>
        </div>
      ) : null}
      {drop && drop.index >= 0 ? (
        <div className="drop-line" style={{ top: drop.top }} aria-hidden="true" />
      ) : null}
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
