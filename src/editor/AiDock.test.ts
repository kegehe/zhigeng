import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";

import { AiDock } from "./AiDock";
import type { EditBlock, EditDoc } from "./blocks";
import { 调色板 } from "./colors";
import type { DocEditPlan } from "../ipc/types";
import { createTestEditor } from "./testEditor";

/**
 * 底部对话框的**交互契约**：收起时只有一条把手、点一下展开、目标跟着选区走、
 * 回稿不点「替换」不进正文。这些是"点了没反应/自己改字"那一类事故的门口，
 * 不是样式细节。
 *
 * 走真编辑器 + 真 React 树，不假造状态：目标是从 ProseMirror 的选区算出来的，
 * 假 doc 测不出"光标在哪一段"。
 */

vi.mock("../ipc/commands", async (importOriginal) => {
  const 真 = await importOriginal<typeof import("../ipc/commands")>();
  return {
    ...真,
    // jsdom 里没有 Tauri：事件监听那一支不会挂，这里显式钉住
    inTauri: () => false,
    api: {
      ...真.api,
      aiRewrite: vi.fn(),
      aiDocEdit: vi.fn(),
    },
  };
});

import { api } from "../ipc/commands";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function 块(content: string): EditBlock {
  return {
    kind: "paragraph",
    id: null,
    raw: content + "\n",
    gapBefore: "",
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
    blocks: 段.map((s, i) => ({ ...块(s), gapBefore: i ? "\n" : "" })),
  };
}

/** 整篇编辑要块 id：给每块补一个稳定 id，其余形状与 `篇` 相同 */
function 有id的篇(...段: string[]): EditDoc {
  return {
    frontMatter: "",
    trailingGap: "",
    blocks: 段.map((s, i) => ({
      ...块(s),
      id: `b-${i + 1}`,
      gapBefore: i ? "\n" : "",
    })),
  };
}

function 方案(edits: DocEditPlan["edits"], note: string | null = null): DocEditPlan {
  return {
    edits,
    note,
    inTokens: 7,
    outTokens: 3,
    ms: 20,
    model: "假模型",
    blocks: 2,
  };
}

const 编辑器们: Editor[] = [];
afterEach(() => {
  for (const e of 编辑器们.splice(0)) e.destroy();
  vi.clearAllMocks();
  // 假时钟只在个别用例里开；用例失败提前退出时也要收回来，否则后面整组跟着假走
  vi.useRealTimers();
});

