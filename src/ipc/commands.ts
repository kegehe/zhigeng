import { invoke } from "@tauri-apps/api/core";
import type { AppInfo, CapturedOut, ListNotes, NoteDetail } from "./types";

export const inTauri = () => "__TAURI_INTERNALS__" in window;

/**
 * 所有跨边界调用都收在这里。返回值类型与 Rust 侧 `ipc.rs` 的 DTO 一一对应——
 * M1 会换成 ts-rs 自动生成，届时删掉手写声明（docs/03 §IPC 契约：禁止前端手写接口类型）。
 */
export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  listNotes: (limit = 200) => invoke<ListNotes>("list_notes", { limit }),
  readNote: (rel: string) => invoke<NoteDetail>("read_note", { rel }),
  vaultOpen: (path: string) => invoke<AppInfo>("vault_open", { path }),
  /** 只等落盘（含 fsync，实测 p95 5.9ms）。索引在 Rust 侧后台补，别等它 */
  captureText: (text: string, sourceUrl?: string) =>
    invoke<CapturedOut>("capture_text", { text, sourceUrl: sourceUrl ?? null }),
  searchKeyword: (query: string, limit = 20) =>
    invoke<{ blockId: string; noteId: string; path: string; title: string; snippet: string; score: number }[]>(
      "search_keyword",
      { query, limit }
    ),
};
