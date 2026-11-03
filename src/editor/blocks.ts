import type { JSONContent } from "@tiptap/core";
import {
  Fragment,
  Node as PmNodeModel,
  type Node as PmNode,
  type ResolvedPos,
  type Schema,
} from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { EditBlock, EditDoc } from "../ipc/types";
import { 拼资产引用, 是库内资产, 拆资产引用, 拆自attrs, type 资产引用 } from "./asset";
import { 拼开栏, 拼围栏, 拆围栏, 拆开栏 } from "./fence";
import { 已识别, 短写, 语言清单, 识别 } from "./highlight";
import { inlineToJson, serializeInline } from "./inline";
import { parseGrid, parseTable, serializeTable, type Align } from "./table";
import { 含, 夹住, 覆盖列, type 矩形 } from "./tableSelect";

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

/**
 * 这一块能不能接管成 `mdImage`。**判据保守，够格才接管**（与表格那条同一口气）：
 *
 * - 内核判的是 image，且**没有子项**；
 * - 摘掉块锚点与 CRLF 的行尾 `\r` 之后，整行**正好只有这一个引用**——`![[a.png]] 后面还有字`
 *   那种接管了就会把后面的字吃掉；
 * - 目标指向本库 `attachments/`（裸文件名与相对路径要的是全库解析，那件活没做）；
 * - 形状里没有我们没搬进 attrs 的字节（标题、尖括号）。
 *
 * 任一条不满足就返回 null，这一块维持 `mdOpaque` 显示源文本——宁可少接管，不可吃用户字节。
 */
function 图片接管(b: EditBlock): 资产引用 | null {
  if (b.kind !== "image" || b.children.length) return null;
  let 行 = b.raw.replace(/\n+$/, "");
  // CRLF 文件的这一行以 `\r` 收尾，而它在锚点**之后**，所以先摘下来交给调用方补回去
  if (行.endsWith("\r")) 行 = 行.slice(0, -1);
  const 尾锚 = typeof b.id === "string" && b.id ? ` ^${b.id}` : "";
  if (尾锚 && 行.endsWith(尾锚)) 行 = 行.slice(0, -尾锚.length);
  const 拆 = 拆资产引用(行);
  return 拆 && 是库内资产(拆.目标) ? 拆 : null;
}

/** 这一块的行尾是不是 CRLF 那个 `\r`。序列化时它排在块锚点之后，位置不能错 */
function 行尾回车(b: EditBlock): string {
  const 文本 = b.raw.replace(/\n+$/, "");
  return 文本.endsWith("\r") ? "\r" : "";
}

function nodeType(b: EditBlock): string {
  // 父项的 raw 含子项那几行的字节（缩进也在里面），所以带子项的块不能拆成行内节点
  if (!EDITABLE.has(b.kind) || b.children.length) {
    // 图片是唯一被接管的**原子**块：缩略图就是它的正文，光标进来不许换一副样子
    if (图片接管(b)) return "mdImage";
    // 表格是唯一被"接管"的不透明块：判据保守（见 table.ts），够格才建网格，
    // 否则维持源文本编辑——列数不齐的表我们拼不回去，就不该装作能
    if (b.kind === "table" && parseTable(b.raw)) return "mdTable";
    return "mdOpaque";
  }
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
    mdAlign: b.align ?? "",
    // `content` 里没有 due::/done::（与索引同口径），重新产出时得靠它写回去
    mdFields: b.fields,
    mdSig: "",
  };
}

export type JsonNode = { type: string; attrs?: Record<string, unknown>; content?: JSONContent[] };

/**
 * 表格结构 → `mdTable` 的 JSON。载入与"工具栏插一张表"共用这一份，
 * 两处各写一遍的话，插进来的表和读进来的表早晚长得不一样。
 */
