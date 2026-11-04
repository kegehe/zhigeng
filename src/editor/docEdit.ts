import {
  Fragment,
  Node as PmNodeModel,
  type Node as PmNode,
} from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

import type { DocEditBlock, DocEditOp, DocEditPlan } from "../ipc/types";
import { 以块级记号开头, 块源码, 源块节点 } from "./blocks";
import { inlineToJson, serializeInline } from "./inline";
import { parseTable } from "./table";

/**
 * 整篇文档编辑的**块级补丁**：模型只能对输入里真有的块 id 提出 replace / delete /
 * insert_after；未涉及的块原样复用。这样块边界、表格、围栏与块 id 不会被"整篇重写"
 * 打散（G5），用户也不需要在正文里先选中什么。
 *
 * 这一层是纯函数：收集、校验、预览、应用都不碰网络，方便用真编辑器测。
 */

export const 块上限 = 300;
export const 上下文字数上限 = 20000;
export const 单块字数上限 = 8000;

export type 块资料 = { kind: string; text: string };

export type 收集结果 =
  | {
      ok: true;
      blocks: DocEditBlock[];
      原文: Map<string, 块资料>;
      /** 整篇是空的：模型可以从文首 insert_after，把整篇写出来 */
      空篇: boolean;
    }
  | { ok: false; why: string };

/** 块在模型与界面里的类型名。与 Rust `doc_edit::可插入` 的白名单同一套 */
export function 块类型(node: PmNode): string {
  const 名 = node.type.name;
  if (名 === "mdHeading") {
    const 级 = Math.min(6, Math.max(1, Number(node.attrs.mdLevel ?? 1)));
    return `heading${级}`;
  }
  if (名 === "mdItem") return String(node.attrs.mdKind ?? "bullet");
  if (名 === "mdParagraph") return "paragraph";
  if (名 === "mdTable") return "table";
  if (名 === "mdImage") return "image";
  if (名 === "mdOpaque") return String(node.attrs.mdKind ?? "raw");
  return 名;
}

/** 给模型看的块内容：文字块用行内 Markdown；代码/引用/表格/图片用完整源码 */
export function 块文本(node: PmNode): string {
  const 名 = node.type.name;
  if (名 === "mdParagraph" || 名 === "mdHeading" || 名 === "mdItem") {
    return serializeInline(node);
  }
  if (名 === "mdOpaque" || 名 === "mdTable" || 名 === "mdImage") {
    return 块源码(node);
  }
  return node.textContent;
}

function idOf(node: PmNode): string {
  return typeof node.attrs.mdId === "string" ? node.attrs.mdId : "";
}

/**
 * 给模型看的块键。真块 id 优先；没有就按顶层序号发一个临时键。
 *
 * **为什么不能等块 id**：用户手写的笔记多数没有 `^b-` 锚点，新建笔记更是一个都没有。
 * 整篇编辑若只认真 id，真实文档会一直报"都还没有块 id"。计划只在同一份快照上应用
 * （`应用整篇编辑` 先做 `doc.eq(快照)`），所以序号在这一趟里就是稳定地址。
 * `i-` 前缀与合法块 id 的 `b-` 前缀不重叠，不会撞上用户的真 id。
 */
function 块键(node: PmNode, index: number): string {
  return idOf(node) || `i-${index + 1}`;
}

/** 这一块能不能换内容。表格/图片/分隔线没有"一段文本"的形状，不给 replace */
export function 可替换(kind: string): boolean {
  return kind !== "table" && kind !== "image" && kind !== "divider";
}

export function 可插入(kind: string): boolean {
  if (kind === "paragraph" || kind === "bullet" || kind === "numbered" || kind === "todo") {
    return true;
  }
  if (kind === "quote" || kind === "code" || kind === "divider" || kind === "table") {
    return true;
  }
  return /^heading[1-6]$/.test(kind);
}

function 是文字块(kind: string): boolean {
  return (
    kind === "paragraph" ||
    kind === "bullet" ||
    kind === "numbered" ||
    kind === "todo" ||
    /^heading[1-6]$/.test(kind)
  );
}

/** 把当前文档收成块清单。没有块 id 的块用本次快照里的临时键（`i-<序号>`），
 *  不要求用户先把整篇保存出 `^b-` 锚点；空落脚段不写字节，也不进清单。 */
