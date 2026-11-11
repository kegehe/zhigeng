import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import {
  按键分栏,
  拖动帧,
  读分栏,
  夹记忆,
  默认宽,
  轨宽,
  折起线,
  右栏下限,
  左栏上限,
  展开死区,
  显示上限,
  写分栏,
  盯分栏变化,
  初始分栏,
} from "./split";

const 键 = "note.split";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("记忆宽度", () => {
  it("坏数回默认，过窄抬到折起线，过宽压到上限", () => {
    expect(夹记忆(Number.NaN)).toBe(默认宽);
    expect(夹记忆(10)).toBe(折起线);
    expect(夹记忆(200.4)).toBe(200);
    expect(夹记忆(900)).toBe(左栏上限);
  });
});

describe("右栏留白", () => {
  it("宽窗顶到左栏上限，窄窗把帽降下来，量不到容器时不夹", () => {
    expect(显示上限(1600)).toBe(左栏上限);
    expect(显示上限(右栏下限 + 200)).toBe(200);
    expect(显示上限(200)).toBe(0);
    expect(显示上限(0)).toBe(左栏上限);
    expect(显示上限(Number.NaN)).toBe(左栏上限);
  });
});

describe("拖动", () => {
  const 开 = { 宽: 默认宽, 折起: false };

  it("宽窗里跟着指针走", () => {
    const 帧 = 拖动帧(开, 40, 1600);
    expect(帧.折起).toBe(false);
    expect(帧.宽).toBe(默认宽 + 40);
    expect(帧.状态).toEqual({ 宽: 默认宽 + 40, 折起: false });
  });

  it("窄过折起线就收成轨，展开宽度仍记按下时那一档", () => {
    const 帧 = 拖动帧(开, 折起线 - 默认宽 - 1, 1600);
    expect(帧.折起).toBe(true);
    expect(帧.宽).toBe(轨宽);
    expect(帧.状态).toEqual({ 宽: 默认宽, 折起: true });
  });

  it("还没碰到折起线时，松手宽度就是按下时的宽度加位移", () => {
    const 帧 = 拖动帧(开, -40, 1600);
    expect(帧.折起).toBe(false);
    expect(帧.状态.宽).toBe(默认宽 - 40);
  });

  it("不能拖过左栏上限；从更窄处往右拖，最多停在右栏下限留出的帽上", () => {
    expect(拖动帧(开, 400, 1600).状态.宽).toBe(左栏上限);
    const 顶到帽 = 拖动帧({ 宽: 折起线, 折起: false }, 400, 右栏下限 + 200);
    expect(顶到帽.宽).toBe(200);
    expect(顶到帽.状态.宽).toBe(200);
  });

  it("窗比记忆窄时，往右拖不把记忆削成帽", () => {
    const 帽 = 180;
    const 帧 = 拖动帧({ 宽: 默认宽, 折起: false }, 80, 帽 + 右栏下限);
    expect(帧.宽).toBe(帽);
    expect(帧.状态).toEqual({ 宽: 默认宽, 折起: false });
  });

  it("分隔条还没离开帽时，往左的虚位移不改记忆", () => {
    const 帧 = 拖动帧({ 宽: 默认宽, 折起: false }, -20, 180 + 右栏下限);
    expect(帧.宽).toBe(180);
    expect(帧.状态.宽).toBe(默认宽);
  });

  it("从轨上往右拖过死区，回到上次的宽度", () => {
    const 起点 = { 宽: 240, 折起: true };
    expect(拖动帧(起点, 展开死区 - 1, 1600)).toEqual({
      状态: 起点,
      宽: 轨宽,
      折起: true,
    });
    const 开了 = 拖动帧(起点, 展开死区, 1600);
    expect(开了.折起).toBe(false);
    expect(开了.状态).toEqual({ 宽: 240, 折起: false });
    expect(拖动帧(起点, 展开死区 + 30, 1600).状态.宽).toBe(270);
  });
});

describe("方向键", () => {
  it("向左一步步收，跨过折起线才折，向右从轨上展开", () => {
    const 窄 = 按键分栏({ 宽: 折起线, 折起: false }, "左", 1600);
    expect(窄).toEqual({ 宽: 折起线, 折起: true });
    expect(按键分栏(窄, "右", 1600)).toEqual({ 宽: 折起线, 折起: false });
    expect(按键分栏(窄, "左", 1600)).toEqual(窄);
  });

  it("向右到不了上限之外，Home 回到默认并展开", () => {
    expect(按键分栏({ 宽: 左栏上限, 折起: false }, "右", 1600).宽).toBe(左栏上限);
    expect(按键分栏({ 宽: 200, 折起: true }, "复位", 1600)).toEqual({
      宽: 默认宽,
      折起: false,
    });
  });

  it("窗比记忆窄时，向左按可见宽度收，而不是按记忆里那个更宽的数", () => {
    const 下 = 按键分栏({ 宽: 默认宽, 折起: false }, "左", 180 + 右栏下限);
    expect(下.折起).toBe(false);
    expect(下.宽).toBe(180 - 16);
  });
});

describe("本机记忆", () => {
  it("没存过 / 存坏了都回默认", () => {
    expect(读分栏()).toEqual(初始分栏);
    localStorage.setItem(键, "{");
    expect(读分栏()).toEqual(初始分栏);
    localStorage.setItem(键, JSON.stringify({ w: "288", c: false }));
    expect(读分栏()).toEqual(初始分栏);
    localStorage.setItem(键, JSON.stringify({ w: 12, c: true }));
    expect(读分栏()).toEqual({ 宽: 折起线, 折起: true });
  });

  it("写得回去，存储被禁也不抛", () => {
    写分栏({ 宽: 240, 折起: true });
    expect(读分栏()).toEqual({ 宽: 240, 折起: true });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => 写分栏({ 宽: 200, 折起: false })).not.toThrow();
  });

  it("读存储抛错时回默认", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(读分栏()).toEqual(初始分栏);
  });
});

describe("跨窗口", () => {
  it("只有这条 key 或整表被清才通知", () => {
    let 次 = 0;
    const 停 = 盯分栏变化(() => 次++);
    window.dispatchEvent(new StorageEvent("storage", { key: "note.theme" }));
    expect(次).toBe(0);
    window.dispatchEvent(new StorageEvent("storage", { key: 键 }));
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(次).toBe(2);
    停();
    window.dispatchEvent(new StorageEvent("storage", { key: 键 }));
    expect(次).toBe(2);
  });
});

describe("接线", () => {
  const 主窗 = fs.readFileSync("src/App.tsx", "utf8");
  const 样式 = fs.readFileSync("src/ui/base.css", "utf8");

  it("主区走分栏，侧栏不再写死 w-72，右边正文列不按折起卸载", () => {
    expect(主窗).toContain("use分栏()");
    expect(主窗).not.toContain("w-72");
    expect(主窗).toContain('className="split-side"');
    expect(主窗).toContain('className="editor-pane');
    // 对话坞跟着编辑器在，不跟侧栏的折起走
    expect(主窗).toContain("{liveEditor && selected ? (");
    expect(主窗).not.toContain("折起 && liveEditor");
  });

  it("演示把分隔条和空列一起收掉，否则全屏左侧留一条缝", () => {
    expect(样式).toContain('[data-present="1"] .split-sash');
    expect(样式).toMatch(/\[data-present="1"\] \.split \{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });
});
