import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CapturedOut } from "./ipc/types";
import { Capture } from "./Capture";

/**
 * 速记窗的索引回执，钉的是监听器**装配**这一层。
 *
 * 回归的 bug：回执曾经按 boolean / 空数组猜，`[]` 在 JS 里是真值，提醒从来没出现过。
 * 现在负载是 `{ rel, ok }`：带 rel 才能分清"这一笔"和"上一笔还没落地的回执"。
 * 只测纯函数挡不住它——坏的是 `listen<索引回执>`、事件名与三种结果的分派，所以这里
 * 把命令、事件、窗口三处都挡住，直接看屏幕上留下了什么。
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type 回执负载 = { rel: string; ok: boolean };

const { 落盘, 关窗, 隐藏, 事件名, 收据 } = vi.hoisted(() => ({
  落盘: vi.fn(),
  关窗: vi.fn(async () => {}),
  隐藏: vi.fn(async () => {}),
  事件名: { 值: "" },
  收据: { 处理: null as null | ((e: { payload: 回执负载 }) => void) },
}));

vi.mock("./ipc/commands", () => ({
  api: { captureText: (t: string) => 落盘(t) },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close: 关窗, hide: 隐藏 }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (名: string, 处理: (e: { payload: 回执负载 }) => void) => {
    事件名.值 = 名;
    收据.处理 = 处理;
    return () => {
      收据.处理 = null;
    };
  },
}));
vi.mock("lucide-react", () => ({ X: () => null }));

const 结果: CapturedOut = {
  rel: "inbox/一条速记.md",
  id: "n-1",
  title: "一条速记",
  contentHash: "h",
  created: "2026-11-08T00:00:00Z",
  indexMs: 3,
};

const 活的: (() => void)[] = [];

beforeEach(() => {
  // jsdom 没有 matchMedia；速记窗挂载时会问一次主题
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  vi.useFakeTimers();
});

afterEach(() => {
  for (const 拆 of 活的) 拆();
  活的.length = 0;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
  收据.处理 = null;
  事件名.值 = "";
});

/** 等到组件把事件订阅上（它走的是动态 import + 异步 listen） */
async function 冲() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function 挂() {
  const 根 = document.createElement("div");
  document.body.appendChild(根);
  const 树 = createRoot(根);
  await act(async () => {
    树.render(createElement(Capture));
  });
  活的.push(() => {
    act(() => 树.unmount());
    根.remove();
  });
  await 冲();
  expect(收据.处理).not.toBeNull();
  // 只听自己的事件：通用 note://indexed 的空数组可能是别的窗口的失败
  expect(事件名.值).toBe("note://capture-indexed");
  return 根;
}

function 打字(根: HTMLElement, 文: string): HTMLTextAreaElement {
  const 框 = 根.querySelector("textarea")!;
  const 设值 = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    设值.call(框, 文);
    框.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return 框;
}