export function 收集整篇(state: EditorState): 收集结果 {
  const blocks: DocEditBlock[] = [];
  const 原文 = new Map<string, 块资料>();
  const 见过 = new Set<string>();
  let 总字 = 0;
  let 序号 = 0;
  let 错: string | null = null;

  state.doc.forEach((node) => {
    const index = 序号++;
    if (错) return;
    const id = idOf(node);
    const text = 块文本(node);
    // 表格 / 代码块下面那个"落脚点"是空段落，不落盘，也没有内容可改
    if (!id && !text.trim()) return;
    const key = id || 块键(node, index);
    if (见过.has(key)) {
      错 = `块 id 重复：${key}`;
      return;
    }
    见过.add(key);
    const kind = 块类型(node);
    const 字 = [...text].length;
    if (字 > 单块字数上限) {
      错 = `块 ${key} 太长（${字} 字，单块上限 ${单块字数上限} 字）`;
      return;
    }
    总字 += 字;
    blocks.push({ id: key, kind, text });
    原文.set(key, { kind, text });
  });

  if (错) return { ok: false, why: 错 };
  if (!blocks.length) {
    // 真正的空文档（或只剩空落脚段）：合法请求，从文首开始写。
    return { ok: true, blocks: [], 原文, 空篇: true };
  }
  if (blocks.length > 块上限) {
    return { ok: false, why: `整篇编辑最多 ${块上限} 块，这篇有 ${blocks.length} 块` };
  }
  if (总字 > 上下文字数上限) {
    return { ok: false, why: `整篇文字太长（${总字} 字，上限 ${上下文字数上限} 字）` };
  }
  return { ok: true, blocks, 原文, 空篇: false };
}

export type 应用结果 =
  | { ok: true; tr: Transaction; 应用数: number; 首索引: number }
  | { ok: false; why: string };

function 短(text: string, 长 = 42): string {
  const 一 = text.replace(/\s+/g, " ").trim();
  return [...一].length > 长 ? [...一].slice(0, 长).join("") + "…" : 一;
}

/** 预览用的一行。界面只读它，不自己再拼一套旧/新文本 */
export type 预览条 = { 标签: string; 旧: string | null; 新: string | null };

export function 计划预览(plan: DocEditPlan, 快照: EditorState["doc"] | null): 预览条[] {
  const 资料 = new Map<string, 块资料>();
  let 序号 = 0;
  快照?.forEach((node) => {
    资料.set(块键(node, 序号++), { kind: 块类型(node), text: 块文本(node) });
  });
  return plan.edits.map((op) => {
    if (op.op === "replace") {
      const 旧 = 资料.get(op.id);
      const 换类 = op.kind && op.kind !== 旧?.kind ? `为 ${op.kind} ` : "";
      return {
        标签: `替换${换类}${旧 ? `「${短(旧.text)}」` : `块 ${op.id}`}`,
        旧: 旧?.text ?? null,
        新: op.text,
      };
    }
    if (op.op === "delete") {
      const 旧 = 资料.get(op.id);
      return {
        标签: `删除${旧 ? `「${短(旧.text)}」` : `块 ${op.id}`}`,
        旧: 旧?.text ?? null,
        新: null,
      };
    }
    const after = op.after ? 资料.get(op.after) : null;
    return {
      标签: `在${after ? `「${短(after.text)}」` : "文首"}后插入 ${op.kind}`,
      旧: null,
      新: op.text,
    };
  });
}

function 规整源码(kind: string, text: string): string {
  if (kind === "code") {
    return text.trimStart().startsWith("```") ? text : "```\n" + text + "\n```";
  }
  if (kind === "quote") {
    // 模型可能只给引用正文，也可能原样给带 `> ` 的源文本；逐行补一次，已经带的不重复加。
    return text
      .split(/\r?\n/)
      .map((行) => {
        const 缩 = 行.trimStart();
        if (!缩) return ">";
        return 缩.startsWith(">") ? 行 : `> ${行}`;
      })
      .join("\n");
  }
  if (kind === "divider") return "---";
  return text;
}

/**
 * 代码块的块锚写在闭栏**之后单独一行**。`块文本` 给模型看的就是带锚的那份，模型只改
 * 一行代码、原样回传时这行锚会挡住 `拆围栏` 的"闭栏在末行"判据：整块退回源文本，
 * 屏幕上的代码框变成 ` ``` ` 源码（字节倒还对）。锚由 `mdId` 负责补回，这里先摘掉。
 */
function 去尾锚(text: string, id: string): string {
  const 净 = text.trimEnd();
  const 尾 = `\n^${id}`;
  return 净.endsWith(尾) ? 净.slice(0, -尾.length) : text;
}

/**
 * 段落文字若以块级记号开头，落盘时内核会把它读成另一种块（判据见 `以块级记号开头`）。
 * 行内文字本来就不该带这些记号；所有编辑是一整份拒绝，说清换用哪个 kind 比悄悄改类型好。
 */
