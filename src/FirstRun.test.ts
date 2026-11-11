import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AppInfo } from "./ipc/types";
import { FirstRun } from "./FirstRun";

/**
 * 首启第二步的回归：库已经选好、只是备份那一步没答完时，界面必须**直接从第二步开始**。
 * 上一版的毛病在 App 那一层（只判 `vaultPath` 就放行），这里钉的是 FirstRun 接住
 * `已有库` 之后的行为：不再问一遍库放哪儿，也不再白打一趟 `vault_default_path`。
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { 默认路径 } = vi.hoisted(() => ({
  默认路径: vi.fn(async () => "D:\\Notes"),
}));
vi.mock("./ipc/commands", () => ({
  api: {
    vaultDefaultPath: () => 默认路径(),
    vaultOpen: vi.fn(),
    backupSet: vi.fn(),
  },
}));

const 库: AppInfo = {
  version: "0.1.0",
  vaultPath: "D:\\Notes",
  indexNotes: 3,
  schemaVersion: 1,
  backupDir: null,
  backupDisabled: false,
  backupLastAt: null,
};

const 活的: (() => void)[] = [];
afterEach(() => {
  for (const 拆 of 活的) 拆();
  活的.length = 0;
  默认路径.mockClear();
});

function 挂(已有库: AppInfo | null) {
  const 根 = document.createElement("div");
  document.body.appendChild(根);
  const 树 = createRoot(根);
  act(() => {
    树.render(createElement(FirstRun, { 已有库, onOpened: () => {} }));
  });
  活的.push(() => {
    act(() => 树.unmount());
    根.remove();
  });
  return 根;
}

it("库已有、备份没答完时，直接从第二步开始", async () => {
  let 根!: HTMLElement;
  await act(async () => {
    根 = 挂(库);
  });
  expect(根.textContent).toContain("再给备份挑一个目录");
  expect(根.textContent).toContain(库.vaultPath!);
  expect(根.textContent).not.toContain("选一个目录放你的笔记");
  // 库已经开好了，这一步不该再去问默认路径
  expect(默认路径).not.toHaveBeenCalled();
});

it("库还没有时仍是第一步，默认路径由后端给", async () => {
  let 根!: HTMLElement;
  await act(async () => {
    根 = 挂(null);
  });
  expect(根.textContent).toContain("选一个目录放你的笔记");
  expect(默认路径).toHaveBeenCalledTimes(1);
  const 输入 = 根.querySelector("#vault-path") as HTMLInputElement;
  expect(输入.value).toBe("D:\\Notes");
});
