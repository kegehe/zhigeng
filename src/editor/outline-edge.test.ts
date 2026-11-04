import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import type { EditBlock, EditDoc } from "./blocks";
import { createTestEditor } from "./testEditor";
import { OutlineEdge } from "./OutlineEdge";

/**
 * 左缘大纲（方案 G）的**交互契约**：没标题连把手都不渲染；把手点开有浮层；
 * 点条目光标真的跳进那一节；悬停滑出、移开收起；Esc 收起后焦点回把手。
 * 这些是"大纲找不着/焦点被抢"那类事故的门口。列表本体与跳转逻辑在 OutlinePanel
 * （outline.test.ts 钉过），这里只钉壳。
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function 块(kind: EditBlock["kind"], content: string, level: number | null = null): EditBlock {
  const 前 = kind === "heading" ? "#".repeat(level ?? 1) + " " : "";
  return {
    kind,
    id: null,
    raw: 前 + content + "\n",
    gapBefore: "",
    content,
    level,
    checked: null,
    align: null,
    fields: [],
    children: [],
  };
}

function 篇(...段: EditBlock[]): EditDoc {
  return { frontMatter: "", trailingGap: "", blocks: 段 };
}

const 编辑器们: Editor[] = [];
afterEach(() => {
  for (const e of 编辑器们.splice(0)) e.destroy();
  vi.useRealTimers();
});

async function 挂(editor: Editor) {
  const 根 = document.createElement("div");
  document.body.appendChild(根);
  const 树 = createRoot(根);
  await act(async () => {
    树.render(createElement(OutlineEdge, { editor }));
  });
  return {
    根,
    拆: () => {
      act(() => 树.unmount());
      根.remove();
    },
  };
}

async function 点(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("OutlineEdge（正文左缘把手 + 悬停浮层）", () => {
  it("没有标题的短笔记连把手都不渲染：不为布局而布局", async () => {
    const editor = createTestEditor(篇(块("paragraph", "光秃秃一段")));
    编辑器们.push(editor);
    const { 根, 拆 } = await 挂(editor);
    expect(根.querySelector(".outline-edge-handle")).toBeNull();
    expect(根.querySelector(".outline-flyout")).toBeNull();
    拆();
  });

  it("有标题时默认只有把手；点开有浮层与条目，Esc 收起后焦点回把手", async () => {
    const editor = createTestEditor(
      篇(块("heading", "第一节", 1), 块("paragraph", "正文"), 块("heading", "第二节", 2)),
    );
    编辑器们.push(editor);
    const { 根, 拆 } = await 挂(editor);
    expect(根.querySelector(".outline-flyout")).toBeNull();
    const 把手 = 根.querySelector('button[aria-label="展开大纲"]')!;
    expect(把手).not.toBeNull();

    await 点(把手);
    const 浮层 = 根.querySelector(".outline-flyout")!;
    expect(浮层).not.toBeNull();
    // 列表是 OutlinePanel 的：条目照常渲染
    expect(浮层.querySelectorAll(".outline-item").length).toBe(2);
    // 焦点进到列表里（键盘用户用得到）——Esc 收起时才谈得上"把焦点还回来"
    await act(async () => {
      (浮层.querySelector(".outline-item") as HTMLElement).focus();
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(根.querySelector(".outline-flyout")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("展开大纲");
    拆();
  });

  it("点浮层里的条目：光标跳进那一节，当前节高亮跟着走", async () => {
    const editor = createTestEditor(
      篇(块("heading", "第一节", 1), 块("paragraph", "正文"), 块("heading", "第二节", 2)),
    );
    编辑器们.push(editor);
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开大纲"]')!);
    const 条目 = [...根.querySelectorAll<HTMLButtonElement>(".outline-item")];
    await 点(条目[1]!);
    const { $from } = editor.state.selection;
    expect($from.parent.type.name).toBe("mdHeading");
    expect($from.parent.textContent).toBe("第二节");
    expect(条目[1]?.classList.contains("on")).toBe(true);
    拆();
  });

  it("鼠标移入把手滑出（120ms）、移开收起（300ms）", async () => {
    vi.useFakeTimers();
    const editor = createTestEditor(
      篇(块("heading", "第一节", 1), 块("paragraph", "正文")),
    );
    编辑器们.push(editor);
    const { 根, 拆 } = await 挂(editor);
    const 壳 = 根.querySelector(".outline-edge")!;
    // React 的 onPointerEnter / onPointerLeave 由 pointerover / pointerout 合成
    await act(async () => {
      壳.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: null }));
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(根.querySelector(".outline-flyout")).not.toBeNull();

    await act(async () => {
      壳.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: null }));
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(根.querySelector(".outline-flyout")).toBeNull();
    拆();
  });

  it("大纲挂在 editor-pane 里、main 外面：100% 按正文列算，缩放时把手不离正文", () => {
    // jsdom 算不了布局，只能钉结构：`.outline-edge` 的 `100%` 取的是定位祖先的宽度，
    // 挂在没有定位的祖先上就成了视口宽度（2026-11-02 真机：缩放时漂、窄窗贴窗口最左）。
    // 同时必须在 main 外面，否则浮层跟着正文滚走。JSX 注释里也可能写标签，先剥掉。
    const 源 = readFileSync("src/App.tsx", "utf8").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    const 面板 = 源.indexOf('<div className="editor-pane');
    expect(面板).toBeGreaterThan(-1);
    const 主区闭合 = 源.indexOf("</main>", 面板);
    const 大纲 = 源.indexOf("<OutlineEdge");
    expect(大纲).toBeGreaterThan(主区闭合);
    // editor-pane 的闭合就在大纲之后：两者之间若出现 </div>，大纲就已经掉到面板外面了
    expect(源.slice(主区闭合, 大纲)).not.toContain("</div>");
  });
});
