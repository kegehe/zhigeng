import { Extension, Mark, Node, type Attributes, type Editor } from "@tiptap/core";
import type { Node as PmNode, Schema } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection, type Transaction, type EditorState } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView, NodeView, ViewMutationRecord } from "@tiptap/pm/view";
import { history, redo, undo } from "@tiptap/pm/history";
import {
  applyBlockType,
  applyBlockTypeToSelection,
  块转换位置,
  在引用里,
  enterCell,
  exitTableDown,
  exitOpaqueDown,
  exitQuoteDown,
  带围栏,
  moveCell,
  moveCurrentBlock,
  这项有序记号,
  replaceBlockWithSource,
  判粘贴,
  图片下出口,
  插图片块,
  填充所选,
  块内范围,
  清场所选,
  全选档,
  列表回车,
  列表退格,
  引用回车,
  引用退格,
  列表跳过说明,
  点待办前缀,
  设列表,
  type BlockTypeId,
} from "./blocks";
import { 可无损, 收图注, 是库内资产, 拆自attrs, 新引用, type 资产引用 } from "./asset";
import { api, describeError, 资产地址 } from "../ipc/commands";
import { 批量, TableSelect } from "./tableSelectPlugin";
import { 拼开栏, 拆开栏, 围栏行of } from "./fence";
import { 锚可进账本, 缀可进账本 } from "./quoteFace";
import { 短写, 已识别, 语言清单, 语言of, 着色区间, 识别 } from "./highlight";
import { 引用高亮扩展 } from "./citeFocus";
import { 查找扩展 } from "./findReplace";
import { FormatPainter } from "./formatPainter";
import { mightRender, renderOpaque } from "./render";
import { 行距事件 } from "../ui/typography";

/**
 * 与 md-kernel 块模型一一对应的节点集，加上十个行内标记
 * （加粗 / 斜体 / 行内码 / 删除线 / 上标 / 下标 / 高亮 / 文字色 / 底色 / 链接）。
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
  // 块级对齐：center / right / justify；空串是默认靠左（不落包裹，docs/02 D40）
  mdAlign: { default: "" },
  // 行内字段（due::/done::）。`content` 里没有它们，重新产出这一块时靠它写回
  mdFields: { default: [] as [string, string][] },
  // 载入之后由 stampSignatures 打上去。空串意味着"新块"，必定被重新序列化
  mdSig: { default: "" },
  /**
   * 新建有序项的记号（`4.` / `3)`）。只活在编辑器里：有历史 `mdRaw` 时以源文件前缀为准，
   * 这项用不上；没有 `mdRaw` 的新项才读它。默认空串，不进既有块的签名。
   */
  mdMarker: { default: "" },
  /**
   * 代码块的围栏账本：开栏行与闭栏行**原样**存着（含前导缩进与 `js // 注释` 那串 info），
   * 节点正文只装两道围栏之间的代码。于是"点进代码块"看到的和"退出来"看到的是同一份内容，
   * 不再在 Markdown 与渲染之间跳——而保存时围栏按这两行拼回去，字节与文件本来的形状一致。
   *
   * 两个空串 = 这一块没走围栏账本这条路（不是代码块、或者**没有闭栏**）。没有闭栏时
   * 绝不能接管：那等于替用户凭空造一道 ` ``` `。
   */
  mdFenceOpen: { default: "" },
  mdFenceClose: { default: "" },
  /**
   * 围栏之间**有没有那一行**。` ``` ` 紧挨 ` ``` `（零行）与"中间一个空行"是两种字节，
   * 而两者的正文都是空字符串——不记这一笔，用户删空代码块最后一行就会多出一个空行。
   */
  mdFenceBody: { default: false },
  /**
   * 块级公式的 `$$` 账本，与围栏同一形状：两道 `$$` 原样存着，节点正文只装公式体。
   * 只接管"首末两行各自只有 `$$`"的写法；单行 `$$ E = mc^2 $$` 拼不回同样的字节，
   * 继续按源文本回显（见 `mathFace.ts`）。
   */
  mdMathOpen: { default: "" },
  mdMathClose: { default: "" },
  /** 两道 `$$` 之间**有没有那一行**：`$$\n$$` 与 `$$\n\n$$` 是两种字节 */
  mdMathBody: { default: false },
  /**
   * 引用 / Callout 的前缀账本：每行原样的 `>`（Callout 标题行含 `[!type]`），
   * 用换行拼成一串。节点正文只留剥掉前缀之后的字，所以点进去和看着是同一段。
   * 空串 = 没走这条路（拼不回原字节，或者根本不是引用）。
   */
  mdQuoteMarks: { default: "" },
  /** 从末行摘下的块锚，含前面的空白。空串 = 这块没有行尾锚，或锚还在正文里。 */
  mdQuoteAnchor: { default: "" },
  /**
   * 结构化引用的行尾格式：`\r\n` / `\n`，以及末行是否还带着那个 `\r`。
   * 前缀账本只管"每行前面是什么"，行尾这两笔不记下来，CRLF 文件改一个字就整块换形。
   */
  mdQuoteEol: { default: "\n" },
  mdQuoteTail: { default: "" },
  /** Callout 的类型与折叠标记（`> [!note]-`）。普通引用是空串 / false。 */
  mdCalloutType: { default: "" },
  mdCalloutFolded: { default: false },
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
  // 对齐是 CSS 的事，但值从 attrs 来——`md*` 不能漏进 DOM，只带一个语义化的出口
  const align = String(attrs.mdAlign ?? "");
  if (align === "center" || align === "right" || align === "justify") out["data-md-align"] = align;
  return out;
}

/**
 * 粘贴时把 `data-md-align` 读回 `mdAlign`（docs/02 D40）。
 *
 * 编辑器的剪贴板 HTML 由 `renderHTML` 产出，本来就带着这个属性；不读回来，同篇里
 * 剪切再贴一次就把居中丢了。只认三档白名单——外面的 HTML 写什么值都不能直接进账本。
 */
