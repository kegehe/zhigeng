import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { 新运行号 } from "./runId";

describe("运行号", () => {
  it("取了就往前走，不会因为谁重开而回头", () => {
    const 甲 = 新运行号();
    const 乙 = 新运行号();
    expect(乙).toBeGreaterThan(甲);
    expect(甲).toBeGreaterThan(0);
  });

  /**
   * 真正要钉的是**接线的形状**，不是那个计数器本身：对话框只要还留着自己的 `++号.current`，
   * 重开一次就会与上一次撞号，而上面那条"取了就往前走"照样是绿的。所以像 settings.test
   * 那样直接读源码——对话框必须取模块的号，且不许再自己加一。
   */
  it("对话框不再自己发号", () => {
    const 面板 = fs.readFileSync("src/editor/AiDock.tsx", "utf8");
    expect(面板).toContain('from "./runId"');
    expect(面板).not.toMatch(/\+\+号\.current/);
  });
});
