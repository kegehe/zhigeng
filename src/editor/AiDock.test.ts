import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";

import { AiDock } from "./AiDock";
import type { EditBlock, EditDoc } from "./blocks";
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

const 编辑器们: Editor[] = [];
afterEach(() => {
  for (const e of 编辑器们.splice(0)) e.destroy();
  vi.clearAllMocks();
  // 假时钟只在个别用例里开；用例失败提前退出时也要收回来，否则后面整组跟着假走
  vi.useRealTimers();
});

async function 挂(editor: Editor, 全文 = "整篇正文") {
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
        aiReady: true,
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

    await 点(根.querySelector('button[aria-label="收起"]')!);
    expect(根.querySelector(".ai-dock-panel")).toBeNull();
    // 收起之后把手回来：展开时它不渲染，免得面板下面再挂一个开关
    expect(根.querySelector('button[aria-label="展开 AI 编辑"]')).not.toBeNull();
    拆();
  });

  it("没有选区就改光标所在的那一段；不点替换，正文一个字都不动", async () => {
    const editor = createTestEditor(篇("第一段文字"));
    编辑器们.push(editor);
    editor.commands.setTextSelection(2);
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
    expect(替换.textContent).toBe("替换本段");
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
    await 打字(根.querySelector(".ai-dock-input") as HTMLTextAreaElement, "换个说法");
    await 点(根.querySelector('.ai-dock-foot button[aria-label="发送"]')!);
    await act(async () => {});
    // 目标写在每一轮的问题旁边（面板不再有标题行）
    expect(根.querySelector(".ai-turn-tag")!.textContent).toContain("选区 5 字");
    expect(根.querySelector(".ai-turn-actions button")!.textContent).toBe("替换选中");
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
});
