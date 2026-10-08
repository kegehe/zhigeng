import hljs from "highlight.js/lib/core";

// 按需注册：`highlight.js/lib/core` 只带引擎，语言一个一个引。整包（190 多种）会把首屏
// 的 JS 撑大一截，而笔记里真出现的语言就这些。加语言 = 加一行 import + 一处别名。
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
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
  let 值: string;
  try {
    值 = hljs.highlight(代码, { language: 语言, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
  const 片 = d.createDocumentFragment();
  搬进(new DOMParser().parseFromString(值, "text/html").body, 片, d);
  return 片;
}
