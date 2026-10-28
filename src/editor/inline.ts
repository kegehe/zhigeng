import type { JSONContent } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";

/**
 * 行内 Markdown ↔ ProseMirror 文本节点。
 *
 * 只覆盖编辑器真需要的几种标记，且**刻意不求全**：未改动的块根本不走这里
 * （它们按原始源切片回写，见 blocks.ts），所以这里的输出只在"用户确实改过这一块"时
 * 才影响文件。自动链接、脚注、以及**我们不产出的** HTML 一律按纯文本处理——宁可少识别，
 * 也不许把用户的字吃掉。
 *
 * 颜色与高亮是**唯一两种借 HTML 落盘的样式**（2026-10-28 定，见 docs/02 D35）：
 *   `==文字==`                              高亮（Obsidian 兼容，固定底色）
 *   `<span style="color:#rrggbb">文字</span>`  文字色
 *   `<span style="background-color:#rrggbb">` 底色
 * 判据只有一条：**本序列化器产出的形状，解析回来必须逐字节还原**——否则改一个字就把整块
 * 字节洗掉。手写出来的另一种嵌套顺序（如 `==<span …>字</span>==`）会在**改过的块**上按固定
 * 层序归一成 `<span …>==字==</span>`，与 `__粗__` → `**粗**` 同一条既有性质；未改动的块
 * 仍按 `raw` 原样回写。所以下面只认这一种写法（双引号、无空格、3/6/8 位十六进制），
 * 别的 HTML 继续当纯文本。
 */

/** 一条行内标记。`color` 只给两种颜色标记用；`href` 只给链接用 */
export type InlineMark = { name: string; href?: string; color?: string };
export type Inline = { text: string; marks: InlineMark[] };

const SPANS: [string, string][] = [
  ["**", "bold"],
  ["__", "bold"],
  ["~~", "strike"],
  ["`", "code"],
  ["*", "italic"],
  ["_", "italic"],
];

/**
 * 颜色 span 的开栏。`y`（sticky）不是微优化：这是每块载入时逐字符跑的路径，
 * 3000 块下切字符串再 exec 会被放大成几十毫秒（BlockEditor 那条 38ms 的教训）。
 */
const 色开 = /<span style="(color|background-color):(#[0-9a-fA-F]{8}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})">/y;

/** 递归上限。行内嵌套只有强调 / 链接 / 颜色三类，8 层早已超出真实写作 */
const 最深层 = 8;

/**
 * 从 `from` 起找与开头那个 span 配对的 `</span>`。
 *
 * 必须数层：颜色与底色叠在同一段字上时，序列化会产出一个套一个的同名标签，
 * 直接 `indexOf("</span>")` 会停在内层，外层就被撕成两半——改一个字文件就坏了。
 */
function 找闭span(src: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < src.length) {
    const open = src.indexOf("<span ", i);
    const close = src.indexOf("</span>", i);
    if (close < 0) return -1;
    if (open >= 0 && open < close) {
      depth += 1;
      i = open + 6;
    } else {
      depth -= 1;
      if (depth === 0) return close;
      i = close + 7;
    }
  }
  return -1;
}

/**
 * 找 `==` 的收口。两侧不许是空白、体内不许换行——这是**解析与序列化共用的同一份判据**
 * （序列化时把首尾空白挪到标记外面，见 `包高亮`），两边各判一套就会写出解不开的语法。
 */
function 找闭高亮(src: string, from: number): number {
  let i = from;
  for (;;) {
    const at = src.indexOf("==", i);
    if (at < 0) return -1;
    const body = src.slice(from, at);
    if (
      body.length > 0 &&
      !/^\s/.test(body) &&
      !/\s$/.test(body) &&
      !body.includes("\n")
    ) {
      return at;
    }
    i = at + 2;
  }
}

