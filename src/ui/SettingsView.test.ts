import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AppInfo, AiView } from "../ipc/types";
import type { AI表单 } from "./settings";
import { SettingsView } from "./SettingsView";

/**
 * 设置页是纯视图，钉的是**用户看得见**的几件事：
 * - 已存 Key 时「删除 Key」是独立一枚，输入框留空才按得动——存与删不再共用一枚按钮，
 *   免得存成功后标签当场翻成"删除"、双击的第二下把刚存的 Key 删掉；
 * - 存完配置的回话落在右下角的 `role="status"` 上，不再钉在页顶（长页里会滚出屏幕）；
 * - 草稿与盘上不一致时说明测试读的是哪一份；盘上没配齐时说的是"先保存再测试"。
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const 活的: { 拆: () => void; 拆过: boolean }[] = [];
afterEach(() => {
  for (const o of 活的) if (!o.拆过) o.拆();
  活的.length = 0;
});

const 信息: AppInfo = {
  version: "0.1.0",
  vaultPath: "D:\\Notes",
  indexNotes: 12,
  schemaVersion: 3,
  backupDir: null,
  backupDisabled: false,
  backupUnconfigured: true,
  backupLastAt: null,
};

function 视图(over: Partial<AiView> = {}): AiView {
  return {
    baseUrl: "https://api.openai.com/v1",
    chatModel: "gpt-4o-mini",
    embeddingModel: "",
    rerank: false,
    keySet: false,
    keyHint: null,
    ...over,
  };
}

function 挂(over: {
  view?: AiView | null;
  form?: AI表单;
  key?: string;
  flash?: string | null;
  存Key?: () => void;
}) {
  const view = over.view === undefined ? 视图() : over.view;
  const form =
    over.form ?? {
      baseUrl: view?.baseUrl ?? "",
      chatModel: view?.chatModel ?? "",
      embeddingModel: view?.embeddingModel ?? "",
      rerank: view?.rerank ?? false,
    };
  const 根 = document.createElement("div");
  document.body.appendChild(根);
  const 树 = createRoot(根);
  act(() => {
    树.render(
      createElement(SettingsView, {
        info: 信息,
        flash: over.flash ?? null,
        onBack: () => {},
        外观: { theme: "system", setTheme: () => {} },
        备份: { draft: "", setDraft: () => {}, 忙: false, 应用: () => {} },
        模型: {
          view,
          form,
          setForm: () => {},
          key: over.key ?? "",
          setKey: () => {},
          忙: null,
          报告: null,
          发现: null,
          保存: () => {},
          存Key: over.存Key ?? (() => {}),
          测试: () => {},
          发现模型: () => {},
        },
        库: { 忙: false, 打开: () => {} },
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

function 按文字(根: HTMLElement, 文: string): HTMLButtonElement | null {
  return (
    (Array.from(根.querySelectorAll("button")).find((b) => b.textContent?.trim() === 文) as
      | HTMLButtonElement
      | undefined) ?? null
  );
}

it("已存 Key 且输入框留空时，「删除 Key」是独立一枚并按得动", async () => {
  const 存 = vi.fn();
  const { 根, 拆 } = 挂({ view: 视图({ keySet: true, keyHint: "…ab12（32 位）" }), key: "", 存Key: 存 });
  // 存的那一枚空着就按不动，删的那一枚按得动：两件事各占一枚按钮
  expect(按文字(根, "存 Key")!.disabled).toBe(true);
  const 钮 = 按文字(根, "删除 Key");
  expect(钮).not.toBeNull();
  expect(钮!.disabled).toBe(false);
  await act(async () => {
    钮!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(存).toHaveBeenCalledTimes(1);
  拆();
});

it("输入框里有新 Key 时，删的那一枚是灰的；没存过就没这一枚", () => {
  const { 根, 拆 } = 挂({ view: 视图({ keySet: true }), key: "sk-new" });
  expect(按文字(根, "存 Key")!.disabled).toBe(false);
  // 输入框里已经有字，这一按到底是"存新的"还是"删旧的"说不清，所以先灰着
  expect(按文字(根, "删除 Key")!.disabled).toBe(true);
  // 一把也没有、也没输入：删除那一枚不出现，存的那一枚按不动
  const 空 = 挂({ view: 视图({ keySet: false }), key: "" });
  expect(按文字(空.根, "删除 Key")).toBeNull();
  expect(按文字(空.根, "存 Key")!.disabled).toBe(true);
  空.拆();
  拆();
});

it("回话落在右下角的 status 上，不再占页首", () => {
  const { 根, 拆 } = 挂({ flash: "配置已保存" });
  const 提示 = 根.querySelector('[role="status"]');
  expect(提示).not.toBeNull();
  expect(提示!.textContent).toContain("配置已保存");
  expect(提示!.className).toContain("fixed");
  拆();
});

it("草稿改了没保存时，明说测试用的是已保存的配置", () => {
  const { 根, 拆 } = 挂({
    view: 视图(),
    form: { baseUrl: "https://api.deepseek.com/v1", chatModel: "deepseek-chat", embeddingModel: "", rerank: false },
  });
  expect(根.textContent).toContain("有改动没保存");
  // 盘上那份是齐的，所以探针按得动
  const 测 = 按文字(根, "测试连通");
  expect(测!.disabled).toBe(false);
  拆();
});

it("盘上没配齐、草稿填齐时，说「先保存再测试」且探针按不动", () => {
  const { 根, 拆 } = 挂({
    view: 视图({ baseUrl: "", chatModel: "" }),
    form: {
      baseUrl: "https://api.deepseek.com/v1",
      chatModel: "deepseek-chat",
      embeddingModel: "",
      rerank: false,
    },
  });
  // 测试读的是盘上那份，它还没配齐——这时候说"测试用的是已保存的配置"是假的，因为根本测不了
  expect(根.textContent).toContain("先保存再测试");
  expect(按文字(根, "测试连通")!.disabled).toBe(true);
  拆();
});

it("读不到盘上配置时，「保存配置」按不动——别把原配置写成空", () => {
  const { 根, 拆 } = 挂({ view: null });
  expect(按文字(根, "保存配置")!.disabled).toBe(true);
  拆();
});

it("盘上没配齐时，「测试连通」与「列出可用模型」按不动，角标说未配置", () => {
  const { 根, 拆 } = 挂({ view: 视图({ baseUrl: "", chatModel: "" }) });
  expect(按文字(根, "测试连通")!.disabled).toBe(true);
  expect(按文字(根, "列出可用模型")!.disabled).toBe(true);
  expect(根.textContent).toContain("未配置");
  拆();
});