function 块记号问题(kind: string, text: string): string | null {
  if (kind !== "paragraph" || !以块级记号开头(text)) return null;
  return "这段文字以块级记号开头（#、-、>、1.、``` 等），落盘会被读成另一种块；请去掉开头的记号，或把 kind 换成对应的块";
}

function 文字块节点(
  state: EditorState,
  kind: string,
  text: string,
  gap: string,
  id: string | null = null,
  // 同一块换内容时沿用它的账本（缩进、待办勾选、callout 字段都不该被顺手抹掉）；
  // 换块类型则重新起一份，避免把上一类的语义带过去。
  原: PmNode | null = null,
): PmNode | null {
  if (/[\r\n]/.test(text)) return null;
  const 同类 = 原 !== null && 块类型(原) === kind;
  const attrs: Record<string, unknown> = 同类
    ? { ...原.attrs }
    : {
        mdGap: gap,
        mdDepth: 0,
        mdFields: [],
        mdChecked: null,
        mdLevel: null,
      };
  // 旧 raw 只当"这块来自文件"的凭据（`docToMarkdown` 据此保留它自己的空行）与有序项
  // 记号的来源（见 blocks.ts `numberedMarker`）用。`mdSig` 已清空，它绝不会被当成
  // "没改过"而原样回写。**不能清空**：清掉之后这块被当成新建，作者留的两个空行会被
  // 重算成一个（真测过）；换个块类型同理，改类型不该顺手改排版。
  attrs.mdRaw = 原 && typeof 原.attrs.mdRaw === "string" ? 原.attrs.mdRaw : "";
  attrs.mdSig = "";
  attrs.mdId = id;
  attrs.mdGap = gap;
  let 型 = "mdParagraph";
  if (/^heading[1-6]$/.test(kind)) {
    型 = "mdHeading";
    attrs.mdKind = "heading";
    attrs.mdLevel = Number(kind.slice(7));
    attrs.mdDepth = 0;
    attrs.mdChecked = null;
  } else if (kind === "bullet" || kind === "numbered" || kind === "todo") {
    型 = "mdItem";
    attrs.mdKind = kind;
    attrs.mdLevel = null;
    if (kind === "todo") attrs.mdChecked = 同类 ? Boolean(原.attrs.mdChecked) : false;
    else attrs.mdChecked = null;
  } else {
    attrs.mdKind = "paragraph";
    attrs.mdLevel = null;
    attrs.mdChecked = null;
    attrs.mdDepth = 0;
  }
  const 节点型 = state.schema.nodes[型];
  if (!节点型) return null;
  try {
    return PmNodeModel.fromJSON(state.schema, {
      type: 型,
      attrs,
      content: inlineToJson(text),
    });
  } catch {
    return null;
  }
}

/** 插入时与上一块之间的空行：同一个列表的连续项不留空行，其余用一整行 */
function 插入间隙(prev: PmNode | null, kind: string): string {
  if (prev && (kind === "bullet" || kind === "numbered" || kind === "todo")) {
    if (块类型(prev) === kind) return "";
  }
  return "\n";
}

