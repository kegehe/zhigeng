import hljs from "highlight.js/lib/core";

// 按需注册：`highlight.js/lib/core` 只带引擎，语言一个一个引。整包（190 多种）会把首屏
// 的 JS 撑大一截，而笔记里真出现的语言就这些。加语言 = 加一行 import + 一处别名。
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import dos from "highlight.js/lib/languages/dos"; // bat / cmd 的模块名是 dos
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * 代码块的**着色层**（docs/03 §块渲染）。
 *
 * 三条边界，都是这个仓库的纪律逼出来的：
 *
 * 1. **只活在显示形里**。序列化读 `mdRaw` 与节点正文，永远不读这里产出的 DOM——
 *    着色画错最坏是"看着不对"，绝不许"落盘不对"。源文本形（光标进来改源码那一面）
 *    不着色：那条路要走 PM 装饰，3000 块的预算得重测，而改代码时看的是字不是颜色。
 * 2. **产出必须过白名单**。highlight.js 给的是 HTML 串（`<span class="hljs-…">`，正文它自己转义）。
 *    我们整条显示形是 DOM 构造的，`innerHTML` 一进来就是另一套规矩：所以解析一遍，
 *    **只留 `span.hljs-*` 与文本**，其余节点一律降级成文字（降级而不是丢——藏内容比画错更糟）。
 * 3. **认不准就不着色**（返回 null，调用方回落到纯文本）。未知语言、超长输入都走这条路。
 */

const 注册 = (name: string, fn: Parameters<typeof hljs.registerLanguage>[1]) =>
  hljs.registerLanguage(name, fn);

注册("bash", bash);
注册("dos", dos); // 下拉里叫"Batch"（别名 bat / cmd），模块名是 dos
注册("c", cpp); // hljs 的 cpp 方言覆盖 C
注册("cpp", cpp);
注册("css", css);
注册("diff", diff);
注册("dockerfile", dockerfile);
注册("go", go);
注册("ini", ini);
注册("java", java);
注册("javascript", javascript);
注册("json", json);
注册("kotlin", kotlin);
注册("lua", lua);
注册("markdown", markdown);
注册("php", php);
注册("plaintext", plaintext);
注册("powershell", powershell);
注册("python", python);
注册("ruby", ruby);
注册("rust", rust);
注册("scss", scss);
注册("sql", sql);
注册("swift", swift);
注册("typescript", typescript);
注册("xml", xml);
注册("yaml", yaml);

/**
 * 围栏 info 串里常见、而 **hljs 自带别名表里实测没有**的写法（`zsh` / `golang` / `toml` /
 * `ps1` / `md` 那些它自己就认，别在这儿重复——重复的条目会让人以为"改这张表就够了"）。
 * `语言of` 先查这张表，再原样交给 hljs。
 */
const 额外别名: Record<string, string> = {
  shell: "bash",
  console: "bash",
  htm: "xml",
  vue: "xml",
  conf: "ini",
  cfg: "ini",
  env: "ini",
  mdx: "markdown",
  sass: "scss",
  csharp: "cpp", // 没引 csharp 方言，先按 C 系着色：关键字大部分对得上，认不准的只是少数
  objc: "cpp",
  "objective-c": "cpp",
};

/** 明确"就是纯文本"的写法：不着色，也别退化成"猜一门语言" */
const 拒绝着色 = new Set(["text", "txt", "plain", "raw"]);

/**
 * 下拉里能选的值。写进文件的就是这一列词（都是 hljs 认得的别名，实测过一遍），
 * 所以"选得出来的"与"上得了色的"是同一份清单——列一个上不了色的语言等于给用户一个摆设。
 * `""` 是把开栏改回光秃秃的 ` ``` `，`text` 是明确声明"这就是纯文本，别猜"。
 */
