import { describe, expect, it } from "vitest";
import type { AppInfo } from "../ipc/types";
import { 首启档 } from "./firstrun";

const 事实 = (过: Partial<AppInfo>): AppInfo => ({
  version: "0",
  vaultPath: "D:\\Notes",
  indexNotes: 0,
  schemaVersion: 1,
  backupDir: null,
  backupDisabled: false,
  backupLastAt: null,
  ...过,
});

describe("首启向导该停在哪一步", () => {
  it("没选库就停在第一步，库的信息可以还没读到", () => {
    expect(首启档(null)).toBeNull(); // 读信息那一趟还没回来，别抢着画
    expect(首启档(事实({ vaultPath: null, backupDir: "E:\\备份" }))).toBe("选库");
    // 顺序不能反：`no_vault` 占位里备份也是"没配"，先判备份就会停在第二步
    expect(首启档(事实({ vaultPath: null }))).toBe("选库");
  });

  it("选了库但备份那一步没答完，下次启动仍停在第二步", () => {
    // 这条就是"选完目录直接关掉应用"的现场：vault_open 已经把库路径写进 last-vault，
    // 只判 vaultPath 会直接进笔记界面，从此再没人问备份
    expect(首启档(事实({}))).toBe("选备份");
    expect(首启档(事实({ backupDir: null }))).toBe("选备份");
  });

  it("与设置页同一份判据：目录只有空白也算还没答", () => {
    // 盘上手改出来的 `dir = "   "` 在 Rust 侧 target() 里是 None。设置页据 判备份
    // 会说"没配"，首启若只看"目录字段非空"就会放行——两处对同一条配置说反话
    expect(首启档(事实({ backupDir: "   " }))).toBe("选备份");
  });

  it("答过之后就不再停：给了目录、或显式选了不备份", () => {
    expect(首启档(事实({ backupDir: "E:\\笔记备份" }))).toBeNull();
    expect(首启档(事实({ backupDisabled: true }))).toBeNull();
  });
});
