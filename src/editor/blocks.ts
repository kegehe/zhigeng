import type { JSONContent } from "@tiptap/core";
import { Fragment, type Node as PmNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
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

export type JsonNode = { type: string; attrs?: Record<string, unknown>; content?: JSONContent[] };

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

/**
 * 有序项的记号（`3.` / `2)` 这一整串）。md-kernel 把它存成 `Kind::Ordered { marker }`
 * 并原样写回，而 `EditBlock` 没有把 marker 带过来——序号与记号只活在 `raw` 的前缀里。
 * 于是"界面上显示什么"与"落盘写什么"必须由同一个函数从同一份 `raw` 上算：
 * 否则改一个字就把 `3.` 落回 `1.`（屏幕上还写着 3），或把用户写的 `2)` 悄悄改成 `2.`。
 * 新建的块没有历史 `raw`，退回 `1.`：CommonMark 按位置重编号，源码写几不影响语义。
 */
export function numberedMarker(raw: string): string {
  const m = /^\s*(\d+[.)])/.exec(raw);
  return m?.[1] ?? "1.";
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
        kind === "numbered"
          ? `${numberedMarker(String(a.mdRaw ?? ""))} `
          : kind === "todo"
            ? `- [${a.mdChecked ? "x" : " "}] `
            : "- ";
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
      // **不能写 `node.text`**：那是 `TextNode` 才有的字段，块节点上它是 undefined，
      // `?? ""` 会把整块吃成空字符串——用户编辑一次代码块 / 表格 / 引用，那块就没了。
      return node.textContent;
    default:
      return serializeInline(node) + fieldSuffix(a.mdFields) + anchorSuffix(a.mdId);
  }
}

/**
 * 工具栏 / 斜杠菜单能给出的块类型。
 *
 * **只列序列化器真能产出的那些**：引用、代码块、表格在 md-kernel 里是不透明块，
 * `serializeNode` 没有"给段落加 `> ` 前缀"这条路——把它们放进菜单，点了就是把源文本
 * 洗成段落的字节（或者反过来），正是第一轮块编辑器被判死刑的形态。要做就得先在内核
 * 与序列化器里把类型转换建成一等公民，那是另一档活。
 */
export type BlockTypeId =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "heading4"
  | "heading5"
  | "heading6"
  | "bullet"
  | "numbered"
  | "todo";

export const BLOCK_TYPES: { id: BlockTypeId; 标签: string }[] = [
  { id: "paragraph", 标签: "正文" },
  { id: "heading1", 标签: "标题 1" },
  { id: "heading2", 标签: "标题 2" },
  { id: "heading3", 标签: "标题 3" },
  { id: "heading4", 标签: "标题 4" },
  { id: "heading5", 标签: "标题 5" },
  { id: "heading6", 标签: "标题 6" },
  { id: "bullet", 标签: "无序列表" },
  { id: "numbered", 标签: "有序列表" },
  { id: "todo", 标签: "待办" },
];

/**
 * 可以"插入"的结构块。全都是**不透明块**：节点正文就是它自己的源文本，
 * 所以插入不需要序列化器会产这些语法（那是"转换"，档 B 的活）。
 *
 * 源文本**不带结尾换行**——`docToMarkdown` 会给每块补 `eol`，多写一个就成了空行。
 */
export const INSERTABLE: { kind: string; 标签: string; 源文本: string }[] = [
  { kind: "divider", 标签: "分隔线", 源文本: "---" },
  { kind: "quote", 标签: "引用", 源文本: "> " },
  { kind: "table", 标签: "表格", 源文本: "| 列 | 列 |\n| --- | --- |\n|  |  |" },
];

/**
 * 把块改成目标类型需要的节点类型与属性补丁。**返回 null 表示不用改或不能改**——
 * 包括不透明块，以及"目标就是当前类型"（不这么判的话一次无意义的 setNodeMarkup 会
 * 改掉 `mdSig`，把整块重新序列化，用户只是点了同一个菜单项却多出一次落盘）。
 */
