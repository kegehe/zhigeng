/**
 * GFM 表格的双向转换。表格是这一档里唯一"渲染出来却还要能改"的形状——引用、代码、公式
 * 都退回源文本编辑，唯独表格不行：要填格子就必须待在格子里，所以它必须是真的网格。
 *
 * 代价写在这里：**只有接管得过来的表才走网格**。判据保守到近乎胆小——列数不齐、带锚点、
 * 行首有缩进、中间有空行，一律不接管（继续是不透明块的源文本编辑）。因为一旦接管，
 * 编辑后的产出由这个文件重新拼 GFM；形状看不准就拼错，拼错就是改用户的字节。
 * 与 [02] D9 同一条决心：宁可少规整，也不许吃语法。
 */

export type Align = "" | "left" | "center" | "right";

export type ParsedTable = {
  /** 每行的单元格文字，已解转义。第 0 行是表头（GFM 表格必有表头） */
  rows: string[][];
  /** 每列的对齐，来自分隔行 */
  aligns: Align[];
};

/** 一行表格 → 单元格。`\|` 是转义竖线，不算分隔符 */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (c === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/** 分隔行的一个单元格 → 对齐 */
export function alignOf(spec: string): Align {
  const 左 = spec.startsWith(":");
  const 右 = spec.endsWith(":");
  return 左 && 右 ? "center" : 右 ? "right" : 左 ? "left" : "";
}

const 分隔格 = /^:?-{1,}:?$/;
const 锚点 = /\^b-[a-z0-9-]{6,}/;

/**
 * 这张表能不能接管？不能就返回 null。
 *
 * 每一条拒绝都对应一种"我们拼不回去"的形状：
 * - 列数不齐：GFM 允许，但按位置补/丢列等于替用户改内容；
 * - 带 `^b-`：锚点可能独占一行挂在表后面，也可能挤在末行里当第 N+1 格，两种都会被动过；
 * - 行首缩进与空行：产回去时我们只会拼规范形，那些字节就没了。
 */
export function parseTable(src: string): ParsedTable | null {
  const 去尾 = src.replace(/\n+$/, "");
  if (!去尾) return null;
  const 行 = 去尾.split("\n");
  if (行.length < 2) return null;
  for (const l of 行) {
    if (!l.trim()) return null;
    if (/^\s/.test(l)) return null;
    if (!l.startsWith("|")) return null;
    if (锚点.test(l)) return null;
  }
  const 分隔 = splitRow(行[1]!);
  if (!分隔.length || 分隔.some((c) => !分隔格.test(c))) return null;
  const 表头 = splitRow(行[0]!);
  if (表头.length !== 分隔.length) return null;
  const rows = [表头, ...行.slice(2).map(splitRow)];
  if (rows.some((r) => r.length !== 分隔.length)) return null;
  return { rows, aligns: 分隔.map(alignOf) };
}

/**
 * 换行以及它周围的那点空白 → 一个空格。一整段粘进格子时会有 `\n\n`，连着折才不会出现
 * "甲  乙" 这种看得见却量不出的空隙。
 */
const 换行带白 = /[ \t]*(?:\r?\n[ \t]*)+/g;

/**
 * 单元格 → 可安全写进一行的文字。两条硬规矩，缺一条产出的就不是表：
 * - 竖线必须转义，否则重新解析多出一列；
 * - **格子里不许留换行**：GFM 的换行就是行结束，留一个 `\n` 进去，那块就从 N 行变成
 *   N+1 行、列数对不上，`parseTable` 随即返回 null——下一次打开它不再是表格，
 *   屏幕上那张网格写进盘的是一堆谁也认不出的字节。文本节点是容得下 `\n` 的
 *   （粘贴、`insertText` 都能进来），所以这条只能拦在写盘前的最后一道关口。
 */
function 写格(s: string): string {
  return s.replace(/\|/g, "\\|").replace(换行带白, " ").trim();
}

/**
 * 结构 → 规范 GFM。**结尾不带换行**：`docToMarkdown` 给每块统一补 `eol`（见 D22）。
 *
 * 分隔行按 `aligns` 重算，所以"改一个格子"会把 `|:-----|` 规整成 `|:---|`——
 * 这与段落被重新序列化是同一种代价，只在用户真的动过这一块时发生。
 */
export function serializeTable(t: { rows: string[][]; aligns: Align[] }): string {
  const 一行 = (cells: string[]) => `| ${cells.map(写格).join(" | ")} |`;
  const 分隔 = t.aligns.map((a) =>
    a === "left" ? ":---" : a === "right" ? "---:" : a === "center" ? ":---:" : "---",
  );
  const 头 = t.rows[0] ?? new Array<string>(t.aligns.length).fill("");
  return [一行(头), `| ${分隔.join(" | ")} |`, ...t.rows.slice(1).map(一行)].join("\n");
}
