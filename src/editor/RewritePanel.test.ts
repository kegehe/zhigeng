import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, expect, it, vi } from "vitest";
import type { EditBlock, EditDoc } from "./blocks";
import { createTestEditor } from "./testEditor";

/**
 * 浮层是组件，这一份是**组件级**用例：纯函数挡不住"号复用""Esc 抢键"这类
 * 只在接线上出现的错——上一轮那两个 bug 都长在这里。
 *
 * 只 mock 了 IPC：`inTauri()` 给 false，所以不订阅 Tauri 事件（流式那半在 Rust 侧另有
 * 用例）；这里验的是"点改写时送出去的号"与"Esc 该不该关"。
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { 假回稿 } = vi.hoisted(() => ({ 假回稿: vi.fn() }));

vi.mock("../ipc/commands", () => ({
  api: { aiRewrite: 假回稿 },
  describeError: (e: unknown) => ({ message: e instanceof Error ? e.message : String(e) }),
  inTauri: () => false,
}));

import { RewritePanel } from "./RewritePanel";

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
  假回稿.mockReset();
});

async function 挂(editor: Editor, onClose: () => void) {
  const 根 = document.createElement("div");
  document.body.appendChild(根);
  const 树 = createRoot(根);
  await act(async () => {
    树.render(
      createElement(RewritePanel, {
        editor,
        放: { left: 10, top: 10, maxHeight: 520 },
        onClose,
      }),
    );
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

function 选中一段(editor: Editor) {
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 5)),
  );
}

function 点(根: HTMLElement, 文字: string) {
  const 钮 = [...根.querySelectorAll("button")].find((b) => b.textContent?.includes(文字));
  if (!钮) throw new Error("找不到按钮：" + 文字);
  钮.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

it("重开浮层拿的是新号，不会与上一次撞号", async () => {
  假回稿.mockResolvedValue({ text: "改好的", inTokens: 1, outTokens: 1, ms: 1, model: "m" });
  const editor = createTestEditor(篇("第一段文字"));
  选中一段(editor);

  const 号们: number[] = [];
  for (let i = 0; i < 2; i++) {
    const { 根, 拆 } = await 挂(editor, () => {});
    await act(async () => {
      点(根, "改写");
    });
    await act(async () => {});
    // aiRewrite(text, instruction, preset, runId)
    号们.push(假回稿.mock.calls.at(-1)![3] as number);
    拆();
  }
  expect(号们.length).toBe(2);
  expect(号们[1]!).toBeGreaterThan(号们[0]!);
  editor.destroy();
});

it("Esc 关浮层；已被别人 preventDefault 的 Esc 不算", async () => {
  const editor = createTestEditor(篇("第一段文字"));
  选中一段(editor);
  let 关了 = 0;
  const { 根 } = await 挂(editor, () => {
    关了 += 1;
  });
  const 输入 = 根.querySelector("input") as HTMLInputElement;
  输入.focus();

  // 从元素上发、让它冒泡到 window：真实按键就是这个路径。直接 dispatch 在 window 上
  // 会跳过 document 那一段，测出来的是个不存在的场景。
  const 挡 = (e: KeyboardEvent) => e.preventDefault();
  document.addEventListener("keydown", 挡);
  await act(async () => {
    输入.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  document.removeEventListener("keydown", 挡);
  expect(关了).toBe(0);

  await act(async () => {
    输入.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  expect(关了).toBe(1);
  editor.destroy();
});
