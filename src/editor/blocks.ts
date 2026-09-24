import type { Node as PmNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { EditBlock, EditDoc } from "../ipc/types";
import { inlineToJson, serializeInline } from "./inline";

export type { EditBlock, EditDoc };

/**
 * md-kernel 的块 ↔ ProseMirror 节点。
 *
 * 两条铁律：
 * 1. **一个块 = 一个顶层节点**。md-kernel 把列表项当成平级的独立块（嵌套项是它的
 *    children），所以这里不借 TipTap 的 `bulletList` 分组——一分组，"块 ↔ 节点"就
 *    不再一一对应，未改动块的字节级回写无从谈起。
 * 2. **没改过的块原样回写 `raw`**。判据是节点内容签名（`sigOf`），且签名是在
 *    节点进入 ProseMirror **之后**才打的——两边都由同一个函数算，不去猜
 *    PM 的 `toJSON()` 长什么样（上一轮正是死在这上面：多一个 `marks: []` 就全判已改）。
 *
 * 第一版可编辑的类型只有段落 / 标题 / 列表项（无序、有序、待办）。引用、Callout、
 * 表格、代码、公式、引用、HTML 与"带子项的列表项"一律走 `mdOpaque`：节点内容就是它
 * 自己的源文本，未改动时精确回写 `raw`，改动后按用户输入的文本原样落盘。它们暂时不是
 * 富文本编辑，但**绝不丢字节**——上一轮失败是静默吃内容，不是崩，所以宁可退到源码视图，
 * 也不许把用户的格式洗成另一种写法。
 */

/** 可行内编辑的类型；其余进 mdOpaque */
const EDITABLE = new Set(["paragraph", "heading", "bullet", "numbered", "todo"]);

function nodeType(b: EditBlock): string {
  // 父项的 raw 含子项那几行的字节（缩进也在里面），所以带子项的块不能拆成行内节点
  if (!EDITABLE.has(b.kind) || b.children.length) return "mdOpaque";
  switch (b.kind) {
    case "heading":
      return "mdHeading";
    case "bullet":
    case "numbered":
    case "todo":
      return "mdItem";
    default:
      return "mdParagraph";
  }
}

function attrsOf(b: EditBlock): Record<string, unknown> {
  return {
    mdRaw: b.raw,
    mdGap: b.gapBefore,
    mdId: b.id,
    mdKind: b.kind,
    mdDepth: 0,
    mdLevel: b.level,
    mdChecked: b.checked,
    // `content` 里没有 due::/done::（与索引同口径），重新产出时得靠它写回去
    mdFields: b.fields,
    mdSig: "",
  };
}

export type JsonNode = { type: string; attrs?: Record<string, unknown>; content?: unknown[] };

/**
 * 只走顶层，与 Rust 侧 `render_exact` 同口径。
 *
 * md-kernel 把嵌套子项的字节算在**父项的 `raw` 里**（子项自己的 `raw` 不带缩进），
 * 把子项提成兄弟节点会重复父项的文本、又让父项的 raw 变成半成品——所以"一块一节点"
 * 的粒度就是 md-kernel 的顶层块，嵌套子树整棵是一个 mdOpaque。
 */
export function docToJson(doc: EditDoc): JsonNode {
  const content: JsonNode[] = doc.blocks.map((b) => {
    const type = nodeType(b);
    const attrs = attrsOf(b);
    if (type === "mdOpaque") {
      // 源文本进节点正文（自带的那个换行由拼装方统一补，见 docToMarkdown）
      const text = b.raw.replace(/\n+$/, "");
      return { type, attrs, content: text ? [{ type: "text", text }] : [] };
    }
    const node: JsonNode = { type, attrs };
    // exactOptionalPropertyTypes：不能写 `content: undefined`
    if (b.content) node.content = inlineToJson(b.content);
    return node;
  });
  if (!content.length) {
    content.push({ type: "mdParagraph", attrs: attrsOf(EMPTY) });
  }
  return { type: "doc", content };
}

const EMPTY: EditBlock = {
  kind: "paragraph",
  id: null,
  raw: "",
  gapBefore: "",
  content: "",
  level: null,
  checked: null,
  fields: [],
  children: [],
};

/** Rust 侧那份拼装的镜像：front-matter + Σ(gap + raw) + 尾部空白。契约的基准线 */
export function reassemble(doc: EditDoc): string {
  let out = doc.frontMatter;
  for (const b of doc.blocks) out += b.gapBefore + b.raw;
  return out + doc.trailingGap;
}

/**
 * 签名里要**排除**的属性：只是编辑器找回原字节的账本，不参与"这块内容变了吗"的判断。
 *
 * 反过来，`mdLevel` / `mdChecked` / `mdKind` / `mdDepth` 必须留在签名里——它们是块的
 * 语义。要是连它们一起按 `md` 前缀剔掉，"改标题层级""勾选待办"就被判成没改，
 * 原样回写旧 `raw`，用户的操作凭空消失。
 */
const BOOKKEEPING = new Set(["mdRaw", "mdGap", "mdSig", "mdId"]);

/**
 * 节点内容签名：去掉编辑器账本后的 JSON。
 * 由同一个函数在"载入后"与"保存时"各算一次，所以不存在形状对不上的问题。
 *
 * **必须重建对象，不能就地 delete**：`node.toJSON()` 返回的 `attrs` 就是节点活着的
 * 那个 attrs 引用，删键等于把 `mdRaw`/`mdSig` 从文档里抹掉——第一次保存看起来正常，
 * 第二次保存时所有块都成了"新块"、全部重新序列化。上一轮 658→410 字节就是这么丢的。
 */
export function sigOf(node: PmNode): string {
  const j = node.toJSON() as Record<string, unknown>;
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((j.attrs as Record<string, unknown>) ?? {})) {
    if (!BOOKKEEPING.has(k)) attrs[k] = v;
  }
  const out: Record<string, unknown> = { type: j.type };
  // 与 PM 自己的形状一致：空 attrs / 空 content 不写键，否则两边永远对不上
  if (Object.keys(attrs).length) out.attrs = attrs;
  if (j.content !== undefined) out.content = j.content;
  if (j.marks !== undefined) out.marks = j.marks;
  return JSON.stringify(out);
}

