import { describe, expect, it } from "vitest";
import {
  下一步永久删除,
  删后选中,
  删除时刻,
  回收站键,
  预览上限,
  预览正文,
} from "./trash";

const 条 = (batch: string, rel: string) => ({
  batch,
  rel,
  size: 1,
  updatedMs: 0,
  deletedMs: 0,
});

describe("回收站条目的身份", () => {
  it("同一路径删两次是两条，各认各的批次", () => {
    expect(回收站键(条("b1", "notes/甲.md"))).not.toBe(回收站键(条("b2", "notes/甲.md")));
  });

  it("分隔符不会让两条不同的记录拼成同一个键", () => {
    // 键里若直接拼字符串，这两组会撞在一起
    expect(回收站键(条("a", "b/c.md"))).not.toBe(回收站键(条("a/b", "c.md")));
  });
});

describe("永久删除的两步确认", () => {
  it("第一次点只是翻成确认态，不执行", () => {
    expect(下一步永久删除(null, "b1\u0000a.md")).toEqual({
      确认中: "b1\u0000a.md",
      执行: false,
    });
  });

  it("再点同一条才执行，并撤掉确认态", () => {
    expect(下一步永久删除("b1\u0000a.md", "b1\u0000a.md")).toEqual({
      确认中: null,
      执行: true,
    });
  });

  it("确认态只跟着最近点的那一条走", () => {
    // 先点了 A 再点 B：确认落到 B，A 那一次不执行
    expect(下一步永久删除("b1\u0000a.md", "b1\u0000b.md")).toEqual({
      确认中: "b1\u0000b.md",
      执行: false,
    });
  });
});

describe("显示的删除时刻", () => {
  it("优先用删除时刻，而不是文件最后编辑时间", () => {
    // rename 会保留 mtime；删一篇上周写好的笔记，显示"上周删除"就是假话
    expect(删除时刻({ updatedMs: 100, deletedMs: 900 })).toBe(900);
  });

  it("旧批次解析不出删除时刻时退回 mtime", () => {
    expect(删除时刻({ updatedMs: 100, deletedMs: 0 })).toBe(100);
  });
});

describe("删掉一条之后选中谁", () => {
  const 列表 = [条("b3", "三.md"), 条("b2", "二.md"), 条("b1", "一.md")];

  it("选中原位置的下一条", () => {
    expect(删后选中(列表, 回收站键(列表[0]!))?.rel).toBe("二.md");
  });

  it("删的是最后一条就退到上一条", () => {
    expect(删后选中(列表, 回收站键(列表[2]!))?.rel).toBe("二.md");
  });

  it("列表空了就没有可选的；条目已不在列表里时退回第一条", () => {
    expect(删后选中([], "x")).toBeNull();
    expect(删后选中(列表, "已经不在列表里")?.rel).toBe("三.md");
  });
});

describe("预览正文", () => {
  it("短正文原样返回", () => {
    expect(预览正文("---\ntitle: 甲\n---\n\n正文\n")).toEqual({
      text: "---\ntitle: 甲\n---\n\n正文\n",
      truncated: false,
    });
  });

  it("超过上限就截断并说明", () => {
    const 长 = "甲".repeat(预览上限 + 10);
    const r = 预览正文(长);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(预览上限);
  });

  it("恰好到上限不算截断", () => {
    expect(预览正文("a".repeat(预览上限)).truncated).toBe(false);
  });

  it("截断点落在代理对中间时退一格，不吐出半个字符", () => {
    // 😀 占两个 UTF-16 码元；把切点塞在它中间，直接 slice 会留下孤立高代理
    const 尾 = "😀";
    const 长 = "a".repeat(预览上限 - 1) + 尾 + "b";
    const r = 预览正文(长);
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith("�")).toBe(false);
    expect(r.text.endsWith(尾)).toBe(false);
    expect(r.text.charCodeAt(r.text.length - 1)).toBe("a".charCodeAt(0));
  });
});
