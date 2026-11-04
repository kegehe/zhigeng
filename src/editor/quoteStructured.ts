import type { JSONContent } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import type { EditBlock } from "../ipc/types";
import type { JsonNode } from "./blocks";
import { inlineToJson, serializeInline, 序列化行内文本 } from "./inline";
import { 引用账本, 拼引用 } from "./quoteFace";

/**
 * 引用 / Callout 的结构化接管。
 *
 * 判据只有一条：**用我们自己的笔把内核给的子块写回去，必须与账本里的正文逐行相等**。
 * 相等才接管；差一个字节就退回 `mdOpaque` 的源文本面。这样"点进去看到的正文"与
 * "保存时写出的字节"说的是同一句话，改一个字也不会把整块格式洗掉。
 *
 * 只接管四种正文块：段落 / ATX 标题 / 无序 / 有序 / 待办列表项，且列表项不带子项。
 * 代码、表格、嵌套引用、缩进码、setext 标题、对齐包裹这些形状一律不接管。
 */

type 子型 = "mdParagraph" | "mdHeading" | "mdItem";

type 子描述 = {
  型: 子型;
  /** 已经按本序列化器归一过的行内文本（可能含软换行 `\n`） */
  文: string;
  /** 与上一块之间空几行。账本里只有 `\n` 串才认得 */
  隔: string;
  级: number;
  类: string;
  记: string;
  勾: boolean;
  字段: [string, string][];
};

function 字段尾(字段: [string, string][]): string {
  return 字段.map(([k, v]) => ` ${k}:: ${v}`).join("");
}

function 子行(d: 子描述): string[] {
  if (d.型 === "mdParagraph") return d.文.split("\n");
  if (d.型 === "mdHeading") {
    const 级 = Math.min(6, Math.max(1, d.级));
    return [`${"#".repeat(级)} ${d.文}${字段尾(d.字段)}`];
  }
  const 记号 =
    d.类 === "numbered"
      ? `${d.记} `
      : d.类 === "todo"
        ? `- [${d.勾 ? "x" : " "}] `
        : "- ";
  return [`${记号}${d.文}${字段尾(d.字段)}`];
}

/** 孩子之间的空行来自 `mdGap`：`""` 紧排，`"\n"` 是中间空一行 */
function 隔行(隔: string): string[] {
  if (!/^\n*$/.test(隔)) return [];
  return Array.from({ length: 隔.length }, () => "");
}

function 子们成行(子们: 子描述[]): string[] {
  const 行: string[] = [];
  for (const 子 of 子们) {
    行.push(...隔行(子.隔), ...子行(子));
  }
  return 行;
}

function 记子(b: EditBlock): 子描述 | null {
  if (b.children.length || b.align) return null;
  const 隔 = b.gapBefore;
  if (!/^\n*$/.test(隔)) return null;
  if (b.kind === "paragraph") {
    if (b.level !== null || b.checked !== null) return null;
    return {
      型: "mdParagraph",
      文: 序列化行内文本(b.content),
      隔,
      级: 1,
      类: "",
      记: "",
      勾: false,
      字段: b.fields,
    };
  }
  if (b.kind === "heading") {
    if (b.level === null || b.level < 1 || b.level > 6) return null;
    const 文 = 序列化行内文本(b.content);
    if (文.includes("\n")) return null;
    return {
      型: "mdHeading",
      文,
      隔,
      级: b.level,
      类: "",
      记: "",
      勾: false,
      字段: b.fields,
    };
  }
  if (b.kind === "bullet" || b.kind === "numbered" || b.kind === "todo") {
    const 文 = 序列化行内文本(b.content);
    if (文.includes("\n")) return null;
    const 记 = b.kind === "numbered" ? /^\s*(\d+[.)])/.exec(b.raw)?.[1] ?? "" : "";
    if (b.kind === "numbered" && !记) return null;
    // 列表标记的另一种写法（`*` / `+`）我们不产出：接管之后会改用户字节，不接管
    if (b.kind !== "numbered" && !/^\s*[-*+] /.test(b.raw)) return null;
    if (b.kind !== "numbered" && /^\s*[+*] /.test(b.raw)) return null;
    return {
      型: "mdItem",
      文,
      隔,
      级: 1,
      类: b.kind,
      记,
      勾: b.checked === true,
      字段: b.fields,
    };
  }
  return null;
}

function 子内容(c: 子描述): JSONContent[] {
  return inlineToJson(c.文);
}

function 子attrs(c: 子描述): Record<string, unknown> {
  return {
    mdRaw: "",
    mdGap: c.隔,
    mdId: null,
    mdKind: c.型 === "mdParagraph" ? "paragraph" : c.型 === "mdHeading" ? "heading" : c.类,
    mdDepth: 0,
    mdLevel: c.型 === "mdHeading" ? c.级 : null,
    mdChecked: c.型 === "mdItem" && c.类 === "todo" ? c.勾 : null,
    mdAlign: "",
    mdFields: c.字段,
    mdSig: "",
    ...(c.型 === "mdItem" && c.类 === "numbered" ? { mdMarker: c.记 } : {}),
  };
}

function 子节点(c: 子描述): JsonNode {
  return { type: c.型, attrs: 子attrs(c), content: 子内容(c) };
}

/** 账本里的正文行（去掉 CRLF 的 `\r`） */
function 净行(身: string): string[] {
  return 身.split("\n").map((行) => (行.endsWith("\r") ? 行.slice(0, -1) : 行));
}