function anchorSuffix(id: unknown): string {
  return typeof id === "string" && id ? ` ^${id}` : "";
}

/** 行内字段：与 md-kernel `render_block` 同一写法（` key:: value`，跟在正文后、锚点前） */
function fieldSuffix(fields: unknown): string {
  if (!Array.isArray(fields)) return "";
  return fields.map(([k, v]) => ` ${k}:: ${v}`).join("");
}

function serializeNode(node: PmNode): string {
  const a = node.attrs as Record<string, unknown>;
  const indent = "  ".repeat(Number(a.mdDepth ?? 0));
  switch (node.type.name) {
    case "mdHeading": {
      const level = Math.min(6, Math.max(1, Number(a.mdLevel ?? 1)));
      return (
        "#".repeat(level) +
        " " +
        serializeInline(node) +
        fieldSuffix(a.mdFields) +
        anchorSuffix(a.mdId)
      );
    }
    case "mdItem": {
      const kind = String(a.mdKind ?? "bullet");
      const marker =
        kind === "numbered" ? "1. " : kind === "todo" ? `- [${a.mdChecked ? "x" : " "}] ` : "- ";
      return (
        indent +
        marker +
        serializeInline(node) +
        fieldSuffix(a.mdFields) +
        anchorSuffix(a.mdId)
      );
    }
    case "mdOpaque":
      // 源文本块：内容就是用户的源文本，改了就原样落盘（自带换行由调用方补）
      return node.text ?? "";
    default:
      return serializeInline(node) + fieldSuffix(a.mdFields) + anchorSuffix(a.mdId);
  }
}

/**
 * 整篇拼回 Markdown。
 *
 * 两个坑都在这儿，都是上一轮真机踩出来的：
 * - `raw` **自带结尾换行**，绝不能 trim——一 trim，相邻列表项之间那个换行就没了，
 *   整篇塌成一段。
 * - 块间空白 = `gap_before`（md-kernel 的口径：raw 含自己那行的换行，gap 是"额外的
 *   空白"）。新建的块没有历史 gap，按类型给：延续同一个列表用 ""，其余用 "\n"
 *   （配上上一块结尾的换行，正好一个空行）。
 */
export function docToMarkdown(doc: PmNode, head: EditDoc): string {
  let out = head.frontMatter;
  let prev: { kind: string; depth: number } | null = null;
  // 空文件装载时会被补一个空段落（ProseMirror 的 doc 要 ≥1 个子节点）。
  // 不特殊处理的话"打开空笔记、一个字没碰、保存"就多出一个换行。
  if (!head.blocks.length && doc.childCount === 1) {
    const only = doc.firstChild!;
    if (!serializeNode(only)) return head.frontMatter + head.trailingGap;
  }
  // 源文本末尾没有换行时不能凭空补一个（md-kernel 的 `render_block` 同一条规矩）
  const last = head.blocks[head.blocks.length - 1];
  const srcEndsNewline = head.trailingGap.endsWith("\n") || Boolean(last?.raw.endsWith("\n"));
  doc.forEach((node, _offset, index) => {
    const a = node.attrs as Record<string, unknown>;
    const raw = typeof a.mdRaw === "string" ? a.mdRaw : "";
    const unchanged = raw.length > 0 && sigOf(node) === String(a.mdSig ?? "");
    const kind = String(a.mdKind ?? "paragraph");
    const depth = Number(a.mdDepth ?? 0);
    const continuesList =
      prev !== null &&
      kind === prev.kind &&
      depth === prev.depth &&
      (kind === "bullet" || kind === "numbered" || kind === "todo");
    const gap = unchanged ? String(a.mdGap ?? "") : continuesList ? "" : "\n";
    const eol = index === doc.childCount - 1 && !srcEndsNewline ? "" : "\n";
    out += gap + (unchanged ? raw : serializeNode(node) + eol);
    prev = { kind, depth };
  });
  return out + head.trailingGap;
}

/**
 * 给每个顶层块打上内容签名。装载完立刻调，**在接 onChange 之前**。
 *
 * 签名只能这么打：JSON 里那份是"我以为节点长什么样"，`sigOf(活节点)` 才是"它实际长
 * 什么样"，两者必须由同一个函数产出，否则判断"改没改"就成了猜谜。空串代表新块，
 * 一定会被重新序列化。
 */
export function stampSignatures(state: EditorState): Transaction | null {
  const tr = state.tr;
  state.doc.forEach((node, offset) => {
    const sig = sigOf(node);
    if (node.attrs.mdSig === sig) return;
    tr.setNodeMarkup(offset, undefined, { ...node.attrs, mdSig: sig });
  });
  if (!tr.docChanged) return null;
  // 打签名不是用户的编辑，不该进撤销栈
  return tr.setMeta("addToHistory", false);
}
