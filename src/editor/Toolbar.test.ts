import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { afterEach, expect, it } from "vitest";
import type { EditBlock, EditDoc } from "./blocks";
import { 调色板 } from "./colors";
import { createTestEditor } from "./testEditor";
import { 格式刷状态of } from "./formatPainter";
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
    align: null,
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

async function 挂(editor: Editor) {
  const 根 = document.createElement("div");
  document.body.appendChild(根);
  const 树 = createRoot(根);
  await act(async () => {
    树.render(createElement(Toolbar, { editor }));
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

it("文字颜色与底色是两枚按钮，各自只开自己的色板", async () => {
  const editor = createTestEditor(篇("第一段文字"));
  editor.commands.setTextSelection({ from: 1, to: 6 });
  const { 根, 拆 } = await 挂(editor);
  // 入口常驻：不选中文字也看得见（与 AI 入口同一条教训）
  const 字色 = 根.querySelector('button[aria-label="文字颜色"]');
  const 底色 = 根.querySelector('button[aria-label="底色"]');
  expect(字色).not.toBeNull();
  expect(底色).not.toBeNull();
  // 按钮里那道色条：没上色时是中性色，上了色才换成用户挑的那档
  expect(字色!.querySelector(".ink-bar")).not.toBeNull();

  await act(async () => {
    字色!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const 板 = 根.querySelector(".color-pop")!;
  expect(板).not.toBeNull();
  expect(板.getAttribute("aria-label")).toBe("文字颜色");
  // 文字色板：6 档 + 一枚"去掉"，**没有高亮那一格**（高亮是底色）
  expect(板.querySelectorAll(".swatch").length).toBe(7);
  expect(板.querySelector(".swatch.mark")).toBeNull();

  const 第一档 = 板.querySelector(".swatch")!;
  await act(async () => {
    第一档.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  // 选完自己收起，否则面板会压在刚改好的那段字上
  expect(根.querySelector(".color-pop")).toBeNull();
  const 段 = editor.getJSON().content![0]!;
  expect(段.content![0]).toEqual(
    expect.objectContaining({
      type: "text",
      marks: [{ type: "textColor", attrs: { color: 调色板[0]!.hex } }],
    }),
  );
  拆();
  editor.destroy();
});

it("格式刷常驻在工具栏：有选区才可点，点开按住态，双击进连续档", async () => {
  const editor = createTestEditor(篇("第一段文字"));
  const { 根, 拆 } = await 挂(editor);
  const 刷 = 根.querySelector('button[aria-label^="格式刷"]') as HTMLButtonElement;
  expect(刷).not.toBeNull();
  // 没有选区就没有"抄谁"的源，按钮灰着
  expect(刷.disabled).toBe(true);

  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 3 });
  });
  expect(刷.disabled).toBe(false);

  await act(async () => {
    刷.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(格式刷状态of(editor.state)).not.toBeNull();
  expect(刷.getAttribute("aria-pressed")).toBe("true");

  await act(async () => {
    刷.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(格式刷状态of(editor.state)?.锁定).toBe(true);
  拆();
  editor.destroy();
});

it("上标与下标各有入口，互斥地套在选区上", async () => {
  const editor = createTestEditor(篇("第一段文字"));
  editor.commands.setTextSelection({ from: 1, to: 6 });
  const { 根, 拆 } = await 挂(editor);
  const 上标 = 根.querySelector('button[aria-label="上标"]') as HTMLButtonElement;
  const 下标 = 根.querySelector('button[aria-label="下标"]') as HTMLButtonElement;
  expect(上标).not.toBeNull();
  expect(下标).not.toBeNull();

  await act(async () => {
    上标.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(editor.getJSON().content![0]!.content![0]).toEqual(
    expect.objectContaining({ marks: [{ type: "sup" }] }),
  );

  // 两个标记互斥：后点的那个把先点的顶掉，而不是叠成两层
  await act(async () => {
    下标.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(editor.getJSON().content![0]!.content![0]).toEqual(
    expect.objectContaining({ marks: [{ type: "sub" }] }),
  );
  拆();
  editor.destroy();
});

it("底色面板第一格是高亮，套的是 ==…== 那一档", async () => {
  const editor = createTestEditor(篇("第一段文字"));
  editor.commands.setTextSelection({ from: 1, to: 6 });
  const { 根, 拆 } = await 挂(editor);
  await act(async () => {
    根.querySelector('button[aria-label="底色"]')!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
  });
  const 板 = 根.querySelector(".color-pop")!;
  expect(板.getAttribute("aria-label")).toBe("底色");
  // 底色板：高亮 1 + 6 档 + "去掉"
  expect(板.querySelectorAll(".swatch").length).toBe(8);
  const 格 = 板.querySelector(".swatch.mark")!;
  expect(格).not.toBeNull();
  await act(async () => {
    格.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const 段 = editor.getJSON().content![0]!;
  expect(段.content![0]).toEqual(
    expect.objectContaining({ type: "text", marks: [{ type: "highlight" }] }),
  );
  拆();
  editor.destroy();
});

it("块级对齐常驻在工具栏：正文可点、列表里灰着，点了改的是块的 mdAlign", async () => {
  const editor = createTestEditor(篇("第一段文字"));
  editor.commands.setTextSelection(2);
  const { 根, 拆 } = await 挂(editor);
  for (const 标签 of ["左对齐", "居中对齐", "右对齐", "两端对齐"]) {
    const b = 根.querySelector(`button[aria-label^="${标签}"]`) as HTMLButtonElement | null;
    expect(b, 标签).not.toBeNull();
    expect(b!.disabled, 标签).toBe(false);
  }
  const 中 = 根.querySelector('button[aria-label="居中对齐"]') as HTMLButtonElement;
  await act(async () => {
    中.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(editor.getJSON().content![0]!.attrs!.mdAlign).toBe("center");
  // 左对齐 = 默认那档：把 mdAlign 清回空串，文件里不留包裹
  const 左 = 根.querySelector('button[aria-label^="左对齐"]') as HTMLButtonElement;
  await act(async () => {
    左.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(editor.getJSON().content![0]!.attrs!.mdAlign).toBe("");

  const 列表: EditDoc = {
    frontMatter: "",
    trailingGap: "",
    blocks: [
      {
        kind: "bullet",
        id: null,
        raw: "- 列表项\n",
        gapBefore: "",
        content: "列表项",
        level: null,
        checked: null,
        align: null,
        fields: [],
        children: [],
      },
    ],
  };
  const 列表编辑器 = createTestEditor(列表);
  列表编辑器.commands.setTextSelection(2);
  const 二 = await 挂(列表编辑器);
  const 灰 = 二.根.querySelector('button[aria-label^="居中对齐"]') as HTMLButtonElement;
  expect(灰.disabled).toBe(true);

  拆();
  editor.destroy();
  二.拆();
  列表编辑器.destroy();
});

it("跨块混选时按共同档亮灯：不同档一盏不亮，点了整批改成同一档", async () => {
  const 混选: EditDoc = {
    frontMatter: "",
    trailingGap: "",
    blocks: [{ ...块("甲", ""), align: "center" }, { ...块("乙", "\n"), align: null }],
  };
  const editor = createTestEditor(混选);
  editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
  const { 根, 拆 } = await 挂(editor);
  const 中 = 根.querySelector('button[aria-label^="居中对齐"]') as HTMLButtonElement;
  // 两块档位不同：动作会把整批拉成同一档，这时亮"居中"就是撒谎
  expect(中.getAttribute("aria-pressed")).toBeNull();

  await act(async () => {
    中.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const 段们 = editor.getJSON().content!;
  expect(段们[0]!.attrs!.mdAlign).toBe("center");
  expect(段们[1]!.attrs!.mdAlign).toBe("center");
  expect(中.getAttribute("aria-pressed")).toBe("true");
  拆();
  editor.destroy();
});

it("无序、有序按钮常驻：点了改这一块，再点同一种回到正文", async () => {
  const editor = createTestEditor(篇("第一段文字"));
  editor.commands.setTextSelection(2);
  const { 根, 拆 } = await 挂(editor);
  const 无序 = 根.querySelector('button[aria-label^="无序列表"]') as HTMLButtonElement;
  const 有序 = 根.querySelector('button[aria-label^="有序列表"]') as HTMLButtonElement;
  expect(无序.disabled).toBe(false);
  expect(有序.disabled).toBe(false);
  await act(async () => {
    无序.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(editor.getJSON().content![0]!.type).toBe("mdItem");
  expect(editor.getJSON().content![0]!.attrs!.mdKind).toBe("bullet");
  expect(无序.getAttribute("aria-pressed")).toBe("true");
  await act(async () => {
    有序.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(editor.getJSON().content![0]!.attrs!.mdKind).toBe("numbered");
  expect(有序.getAttribute("aria-pressed")).toBe("true");
  expect(无序.getAttribute("aria-pressed")).toBeNull();
  await act(async () => {
    有序.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(editor.getJSON().content![0]!.type).toBe("mdParagraph");
  拆();
  editor.destroy();
});

it("待办按钮常驻：点了改成待办，再点回到正文", async () => {
  const editor = createTestEditor(篇("第一段文字"));
  editor.commands.setTextSelection(2);
  const { 根, 拆 } = await 挂(editor);
  const 钮 = 根.querySelector('button[aria-label^="待办"]') as HTMLButtonElement;
  expect(钮.disabled).toBe(false);
  expect(钮.getAttribute("aria-pressed")).toBeNull();
  await act(async () => {
    钮.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(editor.getJSON().content![0]!.attrs!.mdKind).toBe("todo");
  expect(editor.getJSON().content![0]!.attrs!.mdChecked).toBe(false);
  expect(钮.getAttribute("aria-pressed")).toBe("true");
  await act(async () => {
    钮.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(editor.getJSON().content![0]!.type).toBe("mdParagraph");
  拆();
  editor.destroy();
});

it("首行缩进按钮常驻：点一次加上两个全角空格，再点去掉", async () => {
  const editor = createTestEditor(篇("第一段文字"));
  editor.commands.setTextSelection(2);
  const { 根, 拆 } = await 挂(editor);
  const 钮 = 根.querySelector('button[aria-label^="首行缩进"]') as HTMLButtonElement;
  expect(钮.disabled).toBe(false);
  expect(钮.getAttribute("aria-pressed")).toBeNull();
  await act(async () => {
    钮.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(editor.state.doc.textContent.startsWith("\u3000\u3000")).toBe(true);
  expect(钮.getAttribute("aria-pressed")).toBe("true");
  await act(async () => {
    钮.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(editor.state.doc.textContent).toBe("第一段文字");
  expect(钮.getAttribute("aria-pressed")).toBeNull();
  拆();
  editor.destroy();
});

it("标题上的首行缩进按钮是禁用的", async () => {
  const editor = createTestEditor({
    frontMatter: "",
    trailingGap: "",
    blocks: [{ ...块("题", ""), kind: "heading", level: 1, raw: "# 题\n" }],
  });
  editor.commands.setTextSelection(2);
  const { 根, 拆 } = await 挂(editor);
  const 钮 = 根.querySelector('button[aria-label^="首行缩进"]') as HTMLButtonElement;
  expect(钮.disabled).toBe(true);
  expect(钮.getAttribute("aria-label")).toContain("只作用于有文字的正文");
  拆();
  editor.destroy();
});