function 替换节点(
  state: EditorState,
  node: PmNode,
  text: string,
  新类?: string,
  // 换的是最后一块时要留下落脚段（表格尤其），中间块由后面的块提供出口
  末块 = false,
): { ok: true; nodes: PmNode[] } | { ok: false; why: string } {
  const 原类 = 块类型(node);
  if (!可替换(原类)) {
    return { ok: false, why: `${原类} 块暂不支持整篇替换，可以删除或在旁边插入` };
  }
  const kind = 新类 ?? 原类;
  // 只有**换类型**才需要过插入白名单。同类型替换的源块（callout / math / raw …）
  // 本来就能原样回写，不该因为它的名字不在 `可插入` 里被拒。
  if (kind !== 原类 && !可插入(kind)) return { ok: false, why: `不能改成这种块：${kind}` };
  const id = idOf(node);
  // 分隔线写不成 `--- ^b-…`（那已经不是分隔线了），表格序列化器也从不写锚点。
  // 带着块锚点直接换过去，要么把锚点变成正文、要么让它从文件里消失——两条都是
  // 悄悄改坏引用，不如拒绝：删除后另插一块，新块本来就不带锚点。
  if (id && (kind === "divider" || kind === "table")) {
    return {
      ok: false,
      why: `块 ${id} 带着块锚点，换成分隔线 / 表格会把锚点写丢；请先删除这块再插入`,
    };
  }
  const gap = String(node.attrs.mdGap ?? "\n");
  if (是文字块(kind)) {
    if (/[\r\n]/.test(text)) {
      return { ok: false, why: "替换后的文字含换行；请拆成多条 replace / insert_after" };
    }
    const 记号 = 块记号问题(kind, text);
    if (记号) return { ok: false, why: 记号 };
    const next = 文字块节点(state, kind, text, gap, id || null, node);
    return next
      ? { ok: true, nodes: [next] }
      : { ok: false, why: "替换后的行内内容无法解析" };
  }
  if (kind === "table" && !parseTable(规整源码(kind, text) + "\n")) {
    return { ok: false, why: "替换后的表格不是可识别的 Markdown 表格" };
  }
  const 源文 = id && kind === "code" ? 去尾锚(text, id) : text;
  const 节点们 = 源块节点(state, kind, 规整源码(kind, 源文), gap);
  const 首 = 节点们[0];
  if (!首) return { ok: false, why: "这段源码无法变成块" };
  // 源码变了必须重序列化：清掉 mdSig，但保留块 id、它的空行与旧 raw 这份"来自文件"
  // 的凭据（理由同 `文字块节点`）。表格会自带一个空落脚段：换的是最后一块时跟着一起放，
  // 否则以表格结尾就没有键盘出路；中间块不用留，后面的块本来就是出口。
  const 换 = 首.type.create(
    {
      ...首.attrs,
      mdId: id || null,
      mdGap: gap,
      mdRaw: typeof node.attrs.mdRaw === "string" ? node.attrs.mdRaw : "",
      mdSig: "",
    },
    首.content,
    首.marks,
  );
  return { ok: true, nodes: [换, ...(末块 ? 节点们.slice(1) : [])] };
}

function 插入节点(
  state: EditorState,
  op: Extract<DocEditOp, { op: "insert_after" }>,
  prev: PmNode | null,
): { ok: true; nodes: PmNode[] } | { ok: false; why: string } {
  if (!可插入(op.kind)) return { ok: false, why: `不能插入这种块：${op.kind}` };
  if (op.kind === "table" && !parseTable(op.text + "\n")) {
    return { ok: false, why: "插入的表格不是可识别的 Markdown 表格" };
  }
  const gap = 插入间隙(prev, op.kind);
  if (是文字块(op.kind)) {
    const 记号 = 块记号问题(op.kind, op.text);
    if (记号) return { ok: false, why: 记号 };
    const 节点 = 文字块节点(state, op.kind, op.text, gap);
    return 节点
      ? { ok: true, nodes: [节点] }
      : { ok: false, why: "插入的文字含换行，或无法变成一块" };
  }
  const 节点们 = 源块节点(state, op.kind, 规整源码(op.kind, op.text), gap);
  if (!节点们.length) return { ok: false, why: `插入 ${op.kind} 失败` };
  // `源块节点` 总带一个空段落落脚点。中途插入时它就是正文里凭空多出来的一行空白
  //（不落盘，但看着像被塞了个空行）。先摘掉，整份结果真的以这块收尾时由
  // `应用整篇编辑` 统一补回——那里才知道后面还有没有块。
  const 尾 = 节点们[节点们.length - 1];
  const 有落脚点 = 节点们.length > 1 && 尾?.type.name === "mdParagraph" && !尾.textContent;
  return { ok: true, nodes: 有落脚点 ? 节点们.slice(0, -1) : 节点们 };
}

/**
 * 把计划应用到当前文档。**全有或全无**：任何 id 对不上、块类型不支持、文字含换行，
 * 都整份拒绝，正文不动。未涉及的块直接复用原节点（块 id 与字节形状都跟着走）。
 */
