import { 拆围栏, 围栏行of } from "./fence";
import { 着色, 语言of } from "./highlight";
import { parseInline } from "./inline";
// 表格的解析口径只有一份：显示形与网格编辑共用 table.ts 的那两个函数
import { alignOf as 对齐, splitRow } from "./table";

/**
 * 不透明块的**显示形**（docs/03 §块渲染）。
 *
 * 三条纪律，违反任何一条都不许上线：
 *
 * 1. 这里产出的 DOM 只用于显示。序列化永远读 `mdRaw` 与节点正文，不读这里——
 *    `blocks.ts` 压根不 import 本文件。渲染画错了最坏是"看着不对"，绝不许"落盘不对"。
 * 2. **认不准就返回 null**。null 意味着这一块继续显示源文本（也就是改动前的行为），
 *    这是本文件唯一的降级路径。
 * 3. 语法标记不进显示形：`> ` 前缀、围栏、`^b-xxx` 锚点都要剥掉。它们在源文本形里必须
 *    看得见，因为那些字节确实占着文件——隐形的字节是上一轮"看不见尾巴"的同一种错。
 */

/** 独占一行的块 ID（代码块、表格、Callout 用这种放法，见 ADR-002） */
const ANCHOR_OWN = /^\s*\^b-[a-z0-9-]{6,}\s*$/;
/** 贴在末行尾巴上的块 ID */
const ANCHOR_TAIL = /\s*\^b-[a-z0-9-]{6,}\s*$/;
// 围栏的判据只有一份，在 `fence.ts`：显示形与编辑器的围栏账本必须认同一个形状，
// 两套判据早晚分叉，而这里的分叉等于改用户的字节。
const CALLOUT = /^\s*>\s*\[!([A-Za-z-]+)\]([+-])?\s*(.*)$/;
const DIVIDER = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_LINE = /^\s{0,3}>/;
const TODO = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)\d{1,9}[.)]\s+(.*)$/;

/** 剥掉块 ID：它是要点回去的地址，不是正文。代码块与表格后面那一行整行都是 ID */
function stripAnchor(lines: string[]): string[] {
  const out = [...lines];
  while (out.length && ANCHOR_OWN.test(out[out.length - 1]!)) out.pop();
  if (out.length) out[out.length - 1] = out[out.length - 1]!.replace(ANCHOR_TAIL, "");
  return out;
}

