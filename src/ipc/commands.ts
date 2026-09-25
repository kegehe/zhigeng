import { invoke } from "@tauri-apps/api/core";
import type {
  AppInfo,
  CapturedOut,
  EditDoc,
  ListNotes,
  NoteSource,
  TrashRow,
} from "./types";

/**
 * 写命令失败时给的是结构化负载 `{kind, message}`（冲突要能分支出来），
 * 其余命令还是裸字符串。两种都从这里过一遍，别在调用点匹配文案。
 */
export function describeError(e: unknown): { kind: string; message: string } {
  if (e && typeof e === "object" && "kind" in e) {
    const o = e as { kind?: unknown; message?: unknown };
    return { kind: String(o.kind ?? "error"), message: String(o.message ?? "") };
  }
  return { kind: "error", message: String(e) };
}

export const inTauri = () => "__TAURI_INTERNALS__" in window;

/**
 * 所有跨边界调用都收在这里。返回值类型与 Rust 侧 `ipc.rs` 的 DTO 一一对应——
 * M1 会换成 ts-rs 自动生成，届时删掉手写声明（docs/03 §IPC 契约：禁止前端手写接口类型）。
 */
export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  listNotes: (limit = 200) => invoke<ListNotes>("list_notes", { limit }),
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
  /** 行内编辑器要的块结构：每块带精确源切片，未改动的块由前端原样回写 */
  noteEditDoc: (rel: string) => invoke<EditDoc>("note_edit_doc", { rel }),
  /** 原文 + hash。hash 要原样带回 saveNote，服务端才判得出"磁盘这份还是不是你看到的那份" */
  readRaw: (rel: string) => invoke<NoteSource>("read_raw", { rel }),
  saveNote: (rel: string, content: string, expectHash?: string) =>
    invoke<string>("save_note", { rel, content, expectHash: expectHash ?? null }),
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
