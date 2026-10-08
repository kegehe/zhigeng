import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EditDoc } from "../ipc/types";
import { 语言of } from "./highlight";
import { mightRender, renderOpaque } from "./render";

/**
 * 显示形的单测。
 *
 * 这里**不测字节**——字节归 `roundtrip.test.ts`，那才是红线。本文件只回答一件事：
 * 给一段源文本，画出来的东西对不对、该降级的地方有没有降级成源文本。
 */

const r = (kind: string, src: string) => renderOpaque(kind, src, document);
/** 代码块的文字在 `<code>` 里（外层还挂着语言标签），其余类型读整块 */
const text = (k: string, s: string) => {
  const n = r(k, s);
  if (!n) return null;
  return (n.querySelector("code") ?? n).textContent;
};
/** querySelector 只给 Element，读 dataset 要具体一点 */
const q = <T extends HTMLElement>(n: Element | null | undefined, sel: string) =>
  (n?.querySelector(sel) ?? null) as T | null;

describe("显示形：分隔线 / 引用 / Callout", () => {
  it("--- 画成 hr，-- 不是分隔线", () => {
    expect(r("divider", "---")?.tagName).toBe("HR");
    expect(r("divider", "***")?.tagName).toBe("HR");
    expect(r("divider", "___")?.tagName).toBe("HR");
    expect(r("divider", "-- 不是分隔线")).toBeNull();
  });

  it("引用剥掉 > 前缀，懒惰续行留在同一段里", () => {
    const q = r("quote", "> 懒惰续行\n仍然属于上面这个引用。");
    expect(q?.tagName).toBe("BLOCKQUOTE");
    expect(q?.querySelectorAll("p")).toHaveLength(1);
    expect(q?.textContent).toBe("懒惰续行仍然属于上面这个引用。");
    expect(q?.innerHTML).not.toContain("&gt;");
  });

  it("引用里嵌列表 → 段落 + ul", () => {
    const q = r("quote", "> 引用里嵌列表：\n>\n> - 甲\n> - 乙");
    expect(q?.querySelector("p")?.textContent).toBe("引用里嵌列表：");
    expect([...(q?.querySelectorAll("li") ?? [])].map((n) => n.textContent)).toEqual(["甲", "乙"]);
  });

  it("嵌套引用只吃连续那几行，后面的外层内容留在外层", () => {
    // 复查时抓到的：原先遇到 `>` 就 slice 到结尾并 return，"外层乙"被画进了内层
    const q = r("quote", "> 外层甲\n>\n> > 内层\n>\n> 外层乙");
    const 内层 = q!.querySelectorAll("blockquote");
    expect(内层).toHaveLength(1);
    expect(内层[0]!.textContent).toBe("内层");
    expect([...q!.querySelectorAll(":scope > p")].map((p) => p.textContent)).toEqual([
      "外层甲",
      "外层乙",
    ]);
  });

  it("行内语法在显示形里被解开，不留 ** 与 `[[`", () => {
    const q = r("quote", "> 注意 **重点** 与 `code`，见 [[检索策略#^b-m2n5p8r1ic]]");
    expect(q?.querySelector("strong")?.textContent).toBe("重点");
    expect(q?.querySelector("code")?.textContent).toBe("code");
    expect(q?.querySelector(".wikilink")?.textContent).toBe("检索策略");
    expect(q?.textContent).not.toContain("**");
    expect(q?.textContent).not.toContain("[[");
  });

  it("Callout 出类型与标题，正文另起", () => {
    const c = r("callout", "> [!question] 打扰预算是多少？\n> 一天超过 3 次推送就应该收敛策略。");
    expect(c?.dataset["callout"]).toBe("question");
    expect(c?.querySelector(".cal-title")?.textContent).toBe("打扰预算是多少？");
    expect(c?.querySelector(".cal-body p")?.textContent).toBe("一天超过 3 次推送就应该收敛策略。");
  });

  it("折叠 Callout 带 data-folded，未折叠的不带", () => {
    expect(r("callout", "> [!note]- 折叠的提示\n> 内容")?.dataset["folded"]).toBe("1");
    expect(r("callout", "> [!note] 不折叠\n> 内容")?.dataset["folded"]).toBeUndefined();
  });

  it("块 ID 不进显示形：末行尾巴与独占一行都剥掉", () => {
    expect(text("quote", "> 普通引用的第一行。 ^b-x1y2z3a4b5")).toBe("普通引用的第一行。");
    expect(text("code", "```\n甲\n```\n^b-f3g6j9l2mn")).toBe("甲");
    expect(text("divider", "---\n^b-f3g6j9l2mn")).toBe("");
  });

  it("不是 Callout 的首行就降级回源文本", () => {
    expect(r("callout", "> [!note 少了右括号\n> 内容")).toBeNull();
  });
});