function 对齐attrs(el: HTMLElement): Record<string, unknown> {
  const 值 = el.getAttribute("data-md-align");
  return 值 === "center" || 值 === "right" || 值 === "justify" ? { mdAlign: 值 } : {};
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
    return [{ tag: "p", getAttrs: (el) => 对齐attrs(el as HTMLElement) }];
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
    return [{ tag: "h1 h2 h3 h4 h5 h6", getAttrs: (el) => 对齐attrs(el as HTMLElement) }];
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
        ? 这项有序记号(node)
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
 * 显示形（那块 `contenteditable=false` 的岛）上的鼠标事件该谁处理。
 *
 * 只有"左键、没按修饰键"的 mousedown 需要我们自己发选区，其余一律交回 PM 与浏览器。
 * 提成一个纯函数是因为这条判断决定的是"shift-点击能不能扩选区、右键菜单还出不出来"，
 * 而它写在 NodeView 里没法从外面喂事件——判据得能被测试。
 */
export type 岛上鼠标 = "退源码" | "扩选" | "交回";

/**
 * 岛上的"那一击"：左键、没按修饰键。`分派岛上鼠标` 与"点到卡片身上选整块"共用这一个
 * 判据——两处各写一份的话，早晚一处认 shift 扩选、另一处把 shift 也当成换目标。
 *
 * `含Shift` 是给扩选那条路开的口子：shift 不是"另一个目标"，是"在同一个目标上扩"。
 */
function 击是那一击(ev: Event, 含Shift = false): boolean {
  const 击 = ev as MouseEvent;
  return (
    ev.type === "mousedown" &&
    击.button === 0 &&
    !击.altKey &&
    !击.ctrlKey &&
    !击.metaKey &&
    (含Shift || !击.shiftKey)
  );
}

export function 分派岛上鼠标(ev: Event): 岛上鼠标 {
  if (!击是那一击(ev, true)) return "交回";
  return (ev as MouseEvent).shiftKey ? "扩选" : "退源码";
}

/**
 * 卡片上的小图标。几何抄自 lucide（与工具栏那组同一套：`fill=none` + `stroke=currentColor`
 * + 圆角线帽），但 NodeView 里是手搓 DOM，用不了 React 组件。
 * 尺寸给 14：语言牌是 12px 的等宽小字，图标再大就把"卡片的一行元数据"画成工具栏了。
 */
function 画图标(形: "copy" | "check"): SVGSVGElement {
  const 站 = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(站, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    width: "14",
    height: "14",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    svg.setAttribute(k, v);
  const 加 = (名: string, 属: Record<string, string>) => {
    const 元 = document.createElementNS(站, 名);
    for (const [k, v] of Object.entries(属)) 元.setAttribute(k, v);
    svg.append(元);
  };
  if (形 === "copy") {
    加("rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" });
    加("path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" });
  } else {
    加("path", { d: "M20 6 9 17l-5-5" });
  }
  return svg;
}

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
  /** 代码块走围栏账本时**没有宿主**（单面，见构造器），其余两副面孔的类型才有 */
  readonly host: HTMLDivElement | null;
  /** 块内那个语言下拉。只有代码块那一面有，其余类型是 null */
  private 牌: HTMLSelectElement | null = null;
  /** 行号栏与"这一栏现在是几行"。两行以上才存在，单行块不留一个孤零零的 `1` */
  private 行号槽: HTMLDivElement | null = null;
  private 行号数 = 0;
  /** "已复制"那个回显的定时器，视图销毁时要掐掉 */
  private 抄时: ReturnType<typeof setTimeout> | 0 = 0;
  private 节点: PmNode;
  private kind = "raw";
  private 正文 = "";
  private 待重算 = true;
  /** 没有宿主、只有可编辑这一面（代码围栏 / 公式 `$$` 两种账本） */
  private 单面 = false;
  /** 代码单面：语言牌 / 复制键 / 行号栏那一套只属于代码，公式不挂这些 */
  private 代码面 = false;
  /** 公式单面：只给 CSS 一个抓手，把可编辑面画成显示形那张居中公式 */
  private 数学面 = false;

  constructor(
    node: PmNode,
    HTMLAttributes: Record<string, unknown>,
    private readonly view: EditorView,
    private readonly 位置: () => number | undefined,
  ) {
    this.kind = String(node.attrs.mdKind ?? "raw");
    // 显示形要的是"这一块在文件里长什么样"：代码块的围栏在账本里、不在正文里，
    // 直接拿 textContent 去画会认不出开栏而整个降级。
    // **装载这一次不许猜语言**：`highlightAuto` 逐门跑一遍，实测 2~13ms 一块（首门含预热
    // 223ms），而 NodeView 是在打开笔记时一批建出来的。猜测由 `CodeHighlight` 在装饰时算
    // （那里有 8ms 一轮的预算），算完回头刷这个牌——两边读同一份按正文缓存的识别结果。
    this.正文 = 带围栏(node, false);

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

    /**
     * **走了账本的不透明块只有一面**：围栏 / `$$` 不在正文里，可编辑的那一面画出来就是
     * 渲染好的那份，所以点进去与退出来是同一批 DOM——用户要的"样式不变"到这儿才真的成立。
     * 代码那一面外挂着语言牌 / 复制 / 行号，公式只借 CSS 画成居中的公式；没闭栏的代码块
     * 与引用 / Callout 仍然两副面孔：它们的显示形要剥掉正文里真实存在的字节。
     */
    this.代码面 =
      this.kind === "code" && Boolean(node.attrs.mdFenceOpen) && Boolean(node.attrs.mdFenceClose);
    this.数学面 =
      this.kind === "math" && Boolean(node.attrs.mdMathOpen) && Boolean(node.attrs.mdMathClose);
    this.单面 = this.代码面 || this.数学面;
    this.节点 = node;
    if (this.代码面) {
      dom.dataset["mdCode"] = "";
      /**
       * 语言牌是个**真下拉**（用户点名要"块内语言牌变成交互控件"）。它排在 contentDOM
       * 之外，所以 PM 不会把它当正文；`stopEvent` 对它的每一个事件都返回 true，让浏览器
       * 自己处理原生下拉——那一下不是"改源码"，是选一个元数据。
       *
       * 装载时只按**文件里写着的**那个词填，不在此刻猜语言：`highlightAuto` 是逐门跑一遍，
       * 实测比指定语言贵十倍，一篇里十几个代码块全压在打开那一刻不值当。猜测由
       * `CodeHighlight` 在装饰时算（跳过正在输入的那一块），算完回头刷这个牌。
       */
      const 牌 = document.createElement("select");
      牌.className = "md-lang";
      牌.setAttribute("aria-label", "代码语言");
      牌.title = "代码语言（写进 ``` 后面）";
      // 只读正文（浏览 / 演示）里这个下拉只是"语言是什么"的标签，不是可操作控件。
      // 它不归 ProseMirror 管，`editable` 不会自动照顾它——真机点一下照样改文档。
      牌.disabled = !this.view.editable;
      for (const 项 of 语言清单) {
        const o = document.createElement("option");
        o.value = 项.值;
        o.textContent = 项.标签;
        牌.append(o);
      }
      牌.addEventListener("change", () => this.改语言(牌.value));
      this.牌 = 牌;
      /**
       * 原生 `<select>` 上画不出伪元素（replaced element），所以套一层盒子让 CSS 用
       * `currentColor` 画那枚尖角——自造一套下拉在 [06] §4 里是被判死的（控件行为与
       * 键盘都得自己实现，还常常比原生的难用）。
       */
      const 牌框 = document.createElement("span");
      牌框.className = "md-lang-box";
      牌框.append(牌);

      /**
       * 复制按钮：抄的是**这一块正文**，也就是围栏之间那段代码——围栏住在账本 attrs 里、
       * 不在正文里，所以"复制代码"天然不会带上 ` ``` `。
       *
       * 它和语言牌一样排在 `contentDOM` **之外**：PM 看不见它，图标与"已复制"那点文字
       * 永远进不了文件。`stopEvent` 对它返回 true，那一下是点控件，不是"点进块里改源码"。
       */
      const 抄 = document.createElement("button");
      抄.type = "button";
      抄.className = "md-copy";
      抄.setAttribute("aria-label", "复制代码");
      抄.title = "复制代码";
      const 两个 = [画图标("copy"), 画图标("check")];
      两个[1]!.classList.add("md-copy-ok");
      抄.append(...两个);
      抄.addEventListener("click", () => void this.抄代码());
      /**
       * `mousedown` 也交回浏览器：不拦的话 PM 会把插入符打到块首，用户看到的是
       * "点一下复制，光标跳走了、还顺手把选区清了"。
       */
      抄.addEventListener("mousedown", (e) => e.preventDefault());

      const 头 = document.createElement("div");
      头.className = "md-card-head";
      头.append(牌框, 抄);
      dom.append(头);
    }
    if (this.数学面) dom.dataset["mdMath"] = "";

    // 宿主排在源文本**前面**：PM 的 `localPosFromDOM` 按"点击的元素在 contentDOM 之前还是
    // 之后"决定落点，排在前面才拿到块首，点一下就是"从这块的开头改源码"。
    if (!this.单面) dom.append(host);
    dom.append(pre);
    this.dom = dom;
    this.host = this.单面 ? null : host;
    this.contentDOM = code;
    this.刷引用();
    渲染实例.set(dom, this);
    // 装载这一次不许猜语言（`补渲染` 交出焦点时也会被调，那次允许）
    this.补渲染(false);
    this.刷行号();
  }

  /**
   * 行号栏。**两行以上才有**（用户拍的档：单行片段挂一个 `1` 看着像出错了）。
   *
   * 三条不是随便选的位置：
   * - 它是 `contentDOM` **之外**的兄弟节点，PM 看不见它——行号要是混进正文，下一次落盘
   *   文件里就多了 `1 2 3`，那是改用户字节里最坏的一种；
   * - 它排在 `pre` **之前**且不在 `pre` 里面：`pre` 才是横向滚动的那个容器（长行不折行），
   *   放进去就会跟着滚走，滚到右边就看不见行号了；
   * - 只在行数真的变了的时候重写 DOM。行数要是不变，打字这一路一次读写都不做。
   */
  private 刷行号(): void {
    if (!this.代码面) return;
    const 数 = this.节点.textContent.split("\n").length; // 行尾带 `\r` 不影响计数
    if (数 === this.行号数) return;
    this.行号数 = 数;
    if (数 < 2) {
      this.行号槽?.remove();
      this.行号槽 = null;
      return;
    }
    if (!this.行号槽) {
      const 槽 = document.createElement("div");
      槽.className = "md-gutter";
      槽.setAttribute("aria-hidden", "true"); // 装饰性内容，读屏不该念一串数字
      this.dom.insertBefore(槽, this.dom.querySelector(".md-src"));
      this.行号槽 = 槽;
    }
    this.行号槽.textContent = Array.from({ length: 数 }, (_, i) => String(i + 1)).join("\n");
  }

  /**
   * 复制这一块代码。`navigator.clipboard` 优先（WebView2 里由用户手势触发，是安全上下文），
   * 被拒或不可用时退回一个离屏 textarea + `execCommand`——**不能只留一条**：那条 API 在
   * 窗口没拿到系统焦点时会 reject，而"点了复制什么也没发生"比退回一条更糟。
   */
  private async 抄代码(): Promise<void> {
    const 文 = this.节点.textContent;
    const 成 = () => {
      this.dom.dataset["copied"] = "";
      if (this.抄时) clearTimeout(this.抄时);
      this.抄时 = setTimeout(() => {
        this.抄时 = 0;
        delete this.dom.dataset["copied"];
      }, 1400);
    };
    try {
      await navigator.clipboard.writeText(文);
      成();
      return;
    } catch {
      /* 权限 / 非安全上下文 / 窗口没焦点：下面退回 execCommand */
    }
    const 藏 = document.createElement("textarea");
    藏.value = 文;
    藏.setAttribute("aria-hidden", "true");
    藏.style.position = "fixed";
    藏.style.top = "-1000px";
    document.body.append(藏);
    藏.select();
    try {
      if (document.execCommand("copy")) 成();
    } catch {
      /* 两条路都不通就什么也不标：比标了"已复制"却没抄上诚实 */
    }
    藏.remove();
  }

  destroy(): void {
    if (this.抄时) clearTimeout(this.抄时);
  }

  /** 开栏行 → 下拉该显示的那个词 */
  /**
   * 开栏里写着的那个词。
   *
   * **必须走 `fence.ts` 的 `拆开栏`**：这是第三处想自己正则一遍开栏行的地方（另外两处是
   * `有效开栏` 与 `改语言`），而它那句 `(.*)$` 恰恰不认行尾的 `\r`——CRLF 的文件里
   * `​```js` 读成"没写语言"，牌显示成空、着色也退回猜。三份实现早晚分叉，这次分叉的是看得见的地方。
   */
  private 词(开: string): string {
    return 拆开栏(开)?.词 ?? "";
  }

  /**
   * 把牌对到文档现在的内容上。
   *
   * `允许算` = 允许为"文件里没写语言"的块跑一次自动识别（只在交出焦点与装饰路径上给，
   * 装载与击键路径上不给）。认出来的词写进 `title`，让用户看得见"这是猜的"。
   */
  刷语言(允许算: boolean): void {
    if (!this.牌) return;
    const 写着的 = this.词(String(this.节点.attrs.mdFenceOpen ?? ""));
    let 现 = 写着的;
    let 猜的: string | null = null;
    if (!现) {
      // 允许算 = 交出焦点这一刻；不允许时只读缓存（装载时装饰路径多半已经算过，
      // 读得到就显示，读不到就先显示空——下一次重算会补上）
      const 猜 = 允许算 ? 识别(this.节点.textContent) : 已识别(this.节点.textContent) ?? null;
      if (猜) {
        现 = 短写(猜);
        猜的 = 现;
      }
    }
    // 文件里写了个清单外的词（`klingon`）：加一条"当前"选项，别让下拉显示成"无"——
    // 一个说不清自己状态的控件比没有控件更糟。
    const 在列 = (v: string) => 语言清单.some((l) => l.值 === v);
    /**
     * **先把上一轮加的删掉再决定加不加**。`刷语言` 有三条来路（建视图、交出焦点、装饰回刷），
     * 只 append 不去重的结果是"每进出一遍，下拉里多一行一模一样的 klingon"——
     * 实测两个清单外语言的块来回点 6 次，29 项涨到 35 项。
     */
    for (const 项 of Array.from(this.牌.options))
      if (!在列(项.value) && 项.value !== 现) 项.remove();
    if (现 && !在列(现) && !Array.from(this.牌.options).some((o) => o.value === 现)) {
      const o = document.createElement("option");
      o.value = 现;
      o.textContent = 现 + "（文件里写的）";
      this.牌.append(o);
    }
    this.牌.value = 现;
    if (猜的) {
      this.牌.dataset["guessed"] = 猜的;
      this.牌.title = `没写语言，按内容猜的是 ${现}（改一下这块就会写进文件；选一下可覆盖）`;
    } else {
      // 空字符串也算"属性存在"，CSS 的 [data-guessed] 会误判成"这是猜的"
      delete this.牌.dataset["guessed"];
      this.牌.title = "代码语言（写进 ``` 后面）";
    }
    this.dom.setAttribute("data-md-lang", 现);
  }

  /** 选语言 = 改开栏行的 info 首词，缩进、围栏长度、后面那串 `// 注释` 都原样留着 */
  private 改语言(值: string): void {
    // 与 `改注` 同一条闸：`dispatch` 不看 `editable`，只读时这个下拉若还能被触发
    // （禁用状态被绕过、或 NodeView 建在只读态），就会改到一篇"只是看看"的正文。
    if (!this.view.editable) return;
    let pos: number | undefined;
    try {
      pos = this.位置();
    } catch {
      return;
    }
    if (pos === undefined) return;
    const 块 = this.view.state.doc.nodeAt(pos);
    if (!块) return;
    const 原 = String(块.attrs.mdFenceOpen ?? "");
    const 拆 = 拆开栏(原);
    if (!拆) return;
    const 新 = 拼开栏({ ...拆, 词: 值 });
    if (新 === 原) return; // 已经是这门语言了，别发空事务
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, { ...块.attrs, mdFenceOpen: 新 })
    );
  }

  /**
   * 引用账本在的时候，点进去的那一面用和显示形同一套盒子（左边线 / Callout 色）。
   * 类型从标题行前缀里读，不另存一份——两份会分叉。
   */
  private 刷引用(): void {
    const 缀文 = String(this.节点.attrs.mdQuoteMarks ?? "");
    if (!缀文) {
      delete this.dom.dataset["mdQuote"];
      delete this.dom.dataset["callout"];
      return;
    }
    this.dom.dataset["mdQuote"] = this.kind === "callout" ? "callout" : "quote";
    const 首 = 缀文.split("\n")[0] ?? "";
    const m = /\[!([A-Za-z-]+)\]([+-]?)/.exec(首);
    if (m?.[1]) this.dom.dataset["callout"] = m[1].toLowerCase();
    else delete this.dom.dataset["callout"];
    // 折叠态只活在显示形；源文本面把标题连同正文一起摊开，于是得在牌上说明一声，
    // 否则"点进来正文突然多出来"会被读成渲染坏了。
    if (m?.[2] === "-") this.dom.dataset["mdFolded"] = "";
    else delete this.dom.dataset["mdFolded"];
  }

  /** 只在脏了的时候重画：一次焦点转移不该重排没动过的块 */
  补渲染(允许算 = true): void {
    if (this.单面) {
      // 交出焦点这一刻刷一次牌：允许它跑识别（缓存多半已被装饰路径捂热，见 CodeHighlight）。
      // 装载那一次传的是 false——`highlightAuto` 比指定语言贵十倍，不该压在打开笔记的路上
      this.刷语言(允许算);
      return;
    }
    if (!this.待重算) return;
    this.待重算 = false;
    const 画 = mightRender(this.kind) ? renderOpaque(this.kind, this.正文, document) : null;
    // 画不出来（HTML、未识别语法、带子项的列表项）就别藏源文本：
    // 把内容收进一个空宿主里，等于在界面上吃掉这一块。
    this.dom.dataset["mdView"] = 画 ? "on" : "none";
    this.host?.replaceChildren(画 ?? document.createTextNode(""));
  }

  update(node: PmNode): boolean {
    const kind = String(node.attrs.mdKind ?? "raw");
    // 单面 / 两面是 **DOM 形状**的差别（有没有宿主），不是属性差别——交给 PM 重建视图，
    // 在这儿将就就会留下"点进去没有可编辑面"或"两面重叠"的怪状态
    const 该代码面 =
      kind === "code" && Boolean(node.attrs.mdFenceOpen) && Boolean(node.attrs.mdFenceClose);
    const 该数学面 =
      kind === "math" && Boolean(node.attrs.mdMathOpen) && Boolean(node.attrs.mdMathClose);
    if (该代码面 !== this.代码面 || 该数学面 !== this.数学面) return false;
    if ((该代码面 || 该数学面) !== this.单面) return false;
    const 旧开栏 = String(this.节点.attrs.mdFenceOpen ?? "");
    this.节点 = node;
    if (kind !== this.kind) {
      this.kind = kind;
      this.dom.setAttribute("data-md-raw", kind);
      this.待重算 = true;
    }
    /**
     * 开栏变了就把牌对回来。`Ctrl+Z` 撤销一次"选语言"改的正是这个属性，而牌此前只在
     * **交出焦点**时刷（`补渲染`）——撤销时焦点根本没动过，于是文件回到了 `js`、
     * 下拉与着色还写着 `go`，屏幕与盘各说一句话。只读缓存（`允许算 = false`），
     * 这条路每次击键都会走。
     */
    if (this.代码面 && String(node.attrs.mdFenceOpen ?? "") !== 旧开栏) this.刷语言(false);
    this.刷引用();
    // 行数变了才重写那一栏（打字时行数一般不动，这条判据让它在击键路径上零读写）
    this.刷行号();
    // 单面那一种**不算源文本**：`带围栏` 会走自动识别，而 update 每次击键都来一遍
    if (!this.单面) {
      const 源 = 带围栏(node, false);
      if (源 !== this.正文) {
        this.正文 = 源;
        this.待重算 = true;
      }
    }
    return true;
  }

  /** 我们自己那半棵子树（含 wrapper 上的 data-md-*）不许惊动 DOM 观察器 */
  ignoreMutation(mut: ViewMutationRecord): boolean {
    const 目标 = mut.target as globalThis.Node;
    return !(目标 === this.contentDOM || this.contentDOM.contains(目标));
  }

  /**
   * 显示形上的鼠标：只有"左键、没按修饰键"那一下归我们。
   *
   * 真机抓到的：**Chromium 不会把插入符放进 `contenteditable=false` 的岛里**，点了就是
   * 选那块 DOM、什么也不发生。所以"点一下退回源文本"不能指望浏览器与 PM 的默认行为，
   * 必须自己发选区。PM 的 `stopEvent` 返回 true 之后这件事就完全归我们管。
   *
   * 但"归我们管"只对那一击成立：从前对宿主子树里的**每一个**事件都返回 true，于是
   * `mouseup`/`contextmenu`/`dblclick`/`dragstart` 全被当成已处理，shift-点击也照样落到
   * 发选区那条路上——结果是想扩选区的人拿到的是"选区清空、光标跳到块首"。
   *
   * Callout 标题是另一种控件：只改折叠态，连选区都不该动（那条是显示态，不是内容）。
   */
  stopEvent(ev: Event): boolean {
    const 目标 = ev.target as Element | null;
    if (!目标) return false;
    /**
     * 语言下拉与复制按钮：PM 一律别看它们。返回 true 让浏览器处理原生行为，我们自己也不
     * preventDefault——那一下是"选一个元数据 / 抄一段代码"，不是"点进块里改源码"，
     * 走 `进源码()` 会把用户从下拉里踢出来、或者把插入符甩到块首。
     */
    if (目标.closest(".md-lang") || 目标.closest(".md-copy")) return true;
    /**
     * 点在**卡片自己身上**——卡片头那一行（语言牌与复制键之外的那段）、行号栏、块自己的
     * 内边距——要的是"这一块"，不是块里的某个字符。PM 的默认行为会把这一击折进块内放一个
     * 插入符，于是整块选中没有任何鼠标路径；而"把这块删掉"只有拿到 NodeSelection 才干净
     * （选中块内文字再删留下的是空围栏，见 `删块在`）。
     *
     * 只认"左键、没按修饰键"的 mousedown：对每一个事件都返回 true 会把 `mouseup` /
     * `dblclick` / shift-点击一起吃掉，那正是下面宿主那一段已经栽过一次的错。
     */
    const 块级落点 =
      目标 === this.dom ||
      !!(目标.closest(".md-card-head") || 目标.closest(".md-gutter"));
    if (块级落点 && this.dom.contains(目标) && !this.host?.contains(目标) && 击是那一击(ev)) {
      this.选整块();
      return true;
    }
    if (!this.host?.contains(目标)) return false;
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
    const 派 = 分派岛上鼠标(ev);
    if (派 === "交回") return false;
    if (派 === "扩选") this.扩到点击处(ev as MouseEvent);
    else this.进源码();
    return true;
  }

  /**
   * shift-点击：把选区从原位扩到这一点，**不许塌成块首**。
   *
   * 落点只能按整块算（岛里的字符位置 PM 也读不准），所以这里扩到的是"这一块"，紧跟着
   * `OpaqueFace` 就把块翻回源文本形——第二次 shift-点击就能落到具体字符上。
   */
  private 扩到点击处(击: MouseEvent): void {
    const 点 = this.view.posAtCoords({ left: 击.clientX, top: 击.clientY });
    if (!点) return;
    const 落 = TextSelection.near(
      this.view.state.doc.resolve(点.inside > 0 ? 点.inside + 1 : 点.pos),
    );
    const 选 = new TextSelection(this.view.state.selection.$anchor, 落.$head);
    if (选.eq(this.view.state.selection)) return;
    this.view.dispatch(this.view.state.tr.setSelection(选).scrollIntoView());
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

  /**
   * 选中整块的 DOM 标记。**必须自己实现这两条**：PM 的默认做法是给 `dom` 加
   * `ProseMirror-selectednode` 那个类，而它配套的 `prosemirror-view/style/prosemirror.css`
   * 我们根本没 import（构建产物里查无 `.ProseMirror pre` 与 `selectednode` 两条规则）——
   * 于是"选区确实是 NodeSelection、屏幕上却什么都没有"。图片那一档早就踩过并给出了答案
   * （`ImageView.selectNode`）：只加一个 DOM 标记，不重画、不发事务。
   *
   * 用同一个 `data-md-sel`：图片卡与代码卡在选中时该是同一副样子，两套属性名就是两套语言。
   */
  selectNode(): void {
    this.dom.dataset.mdSel = "";
  }
  deselectNode(): void {
    delete this.dom.dataset.mdSel;
  }

  /**
   * 把这一整块变成选区（NodeSelection）。
   *
   * `mdOpaque` 不是 atom，但 PM 照样允许给它发 NodeSelection（`isSelectable` 判的是
   * `spec.selectable !== false`），而 `deleteSelection` 对它是**连节点一起删**——
   * 这正是"整块删除"要的那一条：把块里的字全选上删掉，留下的是空围栏与块锚点。
   */
  private 选整块(): void {
    let pos: number | undefined;
    try {
      pos = this.位置();
    } catch {
      return; // 节点已经不在文档里了
    }
    const 块 = pos === undefined ? null : this.view.state.doc.nodeAt(pos);
    if (!块 || pos === undefined || !NodeSelection.isSelectable(块)) return;
    const { state } = this.view;
    this.view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)));
    this.view.focus();
  }
}