function el<K extends keyof HTMLElementTagNameMap>(
  d: Document,
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = d.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * 行内显示形。复用 `parseInline`（加粗 / 斜体 / 行内码 / 删除线 / 链接），
 * `[[wikilink]]` 在这里就地处理——**不动 inline.ts**：那份函数喂着序列化器，
 * 为显示去改它等于拿用户的字节做实验。
 */
function inlineDom(d: Document, src: string): Node[] {
  const out: Node[] = [];
  let rest = src;
  for (;;) {
    const at = rest.indexOf("[[");
    if (at < 0) break;
    const close = rest.indexOf("]]", at + 2);
    if (close < 0) break;
    pushText(out, d, rest.slice(0, at));
    const target = rest.slice(at + 2, close);
    const bar = target.indexOf("|");
    const 址 = bar < 0 ? target : target.slice(0, bar);
    const 别名 = bar < 0 ? "" : target.slice(bar + 1);
    const 名 = 别名.trim() || 址.split("#")[0]!.split("/").pop() || 址;
    out.push(el(d, "span", "wikilink", 名));
    rest = rest.slice(close + 2);
  }
  pushText(out, d, rest);
  return out;
}

function pushText(out: Node[], d: Document, src: string): void {
  for (const n of parseInline(src)) {
    let node: Node = d.createTextNode(n.text);
    for (const mark of n.marks) {
      const tag = { bold: "strong", italic: "em", code: "code", strike: "s", link: "a" }[mark];
      if (!tag) continue;
      const wrap = el(d, tag as "strong");
      if (tag === "a" && n.href) wrap.setAttribute("href", n.href);
      wrap.append(node);
      node = wrap;
    }
    out.push(node);
  }
}

/**
 * 已剥掉引用前缀的行 → 段落 / 列表 / 嵌套引用。
 *
 * 只认一维：缩进更深的列表项并进同一个列表并带 `data-depth`，不建嵌套 `<ul>`。
 * 建嵌套就要同时决定"子项的字节属于谁"，那是序列化器的口径（D22），不是显示层该碰的。
 */
function blocksFromLines(d: Document, lines: string[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  let 段落: string[] = [];
  let 列表: HTMLElement | null = null;
  let 项型 = "";

  const 收段落 = () => {
    if (!段落.length) return;
    const p = el(d, "p");
    段落.forEach((line, i) => {
      if (i) p.append(d.createElement("br"));
      p.append(...inlineDom(d, line));
    });
    out.push(p);
    段落 = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\s+$/, "");
    if (!line.trim()) {
      收段落();
      列表 = null;
      continue;
    }
    // 又一层 `>` 是嵌套引用。**只吃连续的那几行**：原先是 `slice(i)` 一路到结尾再 return，
    // 于是 `> 外层甲 / > > 内层 / > 外层乙` 把"外层乙"画进了内层——显示层在说谎
    if (QUOTE_LINE.test(line)) {
      收段落();
      列表 = null;
      let 末 = i;
      while (末 < lines.length && QUOTE_LINE.test(lines[末]!.replace(/\s+$/, ""))) 末++;
      const inner = lines.slice(i, 末).map((l) => l.replace(/^\s{0,3}>\s?/, ""));
      const q = el(d, "blockquote", "quote");
      q.append(...blocksFromLines(d, inner));
      out.push(q);
      i = 末 - 1; // 下面 for 的 ++ 把游标接到嵌套段之后
      continue;
    }
    const todo = TODO.exec(line);
    const bullet = todo ? null : BULLET.exec(line);
    const ordered = todo || bullet ? null : ORDERED.exec(line);
    if (todo || bullet || ordered) {
      收段落();
      const 头 = todo ?? bullet ?? ordered!;
      const 型 = todo ? "ul" : bullet ? "ul" : "ol";
      if (!列表 || 列表.tagName.toLowerCase() !== 型 || (todo ? "todo" : "plain") !== 项型) {
        列表 = el(d, 型 as "ul");
        out.push(列表);
        项型 = todo ? "todo" : "plain";
      }
      const li = el(d, "li");
      // 缩进走 `--md-indent`（块级样式用的同一个变量名，作用域只在 li 上）：
      // 直接 `padding-left: attr(...)` 不成立，写死数字又把层级变成样式而不是数据
      li.style.setProperty(
        "--md-indent",
        String(Math.floor((头[1] ?? "").replace(/\t/g, "  ").length / 2)),
      );
      if (todo) {
        const box = el(d, "input", "tick");
        box.type = "checkbox";
        box.disabled = true;
        box.checked = /[xX]/.test(todo[2]!);
        li.append(box, ...inlineDom(d, todo[3]!));
      } else li.append(...inlineDom(d, 头[2]!));
      列表.append(li);
      continue;
    }
    列表 = null;
    项型 = "";
    段落.push(line);
  }
  收段落();
  return out;
}

function tableDom(d: Document, lines: string[]): HTMLElement | null {
  const rows = lines.filter((l) => l.trim());
  if (rows.length < 2) return null;
  const 分隔 = splitRow(rows[1]!);
  if (!分隔.length || 分隔.some((c) => !/^:?-{1,}:?$/.test(c))) return null;
  const align = 分隔.map(对齐);
  const t = el(d, "table", "mdtable");
  const row = (cells: string[], tag: "th" | "td") => {
    const tr = el(d, "tr");
    cells.forEach((c, i) => {
      const cell = el(d, tag);
      cell.append(...inlineDom(d, c));
      const a = align[i];
      if (a) cell.dataset["align"] = a;
      tr.append(cell);
    });
    return tr;
  };
  const head = el(d, "thead");
  head.append(row(splitRow(rows[0]!), "th"));
  const body = el(d, "tbody");
  for (const line of rows.slice(2)) body.append(row(splitRow(line), "td"));
  t.append(head, body);
  return t;
}

/** 围栏代码块：开栏的 info 串第一个词是语言，闭栏必须同种字符、不短于开栏且不带 info */
function codeDom(d: Document, lines: string[]): HTMLElement | null {
  const 拆 = 拆围栏(lines.join("\n"));
  const open = 拆 && 围栏行of(拆.开);
  if (!拆 || !open) return null;
  // 没闭栏的围栏按 CommonMark 就是"到文末都是代码"，内核也这么判，所以照画
  const box = el(d, "div", "codeblock");
  if (open.语言) box.append(el(d, "span", "lang", open.语言));
  const 正文 = 拆.身.join("\n");
  const code = el(d, "code");
  /**
   * 能认语言就着色，认不出就一整块纯文本——**两条路的正文必须逐字相同**（着色只加 `span`）。
   * 语言牌上面照的是开栏行里用户写的那个词，这里换成 hljs 的规范名当 class，两件事不混。
   */
  const 语 = 语言of(open.语言);
  const 片 = 着色(d, 语, 正文);
  if (语) code.className = `language-${语}`;
  if (片) code.append(片);
  else code.textContent = 正文;
  const pre = el(d, "pre");
  pre.append(code);
  box.append(pre);
  return box;
}

/** `$$` 块级公式：只剥围栏、居中。没有 TeX 渲染器，画成公式是另一档活 */
function mathDom(d: Document, lines: string[]): HTMLElement | null {
  const one = /^\s*\$\$(.+)\$\$\s*$/.exec(lines.length === 1 ? lines[0]! : "");
  if (one) return el(d, "div", "math", one[1]!.trim());
  const first = lines[0]?.trim() ?? "";
  const last = lines[lines.length - 1]?.trim() ?? "";
  if (lines.length < 2 || !first.startsWith("$$") || !last.startsWith("$$")) return null;
  const inner = [...lines.slice(1, -1)];
  const 头 = first.slice(2).trim();
  const 尾 = last.slice(2).trim();
  if (头) inner.unshift(头);
  if (尾) inner.push(尾);
  if (!inner.length) return null;
  return el(d, "div", "math", inner.join("\n"));
}

/** 资产与嵌入：不加载文件。本地路径在 WebView 里加载不了，画一个碎图比不画更坏 */
function assetDom(d: Document, kind: string, src: string): HTMLElement | null {
  const m = /!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(src) ?? /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/.exec(src);
  if (!m) return null;
  const 目标 = (m[2] || m[1] || "").trim();
  if (!目标) return null;
  const box = el(d, "span", "asset");
  box.dataset["kind"] = kind;
  box.textContent = 目标.split("/").pop() || 目标;
  return box;
}

function quoteDom(d: Document, lines: string[]): HTMLElement {
  const q = el(d, "blockquote", "quote");
  q.append(...blocksFromLines(d, lines.map((l) => l.replace(/^\s{0,3}>\s?/, ""))));
  return q;
}

/**
 * Callout / 折叠块（`> [!note]-`）。标题行单独一条，正文按引用那套解析。
 *
 * `data-folded` 是**显示态**：点标题只改这个属性，绝不发事务，也不写回源文本里的 `-`。
 * 于是"折叠着又改了源码"时折叠回到源文本写的那一档——渲染形是源文本的投影，不是第二份状态。
 */
function calloutDom(d: Document, lines: string[]): HTMLElement | null {
  const head = CALLOUT.exec(lines[0] ?? "");
  if (!head) return null;
  const box = el(d, "div", "callout");
  box.dataset["callout"] = head[1]!.toLowerCase();
  if (head[2] === "-") box.dataset["folded"] = "1";
  const bar = el(d, "div", "cal-head");
  bar.append(el(d, "span", "cal-badge", head[1]!.toLowerCase()));
  bar.append(el(d, "span", "cal-title", head[3] || head[1]!));
  const body = el(d, "div", "cal-body");
  body.append(...blocksFromLines(d, lines.slice(1).map((l) => l.replace(/^\s{0,3}>\s?/, ""))));
  box.append(bar, body);
  return box;
}

/**
 * 一个不透明块的显示形。返回 null 表示"这块我们画不来"，调用方继续显示源文本。
 *
 * `src` 是节点正文（`mdRaw` 去掉结尾换行），`kind` 是 md-kernel 的类型名。
 * 带子项的列表项（`bullet` / `numbered` / `todo`）画不了：它们的正文是多行带缩进的整棵树，
 * 而块类型切换、索引与序列化都按"一块一项"记账（D22），要画就得同时改那些口径——档 B。
 */
export function renderOpaque(kind: string, src: string, d: Document): HTMLElement | null {
  const lines = stripAnchor(src.split("\n"));
  switch (kind) {
    case "divider":
      return lines.some((l) => DIVIDER.test(l)) ? el(d, "hr", "divider") : null;
    // kind 是内核判的，它就是引用 / 表格，所以懒惰续行（不带 `>` 的那一行）照续行处理，
    // 不因为"这行没有前缀"就退回源文本。
    case "quote":
      return lines.length ? quoteDom(d, lines) : null;
    case "callout":
      return calloutDom(d, lines);
    case "code":
      return codeDom(d, lines);
    case "table":
      return lines.length ? tableDom(d, lines) : null;
    case "math":
      return mathDom(d, lines);
    case "image":
    case "embed":
    case "file":
      return assetDom(d, kind, lines.join("\n"));
    default:
      return null;
  }
}

/**
 * 这个 kind 有没有可能画。画不来的那些（HTML、未识别语法、带子项的列表项）必须继续
 * 显示源文本——把内容藏进一个空宿主里等于在界面上吃掉这一块。
 */
export function mightRender(kind: string): boolean {
  return ["divider", "quote", "callout", "code", "table", "math", "image", "embed", "file"].includes(
    kind,
  );
}