export function parseInline(src: string, 层 = 0): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) {
      out.push({ text: buf, marks: [] });
      buf = "";
    }
  };
  /**
   * 收一段带标记的文字。`内层` 先解析、外层标记追加在**数组末尾**——序列化时按数组顺序
   * 一层层往外包，顺序正好反过来（数组第一项是最内层）。顺序错了会写出
   * `**[a](u)**` 这种把链接包在加粗外面的形状，再解析回来就不再是同一个结构。
   */
  const 收 = (body: string, mark: InlineMark, 可再解析 = true) => {
    flush();
    const 内 =
      可再解析 && 层 < 最深层 ? parseInline(body, 层 + 1) : [{ text: body, marks: [] as InlineMark[] }];
    for (const n of 内) out.push({ text: n.text, marks: [...n.marks, mark] });
  };
  while (i < src.length) {
    // 1) 颜色 span。只认我们自己产出的形状，别的一律落到"字面文字"那条路
    色开.lastIndex = i;
    const 色 = 色开.exec(src);
    if (色) {
      const body = 色.index + 色[0].length;
      const close = 找闭span(src, body);
      if (close >= 0) {
        收(src.slice(body, close), {
          name: 色[1] === "color" ? "textColor" : "bgColor",
          color: 色[2]!,
        });
        i = close + 7;
        continue;
      }
    }
    // 2) 高亮 `==…==`
    if (src.startsWith("==", i)) {
      const close = 找闭高亮(src, i + 2);
      if (close > 0) {
        收(src.slice(i + 2, close), { name: "highlight" });
        i = close + 2;
        continue;
      }
    }
    // 3) 链接 `[文字](目标)`
    if (src[i] === "[") {
      const close = src.indexOf("]", i);
      if (close > i && src[close + 1] === "(") {
        const end = src.indexOf(")", close + 2);
        if (end > close) {
          收(src.slice(i + 1, close), { name: "link", href: src.slice(close + 2, end) });
          i = end + 1;
          continue;
        }
      }
    }
    // 4) 强调 / 行内码
    let hit = false;
    for (const [token, mark] of SPANS) {
      if (!src.startsWith(token, i)) continue;
      const close = src.indexOf(token, i + token.length);
      const body = close > 0 ? src.slice(i + token.length, close) : "";
      // 空内容或含空白的内容不当标记：`** 粗 **`、路径里的 `a_b_c` 都不该被误认
      if (close > 0 && body.length > 0 && !/\s/.test(body)) {
        收(body, { name: mark }, token !== "`");
        i = close + token.length;
        hit = true;
        break;
      }
    }
    if (hit) continue;
    buf += src[i];
    i += 1;
  }
  flush();
  return out;
}

/**
 * 给 ProseMirror 用的 JSON 片段。
 *
 * marks 为空时**必须整个省掉这个键**：PM 的 `Text.toJSON()` 只在有 marks 时才写它，
 * 多写一个 `marks: []` 会让"载入时算的签名"和"实时算的签名"永远对不上，
 * 于是每个块都被判定为已改、整篇被重新序列化——上一轮就是这么把文件写坏的。
 */
export function inlineToJson(src: string): JSONContent[] {
  return parseInline(src).map((n) => {
    const json: JSONContent = { type: "text", text: n.text };
    if (n.marks.length) {
      json.marks = n.marks.map((m) => {
        if (m.name === "link") return { type: "link", attrs: { href: m.href ?? "", title: null } };
        if (m.name === "textColor" || m.name === "bgColor") {
          return { type: m.name, attrs: { color: m.color ?? "" } };
        }
        return { type: m.name };
      });
    }
    return json;
  });
}

/**
 * 序列化的固定层序。ProseMirror 给的 `marks` 是 schema 顺序而不是嵌套顺序，
 * 照它直接包会让"先写出去的那一版"和"重新载入再写回去的那一版"不一样——
 * 改一个字的块被洗成另一种形状，是最难查的那种坏。排一次序，字节就只由内容决定。
 */
const 层序: Record<string, number> = {
  bold: 0,
  italic: 1,
  code: 2,
  strike: 3,
  link: 4,
  highlight: 5,
  textColor: 6,
  bgColor: 7,
};

function wrap(inner: string, token: string): string {
  // 内容里已经有同一个 token 就不包了，避免产出解不开的语法
  return inner.includes(token) ? inner : `${token}${inner}${token}`;
}

/** 高亮：首尾空白留在标记外面，否则 `== 字==` 解析不回来（判据见 `找闭高亮`） */
function 包高亮(inner: string): string {
  if (inner.includes("==")) return inner;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  const core = m?.[2] ?? "";
  if (!core) return inner;
  return `${m![1]}==${core}==${m![3]}`;
}

function 包色(inner: string, prop: "color" | "background-color", color: string): string {
  if (!color) return inner;
  // **不要再判"体内有没有 `</span>`"**：同一段字既上文字色又上底色时，内层本来就带着
  // 一个 `</span>`，判了就把外层整个丢掉（真机上表现为"选中的底色一保存就没了"）。
  // 收口靠解析那边的层数计数（`找闭span`），不靠这里少包一层。
  return `<span style="${prop}:${color}">${inner}</span>`;
}

export function serializeInline(node: PmNode): string {
  let out = "";
  node.forEach((child) => {
    let text = child.text ?? "";
    const marks = [...child.marks].sort(
      (a, b) => (层序[a.type.name] ?? 99) - (层序[b.type.name] ?? 99),
    );
    for (const mark of marks) {
      switch (mark.type.name) {
        case "bold":
          text = wrap(text, "**");
          break;
        case "italic":
          text = wrap(text, "*");
          break;
        case "code":
          text = text.includes("`") ? text : `\`${text}\``;
          break;
        case "strike":
          text = wrap(text, "~~");
          break;
        case "link":
          text = `[${text}](${mark.attrs.href ?? ""})`;
          break;
        case "highlight":
          text = 包高亮(text);
          break;
        case "textColor":
          text = 包色(text, "color", String(mark.attrs.color ?? ""));
          break;
        case "bgColor":
          text = 包色(text, "background-color", String(mark.attrs.color ?? ""));
          break;
        default:
          break;
      }
    }
    out += text;
  });
  return out;
}
