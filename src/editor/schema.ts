import { Extension, Mark, Node, type Attributes } from "@tiptap/core";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import { history } from "@tiptap/pm/history";
import { numberedMarker } from "./blocks";

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
  History,
];
