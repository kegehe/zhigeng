import { Extension, Mark, Node, type Attributes, type Editor } from "@tiptap/core";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import { history } from "@tiptap/pm/history";
import { applyBlockType, moveCurrentBlock, numberedMarker, type BlockTypeId } from "./blocks";

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

/**
 * 暂时不做富文本的块：节点正文就是它自己的源文本，未改动时精确回写 `raw`。
 *
 * 不是 atom、不是占位符——`code: true` + `content: "text*"` 让它像代码块那样**可以直接
 * 改源码**（表格、公式、引用都读得懂源文本），改了就把用户输入的文本原样落盘。
 * 用户要的从来不是"不能编辑"，而是"别把我的格式洗掉"。
 */
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

/** 回车切块时 ProseMirror 会把属性复制给下半段，同一个 ` ^b-xxx` 锚点就会出现在两个块上。
 *  ID 一经分配永不复用（docs/02），所以重复的只留第一个，其余退回"无 ID"。 */
export const UniqueBlockIds = () =>
  new Plugin({
    appendTransaction: (_steps, _old, state) => {
      const seen = new Set<string>();
      let tr: Transaction | null = null;
      // 顶层节点的 offset 就是绝对位置（doc 没有开始标记），不要再 +1
      state.doc.forEach((node, offset) => {
        const id = node.attrs.mdId as string | null;
        if (!id) return;
        if (seen.has(id)) {
          tr = (tr ?? state.tr).setNodeMarkup(offset, undefined, {
            ...node.attrs,
            mdId: null,
            mdSig: "",
          });
          return;
        }
        seen.add(id);
      });
      return tr ?? undefined;
    },
  });

export const BlockIdGuard = Extension.create({
  name: "blockIdGuard",
  addProseMirrorPlugins() {
    return [UniqueBlockIds()];
  },
});

/** 撤销栈直接用 ProseMirror 自己的 history，不经过任何第三方封装 */
export const History = Extension.create({
  name: "history",
  addProseMirrorPlugins() {
    return [history({ newGroupDelay: 500 })];
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

export const mdExtensions = [
  MdDoc,
  MdText,
  MdParagraph,
  MdHeading,
  MdItem,
  MdOpaque,
  MdBold,
  MdItalic,
  MdCode,
  MdStrike,
  MdLink,
  BlockIdGuard,
  BlockTools,
  BlockKeys,
  FocusIndicator,
  History,
];
