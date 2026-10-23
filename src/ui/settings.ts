import type { AppInfo } from "../ipc/types";
import type { Theme } from "./theme";

/**
 * 主题的三档。顺序 = 界面上的顺序，`跟随系统` 排第一因为它是默认值
 * （`读主题` 在没存过 / 存不下时都回 `"system"`）。
 */
export const 主题档位: { 值: Theme; 标签: string }[] = [
  { 值: "system", 标签: "跟随系统" },
  { 值: "light", 标签: "亮色" },
  { 值: "dark", 标签: "暗色" },
];

/** AI 那四格草稿。与 `ai_save_config` 的四个参数一一对应 */
export type AI表单 = {
  baseUrl: string;
  chatModel: string;
  embeddingModel: string;
  rerank: boolean;
};

/** 界面上唯一那台"按下去会改配置"的忙碌态；null = 空闲 */
export type AI忙 = "save" | "key" | "test" | "models" | null;

type 备份事实 = Pick<AppInfo, "backupDir" | "backupDisabled" | "backupLastAt">;

/**
 * 备份面板与侧栏角标共用的那一格。三态**必须可区分**（docs/03 §备份）：
 * 显式选了"我不备份"与"还没答过"是两件事——前者不再骚扰，后者每次启动都该提醒。
 */
export type 备份状态 =
  | { 档: "关着"; 文: string }
  | { 档: "没配"; 文: string }
  | { 档: "开着"; 目录: string; 时刻: string | null };

/**
 * 判备份。**判据只有一份**：侧栏角标、备份面板、设置页三处都从这里取，
 * 谁都不许自己再拼一次 `backupUnconfigured || backupDisabled`。
 *
 * 最后那条分支看着多余（目录空着时 `app_info` 本就该报"没配置"），但界面说的是
 * "盘上有没有第二个目录"这件事——只照标志位拼，就会在目录字段为空时说出"备份到 "
 * 半句话。所以**目录本身也要过一遍**，与 Rust 侧 `BackupConfig::target()` 同口径：
 * 关掉、没填、只有空白，三种都算没在备份。
 */
export function 判备份(info: 备份事实 | null): 备份状态 {
  if (!info) return { 档: "没配", 文: "还没读到库的信息。" };
  if (info.backupDisabled) return { 档: "关着", 文: "备份已关闭：你的笔记只存在一块盘上。" };
  const 目录 = info.backupDir?.trim();
  if (!目录) return { 档: "没配", 文: "还没配置备份目录：你的笔记只存在一块盘上。" };
  return { 档: "开着", 目录, 时刻: info.backupLastAt };
}

/** 侧栏与标题栏那句角标：只在"没在备份"时说话，开着的时候不占地方 */
export function 备份角标(s: 备份状态): string | null {
  return s.档 === "开着" ? null : "没开";
}

/**
 * 设置页「库与关于」那一段要说清的事实：哪些偏好跟着**这个库**走（`.note/config.toml`，
 * 拷库就带走），哪些跟着**这台电脑**走（localStorage / Windows 凭据管理器，换机要重来）。
 * docs/03 §备份与迁移 明写了"这个事实要写在设置页，不要让用户以为拷完就全能用"。
 */
export const 配置归属: { 项: string; 落在哪: string; 随库走: boolean }[] = [
  { 项: "备份目录、AI 端点与模型名", 落在哪: "这个库的 .note/config.toml", 随库走: true },
  { 项: "主题", 落在哪: "这台电脑（应用自己的存储）", 随库走: false },
  { 项: "API Key", 落在哪: "这台电脑的 Windows 凭据管理器", 随库走: false },
];
