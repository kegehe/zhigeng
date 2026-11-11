import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { LinkPanel, LinkRow } from "../ipc/types";
import { LinkPanelView } from "./Links";

/**
 * 反链面板的交互入口。纯判定在 `backlinks.test.ts`，这里钉的是**那颗按钮出没出来、
 * 点了传什么**——判定说"可新建"不等于界面上真有入口。
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const 行 = (改: Partial<LinkRow>): LinkRow => ({
  rel: "",
  title: "",
  status: "missing",
  snippet: "",
  toBlock: false,
  toNote: false,
  kind: "ref",
  target: "",
  broken: true,
  ...改,
});

const 面板 = (出: LinkRow[]): LinkPanel => ({
  rel: "notes/甲.md",
  incoming: [],
  incomingTruncated: false,
  outgoing: 出,
  outgoingTruncated: false,
});

const 活的: (() => void)[] = [];
afterEach(() => {
  for (const 拆 of 活的) 拆();
  活的.length = 0;
});

function 挂(
  panel: LinkPanel,
  动作: {
    onOpen?: (rel: string, title: string) => void;
    onCreate?: (title: string) => void;
  } = {},
) {
  const 根 = document.createElement("div");
  document.body.appendChild(根);
  const 树 = createRoot(根);
  act(() => {
    树.render(
      createElement(LinkPanelView, {
        panel,
        onOpen: 动作.onOpen ?? (() => {}),
        onCreate: 动作.onCreate ?? (() => {}),
      }),
    );
  });
  活的.push(() => {
    act(() => 树.unmount());
    根.remove();
  });
  return 根;
}

const 按钮 = (根: HTMLElement, 文: string) =>
  [...根.querySelectorAll("button")].find((b) => b.textContent?.includes(文)) ?? null;

it("悬空的笔记写法给「新建这篇并打开」，点下去交的是用户写下的原文", () => {
  const onCreate = vi.fn();
  const 根 = 挂(面板([行({ title: "悬空写法", target: "悬空写法" })]), { onCreate });
  const 钮 = 按钮(根, "新建这篇并打开");
  expect(钮).not.toBeNull();
  act(() => 钮!.click());
  expect(onCreate).toHaveBeenCalledWith("悬空写法");
});

it("悬空的资产写法不给新建：那一行仍然是不可点的", () => {
  const onCreate = vi.fn();
  const 根 = 挂(面板([行({ kind: "asset", title: "photo.png", target: "photo.png" })]), {
    onCreate,
  });
  expect(按钮(根, "新建这篇并打开")).toBeNull();
  expect(按钮(根, "photo.png")?.disabled).toBe(true);
});

it("已有的笔记行照旧点开，不出现新建入口", () => {
  const onOpen = vi.fn();
  const 根 = 挂(
    面板([
      行({ broken: false, rel: "notes/乙.md", title: "乙", toNote: true, status: "active" }),
    ]),
    { onOpen },
  );
  expect(按钮(根, "新建这篇并打开")).toBeNull();
  act(() => 按钮(根, "乙")!.click());
  expect(onOpen).toHaveBeenCalledWith("notes/乙.md", "乙");
});
