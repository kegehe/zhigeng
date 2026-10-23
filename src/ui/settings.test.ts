import { describe, expect, it } from "vitest";
import fs from "node:fs";
import type { AppInfo } from "../ipc/types";
import { 主题档位, 判备份, 备份角标, 配置归属 } from "./settings";

const 事实 = (过: Partial<AppInfo>): AppInfo => ({
  version: "0",
  vaultPath: "D:\\Notes",
  indexNotes: 0,
  schemaVersion: 1,
  backupDir: null,
  backupDisabled: false,
  backupUnconfigured: true,
  backupLastAt: null,
  ...过,
});

describe("备份那一格只有一个判据", () => {
  it("显式选了不备份，与还没配置是两句话", () => {
    // docs/03：前者不再骚扰，后者每次启动都该提醒。合成一句"没开"就把这条产品决定抹掉了
    const 关 = 判备份(事实({ backupDisabled: true, backupUnconfigured: false }));
    const 空 = 判备份(事实({}));
    expect(关.档).toBe("关着");
    expect(空.档).toBe("没配");
    expect(关.档 === "关着" && 关.文).toContain("备份已关闭");
    expect(空.档 === "没配" && 空.文).toContain("还没配置备份目录");
  });

  it("两种没备份都说出了后果：只存在一块盘上", () => {
    for (const s of [判备份(事实({ backupDisabled: true })), 判备份(事实({}))]) {
      expect(s.档 === "开着" ? "" : s.文).toContain("只存在一块盘上");
    }
  });

  it("关着优先于没配：用户答过'不备份'就别再问他要目录", () => {
    const s = 判备份(事实({ backupDisabled: true, backupUnconfigured: true }));
    expect(s.档).toBe("关着");
  });

  it("目录是空白 = 没配，不许报成'备份到 '", () => {
    // Rust 侧 BackupConfig::target() 把 trim 后为空算成 None。界面照字段原样拼就会
    // 说出半句话，而这一档的全部意义是"屏幕上说的是盘上的事实"
    expect(判备份(事实({ backupDir: "   ", backupUnconfigured: false })).档).toBe("没配");
    expect(判备份(null).档).toBe("没配");
  });

  it("开着时给出目录与最近一次", () => {
    const s = 判备份(事实({ backupDir: "E:\\笔记备份", backupUnconfigured: false, backupLastAt: "2026-10-01T08:00:00Z" }));
    expect(s).toEqual({ 档: "开着", 目录: "E:\\笔记备份", 时刻: "2026-10-01T08:00:00Z" });
    // 没做过快照时时刻是 null，由界面说"还没做过快照"——这里不替它编一个时间
    const 首回 = 判备份(事实({ backupDir: "E:\\x", backupUnconfigured: false }));
    expect(首回.档 === "开着" && 首回.时刻).toBe(null);
  });

  it("角标只在没备份时说话，且两种没备份都是同一句'没开'", () => {
    expect(备份角标(判备份(事实({ backupDisabled: true })))).toBe("没开");
    expect(备份角标(判备份(事实({})))).toBe("没开");
    expect(备份角标(判备份(事实({ backupDir: "E:\\x" })))).toBe(null);
  });
});

describe("主题档位", () => {
  it("三档齐全，跟随系统排第一", () => {
    // 顺序即界面上的顺序；第一档必须是 `读主题` 在没存过时的默认值，
    // 否则一进设置页看到的当前档与实际套的那一副不是一回事
    expect(主题档位.map((x) => x.值)).toEqual(["system", "light", "dark"]);
    expect(主题档位[0]?.值).toBe("system");
  });

  it("每一档都有中文标签，界面不许出现 system/light/dark", () => {
    for (const 档 of 主题档位) expect(档.标签).toMatch(/^[一-龥]+$/);
  });
});

describe("设置页说清哪些偏好跟着库走", () => {
  it("凭据管理器与本机存储两类都在，且标成不随库走", () => {
    // docs/03 §备份与迁移：换机要重输 Key 这个事实"要写在设置页，不要让用户以为拷完就全能用"
    const 不随库 = 配置归属.filter((x) => !x.随库走).map((x) => x.项);
    expect(不随库.join("")).toContain("API Key");
    expect(不随库.join("")).toContain("主题");
    expect(配置归属.find((x) => x.随库走)?.落在哪).toContain(".note/config.toml");
  });
});

describe("判据真的接在界面上", () => {
  // 纯函数绿了不等于屏幕上用的是它。这一组从源码里读，改回各写一份就红
  // （路径按仓库根拼：jsdom 里 import.meta.url 是 http URL，fileURLToPath 会抛）
  const 主窗 = fs.readFileSync("src/App.tsx", "utf8");
  const 设置 = fs.readFileSync("src/ui/SettingsView.tsx", "utf8");

  it("侧栏角标与两处面板都走 判备份，没有第二份拼法", () => {
    expect(主窗).toContain("判备份");
    expect(设置).toContain("判备份");
    expect(主窗).not.toMatch(/backupUnconfigured \|\| .*backupDisabled/);
  });

  it("标题栏不再有主题下拉，设置页成了唯一那处", () => {
    expect(主窗).not.toContain("<select");
    expect(设置).toContain("主题档位");
  });

  it("按钮基线只有一份定义", () => {
    expect(主窗).not.toMatch(/^const btn =/m);
    expect(fs.readFileSync("src/ui/controls.ts", "utf8")).toMatch(/^export const btn =/m);
  });

  it("设置页有一条回正文的路：返回按钮在，齿轮不是开关", () => {
    // 齿轮在标题栏，它按下去是"再进一次设置"（还会重新 persist 一遍正文），
    // 不是"退出设置"。侧栏底栏那四格是开关，齿轮不在那一排里——
    // 于是设置页必须自己带一条出去的路，否则进得去出不来
    expect(设置).toMatch(/onClick=\{props\.onBack\}/);
    expect(主窗).toContain("onBack={backToNote}");
  });

  it("Esc 在设置页里回正文，但输入框里不抢这一键", () => {
    // 输入框里 Esc 该管的是它自己那点内容（Key、路径），不是整页跳走
    expect(主窗).toMatch(/e\.key === "Escape" && mode === "settings"/);
    expect(主窗).toContain('t.tagName === "INPUT"');
    // 面板开着时那一键归面板（它自己关自己），不能顺手把设置页也关了
    expect(主窗).toMatch(/mode === "settings" && !palette/);
  });
});
