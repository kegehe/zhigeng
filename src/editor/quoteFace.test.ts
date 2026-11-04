import { describe, expect, it } from "vitest";
import { 拼引用, 引用账本, 续行缀 } from "./quoteFace";

describe("引用账本：点进去的正文和看着的是同一段", () => {
  it("普通引用剥掉 > ，拼回去一字不差", () => {
    const 源 = "> 普通引用的第一行。\n> 第二行。";
    const 账 = 引用账本(源, "quote", null);
    expect(账).not.toBeNull();
    expect(账!.身).toBe("普通引用的第一行。\n第二行。");
    expect(账!.缀).toEqual(["> ", "> "]);
    expect(拼引用(账!.缀, 账!.身, 账!.锚)).toBe(源);
  });

  it("行尾块锚摘出正文，拼回去仍在原来的位置", () => {
    const 源 = "> 第二行，块 ID 写在引用内部。 ^b-x1y2z3a4b5";
    const 账 = 引用账本(源, "quote", "b-x1y2z3a4b5");
    expect(账!.身).toBe("第二行，块 ID 写在引用内部。");
    expect(账!.锚).toBe(" ^b-x1y2z3a4b5");
    expect(拼引用(账!.缀, 账!.身, 账!.锚)).toBe(源);
  });

  it("Callout 的 [!type] 留在前缀里，标题才是正文", () => {
    const 源 = "> [!question] 打扰预算是多少？\n> 一天超过 3 次就该停。 ^b-c6d9f2g5h8";
    const 账 = 引用账本(源, "callout", "b-c6d9f2g5h8");
    expect(账!.缀[0]).toBe("> [!question] ");
    expect(账!.身.startsWith("打扰预算是多少？")).toBe(true);
    expect(账!.身).not.toContain("[!question]");
    expect(账!.身).not.toContain("^b-");
    expect(拼引用(账!.缀, 账!.身, 账!.锚)).toBe(源);
  });

  it("懒惰续行没有前缀，不能给它补一个 >", () => {
    const 源 = "> 懒惰续行\n仍然属于上面这个引用。";
    const 账 = 引用账本(源, "quote", null);
    expect(账!.缀).toEqual(["> ", ""]);
    expect(账!.身).toBe("懒惰续行\n仍然属于上面这个引用。");
    expect(拼引用(账!.缀, 账!.身, "")).toBe(源);
  });

  it("CRLF 的 \\r 留在正文行上，拼回去还是 CRLF", () => {
    const 源 = "> 甲\r\n> 乙\r";
    const 账 = 引用账本(源, "quote", null);
    expect(拼引用(账!.缀, 账!.身, 账!.锚)).toBe(源);
  });

  it("多出来的一行沿用普通 > ，不复制 Callout 标题", () => {
    const 缀 = ["> [!note] ", "> "];
    expect(续行缀(缀)).toBe("> ");
    expect(拼引用(缀, "标题\n正文\n新的一行", "")).toBe(
      "> [!note] 标题\n> 正文\n> 新的一行",
    );
  });

  it("一行都没有 > 就不接管", () => {
    expect(引用账本("这不是引用", "quote", null)).toBeNull();
  });
});
