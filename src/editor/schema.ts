import { Extension, Mark, Node, type Attributes, type Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, TextSelection, type Transaction, type EditorState } from "@tiptap/pm/state";
import type { EditorView, NodeView, ViewMutationRecord } from "@tiptap/pm/view";
import { history, redo, undo } from "@tiptap/pm/history";
import {
  applyBlockType,
  enterCell,
  moveCell,
  moveCurrentBlock,
  numberedMarker,
  type BlockTypeId,
} from "./blocks";
import { mightRender, renderOpaque } from "./render";

/**
 * 与 md-kernel 块模型一一对应的节点集，加上五个行内标记。
 *
 * 刻意不引 StarterKit：它带进来的 bulletList/orderedList/paragraph/heading 正是我们
 * 不想要的那套块结构；更糟的是**同名节点会把自定义节点顶掉**，节点类型一旦不是我们自己
 * 声明的那个，`mdRaw`/`mdSig` 这些属性就不存在于 schema 里，ProseMirror 装载 JSON 时
 * 静默丢弃——于是每个块都被判为"已改"、整篇重新序列化，文件被洗掉。上一轮 658→410
 * 字节就是这么来的。所以这里只声明自己用得上的东西，且属性名与 `blocks.ts` 严格一致。
 */

/** 每个块都带的元数据：源切片、与上一块之间的空白、块 ID、原始类型、内容签名 */
const mdAttributes: Attributes = {
  mdRaw: { default: "" },
  mdGap: { default: "\n" },
  mdId: { default: null },
  mdKind: { default: "paragraph" },
  mdDepth: { default: 0 },
  mdLevel: { default: null },
  mdChecked: { default: null },
  // 行内字段（due::/done::）。`content` 里没有它们，重新产出这一块时靠它写回
  mdFields: { default: [] as [string, string][] },
  // 载入之后由 stampSignatures 打上去。空串意味着"新块"，必定被重新序列化
  mdSig: { default: "" },
};

/** 每个 md* 属性都是编辑器的私有账本，不进 DOM；行内字段额外带一份成 `data-fields` */
function domAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) if (!k.startsWith("md")) out[k] = v;
  return out;
}

/**
 * `due::` / `done::` 这类行内字段不在块正文里（md-kernel 与索引同口径把它们剥了），
 * 但它确实占着文件的一段字节。界面上不显示，用户就会在一截看不见的尾巴前面打字，
 * 而且永远想不通为什么存完盘多了几个字符。所以带出来给 CSS 画成灰色后缀。
 */
function viewAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  const out = domAttrs(attrs);
  const fields = attrs.mdFields as [string, string][] | undefined;
  if (fields?.length) out["data-fields"] = fields.map(([k, v]) => `${k}:: ${v}`).join(" ");
  return out;
}

/**
 * 文档根与文本节点。TipTap 不带这两个就没有 schema（原来它们由 StarterKit 顺带提供），
 * 而 `doc` 这个名字是 ProseMirror 硬编码要求的。自己声明，不引第三方包。
 */
export const MdDoc = Node.create({
  name: "doc",
  topNode: true,
  group: "block",
  content: "block+",
});

export const MdText = Node.create({
  name: "text",
  group: "inline",
});