export function blockTypePatch(
  node: PmNode,
  id: BlockTypeId,
): { typeName: string; attrs: Record<string, unknown> } | null {
  if (node.type.name === "mdOpaque") return null;
  const 清场 = { mdKind: "paragraph", mdLevel: null, mdChecked: null };
  switch (id) {
    case "paragraph":
      if (node.type.name === "mdParagraph" && String(node.attrs.mdKind ?? "paragraph") === "paragraph")
        return null;
      return { typeName: "mdParagraph", attrs: 清场 };
    case "heading1":
    case "heading2":
    case "heading3":
    case "heading4":
    case "heading5":
    case "heading6": {
      // 1–6 级都能给：md-kernel 的 `Kind::Heading { level }` 收 1–6，`serializeNode`
      // 也照这个数拼 `#`。之前只列到 3 是前端自己砍的，不是内核限制。
      const level = Number(id.slice(-1));
      if (node.type.name === "mdHeading" && Number(node.attrs.mdLevel ?? 0) === level) return null;
      return { typeName: "mdHeading", attrs: { ...清场, mdKind: "heading", mdLevel: level } };
    }
    case "bullet":
    case "numbered":
    case "todo": {
      if (node.type.name === "mdItem" && String(node.attrs.mdKind) === id) return null;
      const attrs: Record<string, unknown> = { ...清场, mdKind: id };
      if (id === "todo") attrs.mdChecked = false;
      return { typeName: "mdItem", attrs };
    }
  }
}

/**
 * 把光标所在的块改成目标类型，返回那笔事务（不改就不返回事务）。
 *
 * **输入规则、斜杠菜单、测试都走这里**：三处各写一份 `setNodeMarkup` 的话，测试绿的
 * 那次不代表按钮是对的——上一轮"显示用一份、序列化用另一份"的分叉就是这么造出来的。
 */
export function applyBlockType(
  state: EditorState,
  start: number,
  id: BlockTypeId,
): Transaction | null {
  const node = state.doc.nodeAt(start);
  if (!node) return null;
  const patch = blockTypePatch(node, id);
  if (!patch) return null;
  return state.tr.setNodeMarkup(start, state.schema.nodes[patch.typeName], {
    ...node.attrs,
    ...patch.attrs,
  });
}

const LIST_KINDS = new Set(["bullet", "numbered", "todo"]);

/** 与 `docToMarkdown` 里同一条判据：同一列表、同一层级的连续项之间不留空行 */
function continuesList(prev: PmNode | null, kind: string, depth: number): boolean {
  if (!prev) return false;
  const pk = String(prev.attrs.mdKind ?? "paragraph");
  return pk === kind && Number(prev.attrs.mdDepth ?? 0) === depth && LIST_KINDS.has(kind);
}

/**
 * 把第 `from` 个顶层块挪到第 `to` 个位置（都是**块序号**，不是字符位置——位置在删插
 * 之间会漂，序号不会）。返回 null 表示原地不动。
 *
 * 拖拽排序敢做，靠两件事：锚点写在 `raw` 里跟着自己那块走（链接认块 ID 不认顺序），
 * 而未改动的块仍然逐字节回写。但**块间空白必须重算**：gap 编码的正是"谁跟在谁后面"，
 * 一个段落挪到列表项后面却带着 `gap=""`，Markdown 会把它读成那个列表项的续行——
 * 内容一个字节没丢，语义丢了。
 *
 * 只重算**前驱真的变了**的那几块。全量重算会把"作者故意留的两三个空行"抹成一行的
 * 间隔改掉，那是另一种改用户内容。
 */