/**
 * 结构化引用 / Callout 的标题行。单独一个节点是为了让"标题"和"正文段落"在编辑面
 * 各占一行，而且回车时能明确地"从标题落到正文"——把它们塞进同一个段落就分不清了。
 *
 * 不带任何账本属性：标题的 `[!type]` 前缀住在父节点的 `mdQuoteMarks` 里。
 */
export const MdQuoteHead = Node.create({
  name: "mdQuoteHead",
  content: "inline*",
  defining: true,
  parseHTML() {
    return [{ tag: "div[data-md-quote-head]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", { ...domAttrs(HTMLAttributes), "data-md-quote-head": "" }, 0];
  },
});

/**
 * 引用 / Callout 的结构化节点（docs/02 D42 / D43）。
 *
 * 与 `mdOpaque` 的区别只有一条：**正文是真正可编辑的段落 / 列表**，而不是一段源文本。
 * 每行前面的 `>`、Callout 的 `[!type]`、行尾块锚仍在 `md*` 账本里，保存时按行拼回去。
 * 拼不回去的块在 `quoteStructured.ts` 里就被挡在门外，继续走 `mdOpaque`。
 */
class QuoteView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private 牌: HTMLButtonElement | null = null;
  private 节点: PmNode;

  constructor(node: PmNode, 属性: Record<string, unknown>) {
    this.节点 = node;
    const 型 = String(node.attrs.mdKind ?? "quote");
    if (型 === "callout") {
      const dom = document.createElement("div");
      dom.className = "callout md-quote";
      for (const [k, v] of Object.entries(属性)) {
        if (k.startsWith("md") || v === null || v === undefined) continue;
        dom.setAttribute(k, String(v));
      }
      const 牌 = document.createElement("button");
      牌.type = "button";
      牌.className = "cal-badge";
      牌.setAttribute("aria-label", "折叠 / 展开");
      // 折叠是**显示态**：只改 DOM 属性，不发事务、也不写回 `[!type]-`（与显示形同一条）
      牌.addEventListener("mousedown", (e) => e.preventDefault());
      牌.addEventListener("click", () => {
        if (dom.dataset["folded"]) delete dom.dataset["folded"];
        else dom.dataset["folded"] = "1";
      });
      const 身 = document.createElement("div");
      身.className = "cal-body";
      dom.append(牌, 身);
      this.dom = dom;
      this.contentDOM = 身;
      this.牌 = 牌;
      if (node.attrs.mdCalloutFolded) dom.dataset["folded"] = "1";
    } else {
      const dom = document.createElement("blockquote");
      dom.className = "quote md-quote";
      for (const [k, v] of Object.entries(属性)) {
        if (k.startsWith("md") || v === null || v === undefined) continue;
        dom.setAttribute(k, String(v));
      }
      this.dom = dom;
      this.contentDOM = dom;
    }
    this.同步(node);
  }

  private 同步(node: PmNode): void {
    this.节点 = node;
    const 型 = String(node.attrs.mdKind ?? "quote");
    this.dom.dataset["mdQuote"] = 型 === "callout" ? "callout" : "quote";
    const 类 = String(node.attrs.mdCalloutType ?? "").toLowerCase();
    if (型 === "callout" && 类) this.dom.dataset["callout"] = 类;
    else delete this.dom.dataset["callout"];
    if (this.牌) this.牌.textContent = 类;
  }

  update(node: PmNode): boolean {
    if (node.type.name !== "mdQuote") return false;
    // 普通引用与 Callout 的 DOM 结构不同（badge、.cal-body）。kind 一变就得让 PM
    // 重建 NodeView——Return true 只会改 data 属性，屏幕上看不到 badge，还是旧壳子。
    if (String(node.attrs.mdKind ?? "quote") !== String(this.节点.attrs.mdKind ?? "quote")) {
      return false;
    }
    this.同步(node);
    return true;
  }

  stopEvent(ev: Event): boolean {
    const 目标 = ev.target;
    return 目标 instanceof Element && 目标.closest(".cal-badge") !== null;
  }

  ignoreMutation(mut: ViewMutationRecord): boolean {
    const 目标 = mut.target as globalThis.Node;
    return !(目标 === this.contentDOM || this.contentDOM.contains(目标));
  }

  selectNode(): void {
    this.dom.dataset.mdSel = "";
  }
  deselectNode(): void {
    delete this.dom.dataset.mdSel;
  }
}