function 回车(框: HTMLTextAreaElement) {
  act(() => {
    框.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

it("后台回执 ok=false 时说出'搜索还没更新'，并且不再自动收起", async () => {
  落盘.mockResolvedValue(结果);
  const 根 = await 挂();
  回车(打字(根, "一条速记"));
  await 冲();
  expect(根.textContent).toContain("已保存");

  await act(async () => {
    收据.处理!({ payload: { rel: 结果.rel, ok: false } });
  });
  expect(根.textContent).toContain("搜索还没更新");
  expect(根.textContent).toContain("暂时搜不到");

  // 450ms 的自动收起已经撤掉：再等下去也不许收
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  expect(隐藏).not.toHaveBeenCalled();
});

it("回执是这一篇且 ok=true 时，不报警，照常收起", async () => {
  落盘.mockResolvedValue(结果);
  const 根 = await 挂();
  回车(打字(根, "一条速记"));
  await 冲();

  await act(async () => {
    收据.处理!({ payload: { rel: 结果.rel, ok: true } });
  });
  expect(根.textContent).not.toContain("搜索还没更新");
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  // 收起必须是 hide：销毁窗口会连监听器一起带走，晚到的回执就没处说了
  expect(隐藏).toHaveBeenCalledTimes(1);
  expect(关窗).not.toHaveBeenCalled();
});

it("手动收起会撤掉自动收起：收起后再等，不会被旧定时器再收一次", async () => {
  落盘.mockResolvedValue(结果);
  const 根 = await 挂();
  const 框 = 打字(根, "一条速记");
  回车(框);
  await 冲();

  // 450ms 还没到，用户先按 Esc 收起
  act(() => {
    框.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(隐藏).toHaveBeenCalledTimes(1);
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  // 旧定时器已经被手动收起撤掉，不该再来第二下
  expect(隐藏).toHaveBeenCalledTimes(1);
});

it("自动收起之后才到的失败回执仍然留下提醒", async () => {
  落盘.mockResolvedValue(结果);
  const 根 = await 挂();
  回车(打字(根, "一条速记"));
  await 冲();

  // 后台索引被导入占着时会晚于 450ms
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  expect(隐藏).toHaveBeenCalledTimes(1);

  // 窗口只是收起、JS 还活着：回执到了照样要落到状态里，下次唤出看得见
  await act(async () => {
    收据.处理!({ payload: { rel: 结果.rel, ok: false } });
  });
  expect(根.textContent).toContain("搜索还没更新");
});

it("回执比命令先到（路径还不知道）也认得出失败", async () => {
  let 交卷!: (v: CapturedOut) => void;
  落盘.mockReturnValue(
    new Promise((收) => {
      交卷 = 收;
    })
  );
  const 根 = await 挂();
  回车(打字(根, "一条速记"));
  await 冲();

  // 命令还没返回：先按 rel 存着，不能这时就报（上一笔的回执也会落进这个空档）
  await act(async () => {
    收据.处理!({ payload: { rel: 结果.rel, ok: false } });
  });
  expect(根.textContent).not.toContain("搜索还没更新");

  await act(async () => {
    交卷(结果);
  });
  await 冲();
  // 命令返回后按 res.rel 认领：这一笔确实没补上
  expect(根.textContent).toContain("搜索还没更新");
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  expect(隐藏).not.toHaveBeenCalled();
});

it("上一笔的回执带 rel，不会算到这一笔头上", async () => {
  let 交卷!: (v: CapturedOut) => void;
  落盘.mockReturnValue(
    new Promise((收) => {
      交卷 = 收;
    })
  );
  const 根 = await 挂();
  回车(打字(根, "一条速记"));
  await 冲();

  // 命令还没返回，上一笔速记的失败回执先到：它带的是别的 rel
  await act(async () => {
    收据.处理!({ payload: { rel: "inbox/上一笔.md", ok: false } });
  });

  await act(async () => {
    交卷(结果);
  });
  await 冲();
  expect(根.textContent).not.toContain("搜索还没更新");
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  expect(隐藏).toHaveBeenCalledTimes(1);
});

it("保存还没返回时接着打字：返回后不吞字、也不自动收起", async () => {
  let 交卷!: (v: CapturedOut) => void;
  落盘.mockReturnValue(
    new Promise((收) => {
      交卷 = 收;
    })
  );
  const 根 = await 挂();
  const 框 = 打字(根, "第一条");
  回车(框);
  await 冲();
  expect(根.textContent).toContain("保存中");

  // 命令还在飞，用户已经接着写第二条
  打字(根, "第二条");
  await act(async () => {
    交卷(结果);
  });
  await 冲();

  // 第一条存完了，但框里那截不能被他自己的返回值清掉
  expect(框.value).toBe("第二条");
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  expect(隐藏).not.toHaveBeenCalled();

  // 保存守卫也要放开：下一条 Enter 能把第二条交出去
  回车(框);
  await 冲();
  expect(落盘).toHaveBeenLastCalledWith("第二条");
});

it("存完接着写下一句时不自动收起，也不把这一句吞掉", async () => {
  落盘.mockResolvedValue(结果);
  const 根 = await 挂();
  回车(打字(根, "第一条"));
  await 冲();
  expect(根.textContent).toContain("已保存");

  const 框 = 打字(根, "第二条");
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  expect(隐藏).not.toHaveBeenCalled();
  expect(框.value).toBe("第二条");
});
