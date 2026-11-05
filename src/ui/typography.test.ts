import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { 写行距, 套行距, 读行距, 盯行距变化, 行距事件 } from "./typography";

const 键 = "note.leading";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.leading;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("正文行高只认三档，读不出来就回标准", () => {
  it("没存过 / 存坏了都是标准", () => {
    expect(读行距()).toBe("standard");
    localStorage.setItem(键, "huge");
    expect(读行距()).toBe("standard");
  });

  it("三档原样读回", () => {
    for (const v of ["tight", "standard", "loose"] as const) {
      localStorage.setItem(键, v);
      expect(读行距()).toBe(v);
    }
  });

  it("存储被禁也回标准，不把正文排版带崩", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(读行距()).toBe("standard");
  });
});

describe("套 / 写", () => {
  it("写：当场落到 data-leading，并记住", () => {
    let 广播 = 0;
    const 听 = () => 广播++;
    document.addEventListener(行距事件, 听);
    写行距("loose");
    document.removeEventListener(行距事件, 听);
    expect(document.documentElement.dataset.leading).toBe("loose");
    expect(localStorage.getItem(键)).toBe("loose");
    expect(广播).toBe(1);
  });

  it("同一档重复套不广播：首帧那次套用没人需要重画", () => {
    let 广播 = 0;
    const 听 = () => 广播++;
    document.addEventListener(行距事件, 听);
    套行距("tight");
    套行距("tight");
    document.removeEventListener(行距事件, 听);
    expect(广播).toBe(1);
  });

  it("存不下也要当场生效", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    写行距("tight");
    expect(document.documentElement.dataset.leading).toBe("tight");
  });

  it("标准档也写属性：三档在 DOM 上都看得见", () => {
    // CSS 里标准档故意没有规则（1.75 就是默认值）；属性不在就等于"没选过"，
    // 与"选了标准"混成一件，排查时说不清当前是哪一档
    套行距("standard");
    expect(document.documentElement.dataset.leading).toBe("standard");
  });
});

describe("跨窗口同步", () => {
  it("别的窗口改了这个 key 才重算；取消订阅后不再理", () => {
    let 次 = 0;
    const 停 = 盯行距变化(() => 次++);

    window.dispatchEvent(new StorageEvent("storage", { key: "note.theme" }));
    expect(次).toBe(0);

    window.dispatchEvent(new StorageEvent("storage", { key: 键, newValue: "loose" }));
    expect(次).toBe(1);

    // key === null 是 localStorage.clear()：外部把偏好清了也该回到标准
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(次).toBe(2);

    停();
    window.dispatchEvent(new StorageEvent("storage", { key: 键 }));
    expect(次).toBe(2);
  });
});

describe("接线真的在，而不是只写了函数", () => {
  const 读 = (p: string) => fs.readFileSync(p, "utf8");
  const tokens = 读("src/ui/tokens.css");
  const base = 读("src/ui/base.css");
  const 主窗 = 读("src/App.tsx");
  const 设置 = 读("src/ui/SettingsView.tsx");
  const 插件 = 读("src/editor/schema.ts");

  it("token 只有一份，标准档不重复记数字", () => {
    expect(tokens).toMatch(/--leading-note:\s*var\(--leading-body\)/);
    expect(tokens).toMatch(/html\[data-leading="tight"\]\s*\{\s*--leading-note:\s*1\.6;/);
    expect(tokens).toMatch(/html\[data-leading="loose"\]\s*\{\s*--leading-note:\s*2;/);
    // 标准档**不该**有覆盖规则；有就说明 1.75 被记了第二遍
    expect(tokens).not.toMatch(/html\[data-leading="standard"\]/);
    expect(tokens).toContain("--leading-note: var(--leading-note);");
  });

  it("只有正文内容跟档位；面板正文与代码各守自己的行高", () => {
    expect(base).toMatch(
      /\.block-editor \.ProseMirror p,\s*\.block-editor \.ProseMirror li\s*\{\s*line-height:\s*var\(--leading-note\);/,
    );
    expect(base).toMatch(
      /\.block-editor \[data-md-item\] \{[\s\S]*?line-height: var\(--leading-note\);/,
    );
    expect(base).toMatch(
      /\.block-editor \[data-md-cell\] \{[\s\S]*?line-height: var\(--leading-note\);/,
    );
    // 闪现提示 / 返回链接这些 `.prose-note p` 仍是基准行高
    expect(base).toMatch(
      /\.prose-note p \{\s*margin: 0 0 var\(--gap-para\);\s*line-height: var\(--leading-body\);/,
    );
    expect(base).toMatch(/\.md-gutter \{[^}]*line-height: var\(--leading-code\);/s);
    // 代码"点进去"的源文本形也不跟偏好：同一块的两副面孔必须同一档行距
    expect(base).toMatch(
      /\.md-opaque\[data-md-raw="code"\] \.md-src \{\s*line-height: var\(--leading-code\);/,
    );
  });

  it("首帧前套上，设置页与命令面板都能改", () => {
    expect(读("src/main.tsx")).toMatch(/套行距\(读行距\(\)\)/);
    expect(主窗).toMatch(/function use行距\(\)/);
    expect(主窗).toMatch(/行距, set行距/);
    expect(设置).toContain("行距档位");
    expect(设置).toContain('aria-label="正文行高"');
    expect(主窗).toContain("正文行高：紧凑");
    expect(主窗).toContain("正文行高：标准");
    expect(主窗).toContain("正文行高：宽松");
  });

  it("焦点竖线听行距事件，且仍然不发事务", () => {
    expect(插件).toContain("行距事件");
    expect(插件).toMatch(/addEventListener\("focus", 重画\)/);
    expect(插件).toMatch(/addEventListener\("blur", 收线\)/);
    const 段 = 插件.slice(插件.indexOf("addEventListener(行距事件"), 插件.indexOf("destroy: ()"));
    expect(段).not.toContain("dispatch");
  });
});