export function tableJson(
  t: { rows: string[][]; aligns: Align[] },
  attrs: Record<string, unknown>,
): JsonNode {
  return {
    type: "mdTable",
    attrs: { ...attrs, mdAligns: t.aligns },
    content: t.rows.map((cells, r) => ({
      type: "mdTableRow",
      content: cells.map((c, i) => ({
        type: "mdTableCell",
        attrs: { header: r === 0, align: t.aligns[i] ?? "" },
        content: inlineToJson(c),
      })),
    })),
  };
}

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
      /**
       * 代码块走**围栏账本**：开栏行与闭栏行挪进 attrs，正文只装两道围栏之间的代码，
       * 这样点进去编辑的就是代码本身，不会先看到一屏 Markdown。判据只有一条——
       * **得有闭栏**。没闭栏的围栏按 CommonMark 是"到文末都是代码"，接管了就得凭空
       * 补一道 ` ``` `，那是替用户写字节。
       *
       * 接管之前先把**行尾那枚块锚**摘掉：内核给代码块写锚点是单起一行（`^b-…` 走在闭栏
       * 之后），而 `拆围栏` 认的是"闭栏在末行"。不摘就判成"没闭栏"，整块退回两副面孔；
       * 摘了又忘了补，就是改一次代码块把它的锚点从文件里抹掉——反链与拖拽排序都认那个 ID。
       * **只摘与 `b.id` 一字不差的那一行**，别的一律留在正文里：宁可少接管，不可吃用户字节。
       */
      const 尾锚 = typeof b.id === "string" && b.id ? `^${b.id}` : "";
      const 有尾锚 = 尾锚 !== "" && text.endsWith(`\n${尾锚}`);
      const 体 = 有尾锚 ? text.slice(0, -(`\n${尾锚}`.length)) : text;
      const 拆 = b.kind === "code" ? 拆围栏(体) : null;
      if (拆?.闭) {
        const 身 = 拆.身.join("\n");
        return {
          type,
          attrs: {
            ...attrs,
            mdFenceOpen: 拆.开,
            mdFenceClose: 拆.闭,
            mdFenceBody: 拆.身.length > 0,
          },
          content: 身 ? [{ type: "text", text: 身 }] : [],
        };
      }
      return { type, attrs, content: text ? [{ type: "text", text }] : [] };
    }
    if (type === "mdTable") return tableJson(parseTable(b.raw)!, attrs);
    if (type === "mdImage") {
      const 拆 = 图片接管(b)!;
      return {
        type,
        attrs: {
          ...attrs,
          ...图片账本(拆),
          // 摘下来是为了拆得动引用，拼回去时必须原位补回，不然 CRLF 文件保存一次就整行换形
          mdEol: 行尾回车(b),
        },
      };
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
  align: null,
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

/**
 * 块级对齐的落盘形状（docs/02 D40）：`<div align="…">` 独占一行、内部前后各留一个
 * 空行，再裹住那一块正文。
 *
 * 空行不是排版，是语法的分界线：CommonMark 的 HTML 块（类型 6）到空行就结束，里面的
 * Markdown 才会被别的阅读器当 Markdown 解析。少了它，`**粗体**` 在 Obsidian / GitHub
 * 上会显示成字面的星号。`left` 不落包裹——默认就是靠左。
 */
function 包裹对齐(align: unknown, body: string): string {
  const 值 = String(align ?? "");
  if (值 !== "center" && 值 !== "right" && 值 !== "justify") return body;
  if (!body.trim()) return "";
  return `<div align="${值}">\n\n${body}\n\n</div>`;
}

function serializeNode(node: PmNode): string {
  const a = node.attrs as Record<string, unknown>;
  const indent = "  ".repeat(Number(a.mdDepth ?? 0));
  switch (node.type.name) {
    case "mdHeading": {
      const level = Math.min(6, Math.max(1, Number(a.mdLevel ?? 1)));
      return 包裹对齐(
        a.mdAlign,
        "#".repeat(level) +
          " " +
          serializeInline(node) +
          fieldSuffix(a.mdFields) +
          anchorSuffix(a.mdId),
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
    case "mdImage": {
      /**
       * 图片块的字节**只从 attrs 拼**，不碰 `mdRaw`：屏幕上显示的就是这张图，
       * 用户能改的（别名）也直接落进 attrs，所以"屏幕说的"与"落盘的"天然是同一句话。
       * 没改过的块由 `docToMarkdown` 那侧的 `unchanged` 分支原样回写 `raw`，走不到这里。
       *
       * `mdNamed` 是"`![[a.png|]]` 那根竖线是用户打的"这件事本身；别名一旦有内容，
       * 无论这个标志怎么来的都必须写回去——宁可多一根竖线，不可丢掉用户打的字。
       */
      const 拆 = 拆自attrs(a);
      // 顺序是文件里的顺序：引用、锚点、行尾回车。换一下就改了用户字节的位置
      return 拼资产引用(拆) + anchorSuffix(a.mdId) + String(a.mdEol ?? "");
    }
    case "mdOpaque": {
      // 源文本块：内容就是用户的源文本，改了就原样落盘（自带换行由调用方补）
      // **不能写 `node.text`**：那是 `TextNode` 才有的字段，块节点上它是 undefined，
      // `?? ""` 会把整块吃成空字符串——用户编辑一次代码块 / 表格 / 引用，那块就没了。
      const 开 = 有效开栏(node);
      const 闭 = String(a.mdFenceClose ?? "");
      if (!开 || !闭) return node.textContent;
      // 围栏账本这条路：正文只装代码，两道围栏按原样拼回去。空正文要按 `mdFenceBody`
      // 分成 `[]` 与 `[""]` 两种——` ``` 紧挨 ``` ` 与"中间一个空行"是两种字节。
      const 身 = node.textContent
        ? node.textContent.split("\n")
        : a.mdFenceBody
          ? [""]
          : [];
      /**
       * 块锚补回自己那一行（装载时是从 `拆围栏` 眼前摘掉的）。没这条就是"编辑一次代码块，
       * 它的 `^b-…` 从文件里消失"——反链按块 ID 指过来就指空了。
       * 不走账本的那条路不用补：锚点一直躺在 `textContent` 里。
       */
      const 锚 = typeof a.mdId === "string" && a.mdId ? `\n^${a.mdId}` : "";
      return 拼围栏({ 开, 身, 闭 }) + 锚;
    }
    case "mdTable": {
      // 结构 → GFM。列数与对齐由这张表自己带着（mdAligns），所以"加一列"必须同时
      // 改 aligns，否则产出的分隔行比表头短，重新解析就裂了
      const 行们: string[][] = [];
      node.forEach((行) => {
        const 格: string[] = [];
        行.forEach((c) => 格.push(serializeInline(c)));
        行们.push(格);
      });
      return serializeTable({ rows: 行们, aligns: (a.mdAligns as Align[]) ?? [] });
    }
    default:
      return 包裹对齐(
        a.mdAlign,
        serializeInline(node) + fieldSuffix(a.mdFields) + anchorSuffix(a.mdId),
      );
  }
}

/**
 * 这一块**实际生效的开栏行**：账本里那一行 +（只在它是空的）自动识别出来的语言。
 *
 * 四条规矩：
 * - **只在开栏没有 info 首词时猜**。作者写了 `klingon` 就留着 `klingon`——把别人写的
 *   东西改成我们的猜测不叫"识别"，叫覆盖。
 * - **猜出来的词后面那段原样留着**（`​```js // 标记` 清成无语言要得到 `​``` // 标记`，
 *   不是 `​````）：那是用户写的字节，改语言不等于删注释。行尾的 `\r` 也算"那段"。
 * - **只写清单里有的那一门**。`识别` 万一哪天吐回 hljs 的真名（`Batch file (DOS)`、
 *   `TOML, also INI` 这种带空格的），直接拼进开栏就写出一道解析不出来的围栏。
 * - 序列化与显示共用这一个函数：屏幕上标的语言与文件里写的语言必须是同一个答案。
 *
 * `允许猜 = false` 给"装载那一路"用：`highlightAuto` 是逐门跑一遍，实测比指定语言贵十倍
 * （30 行 2~13ms、首门含预热 223ms），不该压在打开笔记与建 NodeView 的路上。
 */
export function 有效开栏(node: PmNode, 允许猜 = true): string {
  const a = node.attrs as Record<string, unknown>;
  const 开 = String(a.mdFenceOpen ?? "");
  if (!开 || !a.mdFenceClose) return 开;
  const 拆 = 拆开栏(开);
  if (!拆 || 拆.词) return 开; // 写了语言（认不认得出都不关我们的事）
  const 猜 = 允许猜 ? 识别(node.textContent) : (已识别(node.textContent) ?? null);
  if (!猜) return 开;
  const 项 = 语言清单.find((l) => l.值 === 短写(猜));
  if (!项) return 开;
  return 拼开栏({ ...拆, 词: 项.值 });
}

/**
 * 这一块**在文件里长什么样**的源文本：走了围栏账本的代码块要把两道围栏拼回来，
 * 其余不透明块就是节点正文。
 *
 * 显示形要的是这个，不是 `node.textContent`——后者对代码块来说只有围栏之间那段，
 * 拿它去 `renderOpaque("code", …)` 会因为认不出开栏而整个降级。
 */
export function 带围栏(node: PmNode, 允许猜 = true): string {
  const a = node.attrs as Record<string, unknown>;
  const 开 = 有效开栏(node, 允许猜);
  const 闭 = String(a.mdFenceClose ?? "");
  if (!开 || !闭) return node.textContent;
  const 身 = node.textContent ? node.textContent.split("\n") : a.mdFenceBody ? [""] : [];
  return 拼围栏({ 开, 身, 闭 });
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
  { kind: "code", 标签: "代码块", 源文本: "```\n\n```" },
  { kind: "table", 标签: "表格", 源文本: "| 列 | 列 |\n| --- | --- |\n|  |  |" },
];

/**
 * 插完代码块之后光标该落在**正文开头**。
 *
 * 围栏在账本里、不在正文里，所以正文的第一个字符就是块内位置 1——不再是"跳过一道开栏"
 * 那种算法（那是围栏还写在正文里的年代）。落在块外（PM 的默认行为：选区留在插入点之前）
 * 时，用户第一次打字改的是围栏本身，产出一份"看着是代码块、其实围栏被打断"的东西。
 * 表格不需要这条：它是网格，落点天然是某一格。
 */
export function 代码落点(块起点: number): number {
  return 块起点 + 1;
}

/**
 * `Ctrl+A` 该落到哪一档：光标在**不透明块**里时先选这一块，整块已经包住了再按才扩到全文。
 * 返回 `null` = 这条不管，交回默认行为。
 *
 * 为什么要改默认：代码块是一整段就地编辑的内容，人在里面按全选要的是**那段代码**；
 * 一次跳到全文等于逼他"点出去、再按、再滚回来"。第二次扩到全文是 Notion / VS Code 的
 * 肌肉记忆，所以"我就是要选整篇"这条路没被堵掉。
 *
 * 两类块明确不在其列：
 * - **表格**：它有自己的格子矩形选区（`tableSelectPlugin`），抢 `Mod-a` 会把那套判据绕开；
 * - **普通段落 / 标题 / 列表项**：那是写正文的地方，全选就是全选整篇，没人期待"只选这一段"。
 */
export function 全选档(state: EditorState): "块" | "全文" | null {
  const { $from } = state.selection;
  if (!$from.depth) return null;
  const 块 = $from.node(1);
  if (块.type.name !== "mdOpaque") return null;
  const 起 = $from.before(1) + 1;
  const 止 = $from.after(1) - 1;
  if (止 <= 起) return "全文"; // 空块没有"这一块"可选，直接给全文
  const { from, to, empty } = state.selection;
  // 整块已被包住（含"选区比块还大"的整篇全选）→ 下一档才是全文
  return !empty && from <= 起 && to >= 止 ? "全文" : "块";
}

/** 那一块内容的起止（选区用），不在不透明块里或空块给 null */
export function 块内范围(state: EditorState): { 起: number; 止: number } | null {
  const { $from } = state.selection;
  if (!$from.depth || $from.node(1).type.name !== "mdOpaque") return null;
  const 起 = $from.before(1) + 1;
  const 止 = $from.after(1) - 1;
  return 止 > 起 ? { 起, 止 } : null;
}

/**
 * 节点当前是哪一种可转块类型（`BLOCK_TYPES` 的 id）。代码 / 引用 / 表格 / 图片给 null：
 * 它们不在可转名单里，格式刷也不该把"源是一段正文"刷成"块类型是 null 的别人"。
 */
export function 块类型of(node: PmNode): BlockTypeId | null {
  const 型 = node.type.name;
  if (型 === "mdHeading") {
    const level = Math.min(6, Math.max(1, Number(node.attrs.mdLevel ?? 1)));
    return `heading${level}` as BlockTypeId;
  }
  if (型 === "mdItem") {
    const kind = String(node.attrs.mdKind ?? "");
    return kind === "bullet" || kind === "numbered" || kind === "todo" ? kind : null;
  }
  if (型 === "mdParagraph") return "paragraph";
  return null;
}

/**
 * 把块改成目标类型需要的节点类型与属性补丁。**返回 null 表示不用改或不能改**——
 * 包括不透明块，以及"目标就是当前类型"（不这么判的话一次无意义的 setNodeMarkup 会
 * 改掉 `mdSig`，把整块重新序列化，用户只是点了同一个菜单项却多出一次落盘）。
 */
export function blockTypePatch(
  node: PmNode,
  id: BlockTypeId,
): { typeName: string; attrs: Record<string, unknown> } | null {
  // 表格与不透明块都不给转：序列化器没有"把一张表变成段落"这条路，
  // 允许转就是把用户的表格洗成一行 `|` 文本（D27 判死的正是这种）
  if (node.type.name === "mdOpaque" || node.type.name === "mdTable") return null;
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
      // 列表项写不出对齐包裹（serializeNode 的 mdItem 分支不读 mdAlign），所以转过去时
      // 把对齐清掉。留着的话，将来再转回正文会突然又居中——文件里从来没记过这一笔。
      const attrs: Record<string, unknown> = { ...清场, mdKind: id, mdAlign: "" };
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

/**
 * 块级对齐（docs/02 D40）。`left` 是默认，文件里不落任何包裹。
 *
 * 能对齐的只有**正文与 ATX 标题**：列表项的符号是绝对定位的画法，居中后正文与符号会
 * 分家；图片 / 表格 / 代码 / 引用在文件里是另一种块，包裹起来内核不会认——与其给一个
 * 一点就丢的按钮，不如只对真能往返的那两类开放。
 *
 * **setext 标题（`标题\n===`）不开放对齐**：内核只认包裹里的 ATX 标题，而前端没有把
 * 标题写法带到 attrs 里——点一下对齐就会把 `标题\n===` 落成 `# 标题`，这不是用户点的
 * 那件事。判据看 `mdRaw` 的第二行，带包裹的块不看（内核已保证里面是 ATX）。
 */
export type BlockAlign = "left" | "center" | "right" | "justify";

export const BLOCK_ALIGNS: { id: BlockAlign; 标签: string }[] = [
  { id: "left", 标签: "左对齐" },
  { id: "center", 标签: "居中对齐" },
  { id: "right", 标签: "右对齐" },
  { id: "justify", 标签: "两端对齐" },
];

/** 这一块当前的对齐档；认不出的值按默认靠左算。 */
export function 块对齐of(node: PmNode | null): BlockAlign {
  const 值 = String(node?.attrs.mdAlign ?? "");
  return 值 === "center" || 值 === "right" || 值 === "justify" ? 值 : "left";
}

/**
 * 从文件装载的标题是不是 setext 写法。只看没有 `mdAlign` 的块：带包裹的块内核已经
 * 保证里面是 ATX。`mdRaw` 的第二行是 `===` / `---` 下划线才算；改过文字的标题也照此
 * 判——它落盘时本来就要重建成 ATX，再给它一个"只改对齐"的按钮只会把两件事混在一起。
 */
function 是setext标题(node: PmNode): boolean {
  if (node.type.name !== "mdHeading" || String(node.attrs.mdAlign ?? "")) return false;
  const 行 = String(node.attrs.mdRaw ?? "").replace(/\r\n/g, "\n").split("\n");
  return 行.length > 1 && /^ {0,3}(?:=+|-+)[ \t]*$/.test(行[1] ?? "");
}

function 能对齐(node: PmNode): boolean {
  if (node.type.name === "mdParagraph") return true;
  return node.type.name === "mdHeading" && !是setext标题(node);
}

/**
 * 选区覆盖到的顶层块。光标（空选区）只算它所在的那一块。
 *
 * 走 `nodesBetween` 而不是 `doc.forEach`：工具栏每次重渲染都会问一次"能不能对齐"，
 * 全篇扫一遍等于在 3000 块的文档上给每一次击键再加 3000 次回调（G6 的预算）。
 * 只走进选区、且不往块里面下钻，代价与选中的块数成正比。
 */
function 所选顶层块(state: EditorState): { pos: number; node: PmNode }[] {
  const { from, to, empty } = state.selection;
  const 止 = Math.min(empty ? from + 1 : to, state.doc.content.size);
  const out: { pos: number; node: PmNode }[] = [];
  if (止 <= from) return out;
  state.doc.nodesBetween(from, 止, (node, pos, parent) => {
    if (parent === state.doc) out.push({ pos, node });
    return false;
  });
  return out;
}

/** 选区里有没有能对齐的块。工具栏拿它决定按钮禁用态——纯函数，不碰 DOM。 */
export function 有可对齐块(state: EditorState): boolean {
  return 所选顶层块(state).some((b) => 能对齐(b.node));
}

/**
 * 选区里可对齐块的**共同**对齐档；多块不同档、或者一块都没有时给 null。
 *
 * 按钮亮不亮必须按动作真正的作用域算：多块混选时只读第一块，会出现"亮着居中、
 * 按下去却把另一段也改成居中"的错觉。不同档时一盏都不亮，比撒谎诚实。
 */
export function 共同对齐(state: EditorState): BlockAlign | null {
  const 可 = 所选顶层块(state).filter((b) => 能对齐(b.node));
  if (!可.length) return null;
  const 首 = 块对齐of(可[0]!.node);
  return 可.every((b) => 块对齐of(b.node) === 首) ? 首 : null;
}

/**
 * 把选区覆盖到的正文 / 标题设成同一档对齐，**一笔事务**（一次 `Ctrl+Z` 回退整批）。
 *
 * `跳过` 是选区里不参与对齐的块数（列表、引用、代码、图片、表格……）。调用方拿它决定
 * 要不要告诉用户"这一步只作用于正文与标题"——纯函数不碰界面。
 *
 * 全部已经是这一档时返回 `tr: null`：连点两次"居中"不该把这篇标成待保存。
 */
export function applyBlockAlign(
  state: EditorState,
  align: BlockAlign,
): { tr: Transaction | null; 跳过: number } {
  const 块们 = 所选顶层块(state);
  const 可 = 块们.filter((b) => 能对齐(b.node));
  const 目标 = align === "left" ? "" : align;
  if (!可.length || 可.every((b) => String(b.node.attrs.mdAlign ?? "") === 目标)) {
    return { tr: null, 跳过: 块们.length - 可.length };
  }
  const tr = state.tr;
  for (const b of 可) {
    tr.setNodeMarkup(b.pos, undefined, { ...b.node.attrs, mdAlign: 目标 });
  }
  return { tr, 跳过: 块们.length - 可.length };
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
 * 光标所在、或整块被选中的那一个**顶层块**的起点；没有可指的块给 -1。
 *
 * 原子块与"点到卡片身上"的整块选中，`$from.depth` 都是 0——那一块自己就是选区，
 * 下面没有可落的文本位置。不接这一支，"选中一张图按 Alt+↓"就什么都不会发生——
 * 手柄 `⋮` 能拖，键盘不能做，正是这个项目被报过两次的那类缺口。
 */
export function 顶层块起点(state: EditorState): number {
  const { $from } = state.selection;
  if ($from.depth) return $from.before(1);
  return state.selection instanceof NodeSelection ? state.selection.from : -1;
}

/**
 * 删掉 `起` 处那一个顶层块，返回带着**已放回光标**的事务。
 *
 * 为什么要有它：代码块 / 引用 / 表格这些块，"把里面的字全选上删掉"留下的是一个
 * **空围栏**（实测：```` ```rust ```` 与闭栏还在，块锚点也还在），而用户要的"这块没了"
 * 只有连节点一起删掉才成立。整块删除走 PM 的 NodeSelection + `deleteSelection` 是干净的，
 * 缺的从来不是能力，是入口。
 *
 * 落脚点那一步不是装饰：删的是文档里最后一块时，人站在一片什么都没有的地方，
 * 键盘再也回不来（`图片下出口` 那段注释记着同一类死局被报过两次）。
 */
export function 删块在(state: EditorState, 起: number): Transaction | null {
  const 块 = state.doc.nodeAt(起);
  if (!块) return null;
  /**
   * 文档里就剩这一块时不是"删掉"而是"换成一个空段落"：走 `delete` 会得到一个零块的
   * 文档，而 doc 的内容规不答应——PM 在 `fillBefore` 里自己造默认节点，实测直接
   * `Maximum call stack size exceeded`（栈整个在 prosemirror-model 里，看不出是谁的锅）。
   * 落脚点这一步不是装饰：删的是最后一块时，人站在一片什么都没有的地方，键盘再也回不来
   * （`图片下出口` 那段注释记着同一类死局被报过两次）。
   */
  const 独块 = state.doc.childCount === 1;
  const 段 = 独块 ? state.schema.nodes.mdParagraph?.create() : null;
  const tr =
    段 && 独块
      ? state.tr.replaceWith(起, 起 + 块.nodeSize, 段)
      : state.tr.delete(起, 起 + 块.nodeSize);
  // 光标落回删掉的那个位置：往前是上一块的末尾，往后是顶上来的那一块，都接得住
  return tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(起, tr.doc.content.size))));
}

/**
 * 删掉"当前这一块"。与 `moveCurrentBlock` 问的是同一个块，所以手柄菜单与
 * 选中整块之后按 `Delete` 说的是同一件事。
 *
 * 选区是**一段文字**时返回 null：那时"这一块"没有一致的含义（它可能盖住五块，
 * 而 Ctrl+A 之后按删除菜单应当删五块还是删一块？），交回 `deleteSelection` 处理。
 */
export function 删当前块(state: EditorState): Transaction | null {
  const 选 = state.selection;
  if (!(选 instanceof NodeSelection) && !选.empty) return null;
  const 起 = 顶层块起点(state);
  return 起 < 0 ? null : 删块在(state, 起);
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
  if (delta === 0) return null;
  const 起点 = 顶层块起点(state);
  if (起点 < 0) return null;
  let index = -1;
  let i = 0;
  state.doc.forEach((n, off) => {
    if (off === 起点) index = i;
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
  if (moved.type.isAtom) {
    // 原子块没有"块内偏移"可回，选回这一块本身（连着按两次 Alt+↓ 移的才是同一块）
    return tr.setSelection(NodeSelection.create(tr.doc, newStart));
  }
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
  const 块起点 = start + node.nodeSize;
  const tr = state.tr.insert(块起点, sourceBlock(state, kind, source, "\n"));
  if (kind === "code") tr.setSelection(TextSelection.near(tr.doc.resolve(代码落点(块起点))));
  return tr.scrollIntoView();
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
  const tr = state.tr.replaceWith(start, start + node.nodeSize, sourceBlock(state, kind, source, gap));
  if (kind === "code") tr.setSelection(TextSelection.near(tr.doc.resolve(代码落点(start))));
  return tr;
}

/** 图片块那一行的形状。载入与粘贴共用，两处各写一份就会分叉 */
function 图片账本(拆: 资产引用): Record<string, unknown> {
  return {
    mdSrc: 拆.目标,
    mdAlt: 拆.别名,
    mdWiki: 拆.形 !== "md",
    mdNamed: 拆.有别名,
    mdLead: 拆.前,
    mdTail: 拆.后,
    mdEol: "",
  };
}

/** 新建块的账本：没有源切片可回，所以 `mdRaw` 空、签名空（必被重新序列化） */
function 新块账本(gap: string) {
  return {
    mdKind: "paragraph",
    mdRaw: "",
    mdGap: gap,
    mdId: null,
    mdDepth: 0,
    mdLevel: null,
    mdChecked: null,
    mdFields: [],
    mdSig: "",
  };
}

/**
 * 表格与空段落下面那个"落脚点"。
 *
 * 为什么必须有：以表格结尾的文档没有地方放光标——格子里装不下换行（GFM 的换行就是行结束），
 * `Tab` / `Enter` 在末格只会一路加行，于是"表格下面写点东西"这件事**没有任何出路**
 * （2026-09-29 用户报的，真机与 jsdom 双层复现过）。空段落在 `docToMarkdown` 里
 * 不落任何字节（"重新产出后是空白的块不落任何字节"那条），所以加它**不改文件一个字**。
 */
function 落脚点(schema: Schema): PmNode | null {
  const 段型 = schema.nodes.mdParagraph;
  return 段型 ? 段型.create(新块账本("\n")) : null;
}

function sourceBlock(state: EditorState, kind: string, source: string, gap: string): PmNode[] {
  const 账本 = { ...新块账本(gap), mdKind: kind };
  // 工具栏插入的表格骨架直接建成网格：插完就能在格子里打字，
  // 而不是先看到三行 `|` 再被要求"点出去才变回表格"
  if (kind === "table" && state.schema.nodes.mdTable) {
    const t = parseTable(source + "\n");
    if (t) {
      const 表 = PmNodeModel.fromJSON(state.schema, tableJson(t, 账本) as never);
      const 尾 = 落脚点(state.schema);
      return 尾 ? [表, 尾] : [表];
    }
  }
  const opaque = state.schema.nodes.mdOpaque;
  if (!opaque) throw new Error("schema 里没有 mdOpaque 节点");
  /**
   * 代码块按**围栏账本**建：骨架 ` ```\n\n``` ` 拆成"开栏行 + 一个空正文 + 闭栏行"，
   * 于是插完直接就能在框里打字，屏幕上从头到尾不出现 ` ``` `。与 `docToJson` 载入
   * 文件时同一条路——插入的代码块与读进来的代码块必须长一样，否则"改一次才知道分叉"。
   */
  const 拆 = kind === "code" ? 拆围栏(source) : null;
  // 空正文**不能建空文本节点**（PM 不允许），靠 `mdFenceBody` 记住"围栏之间有一行"
  const 正文 = 拆 ? 拆.身.join("\n") : "";
  const 块 =
    拆 && 拆.闭
      ? opaque.create(
          {
            ...账本,
            mdFenceOpen: 拆.开,
            mdFenceClose: 拆.闭,
            mdFenceBody: 拆.身.length > 0,
          },
          正文 ? state.schema.text(正文) : null
        )
      : opaque.create(账本, state.schema.text(source));
  /**
   * 与表格同一条规矩：插进来的块下面留一个空段落**落脚点**（空段落不落盘，一个字节都不多）。
   * 不留的话，"在文末插一个代码块"就只剩鼠标能出去——而代码块的出口本来就设计成 `↓`。
   */
  const 尾 = 落脚点(state.schema);
  return 尾 ? [块, 尾] : [块];
}

/**
 * 剪贴板里是表格时，把**当前这个空段落**换成网格。
 *
 * 只在空段落上接管：光标在写着字的段落里、或在别人的格子里，默认粘贴才是用户预期的
 * （往格子里粘一串字就是填那一格）。判据是 `parseGrid`，与文件里的表同一条——认不准就
 * 返回 null，让 PM 按纯文本粘，绝不"看起来像表就先接下来再说"。
 */
export function pasteGrid(state: EditorState, text: string): Transaction | null {
  const 表型 = state.schema.nodes.mdTable;
  if (!表型) return null;
  const { $from } = state.selection;
  if (!$from.depth) return null;
  const 起点 = $from.before(1);
  const 块 = state.doc.nodeAt(起点);
  if (!块 || 块.type.name !== "mdParagraph" || 块.textContent.trim()) return null;
  const 结构 = parseGrid(text);
  if (!结构) return null;
  const 账本 = { ...新块账本(String(块.attrs.mdGap ?? "\n")), mdKind: "table" };
  const 节点 = PmNodeModel.fromJSON(state.schema, tableJson(结构, 账本) as never);
  // 与插入同一条规矩：表格后面留一个落脚点（空段落不落盘），否则粘在文末就出不去
  const 尾 = 落脚点(state.schema);
  const tr = state.tr.replaceWith(起点, 起点 + 块.nodeSize, 尾 ? [节点, 尾] : [节点]);
  // 粘完直接把光标放进第一格：用户的下一件事是打字，不是再点一下
  const 首 = 第n格(节点, 起点, 0);
  return 首 === null ? tr : tr.setSelection(TextSelection.near(tr.doc.resolve(首 + 1)));
}

/**
 * 把存好盘的几张图落成**顶层块**。粘贴与（将来的）拖拽共用这一条。
 *
 * 三条与表格一致的口径：
 * - 光标在一个**空段落**里就换掉它——"新起一行粘图"才是用户预期的，留着那个空段就是多一行空白；
 * - 后面永远跟一个空段落**落脚点**。图片是原子块，插入符进不去，文末粘图不给落脚点
 *   就是"块在文末没有键盘出路"那一类死局（用户报过两次，见 docs/05）；
 * - 落脚点是空段落，不落盘，一个字节都不多。
 */
export function 插图片块(state: EditorState, 引用们: 资产引用[]): Transaction | null {
  const 型 = state.schema.nodes.mdImage;
  if (!型 || !引用们.length) return null;
  const 选 = state.selection;
  /**
   * 整块被选中（图片是原子块，点一下就是 NodeSelection，`$from.depth` 为 0）。
   * 不接这一支，"选中一张图再 Ctrl+V"会返回 null——而字节**已经落盘了**，于是屏幕上
   * 什么都没发生、盘上多一枚没人引用的文件，还一句提示都没有（复查实测到的形状）。
   * 接了之后语义与 Notion 一致：选中的那一块被换掉。
   */
  const 整块选中 = 选 instanceof NodeSelection && 选.$from.depth === 0;
  const 起点 = 整块选中 ? 选.from : 选.$from.depth ? 选.$from.before(1) : -1;
  if (起点 < 0) return null;
  const 块 = state.doc.nodeAt(起点);
  if (!块) return null;
  const 换 = 整块选中 || (块.type.name === "mdParagraph" && !块.textContent.trim());
  const 插入点 = 换 ? 起点 : 起点 + 块.nodeSize;
  const 账本 = { ...新块账本(String(块.attrs.mdGap ?? "\n")), mdKind: "image" };
  const 节点们 = 引用们.map((拆) => 型.create({ ...账本, ...图片账本(拆) }));
  const 尾 = 落脚点(state.schema);
  const 内容 = 尾 ? [...节点们, 尾] : 节点们;
  const tr = 换
    ? state.tr.replaceWith(起点, 起点 + 块.nodeSize, 内容)
    : state.tr.insert(插入点, 内容);
  // 粘完把人放到图片下面那一行：用户的下一件事是继续打字，不是去够鼠标
  const 尺寸 = 节点们.reduce((n, x) => n + x.nodeSize, 0);
  return tr.setSelection(TextSelection.near(tr.doc.resolve(插入点 + 尺寸 + 1))).scrollIntoView();
}

/**
 * 剪贴板里那堆字在这个落点该怎么处理。**判据与动作分开**：判据是纯函数、能被测，
 * 扩展里只留"照着做"。四条分支各有各的不接管理由：
 *
 * - **格子里 + 多行 → 摊平**：单元格是 `inline*`，装不下换行。交回 PM 的默认粘贴会把
 *   换行变成拆块，于是**原来那张表被顶成两半**（真机抓到过：3 行的表变成 1 行 + 2 行，
 *   中间掉出两个空段落）。GFM 的格子里本来就没有换行，折成空格与 `写格()` 落盘那条同规矩。
 * - **格子里 + 单行 → 交回**：行内样式（加粗、链接）的默认粘贴不该被我们抢走。
 * - **空段落 + 剪贴板是表 → 换成网格**（判据在 `parseGrid`，认不准就不接）。
 * - **其余 → 交回**。
 */
export type 粘贴判 =
  | { 做: "摊平"; 文: string }
  | { 做: "网格"; tr: Transaction }
  | { 做: "交回" };

export function 判粘贴(state: EditorState, text: string): 粘贴判 {
  if (!text) return { 做: "交回" };
  if (cellAt(state)) {
    if (!/[\r\n]/.test(text)) return { 做: "交回" };
    return { 做: "摊平", 文: text.replace(/[ \t]*(?:\r?\n[ \t]*)+/g, " ").trim() };
  }
  const tr = pasteGrid(state, text);
  return tr ? { 做: "网格", tr } : { 做: "交回" };
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
  /**
   * **最后"会写出字节"的那一块**——不是"最后一个 child"。
   *
   * 两者会不一样，因为有的块一个字节都不写：回车拆出来的空块、表格后面那个落脚点。
   * 拿"最后一个 child"判结尾换行，就会让落脚点把文件的结尾习惯改掉（表格不再是最后一个
   * child → 被补一个 `\n`），而"从结尾削掉一个 `\n`"那种补法又会伤到未改动的块——它的
   * `raw` 本来就带着自己的换行（2026-09-29 复查实测：删掉末块后 `a\n` 被写成 `a`）。
   */
  const 会写字节 = (n: PmNode): boolean => {
    const a = n.attrs as Record<string, unknown>;
    const raw = typeof a.mdRaw === "string" ? a.mdRaw : "";
    // 未改动的块连空白都原样回写（raw 是文件本来的字节）
    if (raw.length > 0 && sigOf(n) === String(a.mdSig ?? "")) return true;
    return serializeNode(n).trim() !== "";
  };
  let 最后写出 = -1;
  for (let i = doc.childCount - 1; i >= 0; i--) {
    const n = doc.child(i);
    if (n && 会写字节(n)) {
      最后写出 = i;
      break;
    }
  }
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
    let gap =
      raw.length > 0 ? String(a.mdGap ?? "") : continuesList || !out ? "" : "\n";
    // **新块的 gap 语义是"与上一块之间空一整行"**，而"上一块写完了"隐含着一件事：它得先
    // 把自己的行终止。文件最后一行的 `raw` 本来不带换行（未改动的块原样回写、不补 eol），
    // 在它后面插一块时只给一个 "\n" 就变成 `末段\n---` —— 内核把它读成 setext 二级标题，
    // 插一张表则整张表被吞进上一段（2026-09-29 复查实测）。所以这里按 `out` 实际结尾补。
    if (gap === "\n" && out && !out.endsWith("\n")) gap = "\n\n";
    const eol = index === 最后写出 && !srcEndsNewline ? "" : "\n";
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

/**
 * 选区所在的表格格子坐标。不在表格里返回 null。
 *
 * 坐标是**按绝对位置比出来的**（不是按序号猜）：`$from.before(n)` 给的就是那一层的起点，
 * 与 `forEach` 的偏移正好对得上。靠序号在有多张表时迟早认错格子。
 */
export function cellAt(
  state: EditorState,
): { 表: number; 行: number; 列: number; 行数: number; 列数: number } | null {
  const { $from } = state.selection;
  if ($from.depth < 3 || $from.node(3).type.name !== "mdTableCell") return null;
  const 表起点 = $from.before(1);
  const 表 = state.doc.nodeAt(表起点);
  if (!表 || 表.type.name !== "mdTable") return null;
  const 行起点 = $from.before(2);
  const 格起点 = $from.before(3);
  let 行 = -1;
  let 列 = -1;
  表.forEach((r, ro, ri) => {
    if (表起点 + 1 + ro !== 行起点) return;
    行 = ri;
    r.forEach((c, co, ci) => {
      if (行起点 + 1 + co === 格起点) 列 = ci;
    });
  });
  if (行 < 0 || 列 < 0) return null;
  return { 表: 表起点, 行, 列, 行数: 表.childCount, 列数: 表.child(行)!.childCount };
}

/** 表里第 n 个格子（按文档序，0 起）的绝对起点 */
function 第n格(表: PmNode, 表起点: number, n: number): number | null {
  let i = 0;
  let 找: number | null = null;
  表.forEach((r, ro) =>
    r.forEach((_c, co) => {
      if (i++ === n) 找 = 表起点 + 1 + ro + 1 + co;
    }),
  );
  return 找;
}

/** 加一行：照末行的列数与各列对齐补空格子 */
export function addRow(state: EditorState, 表起点: number): Transaction | null {
  const 表 = state.doc.nodeAt(表起点);
  const 行型 = state.schema.nodes.mdTableRow;
  const 格型 = state.schema.nodes.mdTableCell;
  const 末 = 表?.lastChild;
  if (!表 || !行型 || !格型 || !末) return null;
  const aligns = (表.attrs.mdAligns as string[]) ?? [];
  const 新行 = 行型.create(
    null,
    末.children.map((_c, i) => 格型.create({ header: false, align: aligns[i] ?? "" })),
  );
  return state.tr.insert(表起点 + 表.nodeSize - 1, 新行);
}

/**
 * 结构动过之后把光标放回"原来那一格"。
 *
 * 为什么每次都要现算：整块替换与删行都会把块内选区映射到**块尾**（PM 的规矩），光标就跑到
 * 表格外面，工具栏那一组按钮随即消失——用户看到的是"点一下就没了"。行列都按新表钳一下，
 * 删掉的是光标所在那一格时，落点自然退到同行左边那一格 / 上一行。
 */
function 回到格(tr: Transaction, 表起点: number, 行: number, 列: number): Transaction {
  const 新表 = tr.doc.nodeAt(表起点);
  const 列数 = 新表?.firstChild?.childCount ?? 0;
  if (!新表 || !列数) return tr;
  const n = Math.min(行, 新表.childCount - 1) * 列数 + Math.min(列, 列数 - 1);
  const 起 = 第n格(新表, 表起点, n);
  return 起 === null ? tr : tr.setSelection(TextSelection.near(tr.doc.resolve(起 + 1)));
}

/** 加一列。**必须同时给 `mdAligns` 补一项**：产出的分隔行长度由它算，
 * 只加格子的话 `| --- |` 会比表头短一列，重新解析就错位。 */
export function addColumn(state: EditorState, 表起点: number): Transaction | null {
  const 表 = state.doc.nodeAt(表起点);
  const 格型 = state.schema.nodes.mdTableCell;
  if (!表 || !格型 || 表.type.name !== "mdTable") return null;
  const 位 = cellAt(state);
  const 行们: PmNode[] = [];
  表.forEach((行, _o, i) => {
    行们.push(行.copy(行.content.addToEnd(格型.create({ header: i === 0, align: "" }))));
  });
  const 新表 = 表.type.create(
    { ...表.attrs, mdAligns: [...((表.attrs.mdAligns as string[]) ?? []), ""] },
    Fragment.from(行们),
  );
  const tr = state.tr.replaceWith(表起点, 表起点 + 表.nodeSize, 新表);
  return 位 ? 回到格(tr, 表起点, 位.行, 位.列) : tr;
}

/**
 * 删掉光标所在那一行。
 *
 * 两种情况直接不给删：**表头行**（GFM 的表格必须有表头，删了它产出的就不是表了，而"把第二行
 * 提成表头"是替用户改语义）；**只剩表头**（再删就成空表）。光标删完落进顶上来的那一行——
 * 删的是末行时钳回新的末行。
 */
export function removeRow(state: EditorState, 表起点: number): Transaction | null {
  const 位 = cellAt(state);
  const 表 = state.doc.nodeAt(表起点);
  if (!位 || !表 || 表.type.name !== "mdTable" || 位.行 === 0 || 位.行数 <= 1) return null;
  let 删 = -1;
  表.forEach((行, o, i) => {
    if (i === 位.行) 删 = 表起点 + 1 + o;
  });
  if (删 < 0) return null;
  const tr = state.tr.delete(删, 删 + 表.child(位.行)!.nodeSize);
  // 行号不变：删掉那一行之后顶上来的是它下面一行，光标跟着走才是"删的就是我站的那行"。
  // 删的是末行时 `回到格` 自己钳到新的末行。
  return 回到格(tr, 表起点, 位.行, 位.列);
}

/**
 * 删掉光标所在那一列：**每一行都要少一格**，`mdAligns` 同位次也要削掉——
 * 只删格子的话分隔行会比表头长一列，产出的那份重新解析就错位。
 */
export function removeColumn(state: EditorState, 表起点: number): Transaction | null {
  const 位 = cellAt(state);
  const 表 = state.doc.nodeAt(表起点);
  if (!位 || !表 || 表.type.name !== "mdTable" || 位.列数 <= 1) return null;
  const 行们: PmNode[] = [];
  表.forEach((行) => {
    const 格们: PmNode[] = [];
    行.forEach((c, _o, j) => {
      if (j !== 位.列) 格们.push(c);
    });
    行们.push(行.copy(Fragment.from(格们)));
  });
  const aligns = [...((表.attrs.mdAligns as string[]) ?? [])];
  aligns.splice(位.列, 1);
  const 新表 = 表.type.create({ ...表.attrs, mdAligns: aligns }, Fragment.from(行们));
  const tr = state.tr.replaceWith(表起点, 表起点 + 表.nodeSize, 新表);
  return 回到格(tr, 表起点, 位.行, 位.列);
}

/**
 * 设当前列的对齐。**产出的分隔行（`mdAligns`）与画出来的样子（每格 `align`）必须一起改**：
 * 只改一边就会出现"屏幕上居中、文件里写 `---`"，那是又一次"看得见却落不下去"。
 *
 * 已经是这一档就返回 null——不发事务、不标脏、不把整张表重新序列化一遍。用户在同一列上
 * 连点两次"居中"不该让这篇笔记变成"待保存"。
 */
export function setAlign(
  state: EditorState,
  表起点: number,
  对: Align,
): Transaction | null {
  const 位 = cellAt(state);
  const 表 = state.doc.nodeAt(表起点);
  if (!位 || !表 || 表.type.name !== "mdTable") return null;
  const 格型 = state.schema.nodes.mdTableCell;
  if (!格型) return null;
  if (String(表.child(位.行)?.child(位.列)?.attrs.align ?? "") === 对) return null;
  const 行们: PmNode[] = [];
  表.forEach((行) => {
    const 格们: PmNode[] = [];
    行.forEach((c, _o, j) => {
      格们.push(j === 位.列 ? 格型.create({ ...c.attrs, align: 对 }, c.content) : c);
    });
    行们.push(行.copy(Fragment.from(格们)));
  });
  const aligns: Align[] = [...((表.attrs.mdAligns as Align[]) ?? [])];
  while (aligns.length < 位.列数) aligns.push("");
  aligns[位.列] = 对;
  const 新表 = 表.type.create({ ...表.attrs, mdAligns: aligns }, Fragment.from(行们));
  const tr = state.tr.replaceWith(表起点, 表起点 + 表.nodeSize, 新表);
  return 回到格(tr, 表起点, 位.行, 位.列);
}

/**
 * 某个文档位置落在表的哪一格（不在格子里给 null）。
 *
 * 与 `cellAt()` 同一套坐标，但**不读选区**——拖选时指针所在处还没有选区，只有坐标。
 * 从给定位置往上找 `mdTableCell`，而不是假定深度固定：`posAtCoords` / `posAtDOM` 给的
 * 位置深浅不一（空格子里那一下可能落在格子内、也可能落在格子前），按节点名找最稳。
 */
export function 格坐标At(
  state: EditorState,
  pos: number
): { 表: number; 行: number; 列: number } | null {
  let $p: ResolvedPos | null = null;
  try {
    $p = state.doc.resolve(pos);
  } catch {
    return null;
  }
  // 格子在 depth 3（doc → mdTable → mdTableRow → mdTableCell），所以表那一层是 `d-2`：
  // 按 `d-1` 取到的是**行**，`nodeAt` 出来不是 mdTable，判据当场落空——真机上就是这么静默
  // 拖不动的，jsdom 那批测试直接喂 `改选区` 绕过了这一层。
  for (let d = $p.depth; d >= 3; d--) {
    if ($p.node(d).type.name !== "mdTableCell") continue;
    const 表起点 = $p.before(d - 2);
    if (state.doc.nodeAt(表起点)?.type.name !== "mdTable") return null;
    return { 表: 表起点, 行: $p.index(d - 2), 列: $p.index(d - 1) };
  }
  /**
   * 落在格子的边线/内边距上时，PM 给的位置在**行里、那一格之前**（深度只到行）。
   * 这一档也要认出来，否则"沿着表格边缘拖"会一路丢坐标，选区拖到第二格就断了。
   */
  for (let d = $p.depth; d >= 2; d--) {
    if ($p.node(d).type.name !== "mdTableRow") continue;
    const 列 = $p.index(d);
    if (列 >= $p.node(d).childCount) return null; // 行末之外：不属于任何一格
    const 表起点 = $p.before(d - 1);
    if (state.doc.nodeAt(表起点)?.type.name !== "mdTable") return null;
    return { 表: 表起点, 行: $p.index(d - 1), 列 };
  }
  return null;
}

/**
 * 批量改矩形里的格子。清空 / 填充 / 对齐三种动作共用这一条通路——各写一份"重建整张表"
 * 迟早出现只改格子不改 `mdAligns` 那种分叉（屏幕上居中、文件里写 `---`）。
 *
 * `改` 收到的是**原表**里的左上格，所以"填充"抄的是动手之前的内容，不会抄到自己刚写的
 * 那份上。什么都没变就返回 null：连点两次"清空"不该把笔记标成待保存。
 */
function 改格们(
  state: EditorState,
  表起点: number,
  矩: 矩形,
  改: (格: PmNode, 行: number, 列: number, 左上格: PmNode, 是左上: boolean) => PmNode,
  改对齐?: (对齐们: Align[], 夹住后: 矩形) => Align[],
): Transaction | null {
  const 表 = state.doc.nodeAt(表起点);
  const 格型 = state.schema.nodes.mdTableCell;
  if (!表 || 表.type.name !== "mdTable" || !格型) return null;
  const 夹后 = 夹住(矩, 表.childCount, 表.child(0)?.childCount ?? 0);
  if (!夹后) return null;
  const 左上格 = 表.child(夹后.r0)?.child(夹后.c0);
  if (!左上格) return null;
  let 动过 = false;
  const 行们: PmNode[] = [];
  表.forEach((行, _行偏, 行号) => {
    const 格们: PmNode[] = [];
    行.forEach((格, _格偏, 列号) => {
      if (!含(夹后, { 行: 行号, 列: 列号 })) {
        格们.push(格);
        return;
      }
      const 新格 = 改(格, 行号, 列号, 左上格, 行号 === 夹后.r0 && 列号 === 夹后.c0);
      if (新格 !== 格) 动过 = true;
      格们.push(新格);
    });
    行们.push(行.copy(Fragment.from(格们)));
  });
  const 原对齐 = (表.attrs.mdAligns as Align[]) ?? [];
  const 对齐们 = 改对齐 ? 改对齐(原对齐, 夹后) : 原对齐;
  if (改对齐 && 对齐们.join("\u0000") !== 原对齐.join("\u0000")) 动过 = true;
  if (!动过) return null;
  const 新表 = 表.type.create({ ...表.attrs, mdAligns: 对齐们 }, Fragment.from(行们));
  const tr = state.tr.replaceWith(表起点, 表起点 + 表.nodeSize, 新表);
  return 回到格(tr, 表起点, 夹后.r0, 夹后.c0);
}

/** 清空所选的每一格（含左上格）。内容与形状都不动——GFM 的格子本来就没有换行 */
export function 清场所选(
  state: EditorState,
  表起点: number,
  矩: 矩形,
): Transaction | null {
  const 格型 = state.schema.nodes.mdTableCell;
  if (!格型) return null;
  return 改格们(state, 表起点, 矩, (格) => (格.childCount ? 格型.create(格.attrs) : 格));
}

/** 填充：把矩形左上角那一格抄进其余格（表格里 `Ctrl+D` 的位置） */
export function 填充所选(
  state: EditorState,
  表起点: number,
  矩: 矩形,
): Transaction | null {
  const 格型 = state.schema.nodes.mdTableCell;
  if (!格型) return null;
  return 改格们(
    state,
    表起点,
    矩,
    (格, _行, _列, 左上格, 是左上) =>
      是左上 || 格.eq(左上格) ? 格 : 格型.create(格.attrs, 左上格.content),
  );
}

/** 设所选覆盖到的**每一列**的对齐。单列那版是 `setAlign`，两条共用同一份 `mdAligns` 规矩 */
export function 对所齐所选(
  state: EditorState,
  表起点: number,
  矩: 矩形,
  对: Align,
): Transaction | null {
  const 格型 = state.schema.nodes.mdTableCell;
  const 列数 = state.doc.nodeAt(表起点)?.child(0)?.childCount ?? 0;
  if (!格型) return null;
  return 改格们(
    state,
    表起点,
    矩,
    (格) => (String(格.attrs.align ?? "") === 对 ? 格 : 格型.create({ ...格.attrs, align: 对 }, 格.content)),
    (原, 夹) => {
      const 新 = [...原];
      // 补到**列数**而不是 c1：分隔行的长度由 mdAligns 算，短于表头就是那张 02 里
      // 明令不许产出的"分隔行比表头短"的表。与单列那版 `setAlign` 同一条规矩。
      while (新.length < 列数) 新.push("" as Align);
      /**
       * 用 `改格们` **夹住后**的矩形，不用传进来的 `矩`：越界的 `矩.c1` 会把 mdAligns 写得
       * 比表头长，分隔行跟着变长，内核就不再认它是表（真测过：三列的表产出五段分隔行）。
       * 格子那一路本来就夹了，只有对齐这一路漏了。
       */
      for (let c = 夹.c0; c <= 夹.c1; c++) 新[c] = 对;
      return 新;
    },
  );
}

/**
 * 删掉矩形覆盖到的每一行。**表头行（第 0 行）永不删**：GFM 的表格必须有表头，
 * 删掉了产出的那份连分隔行都不成形。全落在表头上时返回 null。
 */
export function 删所选行(
  state: EditorState,
  表起点: number,
  矩: 矩形,
): Transaction | null {
  const 表 = state.doc.nodeAt(表起点);
  if (!表 || 表.type.name !== "mdTable") return null;
  const 夹后 = 夹住(矩, 表.childCount, 表.child(0)?.childCount ?? 0);
  if (!夹后) return null;
  const 删的 = new Set<number>();
  for (let r = Math.max(1, 夹后.r0); r <= 夹后.r1; r++) 删的.add(r);
  const 剩 = 表.childCount - 删的.size;
  if (删的.size === 0 || 剩 < 1) return null;
  const 行们: PmNode[] = [];
  表.forEach((行, _偏, i) => {
    if (!删的.has(i)) 行们.push(行);
  });
  const tr = state.tr.replaceWith(
    表起点,
    表起点 + 表.nodeSize,
    表.type.create(表.attrs, Fragment.from(行们)),
  );
  return 回到格(tr, 表起点, Math.min(夹后.r0, 剩 - 1), 夹后.c0);
}

/** 删掉矩形覆盖到的每一列：每行都少这几格，`mdAligns` 的同位次一起削掉 */
export function 删所选列(
  state: EditorState,
  表起点: number,
  矩: 矩形,
): Transaction | null {
  const 表 = state.doc.nodeAt(表起点);
  if (!表 || 表.type.name !== "mdTable") return null;
  const 夹后 = 夹住(矩, 表.childCount, 表.child(0)?.childCount ?? 0);
  if (!夹后) return null;
  const 删的 = new Set(覆盖列(夹后));
  const 列数 = 表.child(0)?.childCount ?? 0;
  if (列数 - 删的.size < 1) return null;
  const 行们: PmNode[] = [];
  表.forEach((行) => {
    const 格们: PmNode[] = [];
    行.forEach((格, _偏, j) => {
      if (!删的.has(j)) 格们.push(格);
    });
    行们.push(行.copy(Fragment.from(格们)));
  });
  const 对齐们 = ((表.attrs.mdAligns as Align[]) ?? []).filter((_a, i) => !删的.has(i));
  const tr = state.tr.replaceWith(
    表起点,
    表起点 + 表.nodeSize,
    表.type.create({ ...表.attrs, mdAligns: 对齐们 }, Fragment.from(行们)),
  );
  let 留 = 0;
  for (let c = 0; c < 列数; c++) if (c < 夹后.c0 && !删的.has(c)) 留++;
  return 回到格(tr, 表起点, 夹后.r0, 留);
}

/**
 * 把光标移到第 n 个格子；n 越界时先加一行再进去。
 *
 * 两条键都走这里：`Tab` 在最后一格 = 加一行（Notion 的肌肉记忆，也是填表最快的路），
 * `Enter` = 下一行同一列、末行则加一行。GFM 的格子里装不下换行，所以 Enter **永不拆块**——
 * 劈开表格节点产出来的形状 `serializeNode` 根本不认。
 */
function 走到格(state: EditorState, n: number): Transaction | null {
  const { $from } = state.selection;
  if (!$from.depth) return null;
  const 表起点 = $from.before(1);
  const 表 = state.doc.nodeAt(表起点);
  if (!表 || 表.type.name !== "mdTable") return null;
  const 总 = 表.children.reduce((a, r) => a + r.childCount, 0);
  if (n < 0) return null;
  if (n < 总) {
    const 起点 = 第n格(表, 表起点, n);
    return 起点 === null
      ? null
      : state.tr.setSelection(TextSelection.near(state.doc.resolve(起点 + 1)));
  }
  const 加 = addRow(state, 表起点);
  if (!加) return null;
  const 新表 = 加.doc.nodeAt(表起点);
  const 起点 = 新表 ? 第n格(新表, 表起点, n) : null;
  return 起点 === null ? 加 : 加.setSelection(TextSelection.near(加.doc.resolve(起点 + 1)));
}

export function moveCell(state: EditorState, delta: 1 | -1): Transaction | null {
  const 位 = cellAt(state);
  if (!位) return null;
  const n = 位.行 * 位.列数 + 位.列 + delta;
  if (n >= 位.行数 * 位.列数 && delta < 0) return null;
  return 走到格(state, n);
}

/** 末行整行是空的（表头行不算"空行"，它是 GFM 的必需行） */
function 末行全空(表: PmNode): boolean {
  const 末 = 表.lastChild;
  return !!末 && 末.children.every((c) => !c.textContent.trim());
}

/**
 * 把光标送出表格下方。`tr` 是已经改过这张表的事务（也可以是新开的）。
 *
 * 下面已经有块就落进那块；没有就现补一个空段落——**补出来的段落不落盘**，
 * 所以"在文末的表格里按一下 ↓"不会碰用户文件的任何一个字节。
 */
/**
 * 把光标送到**这一块**下面（后面没有块就补一个空段落落脚点）。
 *
 * 表格与不透明块共用它——两类的死局是同一种：块在文末时下面没有可去的地方，
 * 键盘出口也就不存在（2026-09-29 用户报的表格那一版，代码块是同一版）。
 */
function 送出块下(tr: Transaction, 块起点: number): Transaction | null {
  const 块 = tr.doc.nodeAt(块起点);
  const 段型 = tr.doc.type.schema.nodes.mdParagraph;
  if (!块 || !段型) return null;
  const 后 = 块起点 + 块.nodeSize;
  if (!tr.doc.nodeAt(后)) {
    const 尾 = 落脚点(tr.doc.type.schema);
    if (!尾) return null;
    tr.insert(后, 尾);
  }
  return tr.setSelection(TextSelection.near(tr.doc.resolve(后 + 1))).scrollIntoView();
}

/**
 * 最后一行按 `↓`：离开表格。别的行交回 PM——那里 ↓ 该在格子内移动，不该跳出去。
 */
export function exitTableDown(state: EditorState): Transaction | null {
  const 位 = cellAt(state);
  if (!位 || 位.行 !== 位.行数 - 1) return null;
  return 送出块下(state.tr, 位.表);
}

/**
 * 光标在**不透明块的最后一行**按 `↓`：离开这块。代码块 / 引用 / 围栏这类块的出口。
 *
 * 判据是"在最后一行"而不是"在内容末尾"：引用与未闭栏的围栏，最后一行后面还跟着看不见的
 * 字节，要求光标越过它们才按得出去，等于没有出口。代码块自 2026-09-30 起围栏在账本里、
 * 正文只剩代码，"最后一行"就是最后一行代码——同一条判据，两种形状都说得通。
 *
 * 不在最后一行时交回 PM：那里 `↓` 该在块内下移一行。`Enter` 也永远不换块——
 * 代码块里回车就是换行，拆出来的两半围栏 `serializeNode` 不认。
 */
export function exitOpaqueDown(state: EditorState): Transaction | null {
  const { $from } = state.selection;
  if (!$from.depth) return null;
  const 起点 = $from.before(1);
  const 块 = state.doc.nodeAt(起点);
  if (!块 || 块.type.name !== "mdOpaque") return null;
  if ($from.parent !== 块) return null;
  // 后面还有换行 = 不在最后一行
  if (块.textContent.slice($from.parentOffset).includes("\n")) return null;
  return 送出块下(state.tr, 起点);
}

/**
 * 选中图片块时按 `↓` 或 `Enter`：离开这块，落到它下面那一行（没有就现造一个落脚点）。
 *
 * 图片是**原子块**，插入符根本进不去，所以判据不是"在最后一行"而是"这一整块就是选区"
 * （点一下、或方向键走到它上面都会得到 NodeSelection）。不接这条键，"文末粘一张图"
 * 就又变成用户报过两次的那个死局：块占了文末，键盘出不去。
 */
export function 图片下出口(state: EditorState): Transaction | null {
  const 选 = state.selection;
  if (!(选 instanceof NodeSelection) || 选.node.type.name !== "mdImage") return null;
  return 送出块下(state.tr, 选.from);
}

/**
 * 格子里按 `Enter`。
 *
 * 三条分支，前两条是原样（Notion 的肌肉记忆，文档与测试都钉着）：非末行 → 下一行同一列；
 * 末行且那一行有内容 → 加一行。**末行整行是空的 → 删掉那个空行并送出表格**——
 * 这是"再按一次就出去"，也是表格在文档末尾时唯一的自然出口。空行没有内容，删掉不丢数据；
 * 只剩表头时不删（GFM 的表必须有表头行），只把人送出去。
 */
export function enterCell(state: EditorState): Transaction | null {
  const 位 = cellAt(state);
  if (!位) return null;
  const 表 = state.doc.nodeAt(位.表);
  if (表 && 位.行 === 位.行数 - 1 && 末行全空(表)) {
    const tr = state.tr;
    if (位.行数 > 1) {
      let 删 = -1;
      表.forEach((行, o, i) => {
        if (i === 位.行) 删 = 位.表 + 1 + o;
      });
      if (删 >= 0) tr.delete(删, 删 + 表.child(位.行)!.nodeSize);
    }
    return 送出块下(tr, 位.表);
  }
  return 走到格(state, (位.行 + 1) * 位.列数 + 位.列);
}

/** 光标所在表格的起点；不在表格里返回 null（工具栏据此决定要不要给「+ 行 / + 列」） */
export function tableAt(state: EditorState): number | null {
  const { $from } = state.selection;
  if (!$from.depth) return null;
  const 起点 = $from.before(1);
  const 表 = state.doc.nodeAt(起点);
  return 表?.type.name === "mdTable" ? 起点 : null;
}