export const MdQuote = Node.create({
  name: "mdQuote",
  group: "block",
  content: "(mdParagraph | mdHeading | mdItem | mdQuoteHead)+",
  defining: true,
  isolating: true,
  addAttributes() {
    return mdAttributes;
  },
  parseHTML() {
    return [
      {
        tag: "blockquote[data-md-quote]",
        getAttrs: (el) => {
          const 元 = el as HTMLElement;
          const 标 = 元.getAttribute("data-callout") ?? "";
          return {
            mdKind: 元.getAttribute("data-md-quote") === "callout" ? "callout" : "quote",
            // 剪贴板不可信：类型只收字母与连字符，别的一律当普通引用
            mdCalloutType: /^[A-Za-z-]+$/.test(标) ? 标 : "",
            mdCalloutFolded: 元.hasAttribute("data-md-folded"),
          };
        },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const 型 = String(node.attrs.mdKind ?? "quote");
    const 类 = String(node.attrs.mdCalloutType ?? "");
    return [
      "blockquote",
      {
        ...domAttrs(HTMLAttributes),
        "data-md-quote": 型 === "callout" ? "callout" : "quote",
        ...(型 === "callout" && /^[A-Za-z-]+$/.test(类) ? { "data-callout": 类 } : {}),
        ...(node.attrs.mdCalloutFolded ? { "data-md-folded": "" } : {}),
      },
      0,
    ];
  },
  addNodeView() {
    return ({ node, HTMLAttributes }) => new QuoteView(node, HTMLAttributes);
  },
});

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
    return [
      {
        tag: "pre[data-md-raw]",
        /**
         * PM 的剪贴板走的就是这条 `renderHTML` → `parseHTML` 通路，所以**账本必须跟着进 DOM**，
         * 否则"复制一个代码块贴到别处"贴出来的是没有围栏的一堆裸行——`# 这行不是标题`
         * 那样的内容会直接变成真标题（复查实测：过一遍 DOM 之后 `mdFenceOpen` 是空串）。
         * 同理 `mdKind` 也要带回来：只带围栏不带类型，贴出来的块 `单面` 判不出来，
         * 又会退回两副面孔。
         */
        getAttrs: (el) => {
          const 元 = el as HTMLElement;
          const 出: Record<string, string | boolean> = {
            mdKind: 元.getAttribute("data-md-raw") ?? "raw",
          };
          const 开 = 元.getAttribute("data-md-fence-open");
          if (开) {
            出.mdFenceOpen = 开;
            出.mdFenceClose = 元.getAttribute("data-md-fence-close") ?? "";
            出.mdFenceBody = 元.getAttribute("data-md-fence-body") === "1";
          }
          const 数开 = 元.getAttribute("data-md-math-open");
          if (数开) {
            出.mdMathOpen = 数开;
            出.mdMathClose = 元.getAttribute("data-md-math-close") ?? "";
            出.mdMathBody = 元.getAttribute("data-md-math-body") === "1";
          }
          const 缀文 = 元.getAttribute("data-md-quote-marks");
          if (缀文) {
            const 缀 = 缀文.split("\u001e");
            const 锚 = 元.getAttribute("data-md-quote-anchor") ?? "";
            if (缀可进账本(缀) && 锚可进账本(锚)) {
              出.mdQuoteMarks = 缀.join("\n");
              出.mdQuoteAnchor = 锚;
            }
          }
          return 出;
        },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const 开 = String(node.attrs.mdFenceOpen ?? "");
    const 闭 = String(node.attrs.mdFenceClose ?? "");
    const 数开 = String(node.attrs.mdMathOpen ?? "");
    const 数闭 = String(node.attrs.mdMathClose ?? "");
    const 缀文 = String(node.attrs.mdQuoteMarks ?? "");
    const 锚 = String(node.attrs.mdQuoteAnchor ?? "");
    return [
      "pre",
      {
        ...domAttrs(HTMLAttributes),
        "data-md-raw": String(node.attrs.mdKind ?? "raw"),
        style: `--md-indent:${Number(node.attrs.mdDepth ?? 0)}`,
        ...(开 && 闭
          ? {
              "data-md-fence-open": 开,
              "data-md-fence-close": 闭,
              "data-md-fence-body": node.attrs.mdFenceBody ? "1" : "0",
            }
          : {}),
        ...(数开 && 数闭
          ? {
              "data-md-math-open": 数开,
              "data-md-math-close": 数闭,
              "data-md-math-body": node.attrs.mdMathBody ? "1" : "0",
            }
          : {}),
        ...(缀文
          ? {
              "data-md-quote-marks": 缀文.split("\n").join("\u001e"),
              "data-md-quote-anchor": 锚,
            }
          : {}),
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
 * 图片块的 NodeView。**屏幕上只有这一副样子**：聚焦、选中、失焦都不换 DOM——
 * 代码块那一轮立下的产品杆子（"光标进来就换一副样子"不算过关）在这里同样成立。
 *
 * 三件事排在一起才成立：
 * - 正文里没有 Markdown 那一行。它是**原子块**，引用整个住在 attrs 里，屏幕上就是那张图；
 * - 唯一能改的字节（图注）是排在 `contentDOM` 位置之外的真 `<input>`，PM 看不见它，
 *   `stopEvent` 对它返回 true——那一下是打字，不是"点进块里改源码"；
 * - 文件读不到（图被删了、库换到别的机器上）时不画破图，退成文件名那一枚牌。仍然不显示
 *   源文本：那一行本来只有一个引用，显示它的名字就是说真话。
 */
class ImageView implements NodeView {
  dom: HTMLElement;
  private 图: HTMLImageElement;
  private 牌: HTMLSpanElement;
  private 注: HTMLInputElement;
  private 视图: EditorView;
  private 位置: () => number | undefined;
  /** 框里有还没进文档的用户输入。只有 `input` 事件能置它，外部更新据此决定踩不踩 */
  private 打过字 = false;

  constructor(
    node: PmNode,
    _属性: Record<string, unknown>,
    view: EditorView,
    getPos: () => number | undefined
  ) {
    this.视图 = view;
    this.位置 = getPos;

    const 盒 = document.createElement("div");
    盒.className = "md-img";

    const 图 = document.createElement("img");
    图.className = "md-img-i";
    // 图不该挡住打字：先让浏览器把它解码完再排版，滚动到哪算哪
    图.loading = "lazy";
    图.decoding = "async";
    图.addEventListener("error", () => {
      盒.dataset.mdMiss = "";
    });
    this.图 = 图;

    const 牌 = document.createElement("span");
    牌.className = "md-img-miss";
    this.牌 = 牌;

    /**
     * 图注那一行工具条。它**不是** contentDOM：PM 看不见，里面的字永远不会被当成正文，
     * 于是"打个图注"不可能往代码或别的块里塞字节。
     */
    const 条 = document.createElement("div");
    条.className = "md-img-bar";
    const 注 = document.createElement("input");
    注.className = "md-img-alt";
    注.type = "text";
    注.setAttribute("aria-label", "图注");
    注.placeholder = "图注（可留空）";
    注.title = "图注：写进文件里 ![[…|这里]] 的那一段";
    // 只读时不收字：只拦 `change` 不够——演示里打进去的字会留在框里，退出后再
    // 触发一次 `change`（blur）就写进文件了。输入框不归 PM 的 `editable` 管。
    注.readOnly = !this.视图.editable;
    // 用 change 而不是 input：只想聚焦看一眼不该改文件，也不该把整篇标成未保存
    注.addEventListener("change", () => this.改注(注.value));
    // 只有用户真打过字才算"框里有还没进文档的内容"。不记这一笔，撤销之后外部更新会被
    // "别踩掉正在打字的格子"那条判断挡在门外，框里留着撤销前的旧值，用户一 blur 又把
    // 撤销掉的内容写回文件（真查出来过这条链）
    注.addEventListener("input", () => {
      this.打过字 = true;
    });
    // 编辑态：点在工具条上不该顺带把整块选中（那会让输入框刚拿到焦点就被 NodeSelection 抢走）。
    // 浏览态：**必须让它冒泡出去**——"点正文就地转编辑"那个监听挂在 view.dom 上，拦下来
    // 用户点到的就是一格永远写不进去的框。代价是浏览态下要点两下（第一下翻进编辑态，
    // 第二下才进框），比"打了字却静默消失"诚实
    条.addEventListener("mousedown", (e) => {
      if (this.视图.editable) e.stopPropagation();
    });
    条.append(注);
    this.注 = 注;

    盒.append(图, 牌, 条);
    this.dom = 盒;
    this.同步(node);
  }

  /** 把 attrs 投射到 DOM 上。原子块没有正文，所以只有这几样 */
  private 同步(节点: PmNode): void {
    const 目标 = String(节点.attrs.mdSrc ?? "");
    const 注 = String(节点.attrs.mdAlt ?? "");
    const 址 = 资产地址(目标);
    if (址) {
      this.图.src = 址;
    } else {
      // 没有地址就**直接**进"读不到"那一面：浏览器不会因为 `src` 被摘掉而抛 error 事件，
      // 只 removeAttribute 的话屏幕上会剩一个既没有图也没有名牌的空框（查过才改的）
      this.图.removeAttribute("src");
      this.dom.dataset.mdMiss = "";
    }
    this.图.alt = 注;
    this.图.title = 目标;
    this.牌.textContent = 目标.split("/").pop() || 目标;
    // 正在打字且框里的值与文档不同，说明那是还没提交的用户输入，不许被外部更新踩掉
    if (!(document.activeElement === this.注 && this.打过字)) {
      this.注.value = 注;
      this.打过字 = false;
    }
  }

  update(节点: PmNode): boolean {
    if (节点.type.name !== "mdImage") return false;
    this.同步(节点);
    return true;
  }

  /** 工具条里的每一个事件都交回浏览器：那一下是控件行为，不是文档编辑 */
  stopEvent(事件: Event): boolean {
    const 目标 = 事件.target;
    return 目标 instanceof Element && 目标.closest(".md-img-bar") !== null;
  }

  ignoreMutation(): boolean {
    return true;
  }

  /** 选中只加一个 DOM 标记，不重画、不发事务——"聚焦前后是同一批 DOM"就是这么来的 */
  selectNode(): void {
    this.dom.dataset.mdSel = "";
  }
  deselectNode(): void {
    delete this.dom.dataset.mdSel;
  }

  /**
   * 写回图注。**空别名要把那根竖线一起收掉**，否则清掉图注会在文件里留下 `![[a.png|]]`；
   * 表示不了的字符（方括号、换行，Markdown 形还有圆括号）先收掉，收完再过一次写侧那道闸。
   * 收过之后框里剩什么，屏幕上就得显示什么——留着被打掉的字符就是"屏幕说的与落盘的不是
   * 同一句话"，所以这里把框也改回收过的值。
   */
  private 改注(值: string): void {
    // 浏览态整个实例是只读的，但这个 `<input>` 不归 PM 管——不挡一下，"只是看看"也能把
    // 图注写进文件。PM 的 `dispatch` 不看 `editable`，所以这道闸必须自己上
    if (!this.视图.editable) return;
    let pos: number | undefined;
    try {
      pos = this.位置();
    } catch {
      return;
    }
    if (pos === undefined) return;
    const 块 = this.视图.state.doc.nodeAt(pos);
    if (!块 || 块.type.name !== "mdImage") return;
    const 形: "wiki" | "md" = 块.attrs.mdWiki === false ? "md" : "wiki";
    const 原 = String(块.attrs.mdAlt ?? "");
    const 收 = 收图注(值, 形);
    if (收 !== 值) this.注.value = 收;
    /**
     * **值没变就一个事务都不发**——连那根竖线的标志也不动。两个理由叠在一起：
     * 空事务照样走 `onUpdate`，而界面的脏判据是 `inlineRev > 0 || 字节不同`，
     * 于是"聚焦看一眼再移开"能把整篇顶成未保存；而 `![[a.png|]]` 那块被这么一动就会
     * 掉一根竖线（用户没打任何字，文件却变了）。清掉一个**有内容**的图注走的是下面那条：
     * 那时值确实变了，竖线跟着收掉才对。
     */
    if (原 === 收) return;
    const 属性 = { ...块.attrs, mdAlt: 收, mdNamed: 收 !== "" };
    if (!可无损(拆自attrs(属性))) return; // 收过还不行就什么都不改，也比写出一行拆不回来的强
    this.视图.dispatch(this.视图.state.tr.setNodeMarkup(pos, undefined, 属性));
    // 这一刻起框里的内容与文档一致：闸门交回给"外部更新可以踩它"。
    // 不在这儿清，撤销之后框里还留着撤销前的值，用户一 blur 就把刚撤销掉的内容写回文件
    this.打过字 = false;
  }
}

/**
 * 分隔线。**schema 里的原子块**：`---` / `***` / `___` 都是它，原字节躺在 `mdRaw` 里。
 *
 * 为什么不留在 `mdOpaque`：那一行没有"正文"可言，整行都是语法记号。两副面孔会逼用户
 * 点进去对着三个横线改源码——而这里能做的只有"删掉这一块"或"换成别的块"。原子化之后
 * 屏幕上只有一条线，聚焦、选中、失焦都是同一批 DOM。
 */
export const MdDivider = Node.create({
  name: "mdDivider",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return mdAttributes;
  },
  parseHTML() {
    return [
      {
        tag: "hr[data-md-divider]",
        // 剪贴板 HTML 里只带形状；类型与账本默认值由这里补齐（`mdKind` 默认是 paragraph）
        getAttrs: () => ({ mdKind: "divider" }),
      },
    ];
  },
  renderHTML() {
    return ["hr", { class: "md-divider", "data-md-divider": "" }];
  },
  addNodeView() {
    return () => {
      const dom = document.createElement("hr");
      dom.className = "md-divider";
      dom.setAttribute("data-md-divider", "");
      return {
        dom,
        // 选中标记与图片 / 代码块同一个属性名：屏幕上一个块被选中该是同一副样子
        selectNode() {
          dom.dataset["mdSel"] = "";
        },
        deselectNode() {
          delete dom.dataset["mdSel"];
        },
      };
    };
  },
});

/**
 * 图片块。**schema 里的原子块**，字节只有文件里那一行引用：
 * `![[attachments/a3/<sha>.png]]` 或 `![图注](attachments/…)`。
 *
 * 为什么值得为它建节点而不是留在 `mdOpaque` 里：不透明块的两副面孔对图片是错的——
 * 那一行没有"正文"可言（整行都是语法记号），把它退回源文本编辑等于让用户手打哈希文件名。
 * 接管之后屏幕上只有图，能改的只有图注，路径由内容寻址说话。
 *
 * `parseHTML` / `renderHTML` 是剪贴板那条通路（PM 的复制粘贴走的就是它）。账本里
 * 只带 `mdSrc`/`mdAlt`/`mdWiki`：一块被复制到别处就是"另建一块指向同一份字节"，
 * 不该捎走原块的 `mdRaw`、锚点与缩进形状。
 */
export const MdImage = Node.create({
  name: "mdImage",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      ...mdAttributes,
      /** Vault 根相对的资产路径，**照文件里写的那个样子**存着 */
      mdSrc: { default: "" },
      mdAlt: { default: "" },
      /** wiki 形还是 Markdown 形。作者选哪一种，落盘就还是哪一种 */
      mdWiki: { default: true },
      /** `![[a.png|]]` 里那根竖线是用户打的字，不能与 `![[a.png]]` 混为一种字节 */
      mdNamed: { default: false },
      mdLead: { default: "" },
      mdTail: { default: "" },
      /** CRLF 文件的行尾 `\r`。它排在块锚点之后，位置错了就是改用户字节 */
      mdEol: { default: "" },
    };
  },
  parseHTML() {
    return [
      {
        tag: "img[data-md-src]",
        /**
         * **剪贴板是不可信的，这道闸必须在这儿。** PM 的粘贴走 `renderHTML` → `parseHTML`，
         * 所以外部 HTML 里带一个 `data-md-src` 就能把任意字符串塞进 attrs，而序列化器会把它
         * 原样拼成一行写进用户的文件——真测过：`data-md-src="a.png]]\n\n# 注入的标题\n![[b"`
         * 落盘后凭空多出一个标题块。判据不另写一套，就用读写共用的那一对函数自己验自己。
         */
        getAttrs: (el) => {
          const 元 = el as HTMLElement;
          const 目标 = 元.getAttribute("data-md-src") ?? "";
          const 别名 = 元.getAttribute("data-md-alt") ?? "";
          const 形 = 元.getAttribute("data-md-wiki") === "0" ? "md" : "wiki";
          const 拆: 资产引用 = {
            形,
            目标,
            别名,
            有别名: 元.getAttribute("data-md-named") === "1" || 别名 !== "",
            前: "",
            后: "",
          };
          if (!是库内资产(目标) || !可无损(拆)) return false;
          return {
            mdKind: "image",
            mdSrc: 目标,
            mdAlt: 别名,
            mdWiki: 形 !== "md",
            mdNamed: 拆.有别名,
          };
        },
      },
    ];
  },
  renderHTML({ node }) {
    return [
      "img",
      {
        class: "md-img-clip",
        "data-md-src": String(node.attrs.mdSrc ?? ""),
        "data-md-alt": String(node.attrs.mdAlt ?? ""),
        "data-md-wiki": node.attrs.mdWiki === false ? "0" : "1",
        // 那根竖线是用户打的字节，复制粘贴一趟不该把它弄丢
        "data-md-named": node.attrs.mdNamed ? "1" : "0",
        alt: String(node.attrs.mdAlt ?? ""),
      },
    ];
  },
  addNodeView() {
    return ({ node, view, getPos, HTMLAttributes }) =>
      new ImageView(node, HTMLAttributes, view, getPos);
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

/**
 * 上标 / 下标。Markdown 没有原生语法，落盘用 `<sup>` / `<sub>`（docs/02 D38）。
 *
 * 互斥必须**两边都写**：ProseMirror 的 `Mark.addToSet` 遇到"现有标记排除了新标记"会
 * 直接丢弃新的（`other.type.excludes(this.type)` 那条）。只给一边写，反方向点下去
 * 会静默不生效——界面上按钮亮了，字却没变。
 */
export const MdSup = Mark.create({
  name: "sup",
  excludes: "sub",
  parseHTML: () => [{ tag: "sup" }],
  renderHTML: ({ HTMLAttributes }) => ["sup", HTMLAttributes, 0],
});

export const MdSub = Mark.create({
  name: "sub",
  excludes: "sup",
  parseHTML: () => [{ tag: "sub" }],
  renderHTML: ({ HTMLAttributes }) => ["sub", HTMLAttributes, 0],
});

/**
 * 高亮。`==文字==` 落盘（Obsidian 兼容），底色由 `--md-mark` 一个 token 决定——
 * 高亮表达的是"这一段要跳出来"，不是"用户挑了一个颜色"，所以它不参与调色板。
 */
export const MdHighlight = makeMark("highlight", "mark", "Mod-Shift-h");

/**
 * 文字色 / 底色。**落盘是真色值**（`<span style="color:#e5534b">`）而不是 token 名：
 * `.md` 会被 Obsidian / VS Code / git diff 直接打开，写 `var(--x)` 到了别人手里就是一串
 * 谁也不认识的字符。两份调色板（界面与文件）因此必须同源，见 `colors.ts`。
 *
 * `parseHTML` 只认带 `data-md-color` 的 span：粘进来的网页富文本带一堆 `style`，
 * 照单全收等于让别人的样式表决定我们的文件长什么样。
 */
function makeColorMark(name: string, prop: "color" | "background-color") {
  return Mark.create({
    name,
    addAttributes() {
      return {
        color: {
          default: "",
          parseHTML: (el) => el.getAttribute("data-md-color") ?? "",
          renderHTML: () => ({}),
        },
      };
    },
    parseHTML() {
      return [{ tag: "span[data-md-color]" }];
    },
    renderHTML({ mark }) {
      const color = String(mark.attrs.color ?? "");
      return ["span", { "data-md-color": color, style: `${prop}:${color}` }, 0];
    },
  });
}

export const MdTextColor = makeColorMark("textColor", "color");
export const MdBgColor = makeColorMark("bgColor", "background-color");

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
 * "新块"由反向映射判：起点落回旧文档时是 `deleted` 的才算。只凭"与上一块 `mdRaw`
 * 相同"不够——作者故意写的相邻同源块（`甲\n\n\n甲`）也满足它，随便改一处就会把另一块
 * 的空行压掉。
 *
 * 只在**局部改动**里认拆块产物：载入、`moveBlock`、插入结构块、打签名走的都是整树
 * 替换，那些事务里出现的"相邻两块源切片相同"是文件本来的样子（`甲\n\n甲\n`），
 * 清掉就会把作者故意留的空行改没——那是另一种改用户内容。
 */
export const LedgerGuard = () =>
  new Plugin({
    appendTransaction: (steps, old, state) => {
      /**
       * **只在真的改了文档的事务上跑**。PM 对每一次 apply 都会叫这条守卫，纯光标移动也算一次
       * ——不挡就会在"只是点了下正文"时改掉用户没碰过的块的账本（文件里相邻两块源切片相同就中招，
       * `甲\n\n甲` 这种），而那笔补出来的事务是 `docChanged` 的：`onUpdate` 跟着响，这篇就被标成
       * 未保存，字节却一个没变。真测过（探针：动一下光标 `mdRaw` 从 `"甲\n"` 变成 `""`）。
       */
      if (!steps.some((tr) => tr.docChanged)) return undefined;

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

      /**
       * 反查映射：新文档里的位置落回旧文档，`deleted` 说明这个起点是这次事务**新造的**。
       * 拆块与粘贴都会把原块的账本复制给新节点，而"新节点"只有映射知道。
       */
      const 正: Mapping = new Mapping();
      steps.forEach((t) => 正.appendMapping(t.mapping));
      const 反向 = 正.invert();
      const 同源数 = new Map<string, number>();
      for (const { n } of 块) {
        const raw = typeof n.attrs.mdRaw === "string" ? n.attrs.mdRaw : "";
        if (raw) 同源数.set(raw, (同源数.get(raw) ?? 0) + 1);
      }

      块.forEach(({ n, 位置 }, i) => {
        const a = { ...n.attrs, ...改.get(i) };
        const raw = typeof a.mdRaw === "string" ? a.mdRaw : "";
        // **不再拿"与上一块 mdRaw 相同"当拆块判据**：作者故意写的相邻同源块（`甲\n\n\n甲`）
        // 也满足它，随便改一个字就把第二块多余的空行当成拆块产物压掉。现在两条一起看：
        // ① 起点是这次事务新造的；② 这份源切片在文档里另有同源——拆块的两半、粘贴与原块
        // 都满足，而撤销删除放回来的孤立原块不满足（它的账本应当跟着回来）。
        const 新造 = 反向.mapResult(位置, 1).deleted;
        // 表格**不参与这条判据**。它的前提是"重新序列化等于原字节"——段落、标题、列表、
        // 不透明块都成立（产回来就是那份文本），表格不成立：`serializeTable` 产的是规范形，
        // 清掉账本等于把一张用户没碰过的表从 `|:-----|` 重写成 `| :--- |`（真机取证过：
        // 两张相邻且源文本相同的表，给第一张加一列，第二张的字节就跟着变了）。
        // 而这条判据本来也用不到表格身上：格子里的 Enter 被 `TableKeys` 接管成跳格，
        // 表格拆不出"相邻两块同源"这种产物。
        if (raw && 新造 && (同源数.get(raw) ?? 0) > 1 && n.type.name !== "mdTable") {
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

/**
 * Callout 的标题行被整个删掉时兜底。
 *
 * 保存时第一行带 `[!type]` 的就是标题——标题节点没了，正文第一段会**接任标题**
 * （`> [!note] 正文`）。用户只是删了一行，语义却悄悄变了。这里把整块退回普通引用：
 * 类型与账本首行一起改掉（账本才是落盘的权威），文字一个不少。
 */
export const CalloutGuard = Extension.create({
  name: "calloutGuard",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (steps, _old, state) => {
          if (!steps.some((tr) => tr.docChanged)) return undefined;
          let tr: Transaction | null = null;
          state.doc.forEach((node, pos) => {
            if (node.type.name !== "mdQuote") return;
            if (!String(node.attrs.mdCalloutType ?? "")) return;
            let 有头 = false;
            node.forEach((孩子) => {
              if (孩子.type.name === "mdQuoteHead") 有头 = true;
            });
            if (有头) return;
            const 缀 = String(node.attrs.mdQuoteMarks ?? "").split("\n");
            // Callout 的首行前缀是 `> [!type] `；退回普通引用只保留 `>` 那一截
            缀[0] = /^(\s{0,3}>\s*)/.exec(缀[0] ?? "")?.[1] ?? "> ";
            tr = (tr ?? state.tr).setNodeMarkup(pos, undefined, {
              ...node.attrs,
              mdKind: "quote",
              mdCalloutType: "",
              mdCalloutFolded: false,
              mdQuoteMarks: 缀.join("\n"),
            });
          });
          return tr ?? undefined;
        },
      }),
    ];
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
 * **类型切换走 `applyBlockType`，无序 / 有序 / 待办走 `设列表`**（第二次按取消，选区里的多块一起改），
 * 移动走 `moveBlock`。另写一套落盘逻辑会和按钮分叉。下拉里的「待办」仍是设成这种类型，不取消。
 *
 * 列表里的回车、项首退格不放进这张快捷键表：要看 `isComposing`，而 TipTap 的快捷键
 * 函数拿不到那次按键。它们在下面的 `handleKeyDown` 里。
 * 移动之后要把光标放回那一块：`moveBlock` 是整树替换，选区映射后可能落在别的块上，
 * 于是"连按两次 Alt+↓"第二次移的就不是同一块了。这类"看起来能用、第二次就错"的 bug
 * 只能靠显式放回选区来断根。
 */
export const BlockKeys = Extension.create({
  name: "blockKeys",
  addKeyboardShortcuts() {
    const setType = (id: BlockTypeId) => ({ editor }: { editor: Editor }) => {
      const { state } = editor;
      // 选区碰到的块一起改；结构化引用里只落到光标所在的子块（整段引用不能换类型，D43）
      const tr = applyBlockTypeToSelection(state, id);
      if (!tr) return false;
      editor.view.dispatch(tr.scrollIntoView());
      return true;
    };
    const 列表 = (id: "bullet" | "numbered" | "todo") => ({ editor }: { editor: Editor }) => {
      const { tr, 跳过 } = 设列表(editor.state, id);
      if (!tr) return false;
      editor.view.dispatch(tr.scrollIntoView());
      const 说明 = 列表跳过说明(跳过);
      if (说明) {
        editor.view.dom.dispatchEvent(new CustomEvent("md-notice", { detail: 说明, bubbles: true }));
      }
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
      "Ctrl-Shift-8": 列表("bullet"),
      "Ctrl-Shift-7": 列表("numbered"),
      "Ctrl-Shift-9": 列表("todo"),
      "Alt-ArrowUp": move(-1),
      "Alt-ArrowDown": move(1),
    };
  },
  /**
   * 回车在列表项里续下一项；空项上再按，或光标在项首按退格，退回正文。
   * 输入法选词的回车（`isComposing` / keyCode 229）必须放行，否则确认候选词会把这一项拆开。
   */
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            if (!view.editable || event.isComposing || event.keyCode === 229) return false;
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
            const 做 =
              event.key === "Enter"
                ? (s: EditorState) => 列表回车(s) ?? 引用回车(s)
                : event.key === "Backspace"
                  ? (s: EditorState) => 列表退格(s) ?? 引用退格(s)
                  : null;
            if (!做) return false;
            const tr = 做(view.state);
            if (!tr) return false;
            view.dispatch(tr.scrollIntoView());
            return true;
          },
          handleDOMEvents: {
            mousedown(view, event) {
              return 点待办前缀(view, event);
            },
          },
        },
      }),
    ];
  },
});

/**
 * `Ctrl+A` 的两级落点：光标在不透明块里 → 第一下选这一块，第二下才扩到全文。
 *
 * 判据是 `blocks.ts` 的 **`全选档`**（纯函数，用例直接钉），这里只负责发选区事务。
 * 表格与普通段落一律交回默认——前者有自己的格子矩形选区，后者用户要的就是全选整篇。
 */
export const BlockSelectAll = Extension.create({
  name: "blockSelectAll",
  addKeyboardShortcuts() {
    return {
      "Mod-a": ({ editor }) => {
        const { state } = editor;
        const 档 = 全选档(state);
        if (!档) return false;
        if (档 === "全文") return editor.commands.selectAll();
        const 范 = 块内范围(state);
        if (!范) return editor.commands.selectAll();
        // 只发选区：选区事务不许把笔记标脏（这条纪律本轮已被踩过两次）
        editor.view.dispatch(
          state.tr
            .setSelection(
              new TextSelection(state.doc.resolve(范.起), state.doc.resolve(范.止))
            )
            .scrollIntoView()
        );
        return true;
      },
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
          /**
           * 行高变了要重画。缓存键只有块序号，档位一变 `last` 还是旧值，
           * 早退就会把竖线留在旧高度上。这里仍然**只写 DOM，不发事务**。
           * 另听 focus/blur：设置页回来或命令面板归还焦点时，光标位置没变、
           * 不一定有 update，不补这一下竖线就会停留在"关着"的样子。
           */
          const 重画 = () => {
            last = "";
            sync();
          };
          const 收线 = () => {
            if (last === "off") return;
            last = "off";
            paint(0, 0);
          };
          sync();
          document.addEventListener(行距事件, 重画);
          view.dom.addEventListener("focus", 重画);
          view.dom.addEventListener("blur", 收线);
          return {
            update: sync,
            destroy: () => {
              document.removeEventListener(行距事件, 重画);
              view.dom.removeEventListener("focus", 重画);
              view.dom.removeEventListener("blur", 收线);
              paint(0, 0);
            },
          };
        },
      }),
    ];
  },
});

/**
 * 代码块的语法着色**装饰**（docs/03 §代码块的着色）。
 *
 * 为什么走装饰而不是 NodeView 自己画：可编辑那一面的 DOM 归 ProseMirror，我们只能递给它
 * `Decoration.inline`。这也让"点进去"与"退出来"是**同一批 span**——代码块从此不再有
 * 两副面孔，聚焦那一刻样式不会变（用户要的正是这个）。
 *
 * **只装饰视口附近**（ADR-004 §大文档策略里那条"可视区之外不挂 Decoration"）。
 * 真机量过不限视口的版本：30 个 30 行代码块的极端文档上，中位数没变（PM 重排本来就
 * 6.6ms），但 p95 从 10.6 顶到 16ms、最差一帧从 26ms 顶到 112ms——那是一次按键要重建
 * 三千多个装饰。收口之后装饰数量由屏幕高度决定，与文档规模脱钩。
 *
 * 视口未知（jsdom、以及插件刚建好还没测过）时**全部装饰**：宁可第一次装载贵一点，
 * 也不要"第一帧没颜色、下一帧才跳出来"那种闪烁。分词结果按 `(语言, 正文)` 缓存，
 * 一次按键只重新分词被改到的那一块。着色永远不改文档——它只加 `class`。
 */
const 视口键 = new PluginKey<[number, number][]>("mdCodeViewport");
let 视口: [number, number][] = [];
/** 上下各多带一屏的余量，滚动时不会立刻露出没上色的边（按字符估，够粗） */
const 余量 = 4000;
/**
 * 装载那一刻还不知道视口，先按"文档开头一屏"算。
 *
 * 不选"全装饰"：真机量过，30 个 30 行代码块的文档上那一次要 110ms 左右，正好砸在打开
 * 笔记的第一帧之后。也不选"先不装饰、等上报再补"：那样滚动到过的位置会有一帧没颜色。
 * 开头一屏是"打开时看得见的那部分"的过估计，屏幕外的等第一次滚动上报。
 */
const 首屏 = 12000;

export const CodeHighlight = Extension.create({
  name: "codeHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        state: {
          init: (_c, cfg) => {
            视口 = [[0, 首屏]];
            return 着色装饰(cfg.doc, cfg.schema, cfg.selection);
          },
          apply: (tr, 旧, _前, 后) => {
            const 新 = tr.getMeta(视口键);
            const 换了 = 新 !== undefined && 新 !== 视口;
            if (新) 视口 = 新;
            if (!tr.docChanged && !换了) return 旧;
            return 着色装饰(后.doc, 后.schema, 后.selection, 视口);
          },
        },
        props: {
          decorations(state) {
            return (this as { getState(state: EditorState): DecorationSet | null }).getState(state);
          },
        },
        view: (view) => {
          /** 攒着的牌在视图更新完之后刷（那时 DOM 才是稳的） */
          const 刷 = () => {
            if (!待刷牌.size) return;
            const 列 = [...待刷牌];
            待刷牌.clear();
            for (const off of 列) 牌刷新(view, off);
          };
          let 排 = 0;
          /**
           * 视口只许在 `apply` 里落地。从前这里先 `视口 = 视口of(view)` 再带着同一个对象去
           * dispatch，而 `apply` 判的是"meta 里那份与模块里那份不是同一个"——自己先赋了值，
           * 那个比较就**永远相等**，滚动上报全部被当成"没换"丢掉：滚到首屏之外的代码块不上色，
           * 要等下一次真改动文档的事务才补上。
           */
          const 报 = () => {
            排 = 0;
            view.dispatch(view.state.tr.setMeta(视口键, 视口of(view)));
          };
          const 节流 = () => {
            if (!排) 排 = requestAnimationFrame(报);
          };
          节流();
          /**
           * 视图建好之后刷一遍牌：装载那一次装饰已经算过识别（缓存是热的），但那时
           * NodeView 还不存在，牌没被更新。不补这一下就会出现**牌上写着"无"、保存下去
           * 文件里多了个 `py`** ——屏幕上说的与落盘的必须同一句话。
           */
          let 初刷 = requestAnimationFrame(() => {
            初刷 = 0;
            view.state.doc.forEach((块, off) => {
              if (块.type.name === "mdOpaque" && 块.attrs.mdFenceOpen) 牌刷新(view, off);
            });
          });
          window.addEventListener("scroll", 节流, { capture: true, passive: true });
          window.addEventListener("resize", 节流);
          return {
            update: () => 刷(),
            destroy: () => {
              window.removeEventListener("scroll", 节流, { capture: true });
              window.removeEventListener("resize", 节流);
              if (排) cancelAnimationFrame(排);
              if (初刷) cancelAnimationFrame(初刷);
            },
          };
        },
      }),
    ];
  },
});

