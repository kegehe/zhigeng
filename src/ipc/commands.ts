import { invoke } from "@tauri-apps/api/core";
import type { AppInfo, CapturedOut, ListNotes, NoteDetail, TrashRow } from "./types";

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
  /** 默认 Vault 路径由 Rust 侧算：哪块盘可用来决定，前端猜不出来 */
  vaultDefaultPath: () => invoke<string>("vault_default_path"),
  /** 只等落盘（含 fsync，实测 p95 5.9ms）。索引在 Rust 侧后台补，别等它 */
  captureText: (text: string, sourceUrl?: string) =>
    invoke<CapturedOut>("capture_text", { text, sourceUrl: sourceUrl ?? null }),
  searchKeyword: (query: string, limit = 20) =>
    invoke<{ blockId: string; noteId: string; path: string; title: string; snippet: string; score: number }[]>(
      "search_keyword",
      { query, limit }
    ),
  /** 原文。只在进入编辑态时取，普通浏览不付序列化整篇的代价 */
  readRaw: (rel: string) => invoke<string>("read_raw", { rel }),
  saveNote: (rel: string, content: string) => invoke<string>("save_note", { rel, content }),
  /** 返回新建笔记的相对路径 */
  noteCreate: (title: string) => invoke<string>("note_create", { title }),
  noteRename: (rel: string, newStem: string) =>
    invoke<string>("note_rename", { rel, newStem }),
  noteMove: (rel: string, newRel: string) => invoke<void>("note_move", { rel, newRel }),
  noteTrash: (rel: string) => invoke<void>("note_trash", { rel }),
  listTrash: () => invoke<TrashRow[]>("list_trash"),
  noteRestore: (batch: string, rel: string) =>
    invoke<void>("note_restore", { batch, rel }),
};