/**
 * 这一块能不能结构化接管。返回 `mdQuote` 的 JSON；认不准返回 null，
 * 调用方继续给 `mdOpaque` 的源文本面。
 */
export function 引用接管(b: EditBlock): JsonNode | null {
  if (b.kind !== "quote" && b.kind !== "callout") return null;
  const 源 = b.raw.replace(/\n+$/, "");
  const 账 = 引用账本(源, b.kind, b.id);
  if (!账 || 账.身 === "") return null;

  const 原始行 = 账.身.split("\n");
  const 行数 = 原始行.length;
  const eol = 原始行[0]!.endsWith("\r") ? "\r\n" : "\n";
  for (let i = 0; i < 行数 - 1; i++) {
    if (原始行[i]!.endsWith("\r") !== (eol === "\r\n")) return null;
  }
  const tail = 原始行[行数 - 1]!.endsWith("\r") ? "\r" : "";
  if (tail && eol !== "\r\n") return null;

  const 净 = 净行(账.身);
  const 标题 = b.kind === "callout" ? 净[0]! : "";
  const 正文净 = b.kind === "callout" ? 净.slice(1) : 净;
  if (b.kind === "callout") {
    // 标题行写出去必须还是它自己，否则改一次正文就把标题格式洗掉
    if (序列化行内文本(标题) !== 标题) return null;
  }

  const 子们: 子描述[] = [];
  for (const 孩子 of b.children) {
    const 子 = 记子(孩子);
    if (!子) return null;
    // 块锚只认引用自己的那一枚；子块带别的 ID 不接管（账本没地方放它）
    if (孩子.id && 孩子.id !== b.id) return null;
    子们.push(子);
  }

  const 拼出 = 子们成行(子们);
  if (拼出.length !== 正文净.length || 拼出.some((行, i) => 行 !== 正文净[i])) return null;

  const 首缀 = 账.缀[0] ?? "";
  const m = /\[!([A-Za-z-]+)\]([+-]?)/.exec(首缀);
  if (b.kind === "callout" && !m?.[1]) return null;

  const attrs: Record<string, unknown> = {
    mdRaw: b.raw,
    mdGap: b.gapBefore,
    mdId: b.id,
    mdKind: b.kind,
    mdDepth: 0,
    mdLevel: null,
    mdChecked: null,
    mdAlign: "",
    mdFields: [],
    mdSig: "",
    mdQuoteMarks: 账.缀.join("\n"),
    mdQuoteAnchor: 账.锚,
    mdQuoteEol: eol,
    mdQuoteTail: tail,
    mdCalloutType: m?.[1] ?? "",
    mdCalloutFolded: m?.[2] === "-",
  };

  const content: JsonNode[] = [];
  if (b.kind === "callout") {
    content.push({ type: "mdQuoteHead", content: inlineToJson(标题) });
  }
  for (const 子 of 子们) content.push(子节点(子));
  return { type: "mdQuote", attrs, content };
}

/** 一个活子节点 → 与载入时同一份描述（序列化与判据因此读同一套规则） */
function 节点描述(子: PmNode): 子描述 {
  const a = 子.attrs as Record<string, unknown>;
  return {
    型: 子.type.name as 子型,
    文: serializeInline(子),
    隔: String(a.mdGap ?? ""),
    级: Number(a.mdLevel ?? 1),
    类: String(a.mdKind ?? "bullet"),
    记: /^\s*(\d+[.)])/.exec(String(a.mdRaw ?? ""))?.[1] ?? String(a.mdMarker ?? ""),
    勾: a.mdChecked === true,
    字段: (a.mdFields as [string, string][]) ?? [],
  };
}

/**
 * `mdQuote` 的落盘字节：正文按子块的行写出，再套回账本里的每行前缀与行尾锚。
 * 没走账本的新块（剪贴板粘进来的）按 `> ` 起头；Callout 用 `[!type]` 起头。
 */
export function 序列化引用块(node: PmNode): string {
  const a = node.attrs as Record<string, unknown>;
  const eol = String(a.mdQuoteEol ?? "") === "\r\n" ? "\r\n" : "\n";
  const tail = String(a.mdQuoteTail ?? "") === "\r" ? "\r" : "";

  const 子们: PmNode[] = [];
  node.forEach((子) => 子们.push(子));
  const 头 = 子们[0]?.type.name === "mdQuoteHead" ? 子们.shift()! : null;
  const 行: string[] = [];
  for (const 子 of 子们) {
    const 描述 = 节点描述(子);
    行.push(...隔行(描述.隔), ...子行(描述));
  }
  const 正文 = 头 ? [serializeInline(头), ...行] : 行;
  const 身 = 正文.join(eol) + tail;

  const 缀文 = String(a.mdQuoteMarks ?? "");
  let 缀 = 缀文 ? 缀文.split("\n") : [];
  if (!缀.length) {
    const 型 = String(a.mdCalloutType ?? "");
    if (型 && /^[A-Za-z-]+$/.test(型)) {
      缀 = [`> [!${型}]${a.mdCalloutFolded ? "-" : ""} `];
    }
  }
  let 出 = 拼引用(缀, 身, String(a.mdQuoteAnchor ?? ""));
  const id = typeof a.mdId === "string" ? a.mdId : "";
  if (id && !String(a.mdQuoteAnchor ?? "") && !出.trimEnd().endsWith(`^${id}`)) {
    出 = 出.trimEnd() + ` ^${id}`;
  }
  return 出;
}