/**
 * 编辑器此刻在屏幕上的那一段文档位置。
 *
 * PM 的 `visibleRanges` 是内部实现（1.42 的类型里没有），所以用公开 API 自己量一次：
 * 拿编辑器矩形与视口的交集，取上下两条边各 `posAtCoords` 一下。**只要是个粗界**——
 * 下面还有 4000 字的余量兜着，差一点不会露白。
 * 没有布局的环境（jsdom）矩形全是 0 → 返回空表 = "不知道" → 调用方回落到全装饰。
 */
function 视口of(view: EditorView): [number, number][] {
  const r = view.dom.getBoundingClientRect();
  const 顶 = Math.max(r.top, 0);
  const 底 = Math.min(r.bottom, window.innerHeight || 0);
  if (底 - 顶 <= 0 || r.width <= 0) return [];
  const x = r.left + Math.min(8, r.width / 2);
  const 上 = view.posAtCoords({ left: x, top: 顶 + 1 });
  const 下 = view.posAtCoords({ left: x, top: 底 - 1 });
  if (!上 || !下) return [];
  return [[Math.min(上.pos, 下.pos), Math.max(上.pos, 下.pos)]];
}

/** 落在视口（含余量）里的位置才上色 */
function 看得见(起: number, 止: number): boolean {
  if (!视口.length) return true;
  return 视口.some(([a, b]) => 止 >= a - 余量 && 起 <= b + 余量);
}

