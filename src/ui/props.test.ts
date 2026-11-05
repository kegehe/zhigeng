import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { MetaView } from "../ipc/types";
import { 推断类型, 问题行, 解析标签, 算补丁, 行来自, type 属性行 } from "./props";

const 元: MetaView = {
  hash: "h",
  tags: ["a", "b"],
  private: false,
  noAi: false,
  hasFrontMatter: true,
  yamlOk: true,
  props: [
    { key: "priority", value: "high", kind: "text" },
    { key: "as_of", value: "2026-09-22", kind: "date" },
    { key: "范围", value: '["x","y"]', kind: "json" },
  ],
};

const 原样 = () => 行来自(元);

describe("标签输入", () => {
  it("中英文逗号都算分隔，井号去掉，重复只留一次", () => {
    expect(解析标签(" #a, b , a，中文 ")).toEqual(["a", "b", "中文"]);
    expect(解析标签("")).toEqual([]);
  });

  it("标签里的空格不拆：盘上合法的 \"python 3\" 不该被面板拆成两个", () => {
    expect(解析标签("python 3, m4")).toEqual(["python 3", "m4"]);
  });
});

describe("新属性按值推断类型", () => {
  it("日期 / 数字 / 布尔 / 文本", () => {
    expect(推断类型("2026-11-05")).toBe("date");
    expect(推断类型("2026-11-05T08:00:00+08:00")).toBe("date");
    expect(推断类型("-3.5")).toBe("num");
    expect(推断类型("true")).toBe("bool");
    expect(推断类型("high")).toBe("text");
    expect(推断类型("3 件")).toBe("text");
  });
});

describe("面板状态 → 补丁", () => {
  it("什么都没改就不发请求", () => {
    expect(算补丁(元, "a, b", 原样(), false, false)).toBeNull();
  });

  it("只改标签时不动属性", () => {
    expect(算补丁(元, "a, c", 原样(), false, false)).toEqual({
      tags: ["a", "c"],
      props: [],
      private: false,
      noAi: false,
    });
  });

  it("改名按删旧键 + 写新键两笔表达", () => {
    const 行 = 原样();
    行[0] = { ...行[0]!, 键: "importance" };
    expect(算补丁(元, "a, b", 行, false, false)?.props).toEqual([
      { key: "priority", kind: "text", value: null },
      { key: "importance", kind: "text", value: "high" },
    ]);
  });

  it("复杂值没删就不出现在补丁里（后端才不会被重写成字符串）", () => {
    const 行 = 原样();
    行[1] = { ...行[1]!, 值: "2026-12-01" };
    const patch = 算补丁(元, "a, b", 行, false, false);
    expect(patch?.props).toEqual([{ key: "as_of", kind: "date", value: "2026-12-01" }]);
    expect(patch?.props?.some((p) => p.key === "范围")).toBe(false);
  });

  it("复杂值可以显式删除", () => {
    const 行 = 原样();
    行[2] = { ...行[2]!, 删除: true };
    expect(算补丁(元, "a, b", 行, false, false)?.props).toEqual([
      { key: "范围", kind: "json", value: null },
    ]);
  });

  it("AI 开关变了只带开关", () => {
    const patch = 算补丁(元, "a, b", 原样(), true, false);
    expect(patch).toMatchObject({ private: true, noAi: false, props: [] });
  });

  it("新加一行写进去", () => {
    const 行: 属性行[] = [...原样(), { 原键: "", 键: "due", 值: "2026-11-05", 类型: "date", 删除: false }];
    expect(算补丁(元, "a, b", 行, false, false)?.props).toEqual([
      { key: "due", kind: "date", value: "2026-11-05" },
    ]);
  });
});

describe("面板自己先拦下的问题", () => {
  it("空键与重复键", () => {
    expect(问题行([{ 原键: "", 键: " ", 值: "", 类型: "text", 删除: false }])).toBe("属性键不能为空");
    const 行 = 原样();
    行[1] = { ...行[1]!, 键: "priority" };
    expect(问题行(行)).toBe("属性键「priority」重复");
    expect(问题行(原样())).toBeNull();
  });
});

describe("接线守卫", () => {
  const 主窗 = fs.readFileSync("src/App.tsx", "utf8");
  const 命令 = fs.readFileSync("src/ipc/commands.ts", "utf8");

  it("标题栏有入口，主区有这一页", () => {
    expect(主窗).toContain("void openProps()");
    expect(主窗).toContain("<PropsView");
    expect(主窗).toMatch(/mode === "props"/);
  });

  it("保存后必须重载这篇：旧 front-matter 留在 EditDoc 里会把刚写的属性盖回去", () => {
    expect(主窗).toMatch(/api\.noteMetaSave\(selected\.rel, patch/);
    const 段 = 主窗.slice(主窗.indexOf("const saveProps"), 主窗.indexOf("const reloadProps"));
    expect(段).toContain("await loadNote(selected.rel)");
  });

  it("Esc 能出这一页，但输入框里的 Esc 归输入法 / 它自己", () => {
    expect(主窗).toMatch(/e\.key === "Escape" && mode === "props"/);
  });

  it("IPC 两条命令都通到 Rust", () => {
    expect(命令).toContain('invoke<MetaView>("note_meta"');
    expect(命令).toContain('invoke<string>("note_meta_save"');
  });
});
