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
  const 语法 = fs.readFileSync("src/editor/schema.ts", "utf8");
  const 样式 = fs.readFileSync("src/ui/base.css", "utf8");
  const 能力 = fs.readFileSync("src-tauri/capabilities/default.json", "utf8");

  it("演示是根节点上的属性，退出时整棵界面壳一起回来", () => {
    expect(主窗).toContain('data-present={presenting ? "1" : undefined}');
    expect(主窗).toContain("present-surface");
    expect(主窗).toContain("present-hud");
  });

  it("演示时编辑器保持只读，且点正文 / 拖手柄 / 落块都开不了编辑", () => {
    expect(主窗).toContain('editable={mode === "inline" && !presenting}');
    expect(主窗).toContain("locked={presenting}");
    expect(编辑器).toContain("lockedRef.current");
    expect(编辑器).toMatch(/ev\.button !== 0 \|\| editor\.isEditable \|\| lockedRef\.current/);
    expect(编辑器).toMatch(/!e\.isPrimary \|\| lockedRef\.current/);
    // 拖到一半按了 F11：松手那一下也得认这把锁，不能把块落进正在投屏的正文
    expect(编辑器).toMatch(/const up = \(ev: PointerEvent\) => \{[\s\S]*?lockedRef\.current/);
  });

  it("NodeView 里的原生控件也锁住：语言下拉与图注框", () => {
    // `editable` 管不到 contentDOM 之外的控件，而两者都有直接 dispatch / 收字的路
    expect(编辑器).toContain("select.md-lang");
    expect(编辑器).toContain(".md-img-alt");
    expect(编辑器).toContain("牌.disabled = 只读");
    expect(编辑器).toContain("框.readOnly = 只读");
    expect(语法).toMatch(
      /private 改语言\(值: string\): void \{[\s\S]*?if \(!this\.view\.editable\) return;/,
    );
    expect(语法).toContain("注.readOnly = !this.视图.editable");
    expect(语法).toContain("牌.disabled = !this.view.editable");
  });

  it("演示里的链接不许把 WebView 导航走", () => {
    expect(编辑器).toContain('目标.closest("a[href]")');
    expect(编辑器).toMatch(/if \(!lockedRef\.current\) return false;[\s\S]*?a\[href\]/);
  });

  it("F11 用每次渲染的新闭包，且进入只放行一次", () => {
    // 自动保存会换掉 savedDraft / baseHash；监听若抓住旧 persist，就会拿旧哈希误报冲突
    expect(主窗).toContain("进演示用.current = () => void enterPresent();");
    expect(主窗).toContain("退演示用.current = () => void exitPresent();");
    expect(主窗).toContain("进演示用.current();");
    expect(主窗).toContain("退演示用.current();");
    expect(主窗).toMatch(/进演示中\.current \|\| presenting/);
    expect(主窗).toContain("presenting || e.repeat");
    // 待触发的自动保存先撤掉，别和进入前那次 persist 抢同一个 baseHash
    expect(主窗).toMatch(
      /进演示中\.current = true;[\s\S]*?window\.clearTimeout\(saveTimer\.current\)/,
    );
  });

  it("键盘只留 Esc / F11 两条出入口，且 Esc 不被别的浮层吞掉", () => {
    expect(主窗).toMatch(/if \(presenting \|\| e\.repeat\) return;/);
    expect(主窗).toMatch(/e\.key !== "Escape" && e\.key !== "F11"/);
    expect(主窗).toContain('window.addEventListener("keydown", on键, true)');
    expect(主窗).toContain('e.key === "F11" && !palette && mode === "inline"');
    // 查找快捷键也归这把锁管：演示里不再把焦点塞进一个看不见的输入框
    expect(编辑器).toContain("e.repeat || lockedRef.current");
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

  it("演示时侧栏 / 标题栏 / 工具栏一起收走，编辑控件与 AI 坞跟着收起", () => {
    expect(样式).toMatch(
      /\[data-present="1"\] \.titlebar,[\s\S]*?\[data-present="1"\] aside,[\s\S]*?\[data-present="1"\] \.editor-tools/,
    );
    for (const 选择器 of [".md-img-bar", ".ai-dock", ".block-drag-ghost"]) {
      expect(样式).toContain(`[data-present="1"] ${选择器}`);
    }
    // AI 坞不卸载：对话轮次与草稿都是组件内部状态，重挂一次就没了
    expect(主窗).not.toContain("!presenting && liveEditor && selected");
    expect(主窗).toContain("{liveEditor && selected ? (");
  });

  it("浮层收起时不盖住仍有焦点的退出按钮", () => {
    expect(主窗).toContain("ref={演示Hud}");
    expect(主窗).toContain("contains(document.activeElement)");
  });
});