function 着色装饰(doc: PmNode, schema: Schema, 选: { from: number; to: number }, 限: [number, number][] = 视口): DecorationSet {
  if (!schema.spec.nodes.get("mdOpaque")) return DecorationSet.empty;
  const 备份 = 视口;
  视口 = 限;
  const 出: Decoration[] = [];
  const 死线 = (typeof performance !== "undefined" ? performance.now() : 0) + 识别预算;
  try {
    doc.forEach((块, off) => {
      if (块.type.name !== "mdOpaque") return;
      const a = 块.attrs as Record<string, unknown>;
      const 文 = 块.textContent;
      /**
       * Callout 的标题行在源文本面里是行内 `<code>` 里的一段文字，`::first-line` 只对
       * 块容器生效——CSS 那条规则在 WebView2 里一直是空转（实测 600 落到 400）。
       * 用行内装饰给首行套一个类，两边读同一份字重。
       */
      if (a.mdKind === "callout" && a.mdQuoteMarks && 文) {
        const 换 = 文.indexOf("\n");
        const 止 = off + 1 + (换 < 0 ? 文.length : 换);
        if (止 > off + 1) 出.push(Decoration.inline(off + 1, 止, { class: "md-callout-lead" }));
      }
      // 只覆盖走了围栏账本的那批：正文就是纯代码。没闭栏的围栏不接管（那条路上正文里
      // 本来就带着 ```，给它上色会把围栏当代码关键字）
      if (!a.mdFenceOpen || !a.mdFenceClose) return;
      if (!看得见(off, off + 块.nodeSize)) return;
      if (!文) return;
      const 语 = 上色语言(块, off, 选, () => performance.now() > 死线);
      if (!语) return;
      for (const 段 of 着色区间(语, 文)) {
        // 缓存与文档对不上时宁可少画：越界的位置会让 PM 直接抛，一抛整篇画不出来
        if (段.止 > 文.length || 段.起 >= 段.止) continue;
        出.push(Decoration.inline(off + 1 + 段.起, off + 1 + 段.止, { class: 段.类 }));
      }
    });
    return DecorationSet.create(doc, 出);
  } finally {
    视口 = 备份;
  }
}

