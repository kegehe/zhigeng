import type { AppInfo } from "../ipc/types";
import { 判备份 } from "./settings";

/**
 * 首启向导现在该停在哪一步。`null` = 不用停，直接进笔记界面。
 *
 * 两步都要用户亲手答过（docs/03）：
 * 1. 库放哪儿——`vaultPath` 为空；
 * 2. 备份放哪儿——`判备份` 说"没配"。
 *
 * **不能只判 `vaultPath`**。`vault_open` 一确认就把库路径写进了 last-vault，
 * 用户若在第二步直接关掉应用，下次启动 `vaultPath` 已有值、只判它就会一路放行，
 * 笔记从此长期只有一块盘上的一份——恰好违背"唯一副本 = 没有副本"的前提。
 *
 * 备份那一档**复用 `判备份`**，不自己再拼一遍目录 / 开关：那份判据还认
 * "目录只有空白"这种盘上手改出来的配置，与 Rust 侧 `BackupConfig::target()` 同口径。
 * 否则设置页说"没配"、首启却不再问，两处对同一条配置各说各话。
 * 显式选了"我不备份"之后是"关着"，不再打扰。
 */
export type 首启档 = "选库" | "选备份" | null;

export function 首启档(info: AppInfo | null): 首启档 {
  // 还没读到库的信息：什么都别画，更别拿一张空表单替后端发言
  if (!info) return null;
  if (!info.vaultPath) return "选库";
  return 判备份(info).档 === "没配" ? "选备份" : null;
}