export const 语言清单: { 值: string; 标签: string }[] = [
  { 值: "", 标签: "无（保持 ``` 不带语言）" },
  { 值: "text", 标签: "纯文本（不猜语言）" },
  { 值: "js", 标签: "JavaScript" },
  { 值: "ts", 标签: "TypeScript" },
  { 值: "py", 标签: "Python" },
  { 值: "rs", 标签: "Rust" },
  { 值: "go", 标签: "Go" },
  { 值: "java", 标签: "Java" },
  { 值: "kotlin", 标签: "Kotlin" },
  { 值: "swift", 标签: "Swift" },
  { 值: "c", 标签: "C" },
  { 值: "cpp", 标签: "C++" },
  { 值: "php", 标签: "PHP" },
  { 值: "rb", 标签: "Ruby" },
  { 值: "lua", 标签: "Lua" },
  { 值: "bash", 标签: "Shell / Bash" },
  { 值: "ps1", 标签: "PowerShell" },
  { 值: "dos", 标签: "Batch / 命令行批处理" },
  { 值: "sql", 标签: "SQL" },
  { 值: "json", 标签: "JSON" },
  { 值: "yml", 标签: "YAML" },
  { 值: "toml", 标签: "TOML / ini" },
  { 值: "html", 标签: "HTML / XML" },
  { 值: "css", 标签: "CSS" },
  { 值: "scss", 标签: "SCSS" },
  { 值: "md", 标签: "Markdown" },
  { 值: "diff", 标签: "Diff" },
  { 值: "dockerfile", 标签: "Dockerfile" },
];

/**
 * **猜**一门语言：给没有 info 串（或 info 认不出来）的代码块。
 *
 * 三条限制都是实测出来的，不是洁癖：
 * - `highlightAuto` 要在注册表里逐门跑一遍，实测 30 行 9ms、120 行 38ms，是指定语言的
 *   十倍。所以它**不进击键路径、也不进装载路径**——调用方只在"这块交出焦点"与"这块要
 *   落盘"两个时机用它（见 `blocks.ts` 的 `有效开栏` 与 `schema.ts` 的 `CodeHighlight`）。
 * - 太短、单行的不猜：实测 `a=1` 会被判成 `ini`，把这种猜测写进用户文件比不写更糟。
 * - 认不出来给 null（`highlightAuto` 落回纯文本时 `language` 就是 undefined），调用方
 *   保持原样，不许编一门语言出来。
 */
const 识别缓存 = new Map<string, string | null>();
const 最短 = 24;
const 识别上限 = 6000;

export function 识别(代码: string): string | null {
  if (代码.length < 最短 || 代码.length > 识别上限) return null;
  if (!代码.includes("\n")) return null; // 单行没有结构可猜，全是噪声
  const 中 = 识别缓存.get(代码);
  if (中 !== undefined) return 中;
  let 得: string | null;
  try {
    const 候 = hljs.highlightAuto(代码, 语言清单.map((l) => l.值).filter(Boolean));
    得 = 候.language && hljs.getLanguage(候.language) ? 候.language : null;
  } catch {
    得 = null;
  }
  if (识别缓存.size > 400) 识别缓存.delete(识别缓存.keys().next().value as string);
  识别缓存.set(代码, 得);
  return 得;
}

/**
 * 只读缓存，不计算：`undefined` = 还没猜过。
 *
 * 语言牌在装载时要显示"将要落盘的那个词"，但装载不是跑 `highlightAuto` 的地方（十倍成本）。
 * 装饰路径先算、牌后读，两边读的是同一份缓存，所以显示与落盘不可能分叉。
 */
export function 已识别(代码: string): string | null | undefined {
  return 识别缓存.get(代码);
}

/** 下拉里写进文件的那个词 → 它到底认不认（认不了的选项不该存在） */
export const 认得语言 = (词: string): boolean => Boolean(词) && Boolean(语言of(词));

/**
 * hljs 的规范名 → 清单里那个**短写**（`javascript` → `js`、`python` → `py`）。
 *
 * 识别给出的是规范名，而文件里、下拉里用的是短写。不映射的话会出现"识别写了
 * ` ```javascript `，下拉框却对不上任何选项"——一个说不清自己状态的控件比没有控件更糟。
 */
const 短写表 = new Map<string, string>();
for (const l of 语言清单) {
  if (!l.值) continue;
  const 范 = 语言of(l.值);
  if (范 && !短写表.has(范)) 短写表.set(范, l.值);
}
export const 短写 = (语言: string): string => 短写表.get(语言) ?? 语言;

/** info 串第一个词 → hljs 的语言名。认不出来给 null */
export function 语言of(info: string | undefined | null): string | null {
  const 首 = (info ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!首 || 拒绝着色.has(首)) return null;
  const 名 = 额外别名[首] ?? 首;
  return hljs.getLanguage(名) ? 名 : null;
}

/**
 * 一坨代码的着色上限。显示形的重画发生在"块交出焦点"那一刻（不在击键路径上），
 * 而 highlight.js 是同步的：一篇里塞一个几万行的大日志，着色就会把主线程钉住、
 * 让那一拍掉帧。超了就不着色——宁可平白，不可卡。
 */
const 最长 = 20_000;