/** 位置 → 上一次识别的结果。用来让"猜语言"不进击键路径 */
const 猜的 = new Map<number, { 文: string; 语: string | null }>();
/**
 * 一轮重算里最多花多少毫秒猜语言。
 *
 * `highlightAuto` 是逐门跑一遍，实测比指定语言贵十倍（30 行 9ms、120 行 38ms），而"哪些块
 * 没写语言"要等用户开了笔记才知道。给一轮设死预算：**超了就这一轮不猜，下一轮接着来**——
 * 少一帧颜色是可接受的，把打字与滚动拖卡不是。
 */
const 识别预算 = 8;

/**
 * 这一块该按哪门语言上色。**文件里写了就照写的**（认不出也不猜，更不覆盖作者的选择）；
 * 没写才猜一次，而且**正在打字的那一块沿用上一次的答案**——识别不该出现在击键路径上。
 *
 * 猜完顺手刷一下块内那个语言下拉：屏幕上说的与将要落盘的必须是同一句话
 * （两边都读 `highlight.ts` 里那份按正文缓存的识别结果，不会算出两个答案）。
 */
/** 等着刷语言牌的块。**只在视图更新完之后刷**——`state.apply` 里碰 `view.nodeDOM`
 *  会撞上 PM 正在重建 docView，实测直接抛 `descAt of null`，一抛整篇画不出来。 */