export function moveBlock(state: EditorState, from: number, to: number): Transaction | null {
  const kids: PmNode[] = [];
  state.doc.forEach((n) => kids.push(n));
  if (from === to || from + 1 === to || from < 0 || to < 0 || from >= kids.length || to > kids.length)
    return null;
  const list = [...kids];
  const moved = list.splice(from, 1)[0];
  if (!moved) return null;
  const insertAt = from < to ? to - 1 : to;
  list.splice(insertAt, 0, moved);

  const 原前驱 = new Map<PmNode, PmNode | null>();
  kids.forEach((n, i) => 原前驱.set(n, i === 0 ? null : (kids[i - 1] ?? null)));
  // 挪到最前面时该用什么空白：**照抄原来第一块的**。它编码的是"正文开头与文件头的
  // 关系"——有 frontmatter 的是 "\n"（`---` 后面那个空行），没有的是 ""（正文就是第
  // 一个字节）。写死 "" 会把前一种的空行吃掉，save 一次 frontmatter 就和内容粘连。
  const 顶gap = String(kids[0]?.attrs.mdGap ?? "");

  let changed = false;
  const out = list.map((n, i) => {
    const prev = i === 0 ? null : (list[i - 1] ?? null);
    if (原前驱.get(n) === prev) return n; // 前面还是原来那块：它的空白不归我们管
    const want =
      prev === null
        ? 顶gap
        : continuesList(prev, String(n.attrs.mdKind ?? "paragraph"), Number(n.attrs.mdDepth ?? 0))
          ? ""
          : "\n";
    if (String(n.attrs.mdGap ?? "") === want) return n;
    changed = true;
    return n.type.create({ ...n.attrs, mdGap: want }, n.content, n.marks);
  });
  const tr = state.tr.replaceWith(0, state.doc.content.size, Fragment.fromArray(out));
  return changed ? tr.scrollIntoView() : tr;
}

/**
 * 把光标所在的整块上移 / 下移一格，返回带着**已放回选区**的事务。
 *
 * 键盘（`Alt+↑/↓`）与工具栏的上下移按钮共用这一个函数。放回选区不是锦上添花：
 * `moveBlock` 是整树替换，映射后光标可能落到别的块上，于是"连按两次"第二次移的
 * 就不是同一块——第一次对、第二次错的 bug 靠想是想不到的。
 *
 * 到边界返回 null（调用方据此什么都不做，也**不发空事务**：空事务会吞键、还会白标
 * 一次脏，800ms 后凭空写盘）。
 */
export function moveCurrentBlock(state: EditorState, delta: number): Transaction | null {
  const { $from } = state.selection;
  if (!$from.depth || delta === 0) return null;
  const start = $from.before(1);
  let index = -1;
  let i = 0;
  state.doc.forEach((_n, off) => {
    if (off === start) index = i;
    i++;
  });
  if (index < 0) return null;
  // `to` 的口径是"最终落在原序号 to 的位置"：下移一格要跨过紧跟的那一块
  const tr = moveBlock(state, index, delta < 0 ? index - 1 : index + 2);
  if (!tr) return null;
  const newIndex = delta < 0 ? index - 1 : index + 1;
  let newStart = 0;
  let k = 0;
  tr.doc.forEach((n, off) => {
    if (k === newIndex) newStart = off;
    k++;
  });
  const moved = tr.doc.nodeAt(newStart);
  if (!moved) return null;
  const back = Math.min($from.parentOffset, moved.content.size);
  return tr.setSelection(TextSelection.near(tr.doc.resolve(newStart + 1 + back)));
}

/**
 * 在光标所在块**之后**插一个结构块（分隔线 / 引用 / 表格……见 `INSERTABLE`）。
 *
 * 走 `mdOpaque`：节点正文就是它自己的源文本，未改动时精确回写，所以插入不需要
 * 序列化器会产这些语法。两条要紧的口径：
 * - **必须带一个空行的 gap**。紧贴上一段落的 `---` 会被 CommonMark 读成那段的 setext
 *   二级标题下划线——插个分隔线结果把上一段变成了标题；表格与引用的首行同理会并进上一段。
 * - **源文本不带结尾换行**，`docToMarkdown` 会给每块补 `eol`。
 */
export function insertSourceBlock(
  state: EditorState,
  kind: string,
  source: string,
): Transaction | null {
  const { $from } = state.selection;
  if (!$from.depth) return null;
  const start = $from.before(1);
  const node = state.doc.nodeAt(start);
  if (!node) return null;
  return state.tr
    .insert(start + node.nodeSize, sourceBlock(state, kind, source, "\n"))
    .scrollIntoView();
}