export const MdParagraph = Node.create({
  name: "mdParagraph",
  group: "block",
  content: "inline*",
  addAttributes() {
    return mdAttributes;
  },
  parseHTML() {
    return [{ tag: "p" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["p", viewAttrs(HTMLAttributes), 0];
  },
});

export const MdHeading = Node.create({
  name: "mdHeading",
  group: "block",
  content: "inline*",
  addAttributes() {
    return mdAttributes;
  },
  parseHTML() {
    return [{ tag: "h1 h2 h3 h4 h5 h6" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const level = Math.min(6, Math.max(1, Number(node.attrs.mdLevel ?? 1)));
    return [`h${level}`, viewAttrs(HTMLAttributes), 0];
  },
});

/** 单个列表项：无序 / 有序 / 待办共用一个节点，靠 mdKind 区分前缀 */
export const MdItem = Node.create({
  name: "mdItem",
  group: "block",
  content: "inline*",
  defining: true,
  addAttributes() {
    return mdAttributes;
  },
  parseHTML() {
    return [{ tag: "div[data-md-item]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const kind = String(node.attrs.mdKind ?? "bullet");
    const marker =
      kind === "numbered"
        ? numberedMarker(String(node.attrs.mdRaw ?? ""))
        : kind === "todo"
          ? node.attrs.mdChecked
            ? "☑"
            : "☐"
          : "•";
    return [
      "div",
      {
        ...viewAttrs(HTMLAttributes),
        "data-md-item": kind,
        "data-marker": marker,
        style: `--md-indent:${Number(node.attrs.mdDepth ?? 0)}`,
      },
      0,
    ];
  },
});

/** 焦点切换插件靠它把 DOM 认回实例：整树替换后元素是新的，位置才是线索 */
const 渲染实例 = new WeakMap<HTMLElement, OpaqueView>();

/**
 * 不透明块的两副面孔：**平时是显示形（表格画成网格、引用画成引用），光标进来就退回源文本**。
 *
 * 为什么不"渲染 + 结构化编辑"一起做：`serializeNode` 产不出 `> ` 与 ` ``` ` 前缀，
 * 也不产表格的管道行（[02] D27）。把渲染出来的网格做成可点的编辑面，就得同时发明一套
 * "网格 → 字节"的写法——那正是第一轮块编辑器吃掉用户内容的位置。所以：
 *
 * 1. **显示形是纯投影**。`render.ts` 从源文本画 DOM，`docToMarkdown` 一个字都不读它。
 *    画错了最坏是"看着不对"，改源码就能改回来；落盘那条路完全没被碰过。
 * 2. **切换只写 DOM 属性**（`data-md-mode`），不发事务。发事务会走 `onUpdate` → 标脏 →
 *    停手 800ms 把"只是挪了挪光标"的一篇写盘，与焦点竖线同一条纪律。
 * 3. **重画发生在交出焦点的那一刻，不是打字的时候**。ADR-004 量的就是击键路径
 *    （2999 块 p95 0.2ms），每次按键重画一张表格会把这笔预算花在画界面上。
 */
class OpaqueView implements NodeView {
  dom: HTMLDivElement;
  contentDOM: HTMLElement;
  readonly host: HTMLDivElement;
  private kind = "raw";
  private 正文 = "";
  private 待重算 = true;

  constructor(
    node: PmNode,
    HTMLAttributes: Record<string, unknown>,
    private readonly view: EditorView,
    private readonly 位置: () => number | undefined,
  ) {
    this.kind = String(node.attrs.mdKind ?? "raw");
    this.正文 = node.textContent;

    const dom = document.createElement("div");
    dom.className = "md-opaque";
    // 与 renderHTML 同一份口径：账本属性不进 DOM，看得见的是类型与缩进
    for (const [k, v] of Object.entries(HTMLAttributes)) {
      if (k.startsWith("md") || v === null || v === undefined) continue;
      dom.setAttribute(k, String(v));
    }
    dom.setAttribute("data-md-raw", this.kind);
    dom.style.setProperty("--md-indent", String(Number(node.attrs.mdDepth ?? 0)));

    const host = document.createElement("div");
    host.className = "md-view";
    host.contentEditable = "false";
    // 不挂常驻 aria-hidden：两副面孔靠 display:none 互换，同一时刻只有一棵在渲染树里，
    // AT 本来就读不到被隐藏的那份。挂上它反而把**看得见**的显示形（以及能点的 Callout
    // 折叠开关）从无障碍树里抹掉——那是"屏幕上有、读屏里没有"的第二种说谎。

    const pre = document.createElement("pre");
    pre.className = "md-src";
    const code = document.createElement("code");
    pre.append(code);

    // 宿主排在源文本**前面**：PM 的 `localPosFromDOM` 按"点击的元素在 contentDOM 之前还是
    // 之后"决定落点，排在前面才拿到块首，点一下就是"从这块的开头改源码"。
    dom.append(host, pre);
    this.dom = dom;
    this.host = host;
    this.contentDOM = code;
    渲染实例.set(dom, this);
    this.补渲染();
  }

  /** 只在脏了的时候重画：一次焦点转移不该重排没动过的块 */
  补渲染(): void {
    if (!this.待重算) return;
    this.待重算 = false;
    const 画 = mightRender(this.kind) ? renderOpaque(this.kind, this.正文, document) : null;
    // 画不出来（HTML、未识别语法、带子项的列表项）就别藏源文本：
    // 把内容收进一个空宿主里，等于在界面上吃掉这一块。
    this.dom.dataset["mdView"] = 画 ? "on" : "none";
    this.host.replaceChildren(画 ?? document.createTextNode(""));
  }

  update(node: PmNode): boolean {
    const kind = String(node.attrs.mdKind ?? "raw");
    if (kind !== this.kind) {
      this.kind = kind;
      this.dom.setAttribute("data-md-raw", kind);
      this.待重算 = true;
    }
    if (node.textContent !== this.正文) {
      this.正文 = node.textContent;
      this.待重算 = true;
    }
    return true;
  }

  /** 我们自己那半棵子树（含 wrapper 上的 data-md-*）不许惊动 DOM 观察器 */
  ignoreMutation(mut: ViewMutationRecord): boolean {
    const 目标 = mut.target as globalThis.Node;
    return !(目标 === this.contentDOM || this.contentDOM.contains(目标));
  }

  /**
   * 显示形上的鼠标：自己把光标放进这一块。
   *
   * 真机抓到的：**Chromium 不会把插入符放进 `contenteditable=false` 的岛里**，点了就是
   * 选那块 DOM、什么也不发生。所以"点一下退回源文本"不能指望浏览器与 PM 的默认行为，
   * 必须自己发选区。PM 的 `stopEvent` 返回 true 之后这件事就完全归我们管。
   *
   * Callout 标题是另一种控件：只改折叠态，连选区都不该动（那条是显示态，不是内容）。
   */
  stopEvent(ev: Event): boolean {
    const 目标 = ev.target as Element | null;
    if (!目标 || !this.host.contains(目标)) return false;
    if (目标.closest(".cal-head")) {
      if (ev.type === "mousedown") {
        const box = 目标.closest<HTMLElement>(".callout");
        if (box) {
          if (box.dataset["folded"]) delete box.dataset["folded"];
          else box.dataset["folded"] = "1";
        }
      }
      return true;
    }
    if (ev.type === "mousedown") this.进源码();
    return true;
  }

  /** 光标落到块首：显示形随即翻成源文本形（`OpaqueFace` 认选区） */
  private 进源码(): void {
    let pos: number | undefined;
    try {
      pos = this.位置();
    } catch {
      return; // 节点已经不在文档里了
    }
    if (pos === undefined || !this.view.state.doc.nodeAt(pos)) return;
    const tr = this.view.state.tr.setSelection(
      TextSelection.near(this.view.state.doc.resolve(pos + 1)),
    );
    this.view.dispatch(tr.scrollIntoView());
    this.view.focus();
  }
}

export const MdOpaque = Node.create({
  name: "mdOpaque",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  whitespace: "pre",
  defining: true,
  addAttributes() {
    return mdAttributes;
  },
  parseHTML() {
    return [{ tag: "pre[data-md-raw]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "pre",
      {
        ...domAttrs(HTMLAttributes),
        "data-md-raw": String(node.attrs.mdKind ?? "raw"),
        style: `--md-indent:${Number(node.attrs.mdDepth ?? 0)}`,
      },
      ["code", 0],
    ];
  },
  addNodeView() {
    return ({ node, view, getPos, HTMLAttributes }) =>
      new OpaqueView(node, HTMLAttributes, view, getPos);
  },
});

/**
 * 表格的单元格。内容就是行内节点（那五个 mark 都能用），**不带 md\* 账本**：
 * 账本只在顶层块上，`sigOf` 算的是整棵子树的 JSON，嵌套层再带一份只会分叉。
 */
export const MdTableCell = Node.create({
  name: "mdTableCell",
  content: "inline*",
  isolating: true,
  addAttributes() {
    return { header: { default: false }, align: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "td[data-md-cell]" }, { tag: "th[data-md-cell]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const 属性: Record<string, string> = { "data-md-cell": "" };
    const 对 = String(node.attrs.align ?? "");
    if (对) 属性["data-align"] = 对;
    return [node.attrs.header ? "th" : "td", { ...domAttrs(HTMLAttributes), ...属性 }, 0];
  },
});

export const MdTableRow = Node.create({
  name: "mdTableRow",
  content: "mdTableCell+",
  isolating: true,
  parseHTML() {
    return [{ tag: "tr[data-md-row]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["tr", { ...domAttrs(HTMLAttributes), "data-md-row": "" }, 0];
  },
});

/**
 * 表格：**唯一一种"渲染出来还直接在原地改"的不透明块**。
 *
 * 为什么只有它破了"显示形只读、编辑退回源文本"那条规矩（见 §块渲染）：代码块平时是代码、
 * 点进去改源码很自然；表格要填格子就必须待在格子里，于是用户永远只看到 Markdown。
 * 代价是 `serializeNode` 从此必须产得出 GFM 表格——`table.ts` 那份接管判据就是为此存在的：
 * 看不准的形状一律不接管，仍然走源文本。
 */
export const MdTable = Node.create({
  name: "mdTable",
  group: "block",
  content: "mdTableRow+",
  isolating: true,
  defining: true,
  addAttributes() {
    return { ...mdAttributes, mdAligns: { default: [] as string[] } };
  },
  parseHTML() {
    return [{ tag: "table[data-md-table]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "table",
      {
        ...domAttrs(HTMLAttributes),
        "data-md-table": String(node.attrs.mdKind ?? "table"),
        style: `--md-indent:${Number(node.attrs.mdDepth ?? 0)}`,
      },
      ["tbody", 0],
    ];
  },
});

function makeMark(name: string, tag: string, hotkey: string) {
  return Mark.create({
    name,
    parseHTML: () => [{ tag }],
    renderHTML: ({ HTMLAttributes }) => [tag, HTMLAttributes, 0],
    addKeyboardShortcuts: () =>
      hotkey ? { [hotkey]: ({ editor }) => editor.commands.toggleMark(name) } : {},
  });
}

export const MdBold = makeMark("bold", "strong", "Mod-b");
export const MdItalic = makeMark("italic", "em", "Mod-i");
export const MdCode = makeMark("code", "code", "");
export const MdStrike = makeMark("strike", "s", "");

export const MdLink = Mark.create({
  name: "link",
  addAttributes() {
    return { href: { default: "" }, title: { default: null } };
  },
  parseHTML() {
    return [{ tag: "a[href]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["a", HTMLAttributes, 0];
  },
});

/** 块账本的守卫：拆块与粘贴会把原块的账本复制给新块，这里把它认出来并清掉。
 *
 * ProseMirror 拆块时把 attrs 复制给两半，于是 `mdRaw` / `mdSig` / `mdId` **同时描述着
 * 两块**。两条后果都是"屏幕上生效、落盘就错"，都是真机抓到的：
 *
 * - 新块带着 `mdRaw`，序列化器就认为它来自文件、于是沿用原块的 `mdGap`。文件没有
 *   front-matter 时第一块的 gap 是 `""`，拆出来的两块之间因此没有空行，重新解析
 *   **并回一段**——用户那次回车等于没按。
 * - 锚点落在文档序靠前那一半。在段首按回车，` ^b-xxx` 会挂到新产生的**空块**上、
 *   正文那块反而没有 ID，指向它的反向链接从此指向空。
 * - `mdKind` 与实际节点类型不一致。拆一个列表项得到的是 `mdParagraph`，而 `mdKind`
 *   还复制着 `bullet`——序列化器按 `mdKind` 判断"是不是同一个列表的延续"，于是两块
 *   之间不给空行，落盘被内核读回**一个**列表项。
 *
 * 口径：**重复的源切片只留原块那一份**（新块没有源切片可回，按新建块处理），
 * **ID 只给有内容的那一半**（空块在 Markdown 里根本不存在，不配拥有 ID）。
 * ID 一经分配永不复用，见 [02]。
 *
 * 只在**局部改动**里认拆块产物：载入、`moveBlock`、插入结构块、打签名走的都是整树
 * 替换，那些事务里出现的"相邻两块源切片相同"是文件本来的样子（`甲\n\n甲\n`），
 * 清掉就会把作者故意留的空行改没——那是另一种改用户内容。
 */
export const LedgerGuard = () =>
  new Plugin({
    appendTransaction: (steps, old, state) => {
      const 整树替换 = steps.some((tr) =>
        tr.steps.some((s) => {
          const { from, to } = s as unknown as { from?: number; to?: number };
          return from === 0 && to === old.doc.content.size;
        }),
      );
      if (整树替换) return undefined;

      const 块: { n: PmNode; 位置: number }[] = [];
      state.doc.forEach((n, 位置) => 块.push({ n, 位置 }));
      const 改 = new Map<number, Record<string, unknown>>();
      const 合 = (i: number, 属性: Record<string, unknown>) =>
        改.set(i, { ...块[i]!.n.attrs, ...改.get(i), ...属性 });
      const ID在 = new Map<string, number>();

      块.forEach(({ n }, i) => {
        const a = { ...n.attrs, ...改.get(i) };
        const raw = typeof a.mdRaw === "string" ? a.mdRaw : "";
        const 前一份 = i > 0 ? (块[i - 1]!.n.attrs.mdRaw ?? "") : "";
        // 表格**不参与这条判据**。它的前提是"重新序列化等于原字节"——段落、标题、列表、
        // 不透明块都成立（产回来就是那份文本），表格不成立：`serializeTable` 产的是规范形，
        // 清掉账本等于把一张用户没碰过的表从 `|:-----|` 重写成 `| :--- |`（真机取证过：
        // 两张相邻且源文本相同的表，给第一张加一列，第二张的字节就跟着变了）。
        // 而这条判据本来也用不到表格身上：格子里的 Enter 被 `TableKeys` 接管成跳格，
        // 表格拆不出"相邻两块同源"这种产物。
        if (raw && raw === 前一份 && n.type.name !== "mdTable") {
          // 新块没有源切片可回，账本按"新建"重来；`mdKind` 还得与**实际节点类型**对齐：
          // 拆一个列表项会得到 `mdParagraph`，而复制来的 `mdKind` 还写着 `bullet`——
          // 那种状态下序列化器认为它是列表的延续（gap `""`），两行就粘回一个列表项。
          const 型 = n.type.name;
          合(i, {
            mdRaw: "",
            mdSig: "",
            ...(型 === "mdParagraph" || 型 === "mdHeading" ? { mdKind: 型 === "mdHeading" ? "heading" : "paragraph" } : {}),
          });
        }

        const id = a.mdId as string | null;
        if (!id) return;
        const 前 = ID在.get(id);
        if (前 === undefined) {
          ID在.set(id, i);
          return;
        }
        if (n.textContent && !块[前]!.n.textContent) {
          合(前, { mdId: null, mdSig: "" });
          ID在.set(id, i);
        } else {
          合(i, { mdId: null, mdSig: "" });
        }
      });

      let tr: Transaction | null = null;
      改.forEach((属性, i) => {
        tr = (tr ?? state.tr).setNodeMarkup(块[i]!.位置, undefined, 属性);
      });
      return tr ?? undefined;
    },
  });

export const BlockIdGuard = Extension.create({
  name: "blockIdGuard",
  addProseMirrorPlugins() {
    return [LedgerGuard()];
  },
});

/** 撤销栈直接用 ProseMirror 自己的 history，不经过任何第三方封装 */
export const History = Extension.create({
  name: "history",
  addProseMirrorPlugins() {
    return [history({ newGroupDelay: 500 })];
  },
  /**
   * 键必须绑上，不只是"插件有了"。两个理由：一是 `Ctrl+Z` 是肌肉记忆，只有工具栏
   * 上一个 ↶ 等于没有；二是在 contenteditable 里不接管它，浏览器会去撤销**它自己的**
   * DOM 输入记录，ProseMirror 的文档与历史栈就此分叉。
   */
  addKeyboardShortcuts() {
    const 走 =
      (做: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean) =>
      ({ editor }: { editor: Editor }) =>
        做(editor.state, (tr) => editor.view.dispatch(tr));
    return {
      "Mod-z": 走(undo),
      "Mod-Shift-z": 走(redo),
      // Windows 上 Ctrl+Y 是另一个肌肉记忆，别只给 Mac 的 Shift+Cmd+Z
      "Mod-y": 走(redo),
    };
  },
});

/**
 * 块操作的键盘通路。
 *
 * 手柄 `⋮` 是鼠标 affordance（悬停才出现、按住才拖），所以这些操作必须有键盘等价形式，
 * 否则"能看不能做"。记法跟 Google Docs：`Ctrl+Alt+0–3` 改正文与标题层级，
 * `Ctrl+Shift+7/8/9` 改有序 / 无序 / 待办，`Alt+↑/↓` 上下移动整块。
 *
 * **一律走 `applyBlockType` / `moveBlock`**，不另写第二套落盘逻辑——那两处各自演化的
 * 分叉这一轮已经付过一次学费（显示用一套、序列化用另一套）。
 *
 * 移动之后要把光标放回那一块：`moveBlock` 是整树替换，选区映射后可能落在别的块上，
 * 于是"连按两次 Alt+↓"第二次移的就不是同一块了。这类"看起来能用、第二次就错"的 bug
 * 只能靠显式放回选区来断根。
 */
export const BlockKeys = Extension.create({
  name: "blockKeys",
  addKeyboardShortcuts() {
    const setType = (id: BlockTypeId) => ({ editor }: { editor: Editor }) => {
      const { state } = editor;
      const { $from } = state.selection;
      if (!$from.depth) return false;
      const tr = applyBlockType(state, $from.before(1), id);
      if (!tr) return false;
      editor.view.dispatch(tr.scrollIntoView());
      return true;
    };
    const move = (delta: number) => ({ editor }: { editor: Editor }) => {
      // 与工具栏的 ↑/↓ 按钮共用 `moveCurrentBlock`（含"光标跟着块走"那一步）
      const tr = moveCurrentBlock(editor.state, delta);
      if (!tr) return false;
      editor.view.dispatch(tr.scrollIntoView());
      return true;
    };
    return {
      "Ctrl-Alt-0": setType("paragraph"),
      "Ctrl-Alt-1": setType("heading1"),
      "Ctrl-Alt-2": setType("heading2"),
      "Ctrl-Alt-3": setType("heading3"),
      "Ctrl-Alt-4": setType("heading4"),
      "Ctrl-Alt-5": setType("heading5"),
      "Ctrl-Alt-6": setType("heading6"),
      "Ctrl-Shift-8": setType("bullet"),
      "Ctrl-Shift-7": setType("numbered"),
      "Ctrl-Shift-9": setType("todo"),
      "Alt-ArrowUp": move(-1),
      "Alt-ArrowDown": move(1),
    };
  },
});

/**
 * 焦点指示落在**当前块**，不是整篇文章。
 *
 * 为什么不用一圈描边：Chrome 对可编辑的 contenteditable 在**鼠标**聚焦时也判
 * `:focus-visible`（真机量过，去掉 preventDefault 与程序化 focus() 都没用），所以任何
 * `:focus-visible` 描边都会在用户点一下字的时候套住整篇。而"焦点在哪"本来就该问块、
 * 不该问容器——所以改成左页边一条跟随当前块的竖线（[06] §4 要的是"有焦点指示"，
 * 不是"必须是一圈"）。
 *
 * **两条硬约束**：
 * 1. 只写 DOM，绝不 dispatch 事务。事务会走 `onUpdate` → 标脏 → 停手 800ms 把"只是
 *    挪了挪光标"的一篇写盘，那是凭空造出改动。
 * 2. 顶层块序号没变就一次 DOM 读写都不做。`offsetTop` 是布局读取，放在每次 state 更新
 *    上等于在打字路径里插一次强制重排，G6 的预算就是这么被顶穿的。
 */
export const FocusIndicator = Extension.create({
  name: "focusIndicator",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        view: (view) => {
          let last = "";
          // 只报"竖线该画在多高"。写在 `.ProseMirror` **自己**身上：`view.dom.parentElement`
          // 是 TipTap 的容器 div，不是我们那个 `.block-editor`，写上去样式读不到。
          const paint = (top: number, h: number) => {
            view.dom.style.setProperty("--focus-top", `${top}px`);
            view.dom.style.setProperty("--focus-h", `${h}px`);
          };
          const sync = () => {
            const sel = view.state.selection;
            // 只有落在可行内编辑的文本块上才画；不聚焦（Tab 走开、点了侧栏）就收成零高
            if (!view.hasFocus() || !sel.$from.parent.isTextblock) {
              if (last !== "off") {
                last = "off";
                paint(0, 0);
              }
              return;
            }
            const depth0 = sel.$from.depth === 0 ? 0 : sel.$from.before(1);
            const key = `${depth0}`;
            if (key === last) return;
            last = key;
            const dom = view.nodeDOM(depth0);
            // 第一个块的 offsetTop 合法地等于 0，所以只能按"有没有高度"判
            if (!(dom instanceof HTMLElement) || !dom.offsetHeight) {
              paint(0, 0);
              return;
            }
            paint(dom.offsetTop, dom.offsetHeight);
          };
          sync();
          return {
            update: sync,
            destroy: () => paint(0, 0),
          };
        },
      }),
    ];
  },
});

/**
 * 焦点决定不透明块显示哪一副面孔：选区碰到的块是源文本形，其余是显示形。
 *
 * 三条口径：
 * 1. **只写 DOM 属性，不发事务**（与 `FocusIndicator` 同一条纪律）。事务会经
 *    `onUpdate` → 标脏 → 800ms 后把"只是点了点别处"的一篇写盘。
 * 2. **每次更新都把手上的那几个位置对一遍**，不按"位置没变"提前返回：`moveBlock` 与
 *    装载都是整树替换，PM 会把那一块的视图重建，新元素身上没有 `data-md-mode`。
 *    只按位置比就会留下"选区在里面、屏幕上却是显示形"的状态——光标看不见。
 *    空选区走 `$from.before(1)`，是 O(1)，不碰 `doc.forEach`。
 * 3. 交出焦点的那一块才重画（`补渲染`），所以打字的路上没有 DOM 构建。
 */
export const OpaqueFace = Extension.create({
  name: "opaqueFace",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        view: (view) => {
          let 上次: number[] = [];

          const 改 = (pos: number, 开: boolean) => {
            const dom = view.nodeDOM(pos);
            if (!(dom instanceof HTMLElement) || !dom.classList.contains("md-opaque")) return;
            if (开) {
              if (dom.dataset["mdMode"] !== "source") dom.dataset["mdMode"] = "source";
            } else {
              delete dom.dataset["mdMode"];
              渲染实例.get(dom)?.补渲染();
            }
          };

          const sync = (state: EditorState) => {
            const sel = state.selection;
            const 现在: number[] = [];
            // 没有焦点就不算"正在改这一块"：打开一篇时 PM 的选区可能落在文末，
            // 那不该让最后一块顶着源码示人（真机看过：像渲染坏了）
            if (view.hasFocus()) {
              if (sel.empty) {
                if (sel.$from.depth) 现在.push(sel.$from.before(1));
              } else {
                state.doc.forEach((node, off) => {
                  if (sel.from < off + node.nodeSize && sel.to > off) 现在.push(off);
                });
              }
            }
            const 留着 = new Set(现在);
            for (const p of 上次) if (!留着.has(p)) 改(p, false);
            for (const p of 现在) 改(p, true);
            上次 = 现在;
          };

          // 焦点变化不发事务，PM 也就不会调 update——只能自己听
          const on焦点 = () => sync(view.state);
          view.dom.addEventListener("focus", on焦点);
          view.dom.addEventListener("blur", on焦点);
          sync(view.state);
          return {
            update: (v: EditorView) => sync(v.state),
            destroy: () => {
              view.dom.removeEventListener("focus", on焦点);
              view.dom.removeEventListener("blur", on焦点);
              上次.forEach((p) => 改(p, false));
            },
          };
        },
      }),
    ];
  },
});

/**
 * Notion 式的输入原语：前缀转块 + `/` 唤出块菜单。
 *
 * 三条不显然的实现口径：
 * 1. **前缀转换在"敲下空格"那一刻完成，且把空格吃掉**。`#` 后面那个空格是语法记号，
 *    不是内容；不吞它，落盘就成了 `##  标题`（多一个空格，md-kernel 会原样当正文）。
 * 2. **只认行首前缀**，而且只认 `serializeNode` 产得出的类型（见 `BLOCK_TYPES` 那段）。
 *    在句子中间打 `#` 就是打个 `#`。
 * 3. `/` 菜单**不发内容事务**：它只往 DOM 上抛一个 `md-slash` 事件。发事务会走
 *    `onUpdate` → 标脏 → 800ms 后把"只是打了个斜杠"的一篇写盘。
 */
export const BlockTools = Extension.create({
  name: "blockTools",
  addProseMirrorPlugins() {
    const prefixOf = (text: string): BlockTypeId | null => {
      if (/^#{1,3}$/.test(text)) return ("heading" + text.length) as BlockTypeId;
      if (/^[-*+]$/.test(text)) return "bullet";
      if (/^\d{1,2}[.)]$/.test(text)) return "numbered";
      if (/^\[[ xX]\]$/.test(text)) return "todo";
      return null;
    };
    return [
      new Plugin({
        props: {
          handleTextInput: (view, from, to, text) => {
            if (text === " ") {
              const $pos = view.state.doc.resolve(from);
              if ($pos.depth === 0) return false;
              const start = $pos.before(1);
              const node = view.state.doc.nodeAt(start);
              if (!node) return false;
              const 前缀 = node.textBetween(0, from - start - 1, undefined, "￼");
              const target = prefixOf(前缀);
              if (!target) return false;
              // 与斜杠菜单、测试走同一个函数：三处各写一份 setNodeMarkup 的话，
              // 测试绿不代表按钮是对的
              const tr = applyBlockType(view.state, start, target);
              if (!tr) return false;
              view.dispatch(tr.delete(from - 前缀.length, from).scrollIntoView());
              return true;
            }
            if (text === "/") {
              const $pos = view.state.doc.resolve(from);
              if ($pos.depth === 0) return false;
              const node = view.state.doc.nodeAt($pos.before(1));
              if (!node || node.type.name === "mdOpaque") return false;
              // 只在空块的行首唤出菜单；句中打斜杠就是打斜杠
              if (node.textContent.trim() !== "" || $pos.parentOffset !== 0) return false;
              // **不发事务**：发事务就走 `onUpdate` → 标脏 → 停手 800ms 把"只是打了个
              // 斜杠"的一篇写盘。TipTap v3 也没有对外的 transactions 事件，所以这里直接
              // 用一个 DOM 事件把位置交给界面层。
              view.dom.dispatchEvent(
                new CustomEvent("md-slash", { detail: { pos: from }, bubbles: true }),
              );
            }
            return false;
          },
        },
      }),
    ];
  },
});

/**
 * 表格里的键。`Tab` / `Shift+Tab` 走格，`Enter` 到下一行同一列（末行则加一行）。
 *
 * 这三条必须**在键位层面**接管：`Tab` 默认会跳出编辑器（焦点跑到工具栏上），
 * `Enter` 默认会拆块——拆出来的两半表格 `serializeNode` 根本不认。
 */
export const TableKeys = Extension.create({
  name: "tableKeys",
  addKeyboardShortcuts() {
    const 走 =
      (做: (state: EditorState) => Transaction | null) =>
      ({ editor }: { editor: Editor }) => {
        const tr = 做(editor.state);
        if (!tr) return false;
        editor.view.dispatch(tr.scrollIntoView());
        return true;
      };
    return {
      Tab: 走((s) => moveCell(s, 1)),
      "Shift-Tab": 走((s) => moveCell(s, -1)),
      Enter: 走(enterCell),
    };
  },
});

export const mdExtensions = [
  MdDoc,
  MdText,
  MdParagraph,
  MdHeading,
  MdItem,
  MdOpaque,
  MdTable,
  MdTableRow,
  MdTableCell,
  MdBold,
  MdItalic,
  MdCode,
  MdStrike,
  MdLink,
  BlockIdGuard,
  BlockTools,
  BlockKeys,
  TableKeys,
  FocusIndicator,
  OpaqueFace,
  History,
];
