import type { JSONContent } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";

/**
 * 行内 Markdown ↔ ProseMirror 文本节点。
 *
 * 只覆盖编辑器真需要的几种标记，且**刻意不求全**：未改动的块根本不走这里
 * （它们按原始源切片回写，见 blocks.ts），所以这里的输出只在"用户确实改过这一块"时
 * 才影响文件。嵌套强调、自动链接、HTML 内联一律按纯文本处理——宁可少识别，
 * 也不许把用户的字吃掉。
 */

export type Inline = { text: string; marks: string[]; href?: string };

const SPANS: [string, string][] = [
  ["**", "bold"],
  ["__", "bold"],
  ["~~", "strike"],
  ["`", "code"],
  ["*", "italic"],
  ["_", "italic"],
];

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) {
      out.push({ text: buf, marks: [] });
      buf = "";
    }
  };
  while (i < src.length) {
    if (src[i] === "[") {
      const close = src.indexOf("]", i);
      if (close > i && src[close + 1] === "(") {
        const end = src.indexOf(")", close + 2);
        if (end > close) {
          flush();
          out.push({
            text: src.slice(i + 1, close),
            marks: ["link"],
            href: src.slice(close + 2, end),
          });
          i = end + 1;
          continue;
        }
      }
    }
    let hit = false;
    for (const [token, mark] of SPANS) {
      if (!src.startsWith(token, i)) continue;
      const close = src.indexOf(token, i + token.length);
      const body = close > 0 ? src.slice(i + token.length, close) : "";
      // 空内容或含空白的内容不当标记：`** 粗 **`、路径里的 `a_b_c` 都不该被误认
      if (close > 0 && body.length > 0 && !/\s/.test(body)) {
        flush();
        out.push({ text: body, marks: [mark] });
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
      json.marks = n.marks.map((m) =>
        m === "link" ? { type: "link", attrs: { href: n.href ?? "", title: null } } : { type: m }
      );
    }
    return json;
  });
}

function wrap(inner: string, token: string): string {
  // 内容里已经有同一个 token 就不包了，避免产出解不开的语法
  return inner.includes(token) ? inner : `${token}${inner}${token}`;
}

export function serializeInline(node: PmNode): string {
  let out = "";
  node.forEach((child) => {
    let text = child.text ?? "";
    for (const mark of child.marks) {
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
        default:
          break;
      }
    }
    out += text;
  });
  return out;
}
