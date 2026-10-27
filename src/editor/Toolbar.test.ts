import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { afterEach, expect, it, vi } from "vitest";
import type { EditBlock, EditDoc } from "./blocks";
import { createTestEditor } from "./testEditor";
import { Toolbar } from "./Toolbar";

/**
 * 工具栏是组件，这一份钉的是**入口在不在**：上一版 AI 只挂在选区气泡上，
 * 不选中文字就完全看不见，用户的原话是"没有哪里可以调用 AI"。
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function 块(content: string, gapBefore: string): EditBlock {
  return {
    kind: "paragraph",
    id: null,
    raw: content + "\n",
    gapBefore,
    content,
    level: null,
    checked: null,
    fields: [],
    children: [],
  };
}

function 篇(...段: string[]): EditDoc {
  return {
    frontMatter: "",
    trailingGap: "",
    blocks: 段.map((s, i) => 块(s, i === 0 ? "" : "\n")),
  };
}

const 活的: { 拆: () => void; 拆过: boolean }[] = [];
afterEach(() => {
  for (const o of 活的) if (!o.拆过) o.拆();
  活的.length = 0;
});

async function 挂(editor: Editor, onAi: () => void, aiReady: boolean, 提示?: string) {
  const 根 = document.createElement("div");
  document.body.appendChild(根);
  const 树 = createRoot(根);
  await act(async () => {
    树.render(createElement(Toolbar, { editor, onAi, aiReady, 提示: 提示 ?? null }));
  });
  const 记 = { 拆过: false, 拆: () => {} } as { 拆: () => void; 拆过: boolean };
  记.拆 = () => {
    act(() => 树.unmount());
    根.remove();
    记.拆过 = true;
  };
  活的.push(记);
  return { 根, 拆: 记.拆 };
}

it("不选中文字也在：工具栏上有一枚 AI 入口，且点得动", async () => {
  const editor = createTestEditor(篇("第一段文字"));
  const onAi = vi.fn();
  const { 根, 拆 } = await 挂(editor, onAi, true);
  const 钮 = 根.querySelector('button[aria-label="AI 改写选中文字"]');
  expect(钮).not.toBeNull();
  // 没有拦截原因时不该多一块提示
  expect(根.querySelector(".ai-hint")).toBeNull();
  await act(async () => {
    钮!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  // 空选区也照点："先选一段" 由 `准备改写` 说，入口不做灰态
  expect(onAi).toHaveBeenCalledTimes(1);
  拆();
  editor.destroy();
});

it("被拦下的原因贴在工具栏上，不靠正文顶部那行 flash", async () => {
  const editor = createTestEditor(篇("第一段文字"));
  const { 根, 拆 } = await 挂(editor, () => {}, false, "先选中一段文字");
  const 提示 = 根.querySelector(".ai-hint");
  expect(提示).not.toBeNull();
  expect(提示!.textContent).toContain("先选中一段文字");
  expect(提示!.getAttribute("role")).toBe("status");
  拆();
  editor.destroy();
});

it("没配模型时按钮照样在，title 说明下一步", async () => {
  const editor = createTestEditor(篇("第一段文字"));
  const { 根, 拆 } = await 挂(editor, () => {}, false);
  const 钮 = 根.querySelector('button[aria-label="AI 改写选中文字"]');
  expect(钮).not.toBeNull();
  expect(钮!.getAttribute("title")).toContain("配好模型");
  expect((钮 as HTMLButtonElement).disabled).toBe(false);
  拆();
  editor.destroy();
});