const 待刷牌 = new Set<number>();

function 上色语言(
  块: PmNode,
  off: number,
  选: { from: number; to: number },
  截止: () => boolean
): string | null {
  const 写着的 = 围栏行of(String(块.attrs.mdFenceOpen ?? ""))?.语言 ?? "";
  if (写着的) return 语言of(写着的);
  const 文 = 块.textContent;
  const 记 = 猜的.get(off);
  // 缓存命中也要刷牌：装载那一次装饰算得出、NodeView 还不存在，不补这一下就会出现
  // "牌上显示着猜的结果、却没有'这是猜的'那个标记"
  if (记 && 记.文 === 文) {
    待刷牌.add(off);
    return 记.语;
  }
  if (选.from < off + 块.nodeSize && 选.to > off) return 记?.语 ?? null;
  if (截止()) {
    待刷牌.add(off);
    return 记?.语 ?? null;
  }
  const 猜 = 识别(文);
  const 语 = 猜 ? 语言of(短写(猜)) : null;
  if (猜的.size > 400) 猜的.clear();
  猜的.set(off, { 文, 语 });
  待刷牌.add(off);
  return 语;
}

/** 把猜出来的语言同步进块内那个下拉（拿不到视图实例就算了，牌不刷新不是错） */
function 牌刷新(view: EditorView, off: number): void {
  // 牌刷新有几条路是延后的（rAF、视图更新完再刷），延后的路上编辑器可能被销毁。
  // 销毁之后 PM 把 docView 置空，nodeDOM 会直接抛 `descAt of null`——那是测试里
  // "editor.destroy() 那一帧还没跑"的样子，不是用户能撞到的错，但一次抛错就够把整轮测试带崩。
  if (view.isDestroyed) return;
  const dom = view.nodeDOM(off);
  if (!(dom instanceof HTMLElement)) return;
  渲染实例.get(dom)?.刷语言(false);
}

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
              // 引用里落到光标所在的子块上：拿整段引用的位置既读不对前缀，
              // 换类型那一步也会在内容规上抛 RangeError（D43）
              const start = 块转换位置($pos);
              const node = view.state.doc.nodeAt(start);
              if (!node) return false;
              const 前缀 = node.textBetween(0, from - start - 1, undefined, "￼");
              /**
               * ` ``` ` + 空格 → 代码块。它**不走 `applyBlockType`**：块类型下拉里那十种都是
               * `serializeNode` 产得出的行内形状，而代码块是不透明块（正文就是它自己的源文本），
               * 语义是"整块换成一段源文本"，与斜杠菜单点「代码块」同一个函数——两条路必须
               * 产出同一份字节，否则一边绿一边坏。
               */
              if (前缀 === "```") {
                // 引用的内容规只收子块，代码块放不进去：说清楚，别把整段引用换掉
                if ($pos.node(1).type.name === "mdQuote") {
                  view.dom.dispatchEvent(
                    new CustomEvent("md-notice", {
                      detail: "引用里放不了代码块——先把它变成普通正文",
                      bubbles: true,
                    }),
                  );
                  return false;
                }
                const 换 = replaceBlockWithSource(view.state, start, "code", "```\n\n```");
                if (!换) return false;
                view.dispatch(换.scrollIntoView());
                return true;
              }
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
              // 引用里看的是光标所在的子块：拿整段引用判"空不空"永远不为空，菜单就打不开
              const node = view.state.doc.nodeAt(块转换位置($pos));
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
 * 表格里的键。`Tab` / `Shift+Tab` 走格，`Enter` 到下一行同一列（末行则加一行），
 * `ArrowDown` 在最后一行把人送出表格。
 *
 * 这四条必须**在键位层面**接管：`Tab` 默认会跳出编辑器（焦点跑到工具栏上），
 * `Enter` 默认会拆块——拆出来的两半表格 `serializeNode` 根本不认；而 `ArrowDown` 不接的话，
 * 表格是文档最后一块时用户**没有任何出路**（2026-09-29 用户报的死局，见 `enterCell` 那条）。
 *
 * `ArrowDown` 这一条顺手也管**不透明块**（代码块 / 引用）：同一个死局、同一个键、同一套
 * 肌肉记忆，所以两条串在一个绑定里——同一个键在两个扩展里各绑一次的话，谁赢取决于注册
 * 顺序，那是查不动的东西。
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
      // 格子里的 Enter 归表格；选中的是图片块时 Enter 是"下去"，两条串在同一个键上，
      // 同一个键在两个扩展里各绑一次的话谁赢取决于注册顺序，那是查不动的东西
      Enter: 走((s) => enterCell(s) ?? 图片下出口(s)),
      ArrowDown: 走(
        (s) => exitTableDown(s) ?? exitOpaqueDown(s) ?? exitQuoteDown(s) ?? 图片下出口(s),
      ),
      /**
       * 框了多格时 `Delete` / `Backspace` 清空所选的每一格——与电子表格一致，也是用户
       * 框完最自然按下去的那一键。**没框多格就返回 false**：单格时那两键仍是删字符，
       * 抢过来就把"在格子里打字"打坏了。
       */
      Delete: 走((s) => 批量(s, 清场所选)),
      Backspace: 走((s) => 批量(s, 清场所选)),
      // 填充 = 把左上那格抄进其余格（电子表格的 Ctrl+D）
      "Ctrl-d": 走((s) => 批量(s, 填充所选)),
    };
  },
});

/**
 * 粘贴成网格：剪贴板里是 Markdown 表或电子表格的 TSV 时，落进来就是能打字的那张网格；
 * 格子里粘多行则先摊平，别把这张表顶成两半。**判据全在 `判粘贴`**（纯函数、能被测），
 * 这里只照着做。
 *
 * 只读 `text/plain`：带 HTML 的粘贴交回 PM。我们的 schema 只认自己画的那套 `data-md-*`，
 * 网页表格的 `<td>` 进不来，硬接就是把样式当内容吃。
 */
export const TablePaste = Extension.create({
  name: "tablePaste",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handlePaste: (view, event) => {
            const 判 = 判粘贴(view.state, event.clipboardData?.getData("text/plain") ?? "");
            if (判.做 === "交回") return false;
            if (判.做 === "网格") view.dispatch(判.tr.scrollIntoView());
            else if (判.文) view.dispatch(view.state.tr.insertText(判.文));
            // 摊平后是空的（整串都是换行）：什么都不落，也比劈开这张表好
            return true;
          },
        },
      }),
    ];
  },
});

/**
 * 认得出是图片的那些扩展名。**与 md-kernel 的 `is_image_target` 同一批**：两处不一致，
 * 就会出现"内核把它判成 image、我们却不去接管"或反过来的分裂。MIME 优先，
 * 因为截图那类来源只给 `image.png`；有些来源连 MIME 都给不出（只有扩展名）。
 */
const 图片扩展 = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

function 是图片(项: File): boolean {
  if (项.type.startsWith("image/")) return true;
  return 图片扩展.test(项.name);
}

/**
 * 把剪贴板里的图片**存进库里**并落成图片块。
 *
 * 三条判据，少一条就会咬人：
 *
 * 1. **没有图片项就整条交回**。文本与 Markdown 表走的是 `TablePaste` 那条老路，
 *    抢过来就是把"粘一段字"粘坏。
 * 2. **字节先落盘，再动文档**。顺序反了就是"正文里指着一张还没存下来的图"——刷新一次
 *    图就没了。落盘失败时文档一个字都不改，只报一句为什么没进来。
 * 3. **图和文同时在场时听图的**。从网页复制一张带说明的图，用户要么想要图、要么想要字，
 *    两边都插会把一行正文劈开。这一档先取图，说明交回用户自己打（档 2 再谈图文混排）。
 *
 * 等 IPC 的那几十毫秒里用户可能已经切了篇、甚至关了窗，所以回来第一件事是查
 * `view.isDestroyed`（这一轮刚被同类问题坑过一次：销毁后的回调让整篇炸红）。
 * 落点也不揣着旧坐标——用**当下**的选区重算，粘到哪算哪，比把图插到三行之前诚实。
 */
export const ImagePaste = Extension.create({
  name: "imagePaste",
  addProseMirrorPlugins() {
    const 报 = (view: EditorView, 文本: string) => {
      view.dom.dispatchEvent(new CustomEvent("md-notice", { detail: 文本, bubbles: true }));
    };
    const 收 = async (view: EditorView, 文件们: File[]): Promise<void> => {
      const 引用们: 资产引用[] = [];
      const 错们: string[] = [];
      for (const 件 of 文件们) {
        try {
          const 出 = await api.attachmentSave(new Uint8Array(await 件.arrayBuffer()));
          引用们.push(新引用(出.rel));
        } catch (e) {
          错们.push(describeError(e).message);
        }
      }
      if (view.isDestroyed) return;
      if (引用们.length) {
        const tr = 插图片块(view.state, 引用们);
        // 落点算不出来（选区在 PM 认为不合法的位置）时**必须说一句**：字节已经落盘了，
        // 屏幕上什么都不发生就是"应用吞了我的图"，而那句红字是用户唯一能看见的线索
        if (tr) view.dispatch(tr);
        else 报(view, "图片存好了，但这儿放不下它：先点一下正文再粘");
      }
      if (错们.length) 报(view, 错们[0]!);
    };
    return [
      new Plugin({
        props: {
          handlePaste: (view, event) => {
            if (!view.editable) return false;
            const 全 = Array.from(event.clipboardData?.files ?? []);
            if (!全.length) return false;
            const 图们 = 全.filter(是图片);
            if (!图们.length) {
              // 粘的是别的文件：界面必须说一句话，静默不响应是"应用坏了"的观感
              报(view, `${全.length} 个文件里没有认得出的图片，什么都没动`);
              return true;
            }
            void 收(view, 图们);
            return true;
          },
        },
      }),
    ];
  },
});

export const mdExtensions = [
  MdDoc,
  MdText,
  MdParagraph,
  MdHeading,
  MdItem,
  MdQuoteHead,
  MdQuote,
  MdOpaque,
  MdDivider,
  MdImage,
  MdTable,
  MdTableRow,
  MdTableCell,
  MdBold,
  MdItalic,
  MdCode,
  MdStrike,
  MdSup,
  MdSub,
  MdHighlight,
  MdTextColor,
  MdBgColor,
  MdLink,
  BlockIdGuard,
  CalloutGuard,
  BlockTools,
  BlockKeys,
  BlockSelectAll,
  TableKeys,
  TablePaste,
  ImagePaste,
  TableSelect,
  FormatPainter,
  CodeHighlight,
  FocusIndicator,
  OpaqueFace,
  引用高亮扩展,
  查找扩展,
  History,
];