async function 挂(editor: Editor, 全文 = "整篇正文", aiReady = true) {
  const 根 = document.createElement("div");
  document.body.appendChild(根);
  const 树 = createRoot(根);
  const onApplied = vi.fn();
  const onNeedEdit = vi.fn();
  await act(async () => {
    树.render(
      createElement(AiDock, {
        editor,
        rel: "notes/试验.md",
        aiReady,
        全文: () => 全文,
        onNeedEdit,
        onApplied,
      }),
    );
  });
  return {
    根,
    onApplied,
    onNeedEdit,
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

/** 受控输入框：要用原生 setter 再派事件，React 才认这一笔 */
async function 打字(input: HTMLTextAreaElement, 文: string) {
  const 设 = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    设.call(input, 文);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("底部 AI 对话框", () => {
  it("默认只露一条把手，点开才有面板，再点收起", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    const { 根, 拆 } = await 挂(editor);
    expect(根.querySelector(".ai-dock-panel")).toBeNull();
    const 把手 = 根.querySelector('button[aria-label="展开 AI 编辑"]')!;
    expect(把手).not.toBeNull();
    // 收起条只有图标（标题与目标状态 2026-10-28 撤掉）：文字内容必须为空
    expect(把手.textContent?.trim()).toBe("");

    await 点(把手);
    expect(根.querySelector(".ai-dock-panel")).not.toBeNull();
    // 范围开关与空态快捷指令都已撤掉：目标只看选区，没选字就是对整篇说
    expect(根.querySelector(".ai-dock-scope")).toBeNull();
    expect(根.querySelector(".ai-dock-chips")).toBeNull();

    await 点(根.querySelector('button[aria-label="收起"]')!);
    expect(根.querySelector(".ai-dock-panel")).toBeNull();
    // 收起之后把手回来：展开时它不渲染，免得面板下面再挂一个开关
    expect(根.querySelector('button[aria-label="展开 AI 编辑"]')).not.toBeNull();
    拆();
  });

  it("选中一段就改那段：选中原文显示在输入框上，不点替换正文一个字都不动", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    vi.mocked(api.aiRewrite).mockResolvedValue({
      text: "改好的",
      inTokens: 3,
      outTokens: 2,
      ms: 12,
      model: "假模型",
      ctxChars: 4,
    });
    const { 根, onApplied, 拆 } = await 挂(editor, "整篇正文");

    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    // 选中的原文就在输入框上沿：这次改哪一段，按下发送前能核对
    expect(根.querySelector(".ai-dock-sel-text")!.textContent).toBe("第一段文字");
    expect(根.querySelector(".ai-dock-sel-label")!.textContent).toContain("选中 5 字");
    const 输入 = 根.querySelector(".ai-dock-input") as HTMLTextAreaElement;
    await 打字(输入, "润色");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    // 等那个 promise 落地
    await act(async () => {});

    const 参数 = vi.mocked(api.aiRewrite).mock.calls[0]!;
    expect(参数[0]).toBe("第一段文字");
    expect(参数[1]).toBe("润色");
    // 整篇正文作背景：这一条是用户按下发送的明确动作
    expect(参数[4]).toBe("整篇正文");
    // 带上 rel：后端要靠它查隐私位（私密篇不发整篇背景）
    expect(参数[5]).toBe("notes/试验.md");
    // 回稿只在对话框里：没点替换之前正文不许动
    expect(editor.state.doc.textContent).toBe("第一段文字");
    expect(onApplied).not.toHaveBeenCalled();
    // 点发送之后焦点回到输入框：回完字能直接接着写
    expect(document.activeElement).toBe(输入);

    const 替换 = 根.querySelector(".ai-turn-actions button")!;
    expect(替换.textContent).toBe("替换选中");
    await 点(替换);
    expect(editor.state.doc.textContent).toBe("改好的");
    expect(onApplied).toHaveBeenCalledTimes(1);
    // 新文整段选中：下一句接着改同一段
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(1 + "改好的".length);
    拆();
  });

  it("有选区时目标是选区，按钮写「替换选中」", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    vi.mocked(api.aiRewrite).mockResolvedValue({
      text: "换过",
      inTokens: 1,
      outTokens: 1,
      ms: 5,
      model: "假模型",
      ctxChars: 0,
    });
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    expect(根.querySelector(".ai-dock-sel-text")!.textContent).toBe("第一段文字");
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "换个说法");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});
    // 目标写在每一轮的问题旁边（面板不再有标题行）
    expect(根.querySelector(".ai-turn-tag")!.textContent).toContain("选区 5 字");
    expect(根.querySelector(".ai-turn-actions button")!.textContent).toBe("替换选中");
    拆();
  });

  it("回稿在段首写块级记号时不落笔，并在那一轮说出原因", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    vi.mocked(api.aiRewrite).mockResolvedValue({
      text: "# 新标题",
      inTokens: 1,
      outTokens: 1,
      ms: 5,
      model: "假模型",
      ctxChars: 0,
    });
    const { 根, onApplied, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "改成标题");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    await 点(根.querySelector(".ai-turn-actions button")!);
    // 回稿会被内核读成标题：一个字都不落，理由要指到"块级记号"，不是"锚点失鲜"
    expect(editor.state.doc.textContent).toBe("第一段文字");
    expect(onApplied).not.toHaveBeenCalled();
    expect(根.querySelector(".ai-turn-err")!.textContent).toContain("块级记号");
    拆();
  });

  it("回稿预览的嵌套方向与 parseInline 一致：外层包住内层", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const 红 = 调色板[0]!.hex;
    vi.mocked(api.aiRewrite).mockResolvedValue({
      text: `<span style="color:${红}">**粗**</span>`,
      inTokens: 1,
      outTokens: 1,
      ms: 5,
      model: "假模型",
      ctxChars: 0,
    });
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "加粗并染红");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    const 段 = 根.querySelector(".ai-turn-a p")!;
    expect(段.querySelector("span strong")).not.toBeNull();
    expect(段.querySelector("strong span")).toBeNull();
    拆();
  });

  it("回稿预览认得上下标：看得到的就是落笔后的样子", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    vi.mocked(api.aiRewrite).mockResolvedValue({
      text: "H<sub>2</sub>O 与 x<sup>2</sup>",
      inTokens: 1,
      outTokens: 1,
      ms: 5,
      model: "假模型",
      ctxChars: 0,
    });
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "写下标");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    // 预览走的是同一份 parseInline：上下标不能被拍平成字面 `<sub>` 文字
    const 段 = 根.querySelector(".ai-turn-a p")!;
    expect(段.querySelector("sub")!.textContent).toBe("2");
    expect(段.querySelector("sup")!.textContent).toBe("2");
    expect(段.textContent).toBe("H2O 与 x2");
    拆();
  });

  it("落笔之后仍写发起时的字数：回稿多长都不许改写那条历史", async () => {
    // 真机照出来的一条：`目标` 在落笔时会被换成回稿（它还要跟着后续事务平移），
    // 而标签原先是从 `目标.text` 现算的——于是"选区 16 字"在替换之后自己变成了"选区 22 字"，
    // 回看时那个数已经不是用户当时圈住的那一段了
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    vi.mocked(api.aiRewrite).mockResolvedValue({
      text: "换过的一共七个字",
      inTokens: 1,
      outTokens: 1,
      ms: 5,
      model: "假模型",
      ctxChars: 0,
    });
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "换个说法");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});
    expect(根.querySelector(".ai-turn-tag")!.textContent).toContain("选区 5 字");
    await 点(根.querySelector(".ai-turn-actions button")!);
    await act(async () => {});
    // 回稿（8 字）已经进了正文，那条历史仍该说当时圈住的是 5 字
    expect(editor.state.doc.textContent).toContain("换过的一共七个字");
    expect(根.querySelector(".ai-turn-tag")!.textContent).toContain("选区 5 字");
    拆();
  });



  it("正文只有空白时不说「私密篇」——后端本来就把空白背景当没带", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    vi.mocked(api.aiRewrite).mockResolvedValue({
      text: "改好的",
      inTokens: 1,
      outTokens: 1,
      ms: 1,
      model: "假模型",
      ctxChars: 0,
    });
    const { 根, 拆 } = await 挂(editor, "  \n");
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "润色");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});
    expect(根.querySelector(".ai-turn-usage")!.textContent).not.toContain("私密篇");
    拆();
  });

  it("鼠标移入展开、移出收起；点开的才拿焦点", async () => {
    vi.useFakeTimers();
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    const { 根, 拆 } = await 挂(editor);
    const 壳 = 根.querySelector(".ai-dock")!;
    // React 的 onPointerEnter / onPointerLeave 由 pointerover / pointerout 合成
    await act(async () => {
      壳.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: null }));
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(根.querySelector(".ai-dock-panel")).not.toBeNull();
    // 悬浮展开不抢焦点：焦点还在别处
    expect(document.activeElement?.className).not.toContain("ai-dock-input");

    await act(async () => {
      壳.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: null }));
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(根.querySelector(".ai-dock-panel")).toBeNull();
    拆();
    vi.useRealTimers();
  });

  it("指针还停在面板上时，点一下空白不会把它自己收掉", async () => {
    vi.useFakeTimers();
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    const { 根, 拆 } = await 挂(editor);
    const 壳 = 根.querySelector(".ai-dock")!;
    // 真实浏览器里，鼠标移到把手上就会先收到 pointerover——这也是"用户还在这儿"的凭据
    await act(async () => {
      壳.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: null }));
    });
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    const 输入 = 根.querySelector(".ai-dock-input") as HTMLTextAreaElement;
    await act(async () => {
      输入.focus();
    });
    // 点面板空白：输入框失焦到 body，但鼠标没走
    await act(async () => {
      根.querySelector(".ai-dock-log")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(根.querySelector(".ai-dock-panel")).not.toBeNull();

    // 真的移开才收
    await act(async () => {
      壳.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: null }));
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(根.querySelector(".ai-dock-panel")).toBeNull();
    拆();
    vi.useRealTimers();
  });

  it("Esc 与点「收起」都把焦点交给重新出现的把手，不落到 body 上", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    const { 根, 拆 } = await 挂(editor);

    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await act(async () => {
      (根.querySelector(".ai-dock-input") as HTMLTextAreaElement).focus();
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(根.querySelector(".ai-dock-panel")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("展开 AI 编辑");

    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 点(根.querySelector('button[aria-label="收起"]')!);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("展开 AI 编辑");

    // 焦点在正文里、只是把面板开着：Esc 收面板可以，但不许把焦点从正文抢走
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await act(async () => {
      editor.view.focus();
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(根.querySelector(".ai-dock-panel")).toBeNull();
    expect(document.activeElement).not.toBe(根.querySelector('button[aria-label="展开 AI 编辑"]'));
    拆();
  });

  it("回车发送后输入框仍有焦点、还能接着写（生成中不锁输入）", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    let 放: (v: unknown) => void = () => {};
    vi.mocked(api.aiRewrite).mockReturnValue(
      new Promise((r) => {
        放 = r as (v: unknown) => void;
      }) as never,
    );
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    const 输入 = 根.querySelector(".ai-dock-input") as HTMLTextAreaElement;
    await act(async () => {
      输入.focus();
    });
    await 打字(输入, "润色");
    await act(async () => {
      输入.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    // 请求还在路上：输入框不能 disabled（disabled 会把焦点抢走，回完字就得重新点一下）
    expect((输入 as HTMLTextAreaElement).disabled).toBe(false);
    expect(document.activeElement).toBe(输入);

    await act(async () => {
      放({ text: "改好的", inTokens: 1, outTokens: 1, ms: 1, model: "假", ctxChars: 0 });
    });
    await act(async () => {});
    expect(根.querySelector(".ai-turn-actions button")).not.toBeNull();
    拆();
  });


  it("钉住读记录时，正文里敲字不会把记录拽回底部", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    vi.mocked(api.aiRewrite).mockResolvedValue({
      text: "改好的",
      inTokens: 1,
      outTokens: 1,
      ms: 1,
      model: "假模型",
      ctxChars: 0,
    });
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "润色");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    const 记录 = 根.querySelector(".ai-dock-log") as HTMLElement;
    Object.defineProperty(记录, "scrollHeight", { configurable: true, value: 400 });
    // 用户滚上去读自己的那一轮
    记录.scrollTop = 0;
    // 正文里敲一个字：锚点会跟着事务挪，但那不该触发"滚到底"
    await act(async () => {
      editor.view.dispatch(editor.state.tr.insertText("X", 1));
    });
    expect(记录.scrollTop).toBe(0);
    拆();
  });

  it("钉住之后鼠标移开也不收；读长回复时用得着", async () => {
    vi.useFakeTimers();
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    vi.mocked(api.aiRewrite).mockResolvedValue({
      text: "改好的",
      inTokens: 1,
      outTokens: 1,
      ms: 3,
      model: "假模型",
      ctxChars: 0,
    });
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    // 钉住常驻：不等对话出现才给，否则"想钉的时候找不到"
    expect(根.querySelector('button[aria-label="钉住"]')).not.toBeNull();
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "润色");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    const 钉 = 根.querySelector('button[aria-label="钉住"]')!;
    await 点(钉);
    expect(根.querySelector('button[aria-label="取消钉住"]')).not.toBeNull();

    // 把焦点放掉，再让指针离开——此时只剩"钉住"这一条能拦住收起
    await act(async () => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await act(async () => {
      根.querySelector(".ai-dock")!.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(根.querySelector(".ai-dock-panel")).not.toBeNull();
    拆();
    vi.useRealTimers();
  });

  it("焦点在输入框里时，指针移开也不收起（否则打字打到一半框就没了）", async () => {
    vi.useFakeTimers();
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    const 输入 = 根.querySelector(".ai-dock-input") as HTMLTextAreaElement;
    await act(async () => {
      输入.focus();
    });
    await act(async () => {
      根.querySelector(".ai-dock")!.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(根.querySelector(".ai-dock-panel")).not.toBeNull();
    拆();
    vi.useRealTimers();
  });

  /* ---- 方案 G（2026-10-30）的增量：气泡、未读点、空态指令、错误重试 ---- */

  it("收起时有没替换的结果亮未读点；替换之后熄灭", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    vi.mocked(api.aiRewrite).mockResolvedValue({
      text: "改好的",
      inTokens: 1,
      outTokens: 1,
      ms: 1,
      model: "假模型",
      ctxChars: 4,
    });
    const { 根, 拆 } = await 挂(editor);
    // 刚展开还没有对话：不亮
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    expect(根.querySelector(".ai-dock-dot")).toBeNull();
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "润色");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});
    // 收起：结果还没替换，点要亮着——"这里面有东西你没处理"
    await 点(根.querySelector('button[aria-label="收起"]')!);
    expect(根.querySelector(".ai-dock-dot")).not.toBeNull();
    // 替换掉再收起：点灭了
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 点(根.querySelector(".ai-turn-actions button")!);
    await 点(根.querySelector('button[aria-label="收起"]')!);
    expect(根.querySelector(".ai-dock-dot")).toBeNull();
    拆();
  });

  it("没选字时不给选区预览：这一次就是对整篇说的", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    expect(根.querySelector(".ai-dock-sel")).toBeNull();
    expect(
      (根.querySelector(".ai-dock-input") as HTMLTextAreaElement).placeholder,
    ).toContain("整篇");
    拆();
  });

  it("展开后再选字，预览跟着选区出现；取消选区就收回去", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    expect(根.querySelector(".ai-dock-sel")).toBeNull();

    await act(async () => {
      editor.commands.setTextSelection({ from: 1, to: 4 });
    });
    expect(根.querySelector(".ai-dock-sel-text")!.textContent).toBe("第一段");
    expect(根.querySelector(".ai-dock-sel-label")!.textContent).toContain("选中 3 字");

    await act(async () => {
      editor.commands.setTextSelection(2);
    });
    expect(根.querySelector(".ai-dock-sel")).toBeNull();
    拆();
  });

  it("模型没配好时发送只提示去设置：不调模型，也不动正文", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    const { 根, 拆 } = await 挂(editor, "整篇正文", false);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "润色");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});
    expect(根.querySelector(".ai-dock-panel > .ai-turn-err")!.textContent).toContain("设置");
    expect(api.aiRewrite).not.toHaveBeenCalled();
    expect(api.aiDocEdit).not.toHaveBeenCalled();
    expect(editor.state.doc.textContent).toBe("第一段文字");
    拆();
  });

  it("失败的轮次有「重试」：同一句话、同一段目标再发一遍，旧轮次留在历史里", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    vi.mocked(api.aiRewrite).mockRejectedValueOnce(new Error("网络断了"));
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "润色");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});
    expect(根.querySelector(".ai-turn-err")).not.toBeNull();
    const 重试 = [...根.querySelectorAll<HTMLButtonElement>(".ai-turn-actions button")].find(
      (b) => b.textContent === "重试",
    )!;
    expect(重试).not.toBeUndefined();
    vi.mocked(api.aiRewrite).mockResolvedValue({
      text: "改好的",
      inTokens: 1,
      outTokens: 1,
      ms: 1,
      model: "假模型",
      ctxChars: 4,
    });
    await 点(重试);
    await act(async () => {});
    const calls = vi.mocked(api.aiRewrite).mock.calls;
    expect(calls.length).toBe(2);
    // 同一句话、同一段目标（重试不重新判选区——沿用发起那一刻的上下文）
    expect(calls[1]![0]).toBe("第一段文字");
    expect(calls[1]![1]).toBe("润色");
    // 出错不吞历史：两条轮次都在，最新一条有了替换按钮
    expect(根.querySelectorAll(".ai-turn").length).toBe(2);
    const 末轮按钮 = [...根.querySelectorAll<HTMLButtonElement>(".ai-turn-actions button")];
    expect(末轮按钮.some((b) => b.textContent === "替换选中")).toBe(true);
    拆();
  });

  it("空回稿且明确要删：二次确认才删，只删锚定段，可撤销", async () => {
    const editor = createTestEditor(篇("第一段文字", "第二段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    vi.mocked(api.aiRewrite).mockRejectedValueOnce({
      kind: "empty-answer",
      message: "对方回了一个空：没有可替换的文字，正文一个字都没动。",
    });
    const { 根, onApplied, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "把这段删掉");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    expect(editor.state.doc.textContent).toBe("第一段文字第二段文字");
    expect(根.querySelector(".ai-turn-err")!.textContent).toContain("没有可替换的文字");

    const 按文字 = (文: string) =>
      [...根.querySelectorAll<HTMLButtonElement>(".ai-turn-actions button")].find(
        (b) => b.textContent === 文,
      );
    // 第一下只是展开确认，不删
    await 点(按文字("删除这段")!);
    expect(editor.state.doc.textContent).toBe("第一段文字第二段文字");
    expect(onApplied).not.toHaveBeenCalled();
    // 取消回到未确认态
    await 点(按文字("取消")!);
    expect(按文字("删除这段")).not.toBeUndefined();

    // 二次确认才落一笔事务
    await 点(按文字("删除这段")!);
    await 点(按文字("确认删除")!);
    expect(editor.state.doc.textContent).toBe("第二段文字");
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(根.querySelector(".ai-turn-meta")!.textContent).toContain("已删除这段文字");
    expect(按文字("删除这段")).toBeUndefined();
    expect(按文字("确认删除")).toBeUndefined();
    // 撤销是一笔事务这件事由 rewrite.test.ts 的 `删除` 用例钉住（jsdom 没有布局，
    // 在这里再 dispatch 撤销会撞上 scrollToSelection 的 getClientRects）
    拆();
  });

  it("空回稿但不是删除要求：只给重试，不给删除钮", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    vi.mocked(api.aiRewrite).mockRejectedValueOnce({
      kind: "empty-answer",
      message: "对方回了一个空：没有可替换的文字，正文一个字都没动。",
    });
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "润色");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    const 按钮 = [...根.querySelectorAll<HTMLButtonElement>(".ai-turn-actions button")].map(
      (b) => b.textContent,
    );
    expect(按钮).toContain("重试");
    expect(按钮).not.toContain("删除这段");
    拆();
  });

  it("空回稿 + 用户说的是「不要删」：不给删除钮", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    vi.mocked(api.aiRewrite).mockRejectedValueOnce({
      kind: "empty-answer",
      message: "对方回了一个空：没有可替换的文字，正文一个字都没动。",
    });
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "不要删掉这段");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    const 按钮 = [...根.querySelectorAll<HTMLButtonElement>(".ai-turn-actions button")].map(
      (b) => b.textContent,
    );
    expect(按钮).toContain("重试");
    expect(按钮).not.toContain("删除这段");
    拆();
  });

  it("等确认期间目标被改过：删除被拒并说明，正文不动", async () => {
    const editor = createTestEditor(篇("第一段文字", "第二段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    vi.mocked(api.aiRewrite).mockRejectedValueOnce({
      kind: "empty-answer",
      message: "对方回了一个空：没有可替换的文字，正文一个字都没动。",
    });
    const { 根, onApplied, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "删掉这段");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    // 改的是锚点内部：位移会跟着事务挪，但那几个字节已经不是原来那段了
    await act(async () => {
      editor.view.dispatch(editor.state.tr.insertText("X", 2));
    });
    const 按文字 = (文: string) =>
      [...根.querySelectorAll<HTMLButtonElement>(".ai-turn-actions button")].find(
        (b) => b.textContent === 文,
      );
    await 点(按文字("删除这段")!);
    await 点(按文字("确认删除")!);
    expect(editor.state.doc.textContent).toBe("第X一段文字第二段文字");
    expect(onApplied).not.toHaveBeenCalled();
    expect(根.querySelector(".ai-turn-err")!.textContent).toContain("被改过");
    expect(按文字("删除这段")).toBeUndefined();
    拆();
  });

  it("整篇清空：不调模型，二次确认才清空全部正文", async () => {
    const editor = createTestEditor(篇("第一段文字", "第二段文字", "第三段文字"));
    编辑器们.push(editor);
    const { 根, onApplied, 拆 } = await 挂(editor, "第一段文字第二段文字第三段文字");
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "清空文档内容");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    expect(api.aiRewrite).not.toHaveBeenCalled();
    expect(editor.state.doc.textContent).toBe("第一段文字第二段文字第三段文字");
    const 卡 = 根.querySelector(".ai-doc-danger")!;
    expect(卡).not.toBeNull();
    expect(卡.textContent).toContain("整篇清空");
    const 按 = (文: string) =>
      [...卡.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === 文);

    await 点(按("清空整篇正文")!);
    expect(editor.state.doc.textContent).toBe("第一段文字第二段文字第三段文字");
    expect(onApplied).not.toHaveBeenCalled();
    await 点(按("取消")!);
    await 点(按("清空整篇正文")!);
    await 点(按("确认清空")!);

    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.textContent).toBe("");
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(根.querySelector(".ai-doc-danger")).toBeNull();
    expect(
      [...根.querySelectorAll(".ai-turn-meta")].some((p) =>
        p.textContent?.includes("已清空整篇正文"),
      ),
    ).toBe(true);
    拆();
  });

  it("整篇清空优先于段落：有选区也走整篇确认，不发给模型", async () => {
    const editor = createTestEditor(篇("第一段文字", "第二段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "清空整个文档");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    expect(api.aiRewrite).not.toHaveBeenCalled();
    expect(根.querySelector(".ai-doc-danger")).not.toBeNull();
    expect(
      [...根.querySelectorAll<HTMLButtonElement>(".ai-turn-actions button")].some(
        (b) => b.textContent === "删除这段",
      ),
    ).toBe(false);
    拆();
  });

  it("整篇清空确认前文档被改过：拒绝并保留新写的内容", async () => {
    const editor = createTestEditor(篇("第一段文字", "第二段文字"));
    编辑器们.push(editor);
    const { 根, onApplied, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "清空文档内容");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    const 卡 = 根.querySelector(".ai-doc-danger")!;
    const 按 = (文: string) =>
      [...卡.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === 文);
    await act(async () => {
      editor.view.dispatch(editor.state.tr.insertText("X", 2));
    });
    await 点(按("清空整篇正文")!);
    await 点(按("确认清空")!);

    expect(editor.state.doc.textContent).toBe("第X一段文字第二段文字");
    expect(onApplied).not.toHaveBeenCalled();
    expect(根.querySelector(".ai-turn-err")!.textContent).toContain("被改过");
    expect(根.querySelector(".ai-doc-danger")).toBeNull();
    expect([...根.querySelectorAll<HTMLButtonElement>("button")].some((b) => b.textContent === "重试")).toBe(
      false,
    );
    拆();
  });

  it("整篇清空不依赖模型：没配模型也能用", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    const { 根, 拆 } = await 挂(editor, "整篇正文", false);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "清空文档内容");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    expect(api.aiRewrite).not.toHaveBeenCalled();
    expect(根.querySelector(".ai-doc-danger")).not.toBeNull();
    expect(
      (根.querySelector(".ai-dock-input") as HTMLTextAreaElement).placeholder,
    ).toContain("整篇清空");
    拆();
  });

  it("正文已经是空的时候不摆整篇清空确认", async () => {
    const editor = createTestEditor(篇(""));
    编辑器们.push(editor);
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "清空文档内容");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    expect(根.querySelector(".ai-doc-danger")).toBeNull();
    expect(根.querySelector(".ai-dock-panel > .ai-turn-err")!.textContent).toContain("已经是空");
    拆();
  });

  it("整篇范围内改一处 / 否定 / 部分：都不是整篇清空，交给模型", async () => {
    for (const 句 of ["删掉整篇里多余的空行", "不要整篇重写，只改第二段", "整篇删减一半"]) {
      vi.mocked(api.aiDocEdit).mockClear();
      const editor = createTestEditor(有id的篇("第一段", "第二段"));
      编辑器们.push(editor);
      vi.mocked(api.aiDocEdit).mockResolvedValue(
        方案([{ op: "replace", id: "b-1", text: "改过的第一段" }], "改一处"),
      );
      const { 根, 拆 } = await 挂(editor);
      await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
      await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, 句);
      await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
      await act(async () => {});

      expect(根.querySelector(".ai-doc-danger"), 句).toBeNull();
      expect(api.aiDocEdit, 句).toHaveBeenCalledTimes(1);
      // 正文一个字都不动：计划只摆在对话框里
      expect(editor.state.doc.textContent, 句).toBe("第一段第二段");
      拆();
    }
  });

  it("整篇编辑：计划只在对话框预览，点「应用修改」才落正文", async () => {
    const editor = createTestEditor(有id的篇("第一段", "第二段"));
    编辑器们.push(editor);
    vi.mocked(api.aiDocEdit).mockResolvedValue(
      方案([{ op: "replace", id: "b-1", text: "改过的第一段" }], "改一处"),
    );
    const { 根, onApplied, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    // 没选字：不显示选区预览，这一次按整篇处理
    expect(根.querySelector(".ai-dock-sel")).toBeNull();
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "把第一段改成改过的第一段");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    expect(api.aiRewrite).not.toHaveBeenCalled();
    const 调用 = vi.mocked(api.aiDocEdit).mock.calls[0]!;
    expect(调用[0].map((b) => b.id)).toEqual(["b-1", "b-2"]);
    expect(调用[1]).toBe("把第一段改成改过的第一段");
    expect(调用[2]).toBe("notes/试验.md");
    expect(调用[3]).toEqual([]);
    // 计划只在对话框里：没点应用前正文一个字都不动
    expect(editor.state.doc.textContent).toBe("第一段第二段");
    const 计划卡 = 根.querySelector(".ai-doc-plan")!;
    expect(计划卡).not.toBeNull();
    expect(计划卡.textContent).toContain("整篇编辑方案（1 处修改）");
    expect(计划卡.textContent).toContain("改一处");
    expect(计划卡.textContent).toContain("改过的第一段");

    const 按卡 = (卡: Element, 文: string) =>
      [...卡.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent === 文,
      );
    await 点(按卡(计划卡, "取消")!);
    expect(根.querySelector(".ai-doc-plan")).toBeNull();
    expect(editor.state.doc.textContent).toBe("第一段第二段");
    expect(onApplied).not.toHaveBeenCalled();
    expect(根.textContent).toContain("已取消，正文未改");

    // 再发一次并应用：只改 b-1，b-2 原样
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "把第一段改成改过的第一段");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});
    const 计划卡2 = 根.querySelector(".ai-doc-plan")!;
    await 点(按卡(计划卡2, "应用修改")!);
    expect(editor.state.doc.textContent).toBe("改过的第一段第二段");
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(根.querySelector(".ai-doc-plan")).toBeNull();
    expect(根.textContent).toContain("已应用 1 处修改");
    拆();
  });

  it("整篇编辑：应用前文档被改过就拒绝，正文不动", async () => {
    const editor = createTestEditor(有id的篇("第一段", "第二段"));
    编辑器们.push(editor);
    vi.mocked(api.aiDocEdit).mockResolvedValue(
      方案([{ op: "replace", id: "b-1", text: "改过的第一段" }]),
    );
    const { 根, onApplied, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "改第一段");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    const 计划卡 = 根.querySelector(".ai-doc-plan")!;
    const 应用 = [...计划卡.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "应用修改",
    )!;
    await act(async () => {
      editor.view.dispatch(editor.state.tr.insertText("X", 2));
    });
    await 点(应用);

    expect(editor.state.doc.textContent).toBe("第X一段第二段");
    expect(onApplied).not.toHaveBeenCalled();
    expect(根.querySelector(".ai-turn-err")!.textContent).toContain("被改过");
    expect(根.querySelector(".ai-doc-plan")).toBeNull();
    拆();
  });

  it("整篇编辑：模型说不用改时只给说明，不给应用按钮", async () => {
    const editor = createTestEditor(有id的篇("第一段"));
    编辑器们.push(editor);
    vi.mocked(api.aiDocEdit).mockResolvedValue(方案([], "这篇已经很简洁"));
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "简化整篇");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    const 计划卡 = 根.querySelector(".ai-doc-plan")!;
    expect(计划卡.textContent).toContain("这篇已经很简洁");
    expect(
      [...计划卡.querySelectorAll<HTMLButtonElement>("button")].some(
        (b) => b.textContent === "应用修改",
      ),
    ).toBe(false);
    const 知道了 = [...计划卡.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "知道了",
    )!;
    await 点(知道了);
    expect(根.textContent).toContain("已取消，正文未改");
    expect(editor.state.doc.textContent).toBe("第一段");
    拆();
  });

  it("整篇计划应用后，模型那句说明仍随下一轮带去（历史不丢）", async () => {
    const editor = createTestEditor(有id的篇("第一段"));
    编辑器们.push(editor);
    vi.mocked(api.aiDocEdit).mockResolvedValue(
      方案([{ op: "replace", id: "b-1", text: "改过" }], "把第一段改短了"),
    );
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "改第一段");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    const 计划卡 = 根.querySelector(".ai-doc-plan")!;
    await 点(
      [...计划卡.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent === "应用修改",
      )!,
    );
    expect(根.textContent).toContain("已应用 1 处修改");

    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "再正式一点");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    const 历史 = vi.mocked(api.aiDocEdit).mock.calls[1]![3];
    expect(历史).toContainEqual({ role: "assistant", text: "把第一段改短了" });
    拆();
  });

  it("整篇编辑失败：显示错误且正文不动", async () => {
    const editor = createTestEditor(有id的篇("第一段"));
    编辑器们.push(editor);
    vi.mocked(api.aiDocEdit).mockRejectedValueOnce({
      kind: "error",
      message: "网络断了",
    });
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "改整篇");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    expect(根.querySelector(".ai-turn-err")!.textContent).toContain("网络断了");
    expect(根.querySelector(".ai-doc-plan")).toBeNull();
    expect(editor.state.doc.textContent).toBe("第一段");
    拆();
  });

  it("空文档可以直接让 AI 写整篇：不带块、从文首插入，确认后落正文", async () => {
    const editor = createTestEditor(篇());
    编辑器们.push(editor);
    vi.mocked(api.aiDocEdit).mockResolvedValue(
      方案(
        [
          { op: "insert_after", after: null, kind: "heading1", text: "备份纪律" },
          { op: "insert_after", after: null, kind: "paragraph", text: "唯一副本不算备份。" },
        ],
        "写了一篇短文",
      ),
    );
    const { 根, onApplied, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "写一篇关于备份纪律的短文");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    // 空文档也要发：blocks 是空数组，模型据此从零写
    expect(vi.mocked(api.aiDocEdit).mock.calls[0]![0]).toEqual([]);
    expect(editor.state.doc.textContent).toBe("");
    const 计划卡 = 根.querySelector(".ai-doc-plan")!;
    expect(计划卡.textContent).toContain("整篇编辑方案（2 处修改）");

    await 点(
      [...计划卡.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent === "应用修改",
      )!,
    );
    expect(editor.state.doc.firstChild!.type.name).toBe("mdHeading");
    expect(editor.state.doc.textContent).toContain("备份纪律");
    expect(editor.state.doc.textContent).toContain("唯一副本不算备份。");
    expect(onApplied).toHaveBeenCalledTimes(1);
    拆();
  });

  it("没有块 id 的真实笔记也能整篇改：发的是快照序号键，不是空清单", async () => {
    const editor = createTestEditor(篇("第一段", "第二段"));
    编辑器们.push(editor);
    vi.mocked(api.aiDocEdit).mockResolvedValue(
      方案([{ op: "replace", id: "i-2", text: "改过的第二段" }]),
    );
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "改第二段");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    const 块们 = vi.mocked(api.aiDocEdit).mock.calls[0]![0];
    expect(块们.map((b) => b.id)).toEqual(["i-1", "i-2"]);
    expect(根.querySelector(".ai-turn-err")).toBeNull();

    const 计划卡 = 根.querySelector(".ai-doc-plan")!;
    await 点(
      [...计划卡.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent === "应用修改",
      )!,
    );
    expect(editor.state.doc.textContent).toBe("第一段改过的第二段");
    拆();
  });

  it("排版要求可以把段落改成标题：预览说清换类型，应用后层级生效", async () => {
    const editor = createTestEditor(篇("小节标题", "正文一段"));
    编辑器们.push(editor);
    vi.mocked(api.aiDocEdit).mockResolvedValue(
      方案([{ op: "replace", id: "i-1", kind: "heading2", text: "小节标题" }]),
    );
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "优化排版，把小节标题变成二级标题");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    const 计划卡 = 根.querySelector(".ai-doc-plan")!;
    expect(计划卡.textContent).toContain("heading2");
    await 点(
      [...计划卡.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent === "应用修改",
      )!,
    );
    expect(editor.state.doc.firstChild!.type.name).toBe("mdHeading");
    expect(editor.state.doc.firstChild!.attrs.mdLevel).toBe(2);
    拆();
  });

  it("整篇问答接着问时带上上一轮问与答，文档仍以当前块为准", async () => {
    const editor = createTestEditor(篇("备份要保留三份", "唯一副本不算备份"));
    编辑器们.push(editor);
    vi.mocked(api.aiDocEdit).mockResolvedValueOnce(
      方案([], "这篇讲备份纪律：保留多份，唯一副本不算备份。"),
    );
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "这篇讲了什么");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    vi.mocked(api.aiDocEdit).mockResolvedValueOnce(方案([], "第二点是指唯一副本不算备份。"));
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "第二点具体说说");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    const 第二趟 = vi.mocked(api.aiDocEdit).mock.calls[1]!;
    expect(第二趟[3]).toEqual([
      { role: "user", text: "这篇讲了什么" },
      { role: "assistant", text: "这篇讲备份纪律：保留多份，唯一副本不算备份。" },
    ]);
    expect(根.textContent).toContain("第二点是指唯一副本不算备份。");
    拆();
  });

  it("显式样式动词本地执行：不调模型、当场落笔，历史里说清是本地", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    // 没配模型也能用：样式动词本来就不需要模型
    const { 根, onApplied, 拆 } = await 挂(editor, "整篇正文", false);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    const 输入 = 根.querySelector(".ai-dock-input") as HTMLTextAreaElement;
    await 打字(输入, "加粗");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    expect(api.aiRewrite).not.toHaveBeenCalled();
    expect(api.aiDocEdit).not.toHaveBeenCalled();
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(editor.state.doc.rangeHasMark(1, 6, editor.state.schema.marks.bold!.create())).toBe(true);
    // 草稿清空，可以直接接着说要改什么
    expect(输入.value).toBe("");

    const 动作 = 根.querySelector(".ai-turn-actions")!;
    expect(动作.textContent).toContain("本地执行");
    expect(动作.textContent).toContain("未调用模型");
    // 已经落进正文：没有「替换」也没有「复制」
    expect(动作.querySelectorAll("button").length).toBe(0);
    拆();
  });

  it("本地样式命令没有改动：不发事务、不标脏，历史里说「没有改动」", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const { 根, onApplied, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "取消加粗");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    expect(api.aiRewrite).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
    expect(editor.state.doc.textContent).toBe("第一段文字");
    expect(根.querySelector(".ai-turn-actions")!.textContent).toContain("没有改动");
    拆();
  });

  it("带内容要求的句子不被本地截走，仍然交给模型", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 6 });
    vi.mocked(api.aiRewrite).mockResolvedValue({
      text: "改得正式些",
      inTokens: 1,
      outTokens: 1,
      ms: 3,
      model: "假模型",
      ctxChars: 0,
    });
    const { 根, 拆 } = await 挂(editor);
    await 点(根.querySelector('button[aria-label="展开 AI 编辑"]')!);
    await 打字(
      根.querySelector(".ai-dock-input") as HTMLTextAreaElement,
      "把这段加粗一点顺便正式些",
    );
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});

    expect(api.aiRewrite).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.aiRewrite).mock.calls[0]![1]).toBe("把这段加粗一点顺便正式些");
    // 仍然走"预览 → 点替换"：没点之前正文一个字不动
    expect(editor.state.doc.textContent).toBe("第一段文字");
    expect(根.querySelector(".ai-turn-actions button")!.textContent).toBe("替换选中");
    拆();
  });
});
