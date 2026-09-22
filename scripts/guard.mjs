// CI 护栏：三件事必须在每次提交前成立。成本极低，但不做就会慢慢烂掉。
// 1) 依赖方向：note-core / md-kernel / note-cli 不许链接 Tauri，md-kernel 不许链接 SQLite
// 2) perf-budget.json 的键必须齐，且与 docs/03 §性能预算 对得上
// 3) 样式禁止清单（docs/06 §4）：字面量颜色、裸 z-index、transition:all、去掉焦点环、联网取字体
import { readFileSync, readdirSync, statSync } from "node:fs";
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
  [/outline\s*:\s*none|outline-none/, "去掉了焦点环，键盘用户会失去定位"],
  [/https?:\/\/(?!127\.0\.0\.1|localhost)[^\s'"`)]*\.(?:woff2?|js|css)\b/, "联网取字体/脚本"],
  [/animate-\[[^\]]*(?:width|height|top|left|margin|padding)/, "动画布局属性"],
];
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