/**
 * 把当前块**整块换成**一个结构块。
 *
 * 斜杠菜单选"表格 / 引用 / 分隔线"要的是这个语义：那一块本来就是空的、只装着一个 `/`，
 * 往它后面插会留下一个空段落，而且那个 `/` 还得单独再删一次——换掉它一步就对了。
 *
 * `mdGap` 沿用当前块原来的空白：换内容不改排版，不该顺手挪动空行。
 */
export function replaceBlockWithSource(
  state: EditorState,
  start: number,
  kind: string,
  source: string,
): Transaction | null {
  const opaque = state.schema.nodes.mdOpaque;
  const node = state.doc.nodeAt(start);
  if (!opaque || !node) return null;
  const gap = String(node.attrs.mdGap ?? "\n");
  return state.tr.replaceWith(start, start + node.nodeSize, sourceBlock(state, kind, source, gap));
}

function sourceBlock(state: EditorState, kind: string, source: string, gap: string): PmNode {
  const opaque = state.schema.nodes.mdOpaque;
  if (!opaque) throw new Error("schema 里没有 mdOpaque 节点");
  return opaque.create(
    {
      mdKind: kind,
      mdRaw: "",
      mdGap: gap,
      mdId: null,
      mdDepth: 0,
      mdLevel: null,
      mdChecked: null,
      mdFields: [],
      mdSig: "",
    },
    state.schema.text(source),
  );
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
    // **只要这块来自文件，它的空白就还是它自己的**：改内容不改排版。这里原先写的是
    // "没改才沿用 gap"，于是把文件第一块改一个字，gap 从 "" 变成 "\n"——保存一次
    // 就在文件开头凭空多出一个空行（新测试把它钉住了）。只有真正新建的块（没有源
    // 切片可回）才需要现算：延续同一个列表用 ""，文件还没落笔时也用 ""，其余用 "\n"。
    // 两个"没落笔"的来历：① 斜杠菜单选表格——`frontMatter` 为空时文件第一个字节就是
    // 内容，给它一个空行等于在开头凭空多一行（有 front-matter 时那个空行倒是必须）；
    // ② 回车拆在段首，前一半是空块、被下面那条规则整个跳过，此时"第二块"其实是第一
    // 个落笔的块，按 index 判就会给它补出前导空行。
    const gap =
      raw.length > 0 ? String(a.mdGap ?? "") : continuesList || !out ? "" : "\n";
    const eol = index === doc.childCount - 1 && !srcEndsNewline ? "" : "\n";
    const 正文 = unchanged ? raw : serializeNode(node) + eol;
    // **重新产出后是空白的块不落任何字节**：Markdown 里没有"空段落"这个东西，写出来就是
    // 文件里凭空多出的空行（回车一次 → `---\n\n\n\n第一段`）。回车拆出来的那一半在用户
    // 打字之前就走这条；**未改动的块不算**——它的 `raw` 是文件本来的字节，空白也得原样留。
    // 它也不更新 `prev`：落盘之后这一块的"前驱"就是上一个真写了字的块，与内核重新解析
    // 时的形状一致。
    if (!unchanged && !正文.trim()) return;
    out += gap + 正文;
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
 *
 * **必须一次成型，不能逐块 `setNodeMarkup`**：3000 个块逐个改属性是 3000 次整树替换，
 * 实测 854ms（真机 2026-09-24），把打开编辑器的开销全吃在这上面。这里改成"每个节点
 * O(1) 换属性 + 一次整体替换"，子内容全部共享，代价线性。
 */
export function stampSignatures(state: EditorState): Transaction | null {
  const kids: PmNode[] = [];
  let changed = false;
  state.doc.forEach((node) => {
    const sig = sigOf(node);
    if (node.attrs.mdSig === sig) kids.push(node);
    else {
      changed = true;
      kids.push(node.type.create({ ...node.attrs, mdSig: sig }, node.content, node.marks));
    }
  });
  if (!changed) return null;
  const tr = state.tr.replaceWith(0, state.doc.content.size, Fragment.fromArray(kids));
  // 打签名不是用户的编辑，不该进撤销栈
  return tr.setMeta("addToHistory", false);
}
