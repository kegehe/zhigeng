// 护栏：四件事必须在每次提交前成立（`node scripts/check.mjs` 把这一项接进去了）。
// 成本极低，但不做就会慢慢烂掉。
// 1) 依赖方向：note-core / md-kernel / note-cli 不许链接 Tauri，md-kernel 不许链接 SQLite
// 2) perf-budget.json 的键必须齐，且与 docs/03 §性能预算 对得上
// 3) 样式禁止清单（docs/06 §4）：字面量颜色、裸 z-index、transition:all、去掉焦点环、联网取字体
// 4) `[workspace.dependencies]` 里不许有"声明了没人引用"的依赖
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const fail = [];
const lock = readFileSync("Cargo.lock", "utf8");

/** 取某个包在 Cargo.lock 里的整段条目 */
function lockBlock(name) {
  const re = new RegExp(`name = "${name}"\\n(?:version[^\\n]*\\n)(?:[^\\[]*\\n)*?dependencies = \\[([\\s\\S]*?)\\]`, "m");
  const m = lock.match(re);
  return m ? m[1] : null;
}
function depsOf(name) {
  const b = lockBlock(name);
  if (b === null) return null;
  return [...b.matchAll(/"([A-Za-z0-9_.-]+)/g)].map((x) => x[1]);
}

for (const crate of ["note-core", "md-kernel", "note-cli"]) {
  const deps = depsOf(crate);
  if (!deps) {
    fail.push(`Cargo.lock 里找不到 ${crate}`);
    continue;
  }
  const shell = deps.filter((d) => /^tauri(-|$)/.test(d) || d === "window-vibrancy" || d === "webview2-com");
  if (shell.length) fail.push(`${crate} 依赖了壳侧的 crate：${shell.join(", ")}`);
}
const mk = depsOf("md-kernel") ?? [];
const storage = mk.filter((d) => /sqlite|rusqlite/i.test(d));
if (storage.length) fail.push(`md-kernel 依赖了存储层：${storage.join(", ")}`);

// ---- 性能预算 ----
const budget = JSON.parse(readFileSync("perf-budget.json", "utf8"));
for (const k of [
  "同步IPC调用_p95_ms",
  "打字到屏幕_p95_ms",
  "INP_p95_ms",
  "冷启动到可编辑_ms",
  "全文搜索_p95_ms",
  "内存驻留_MB",
  "安装包_MB",
]) {
  if (!(k in budget)) fail.push(`perf-budget.json 缺键 ${k}`);
}
if (budget["同步IPC调用_p95_ms"] !== 8) {
  fail.push("同步 IPC 预算被改动，需同步改 docs/00 的 G6 与 docs/03");
}

// ---- 悬空的 workspace 依赖 ----
// 三次同一种事故：`notify` 声明了没有一个 .rs 引用它（于是"外部改动只靠保存时拦"），
// `criterion` 声明了没有 `[[bench]]` target（于是"微基准每次合入记录"是空的），
// `note-mcp` 被文档记成已交付而 crate 根本不存在。前两条人肉翻代码才发现，
// 一条断言就能永久挡住：**声明 ≠ 使用**。
const wsToml = readFileSync("Cargo.toml", "utf8");
const wsStart = wsToml.indexOf("[workspace.dependencies]");
if (wsStart < 0) {
  fail.push("Cargo.toml 里没有 [workspace.dependencies]，检查这条护栏是否该改");
} else {
  const rest = wsToml.slice(wsStart + "[workspace.dependencies]".length);
  const sectionEnd = rest.search(/^\s*\[/m);
  const block = sectionEnd < 0 ? rest : rest.slice(0, sectionEnd);
  const declared = [...block.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]);
  const consumers = ["crates/md-kernel", "crates/note-core", "crates/note-cli", "src-tauri"]
    .map((d) => join(d, "Cargo.toml"))
    .filter((f) => existsSync(f))
    .map((f) => readFileSync(f, "utf8"));
  for (const name of declared) {
    const used = consumers.some((t) =>
      new RegExp(`^\\s*"?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*=`, "m").test(t),
    );
    if (!used) fail.push(`[workspace.dependencies] 里的 ${name} 没有任何 crate 引用它（声明了没用掉）`);
  }
}

// ---- 样式禁止清单 ----
function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
// 允许出现字面量的地方：token 定义本身、一次性原型
const ALLOW = new Set(["src/ui/tokens.css", "probes/spike-c/index.html"]);
const rules = [
  [/#([0-9a-f]{3,8})\b/i, "字面量 hex 颜色"],
  [/\brgba?\(/, "字面量 rgb() 颜色"],
  [/\boklch\(/, "oklch 字面量"],
  [/transition:\s*all/, "transition: all 会连带过渡布局属性，直接掉帧"],
  [/z-\[\d/, "裸 z-index 数字，请用 --z-* token"],
  [/https?:\/\/(?!127\.0\.0\.1|localhost)[^\s'"`)]*\.(?:woff2?|js|css)\b/, "联网取字体/脚本"],
  [/animate-\[[^\]]*(?:width|height|top|left|margin|padding)/, "动画布局属性"],
];
/**
 * 焦点指示单独判，不混在逐行清单里。
 *
 * 老写法是一刀禁止 outline: none——那条把"不许没有焦点指示"和"必须用一圈描边"混成了
 * 一件事，结果正文编辑器要么套着整篇的圈，要么偷偷绕过护栏。现在判的是本意，但**判据绑在
 * 同一个选择器上**：去掉某个元素的描边，唯一理由必须是同一个选择器（可以带 ::before /
 * ::after 后缀）给出了另一种看得见的指示。
 *
 * 为什么不是"同文件里有任意 :focus 正向声明就放行"：第一版就是那么写的，自检发现全局那条
 * :focus-visible 环能替任何局部豁免过关——那是假闸门。
 */
const NO_RING = /outline\s*:\s*none|outline-none/;
const POSITIVE =
  /(?:outline:\s*(?!none)[^;}]+|box-shadow:\s*(?!none)|border(?:-[a-z]+)?:\s*(?!none)|background(?:-color)?:\s*(?!none)|opacity:\s*1(?![\d.]))/;
/** 把 CSS 切成 {selector, decls}。只服务这一条判据，不是完整解析器 */
function cssRules(text) {
  const out = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({
      selector: m[1].replace(/\s+/g, " ").trim(),
      decls: m[2],
      line: text.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}
/** 剥掉注释但保留行号（注释里提到被禁写法是正常说明） */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => (m.includes("://") ? m : `${p1}${" ".repeat(m.length - p1.length)}`));
}
const files = walk("src").filter((f) => /\.(css|tsx|ts)$/.test(f));
for (const f of files) {
  const norm = f.replace(/\\/g, "/");
  if (ALLOW.has(norm)) continue;
  const text = stripComments(readFileSync(f, "utf8"));
  text.split("\n").forEach((line, i) => {
    if (line.includes("stylelint-disable")) return;
    for (const [re, why] of rules) {
      if (re.test(line)) fail.push(`${norm}:${i + 1} ${why} → ${line.trim().slice(0, 72)}`);
    }
  });
  // 每条"去掉描边"的声明，必须在**同一个选择器**（可带 ::before/::after 后缀）上找到
  // 另一种可见指示，否则判红。
  if (NO_RING.test(text)) {
    const all = cssRules(text);
    for (const r of all) {
      if (!NO_RING.test(r.decls)) continue;
      const ok = all.some(
        (o) =>
          o !== r &&
          o.selector.split(",").some((s) => s.trim().startsWith(r.selector)) &&
          POSITIVE.test(o.decls),
      );
      if (!ok) {
        fail.push(
          `${norm}:${r.line} 选择器「${r.selector}」去掉了描边，但同一个选择器上没有替代焦点指示（[06] §4）`,
        );
      }
    }
  }
  if (norm.endsWith(".css") && norm !== "src/ui/tokens.css") {
    const t = stripComments(readFileSync(f, "utf8"));
    if (/--[\w-]+\s*:\s*(#|oklch|rgb|hsl)/i.test(t)) {
      fail.push(`${norm} 定义了颜色字面量 token，颜色只能出自 tokens.css`);
    }
  }
}

if (fail.length) {
  console.error("护栏未通过：\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log(`护栏通过：依赖方向 ✓ 预算键 ✓ 样式禁止清单 ✓（扫了 ${files.length} 个前端文件）`);
