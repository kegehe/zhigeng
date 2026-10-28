import { describe, expect, it } from "vitest";
import fs from "node:fs";
import type { AppInfo } from "../ipc/types";
import { 主题档位, 判备份, 配置归属 } from "./settings";

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

  it("两处面板都走 判备份，没有第二份拼法", () => {
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
    // 输入框里 Esc 归输入框自己（退回盘上那份 / 清掉草稿），不是整页跳走。
    // **光有这条守卫是不够的**：从前设置页的输入框里没有任何 Escape 行为，于是
    // "不抢"变成了"死键"——所以还要钉住那一页真的接住了这一键。
    expect(主窗).toMatch(/e\.key === "Escape" && mode === "settings"/);
    expect(主窗).toContain('t.tagName === "INPUT"');
    expect(设置).toMatch(/退格\(e, /);
    // 面板开着时那一键归面板（它自己关自己），不能顺手把设置页也关了
    expect(主窗).toMatch(/mode === "settings" && !palette/);
  });

  it("问答页也有 Esc 出口", () => {
    // 问答同样是主区的一页、也没有返回按钮，而提问框里的 Esc 没有自己的含义：
    // 不给这条出口，键盘上就出不去（设置页那一键归输入框，这一页不归）
    expect(主窗).toMatch(/e\.key === "Escape" && mode === "ask"/);
    // 组词中的 Esc 归输入法（与"回车提交"同一条守卫）：那一键不能把整页送走
    expect(主窗).toMatch(/e\.isComposing \|\| e\.keyCode === 229/);
    // 侧栏那三处（新建 / 改名 / 目录菜单）自己处理 Esc，只关自己不动整页
    expect(主窗).toContain('closest(".tree-menu")');
  });
});

describe("设置页的状态只有一个来源", () => {
  const 主窗 = fs.readFileSync("src/App.tsx", "utf8");
  const 设置 = fs.readFileSync("src/ui/SettingsView.tsx", "utf8");

  it("标题栏不再替配置发言（grep 守卫：状态字样与 徽标() 都不许回来）", () => {
    // 那枚角标要同时回答"盘上填了没"与"这次测过没"，还和设置页那格重复；
    // 2026-10-27 拍板撤掉。再挂回去，两个地方就会各说一句话。
    // 判据故意写宽一点：光拦 `AI·` 挡不住写成 "AI 已配置" 的同一件事
    expect(主窗).not.toMatch(/AI[·\s]+\s*(没配|已配置|不通|能检索|只对话)/);
    expect(主窗).not.toMatch(/徽标(红)?\(/);
  });

  it("存 Key 跟「保存配置」是同一按，删 Key 仍是另一件", () => {
    // 凭据管理器与 config.toml 是两份存储，但用户按的是"保存"——不该记得多按一次
    // （2026-10-27 用户拍板）。删除留在自己那一枚，它不该藏在"保存"里
    expect(主窗).toMatch(/新 = await api\.aiSaveKey\(新Key\)/);
    expect(主窗).toMatch(/const ai删Key = async \(\) => \{/);
    // ai_save_key 返回的是盘上那份配置；整份 填回 会把用户刚打的地址 / 模型名清回旧值
    expect(主窗).not.toMatch(/填回\(await api\.aiSaveKey/);
  });

  it("Key 没存上时，也要照实说\"配置已经落盘\"", () => {
    // Key 会被后端按长度（>4096 字节）/ 控制字符拒掉。那时配置已经写进 config.toml 了，
    // 页面若还挂着"未配置"和"有改动没保存"，就是拿一句旧话盖住一件新事实
    expect(主窗).toMatch(/配置已保存，但 Key 没存上/);
    expect(主窗).toMatch(/let KeyErr: unknown = null;/);
  });

  it("换库把上一次的测试报告与表单一起作废", () => {
    // 配置跟着库走（.note/config.toml），A 库的测试结论不能贴到 B 库身上
    const 换库 = 主窗.slice(主窗.indexOf("const 打开库"), 主窗.indexOf("const ai保存"));
    expect(换库).toContain("setAiReport(null)");
    expect(换库).toMatch(/填回\(await api\.aiView\(\)\)/);
  });

  it("齿轮在设置页里不再重进一次", () => {
    // 重进会 setBackupDraft / setAiReport(null) / setAi发现(null) / 填回——三份草稿与
    // 两份结果全没，而齿轮就在光标旁边，长得像开关
    expect(主窗).toMatch(/if \(mode !== "settings"\) void openSettings\(\)/);
  });
});