const 是着色类 = (类: string) => 类.split(/\s+/).every((c) => !c || c.startsWith("hljs-"));

/** 把 hljs 的 HTML 串搬成节点，只认 `span.hljs-*` 与文本；别的元素连它的文字一起留成文本 */
function 搬进(源: Node, 到: Node, d: Document) {
  for (const 子 of Array.from(源.childNodes)) {
    if (子.nodeType === Node.TEXT_NODE) {
      到.appendChild(d.createTextNode(子.textContent ?? ""));
      continue;
    }
    const 元 = 子 as HTMLElement;
    if (元.tagName === "SPAN" && 是着色类(元.className)) {
      const 新 = d.createElement("span");
      新.className = 元.className;
      搬进(元, 新, d);
      到.appendChild(新);
      continue;
    }
    // 不认识的结构：整棵子树的文字照原样留下。宁可少一层颜色，不许少一个字
    到.appendChild(d.createTextNode(子.textContent ?? ""));
  }
}

/**
 * 给一段代码着色。返回 null = 不着色（未知语言、空、超长），调用方回落到纯文本节点。
 *
 * `ignoreIllegals` 是必须的：hljs 默认在语法模式匹配失败时抛异常，而我们的输入是
 * 用户写的任何东西（半截代码、乱码、超长正则都算），抛一次就是那一块画不出来。
 */
export function 着色(
  d: Document,
  语言: string | null,
  代码: string
): DocumentFragment | null {
  if (!语言 || !代码.trim()) return null;
  if (代码.length > 最长) return null;
  const 区间 = 分段(语言, 代码);
  if (!区间) return null;
  const 片 = d.createDocumentFragment();
  搬进(new DOMParser().parseFromString(区间.html, "text/html").body, 片, d);
  return 片;
}

export type 着色区间 = { 起: number; 止: number; 类: string };

/**
 * 代码里每一段"该上色的文字"在**原文里的偏移**。装饰器要的是这个，不是节点：
 * ProseMirror 的可编辑那一面由 PM 自己拼 DOM，我们只能给它 `Decoration.inline`。
 *
 * 顺带一条安全事实：这条路上 hljs 的 HTML 只被读成"偏移 + 类名"，**永远不进 DOM**，
 * 所以它连注入元素的机会都没有——最坏是类名奇怪，而类名过 `是着色类` 的白名单。
 * 认不出语言 / 空 / 超长都给空表（= 不着色，不是画错）。
 */
export function 着色区间(语言: string | null, 代码: string): 着色区间[] {
  return (语言 && 代码.trim() && 代码.length <= 最长 && 分段(语言, 代码)?.区间) || [];
}

/** 缓存：一次按键只重新分词被改到的那一块。上限是防着一篇里滚过几百个代码块把内存吃掉 */
const 缓存 = new Map<string, { html: string; 区间: 着色区间[] }>();
const 缓存上限 = 200;

/** 分一次词，HTML 与偏移一起出（两条路共用同一次分词，两边才不会分叉） */
function 分段(语言: string, 代码: string): { html: string; 区间: 着色区间[] } | null {
  const 键 = 语言 + "\u0000" + 代码;
  const 中 = 缓存.get(键);
  if (中) return 中;
  let 出: { html: string; 区间: 着色区间[] };
  try {
    const r = hljs.highlight(代码, { language: 语言, ignoreIllegals: true });
    出 = { html: r.value, 区间: 区间of(r.value) };
  } catch {
    return null;
  }
  if (缓存.size >= 缓存上限) 缓存.delete(缓存.keys().next().value as string);
  缓存.set(键, 出);
  return 出;
}

/** 把 hljs 的 HTML 走一遍，累计出每段带类文字的原文偏移 */
function 区间of(html: string): 着色区间[] {
  const 果: 着色区间[] = [];
  let 偏 = 0;
  const 走 = (父: Node, 承类: string) => {
    for (const 子 of Array.from(父.childNodes)) {
      if (子.nodeType === Node.TEXT_NODE) {
        const 文 = 子.textContent ?? "";
        if (文 && 承类) 果.push({ 起: 偏, 止: 偏 + 文.length, 类: 承类 });
        偏 += 文.length;
        continue;
      }
      const 元 = 子 as HTMLElement;
      if (元.tagName !== "SPAN" || !是着色类(元.className)) {
        偏 += 子.textContent?.length ?? 0;
        continue;
      }
      走(元, 承类 ? 承类 + " " + 元.className : 元.className);
    }
  };
  走(new DOMParser().parseFromString(html, "text/html").body, "");
  return 果;
}
