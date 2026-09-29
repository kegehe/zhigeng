import { describe, expect, it } from "vitest";
import { 补新建, 匹配, type Matchable, type PaletteItem } from "./palette";

/** 命令面板的排序是"打字 → 出结果"这件事的全部，只能钉在测试里 */
const 项 = (label: string, hint?: string): Matchable & { id: string } => ({ id: label, label, hint });

describe("命令面板匹配", () => {
  const 候选 = [
    项("回收站", "打开回收站"),
    项("检索策略", "notes/ai-native/检索策略.md"),
    项("主动层设计", "notes/ai-native/主动层设计.md"),
    项("我的笔记", "notes/我的笔记.md"),
    项("某笔记", "notes/回收/某笔记.md"),
  ];

  it("空查询保持原序，不重新排", () => {
    expect(匹配("", 候选).map((c) => c.label)).toEqual(候选.map((c) => c.label));
  });

  it("上限截断，但截的是原序的前 N 条", () => {
    expect(匹配("", 候选, 2).map((c) => c.label)).toEqual(["回收站", "检索策略"]);
  });

  it("中文按连续子串命中", () => {
    expect(匹配("检索", 候选).map((c) => c.label)).toEqual(["检索策略"]);
  });

  it("label 的命中压过 hint：搜「回收」先出回收站，不是路径里带回收的笔记", () => {
    const 出 = 匹配("回收", 候选).map((c) => c.label);
    expect(出).toEqual(["回收站", "某笔记"]);
  });

  it("全等最优，命中越靠前越好", () => {
    const 出 = 匹配("笔记", [...候选, 项("笔记")]).map((c) => c.label);
    expect(出[0]).toBe("笔记");
    // 某笔记（第 2 字起）比 我的笔记（第 3 字起）靠前
    expect(出).toEqual(["笔记", "某笔记", "我的笔记"]);
  });

  it("前缀命中优于子序列；大小写不敏感", () => {
    const 拉丁 = [项("Search Bar", "sb"), 项("Sidebar"), 项("Settings")];
    // Sidebar 是 s-i-d-e... 不是 se 前缀，只能靠子序列凑，所以排在 Settings 后面
    expect(匹配("se", 拉丁).map((c) => c.label)).toEqual(["Search Bar", "Settings", "Sidebar"]);
    expect(匹配("SE", 拉丁).length).toBe(3);
    // srch 是子序列（s-r-c-h 都在 Search Bar 里，但不连续）
    expect(匹配("srch", [项("Search Bar")]).length).toBe(1);
  });

  it("凑不齐字符的排除掉", () => {
    expect(匹配("zzz", 候选)).toEqual([]);
  });

  it("同分保持原序（稳定）", () => {
    const 同 = [项("甲一"), 项("乙一"), 项("丙一")];
    expect(匹配("一", 同).map((c) => c.label)).toEqual(["甲一", "乙一", "丙一"]);
  });
});

describe("补新建：打字没找到才给的那一条", () => {
  const 命令 = (label: string): PaletteItem => ({ id: label, group: "笔记", label, run: () => {} });

  it("有任意命中就不给「新建」——哪怕只是前缀命中", () => {
    const 列 = [命令("性能复测样本（临时）")];
    const 建: string[] = [];
    // 从前查的是"全等标题"，于是打前缀时新建照样冒出来，还 unshift 到第 0 行
    expect(补新建(列, "性能复测", (t) => 建.push(t))).toBe(列);
    expect(建).toEqual([]);
  });

  it("一条命中都没有才给，且是唯一一条；run 建的就是打进去的词", () => {
    const 建: string[] = [];
    const 出 = 补新建([], "全新的一篇", (t) => 建.push(t));
    expect(出.map((i) => i.id)).toEqual(["新建"]);
    expect(出[0]!.label).toBe("新建笔记「全新的一篇」");
    出[0]!.run();
    expect(建).toEqual(["全新的一篇"]);
  });

  it("空查询、没给新建回调：都不给这一条", () => {
    const 建 = (t: string) => t;
    expect(补新建([], "", 建)).toEqual([]);
    expect(补新建([], "   ", 建)).toEqual([]);
    expect(补新建([], "某", undefined)).toEqual([]);
  });
});