export function 应用整篇编辑(
  state: EditorState,
  快照: EditorState["doc"],
  plan: DocEditPlan,
): 应用结果 {
  if (!state.doc.eq(快照)) {
    return { ok: false, why: "文档在这期间被改过，这次没有应用；请重新发起" };
  }
  if (!plan.edits.length) return { ok: false, why: "这份计划没有要改的地方" };

  const 原块们: { node: PmNode; key: string }[] = [];
  const 现块 = new Map<string, PmNode>();
  state.doc.forEach((node, _off, index) => {
    const key = 块键(node, index);
    原块们.push({ node, key });
    现块.set(key, node);
  });

  const 改删 = new Map<string, DocEditOp>();
  const 插入 = new Map<string | null, Extract<DocEditOp, { op: "insert_after" }>[]>();
  for (const op of plan.edits) {
    if (op.op === "insert_after") {
      const 列 = 插入.get(op.after) ?? [];
      列.push(op);
      插入.set(op.after, 列);
      continue;
    }
    if (改删.has(op.id)) {
      return { ok: false, why: `同一块被改了两次：${op.id}` };
    }
    const node = 现块.get(op.id);
    if (!node) return { ok: false, why: `模型引用了文档里不存在的块：${op.id}` };
    if (op.op === "replace" && !可替换(块类型(node))) {
      return { ok: false, why: `${op.id} 是 ${块类型(node)} 块，整篇编辑不替换这一类` };
    }
    if (op.op === "replace" && op.kind && op.kind !== 块类型(node) && !可插入(op.kind)) {
      return { ok: false, why: `不能改成这种块：${op.kind}` };
    }
    改删.set(op.id, op);
  }
  for (const [after, 列] of 插入) {
    if (after !== null && !现块.has(after)) {
      return { ok: false, why: `模型要把块插到不存在的块后面：${after}` };
    }
    for (const op of 列) {
      if (!可插入(op.kind)) return { ok: false, why: `不能插入这种块：${op.kind}` };
    }
  }

  const 结果: PmNode[] = [];
  /** 这次新插进来的节点：它们没有落脚点，若正好收尾要补一个 */
  const 插入来的 = new Set<PmNode>();
  let 应用数 = 0;
  let 首索引 = -1;
  const 记首 = (index: number) => {
    if (首索引 < 0) 首索引 = index;
  };

  for (const op of 插入.get(null) ?? []) {
    const 果 = 插入节点(state, op, null);
    if (!果.ok) return 果;
    记首(结果.length);
    结果.push(...果.nodes);
    果.nodes.forEach((n) => 插入来的.add(n));
    应用数++;
  }

  for (const [块序, { node, key }] of 原块们.entries()) {
    const 改 = 改删.get(key);
    let prev: PmNode | null = node;
    if (改?.op === "replace") {
      // 落脚点只给**真的收尾**的那次替换：计划在同一块后还跟着 insert_after 时，
      // 它就不是末块了，再留空段就是正文中间凭空多一行（插入的那块本来就是出口）。
      const 末块 = 块序 === 原块们.length - 1 && !(插入.get(key)?.length);
      const 果 = 替换节点(state, node, 改.text, 改.kind, 末块);
      if (!果.ok) return 果;
      记首(结果.length);
      结果.push(...果.nodes);
      prev = 果.nodes[果.nodes.length - 1] ?? node;
      应用数++;
    } else if (改?.op === "delete") {
      记首(结果.length);
      应用数++;
    } else {
      结果.push(node);
    }
    for (const op of 插入.get(key) ?? []) {
      const 果 = 插入节点(state, op, prev);
      if (!果.ok) return 果;
      记首(结果.length);
      结果.push(...果.nodes);
      果.nodes.forEach((n) => 插入来的.add(n));
      应用数++;
    }
  }

  // 插入的源码块（表格 / 代码 / 引用 / 分隔线）若正好落在整篇末尾，补一个空段落
  // 落脚点：以表格或围栏收尾的文档没有键盘出口。它不落盘（`docToMarkdown` 空块不写字节），
  // 中途的落脚点已在 `插入节点` 摘掉——正文里不再多出那一行可见的空白。
  const 末 = 结果[结果.length - 1];
  if (末 && 插入来的.has(末) && (末.type.name === "mdTable" || 末.type.name === "mdOpaque")) {
    const 尾 = state.schema.nodes.mdParagraph?.create();
    if (尾) 结果.push(尾);
  }

  if (!结果.length) {
    const 段 = state.schema.nodes.mdParagraph?.create();
    if (!段) return { ok: false, why: "schema 里没有段落节点" };
    结果.push(段);
    首索引 = 0;
  }
  if (!应用数) return { ok: false, why: "这份计划没有要改的地方" };

  const tr = state.tr.replaceWith(0, state.doc.content.size, Fragment.fromArray(结果));
  // 光标落到第一处改动：用户按一次 Ctrl+Z 就能把整份补丁退掉。删掉最后一块时
  // `首索引` 会等于结果长度（原位置已经没有块了），夹回最后一块，别把光标甩回文首。
  const 落点 = Math.min(Math.max(0, 首索引), Math.max(0, 结果.length - 1));
  let 位 = 0;
  let k = 0;
  tr.doc.forEach((_n, off) => {
    if (k === 落点) 位 = off;
    k++;
  });
  const 首块 = tr.doc.nodeAt(位);
  tr.setSelection(
    TextSelection.near(tr.doc.resolve(首块?.isAtom ? 位 : 位 + 1)),
  );
  return { ok: true, tr, 应用数, 首索引: 落点 };
}
