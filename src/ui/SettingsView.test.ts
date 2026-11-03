import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { AppInfo, AiView } from "../ipc/types";
import type { AI表单, AI忙 } from "./settings";
import { SettingsView } from "./SettingsView";

/**
 * 设置页是纯视图，钉的是**用户看得见**的几件事：
 * - 存 Key 并进「保存配置」（2026-10-27）：那一行只剩「删除 Key」一枚，输入框留空才按得动，
 *   免得"存新的"与"删旧的"混在一按里；框里有字时行内说明"保存时一起写入"；
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
  删Key?: () => void;
  忙?: AI忙;
  info?: AppInfo;
  setForm?: (f: AI表单) => void;
  setKey?: (k: string) => void;
  set行距?: (v: "tight" | "standard" | "loose") => void;
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
        info: over.info ?? 信息,
        flash: over.flash ?? null,
        onBack: () => {},
        外观: {
          theme: "system",
          setTheme: () => {},
          行距: "standard",
          set行距: over.set行距 ?? (() => {}),
        },
        备份: { draft: "", setDraft: () => {}, 忙: false, 应用: () => {} },
        模型: {
          view,
          form,
          setForm: over.setForm ?? (() => {}),
          key: over.key ?? "",
          setKey: over.setKey ?? (() => {}),
          忙: over.忙 ?? null,
          报告: null,
          发现: null,
          保存: () => {},
          删Key: over.删Key ?? (() => {}),
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

it("已存 Key 且输入框留空时，「删除 Key」按得动", async () => {
  const 删 = vi.fn();
  const { 根, 拆 } = 挂({ view: 视图({ keySet: true, keyHint: "…ab12（32 位）" }), key: "", 删Key: 删 });
  // 存 Key 没有独立的一枚：它跟「保存配置」一起走（2026-10-27）
  expect(按文字(根, "存 Key")).toBeNull();
  const 钮 = 按文字(根, "删除 Key");
  expect(钮).not.toBeNull();
  expect(钮!.disabled).toBe(false);
  await act(async () => {
    钮!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(删).toHaveBeenCalledTimes(1);
  拆();
});

it("输入框里有新 Key 时，删的那一枚是灰的；没存过就没这一枚", () => {
  const { 根, 拆 } = 挂({ view: 视图({ keySet: true }), key: "sk-new" });
  // 输入框里已经有字，这一按到底是"存新的"还是"删旧的"说不清，所以先灰着
  expect(按文字(根, "删除 Key")!.disabled).toBe(true);
  // 新 Key 的去处写在旁边：它跟「保存配置」一起写进去
  expect(根.textContent).toContain("按「保存配置」时一起写入");
  // 一把也没有、也没输入：删除那一枚不出现
  const 空 = 挂({ view: 视图({ keySet: false }), key: "" });
  expect(按文字(空.根, "删除 Key")).toBeNull();
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

it("删除 Key 的忙态落在删除那枚上", () => {
  // 从前两枚按钮共用一个 `忙`，按删除时亮起来的是「存 Key → 处理中…」，正好指反
  const { 根, 拆 } = 挂({ view: 视图({ keySet: true }), key: "", 忙: "key" });
  expect(按文字(根, "删除中…")).not.toBeNull();
  expect(按文字(根, "存 Key")).toBeNull();
  拆();
});

it("正文行高三档可选，旁边那两行样例读的是同一个 token", () => {
  // 打开设置会卸载编辑器：没有样例就等于让用户在黑框里凭名字猜"紧凑"有多紧
  const set行距 = vi.fn();
  const { 根, 拆 } = 挂({ set行距 });
  const 选 = 根.querySelector('select[aria-label="正文行高"]') as HTMLSelectElement | null;
  expect(选).not.toBeNull();
  expect(Array.from(选!.options).map((o) => o.textContent)).toEqual([
    "紧凑",
    "标准",
    "宽松",
  ]);
  act(() => {
    选!.value = "loose";
    选!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(set行距).toHaveBeenCalledWith("loose");
  const 样例 = 根.querySelector('span[style*="--leading-note"]');
  expect(样例?.textContent).toContain("第二行紧挨着");
  拆();
});

it("输入框里的 Esc 把这一格退回盘上那份，不是死键", () => {
  const setForm = vi.fn();
  const view = 视图({ baseUrl: "https://old.example/v1", chatModel: "old-model" });
  const { 根, 拆 } = 挂({
    view,
    form: {
      baseUrl: "https://new.example/v1",
      chatModel: "new-model",
      embeddingModel: "",
      rerank: false,
    },
    setForm,
  });
  const 按Esc = (el: Element) =>
    act(() => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
  按Esc(根.querySelector('input[aria-label="接口地址"]')!);
  expect(setForm).toHaveBeenLastCalledWith(
    expect.objectContaining({ baseUrl: "https://old.example/v1" }),
  );
  按Esc(根.querySelector('input[aria-label="对话模型"]')!);
  expect(setForm).toHaveBeenLastCalledWith(
    expect.objectContaining({ chatModel: "old-model" }),
  );
  拆();
});

it("备份行的「现在」说的是盘上生效那份，不是输入框里的草稿", () => {
  // 按完「不备份」之后输入框还留着旧路径：屏幕上唯一那条路径恰好是不再生效的那条
  const 有 = 挂({ info: { ...信息, backupDir: "D:\bak", backupUnconfigured: false } });
  expect(有.根.textContent).toContain("现在：D:\bak");
  有.拆();
  const 关 = 挂({ info: { ...信息, backupDisabled: true, backupDir: "D:\bak" } });
  expect(关.根.textContent).toContain("现在：不备份");
  关.拆();
});

it("配置读不出来时，Key 那格不说「按保存就能写」——那一按本来就是灰的", () => {
  // view 为 null 时「保存配置」disabled；合并之后 Key 也走这一按，
  // 所以这时行内必须说实话，不能还写"按「保存配置」时一起写入"
  const { 根, 拆 } = 挂({ view: null, key: "sk-new" });
  expect(根.textContent).toContain("配置没读出来，这把 Key 现在存不了");
  expect(根.textContent).not.toContain("按「保存配置」时一起写入");
  expect(按文字(根, "保存配置")!.disabled).toBe(true);
  拆();
});