describe("显示形：代码 / 表格 / 公式 / 资产", () => {
  it("围栏里的空行与伪语法都留在正文里", () => {
    const box = r(
      "code",
      '```rust\nfn main() {\n    println!("你好");\n\n    // --- 这行不是分隔线\n}\n```',
    );
    expect(box?.querySelector(".lang")?.textContent).toBe("rust");
    const 体 = box?.querySelector("code")?.textContent ?? "";
    expect(体).toContain("// --- 这行不是分隔线");
    expect(体).toContain("\n\n");
    expect(体).not.toContain("```");
  });

  it("开栏的 info 串带空格也认：语言取第一个词，注释留在原地", () => {
    // 真机抓的：用户在 ```rust 后面加了一句 `// 标记`，旧正则按"一个词"匹配 info，
    // 整块静默退回源文本——看着像渲染坏了，其实是渲染器不认合法的 info 串
    const box = r("code", "```rust // 一个注释\n甲\n```");
    expect(box?.querySelector(".lang")?.textContent).toBe("rust");
    expect(box?.querySelector("code")?.textContent).toBe("甲");
    expect(r("code", "```js showLineNumbers\n甲\n```")?.querySelector(".lang")?.textContent).toBe(
      "js",
    );
  });

  it("闭栏不许带 info；反引号围栏的 info 里不许有反引号", () => {
    // 带 info 的那一行按 CommonMark 不是闭栏，它是正文的一部分
    expect(text("code", "```\n甲\n``` 带说明")).toBe("甲\n``` 带说明");
    expect(r("code", "```a`b\n甲\n```")).toBeNull();
  });

  it("波浪号围栏与无语言围栏都画得出来；不短于开栏才算闭栏", () => {
    expect(text("code", "~~~\n波浪号围栏。\n~~~")).toBe("波浪号围栏。");
    // 开栏四个反引号、闭栏三个：三个那个不是闭栏，它是正文的一部分
    expect(text("code", "````\n甲\n```\n````")).toBe("甲\n```");
    // 没闭栏：CommonMark 与内核都判"到文末都是代码"，那就照画
    expect(text("code", "```rs\n没有闭栏")).toBe("没有闭栏");
  });

  it("认得的语言出 span，但**文字必须逐字不变**", () => {
    const 源 = "```js\nconst a = 1; // 注释\n```";
    const box = r("code", 源);
    const 码 = box?.querySelector("code");
    expect(码?.querySelectorAll("span").length ?? 0).toBeGreaterThan(0);
    // 着色只是加一层 span：文字与不分词时一模一样，一个字符都不许多不许少
    expect(码?.textContent).toBe("const a = 1; // 注释");
    // class 上带的是**用户自己写的那个词**（`js`），不是 hljs 的规范名——与语言牌同源，
    // 两处都别替用户改口径
    expect(码?.className).toBe("language-js");
    expect(box?.querySelector(".lang")?.textContent).toBe("js");
  });

  it("函数名与类名必须拿到颜色：hljs 的分层 scope 不许被白名单吃掉", () => {
    /**
     * hljs 11 把 `title.function_` 这样的分层 scope 吐成**两个类**（`class="hljs-title function_"`，
     * 只有第一段带前缀）。白名单从前要求"每个词都以 `hljs-` 开头"，于是整个 span 被判死——
     * 函数名与类名一个都不上色，而这正是"按语言显示不同样式"最显眼的一批。
     * 实测 py / js / rs / java 全中，`go` 因为用裸 `hljs-title` 反而躲过了这一刀。
     */
    for (const [语, 文, 词] of [
      ["py", "def greet(name):\n    return name", "greet"],
      ["js", "function add(a, b) {\n  return a;\n}", "add"],
      ["rs", "fn main() {\n    let x = 1;\n}", "main"],
      ["java", "class App {\n  void run() {}\n}", "run"],
    ] as const) {
      const 码 = r("code", `\`\`\`${语}\n${文}\n\`\`\``)?.querySelector("code");
      const 命中 = [...(码?.querySelectorAll("span") ?? [])].find(
        (s) => s.textContent?.includes(词) && s.className.includes("hljs-title")
      );
      expect(命中, `${语} 的 ${词} 没拿到 hljs-title`).toBeTruthy();
      // 第二段被补进我们自己的命名空间：类名一律 `hljs-` 开头，撞不上工具类
      expect(命中!.className.split(/\s+/).every((c) => /^hljs-[\w-]+$/.test(c)), 命中!.className).toBe(true);
      expect(命中!.className).toMatch(/hljs-(function_|class_)/);
    }
  });

  it("子语言（HTML 里的 script）也得上色，文字仍然逐字不变", () => {
    const 源 = '```html\n<div id="a"><script>var x = 1;</script></div>\n```';
    const 码 = r("code", 源)?.querySelector("code");
    expect(码?.textContent).toBe('<div id="a"><script>var x = 1;</script></div>');
    expect(
      [...(码?.querySelectorAll("span") ?? [])].some((s) => s.className.includes("hljs-keyword")),
      "script 里的 var 该按 js 上色"
    ).toBe(true);
  });

  it("未知语言不着色、也不许顺手猜一门：正文照旧全在", () => {
    const 码 = r("code", "```klingon\nnuqDotlh\n```")?.querySelector("code");
    expect(码?.querySelectorAll("span")).toHaveLength(0);
    expect(码?.textContent).toBe("nuqDotlh");
    expect(码?.className).toBe("");
    // text / txt 是"我就是要纯文本"，即便 hljs 有 plaintext 方言也不着色
    expect(r("code", "```text\nconst a = 1;\n```")?.querySelector("code")?.querySelector("span")).toBeNull();
  });

  it("代码内容长得像 HTML 也只能是文字（着色层的注入面）", () => {
    const 源 = '```html\n<img src=x onerror=alert(1)>\n<div class="a">&amp;</div>\n```';
    const 码 = r("code", 源)?.querySelector("code");
    expect(码?.querySelector("img")).toBeNull();
    expect(码?.querySelector("div")).toBeNull();
    // highlight.js 自己会转义正文，白名单再兜一道：只可能多出 span，不可能多出别的元素
    expect(码?.textContent).toBe('<img src=x onerror=alert(1)>\n<div class="a">&amp;</div>');
    expect(码?.innerHTML).not.toMatch(/<(?!\/?span)/);
  });

  it("超长代码不着色：宁可平白，不可把那一拍钉住", () => {
    const 长 = "x".repeat(20_001);
    const 码 = r("code", "```js\n" + 长 + "\n```")?.querySelector("code");
    expect(码?.querySelectorAll("span")).toHaveLength(0);
    expect(码?.textContent).toBe(长);
  });

  it("info 首词 → 语言名：我们自己那张表补的是 hljs 实测不认的写法", () => {
    expect(语言of("shell")).toBe("bash");
    expect(语言of("htm")).toBe("xml");
    expect(语言of("env")).toBe("ini");
    expect(语言of("mdx")).toBe("markdown");
    expect(语言of("csharp")).toBe("cpp");
    // hljs 自带别名（js / rs / golang / toml / zsh）原样交给它，认得出就留着那个词
    for (const 写 of ["js", "ts", "py", "rs", "golang", "toml", "zsh", "html", "yml"]) {
      expect([写, 语言of(写)]).toEqual([写, 写]);
    }
    expect(语言of("")).toBeNull();
    expect(语言of(undefined)).toBeNull();
    expect(语言of("不存在的语言")).toBeNull();
    expect(语言of("text")).toBeNull();
  });

  it("表格出 thead/tbody，对齐按分隔行，转义竖线不算分隔符", () => {
    const t = r(
      "table",
      "| 列 A | 列 B |\n|:---|---:|\n| 1 | 2 |\n| 含 `内联码` 与 [[链接]] | 竖线 \\| 转义 |",
    );
    expect(t?.tagName).toBe("TABLE");
    expect([...(t?.querySelectorAll("thead th") ?? [])].map((n) => n.textContent)).toEqual([
      "列 A",
      "列 B",
    ]);
    expect(q<HTMLTableCellElement>(t, "thead th")?.dataset["align"]).toBe("left");
    expect(t?.querySelectorAll("tbody tr")).toHaveLength(2);
    const 末行 = [...(t?.querySelectorAll("tbody tr") ?? [])][1]!;
    expect(末行.querySelectorAll("td")[1]?.textContent).toBe("竖线 | 转义");
    expect(末行.querySelectorAll("td")[0]?.querySelector("code")?.textContent).toBe("内联码");
    expect(末行.querySelectorAll("td")[0]?.querySelector(".wikilink")?.textContent).toBe("链接");
  });

  it("没有分隔行的表画不出来，退回源文本", () => {
    expect(r("table", "| 甲 | 乙 |")).toBeNull();
    expect(r("table", "| 甲 | 乙 |\n| 不是 | 分隔 |")).toBeNull();
  });

  it("公式只剥掉 $$ 围栏，不假装会排 TeX", () => {
    expect(text("math", "$$\nE = mc^2\n$$")).toBe("E = mc^2");
    expect(text("math", "$$E = mc^2$$")).toBe("E = mc^2");
    expect(r("math", "E = mc^2")).toBeNull();
  });

  it("资产与嵌入显示成文件名，不去加载本地路径", () => {
    const a = r("embed", "![[attachments/a3/a3f9c1e2.png]]");
    expect(a?.classList.contains("asset")).toBe(true);
    expect(a?.dataset["kind"]).toBe("embed");
    expect(a?.textContent).toBe("a3f9c1e2.png");
    expect(a?.querySelector("img")).toBeNull();
    expect(r("image", "![](attachments/甲.png) 之后的文字")?.textContent).toBe("甲.png");
  });
});

