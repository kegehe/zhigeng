import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { EditDoc } from "../ipc/types";
import { 要补篇名 } from "./present";

const 篇 = (首块: string): EditDoc => ({
  frontMatter: "",
  trailingGap: "",
  blocks: [
    {
      kind: 首块,
      id: null,
      raw: "",
      gapBefore: "",
      content: "",
      level: null,
      checked: null,
      align: null,
      fields: [],
      children: [],
    },
  ],
});

describe("演示模式补不补篇名", () => {
  it("第一块是标题就不补：同一句话出现两遍是排版事故", () => {
    expect(要补篇名(篇("heading"))).toBe(false);
  });

  it("第一块是正文才补", () => {
    expect(要补篇名(篇("paragraph"))).toBe(true);
  });

  it("还没装载时不补", () => {
    expect(要补篇名(null)).toBe(false);
  });
});

/**
 * 演示改的是"同一篇的显示方式"，不是另一条渲染路径——所以这里钉的是接线，
 * 不是画出来的像素。最容易悄悄坏掉的三处：全屏没权限、正文点一下又变可编辑、
 * 界面壳收不干净。
 */
describe("演示模式的接线", () => {
  const 主窗 = fs.readFileSync("src/App.tsx", "utf8");
  const 编辑器 = fs.readFileSync("src/editor/BlockEditor.tsx", "utf8");
  const 样式 = fs.readFileSync("src/ui/base.css", "utf8");
  const 能力 = fs.readFileSync("src-tauri/capabilities/default.json", "utf8");

  it("演示是根节点上的属性，退出时整棵界面壳一起回来", () => {
    expect(主窗).toContain('data-present={presenting ? "1" : undefined}');
    expect(主窗).toContain("present-surface");
    expect(主窗).toContain("present-hud");
  });

  it("演示时编辑器保持只读，且点正文 / 拖手柄都开不了编辑", () => {
    expect(主窗).toContain('editable={mode === "inline" && !presenting}');
    expect(主窗).toContain("locked={presenting}");
    expect(编辑器).toContain("lockedRef.current");
    expect(编辑器).toMatch(/ev\.button !== 0 \|\| editor\.isEditable \|\| lockedRef\.current/);
    expect(编辑器).toMatch(/!e\.isPrimary \|\| lockedRef\.current/);
  });

  it("键盘只留 Esc / F11 两条出入口", () => {
    expect(主窗).toMatch(/if \(presenting\) \{[\s\S]*?Escape[\s\S]*?F11/);
    expect(主窗).toContain('e.key === "F11" && !palette && mode === "inline"');
  });

  it("窗口能力里有全屏与还原最大化，否则真机上调用会被拒", () => {
    for (const p of [
      "core:window:allow-set-fullscreen",
      "core:window:allow-maximize",
      "core:window:allow-unmaximize",
    ]) {
      expect(能力).toContain(p);
    }
  });

  it("演示时侧栏 / 标题栏 / 工具栏一起收走", () => {
    expect(样式).toMatch(
      /\[data-present="1"\] \.titlebar,[\s\S]*?\[data-present="1"\] aside,[\s\S]*?\[data-present="1"\] \.editor-tools/,
    );
  });

  it("浮层收起时不盖住仍有焦点的退出按钮", () => {
    expect(主窗).toContain("ref={演示Hud}");
    expect(主窗).toContain("contains(document.activeElement)");
  });
});
