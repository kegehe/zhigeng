import fs from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 2026-11-05 拍板：整篇源码态撤掉，"看到什么就是什么"。
 * 这里钉的是**入口整个不在**，而不是"按钮藏起来了"——少一处，它就自己长回来。
 *
 * 块级的不透明块仍有两副面孔（HTML、未闭栏的代码、拼不回的表格等），那是
 * `[data-md-mode="source"]` 那一套，归显示层管，不在这条的范围内。
 */
describe("整篇源码态已撤", () => {
  const 主窗 = fs.readFileSync("src/App.tsx", "utf8");

  it("Mode 里没有 source，也没有切过去的那条路", () => {
    expect(主窗).not.toMatch(/setMode\("source"\)/);
    expect(主窗).not.toMatch(/mode\s*[!=]==\s*"source"/);
    expect(主窗).not.toContain("switchSurface");
  });

  it("顶栏与命令面板都不再有源码入口", () => {
    expect(主窗).not.toContain("看这篇的源文本");
    expect(主窗).not.toContain("a-surface");
  });

  it("正文只有编辑器一面，没有整篇的 textarea", () => {
    expect(主窗).not.toContain("<textarea");
  });
});