describe("显示形的降级面", () => {
  it("画不来的类型一律 null / mightRender=false", () => {
    for (const kind of ["html", "raw", "paragraph", "heading", "bullet", "numbered", "todo"]) {
      expect(renderOpaque(kind, "任意源文本", document)).toBeNull();
      expect(mightRender(kind)).toBe(false);
    }
  });

  it("带子项的列表项不画：它的正文是整棵嵌套树，画了就得改序列化口径（D22）", () => {
    expect(mightRender("bullet")).toBe(false);
    expect(renderOpaque("bullet", "- 甲\n  - 乙", document)).toBeNull();
  });

  it("再怪的输入也不许抛：渲染挂过一次就不能连累正文显示", () => {
    const 怪 = [
      ["quote", ""],
      ["table", "|\n|\n|"],
      ["code", "````"],
      ["callout", ">"],
      ["math", "$$"],
      ["divider", "\n\n"],
      ["embed", "![[|]]"],
      ["table", "||"],
    ] as const;
    for (const [kind, src] of 怪) expect(() => renderOpaque(kind, src, document)).not.toThrow();
  });

  it("真夹具里该画的块都画得出来", () => {
    for (const name of ["01-基础", "03-代码表格与公式", "04-引用与标注", "06-插入骨架"]) {
      const doc = JSON.parse(readFileSync(`testdata/editdoc/${name}.json`, "utf8")) as EditDoc;
      const 该画的 = doc.blocks.filter((b) => mightRender(b.kind));
      expect(该画的.length, name).toBeGreaterThan(0);
      for (const b of 该画的) {
        const 源 = b.raw.replace(/\n+$/, "");
        const 画 = renderOpaque(b.kind, 源, document);
        const 位 = `${name} / ${b.kind} / ${源.slice(0, 24)}`;
        // 内核判成这个类型的块，显示形不该把它降级成源文本；降级了就是漏了某种写法
        expect(画, 位).not.toBeNull();
        // 语法记号与锚点不许漏进显示形
        for (const 记号 of ["```", "~~~", "^b-", "$$", "> "]) expect(画!.textContent, 位).not.toContain(记号);
        // 有内容的块不许画成空。分隔线本来就是零文字，06 的引用骨架源文本也是空的
        if (b.kind !== "divider" && 源.replace(/[>\s|^`*_-]/g, ""))
          expect(画!.textContent!.trim().length, 位).toBeGreaterThan(0);
      }
    }
  });

  it("未识别语法不许被画成别的东西：它必须继续显示源文本", () => {
    const doc = JSON.parse(
      readFileSync("testdata/editdoc/05-未识别语法.json", "utf8"),
    ) as EditDoc;
    const 不认识的 = doc.blocks.filter((b) => !mightRender(b.kind) && b.kind !== "paragraph");
    expect(不认识的.length).toBeGreaterThan(0);
    for (const b of 不认识的) {
      expect(mightRender(b.kind)).toBe(false);
      expect(renderOpaque(b.kind, b.raw, document)).toBeNull();
    }
  });
});
