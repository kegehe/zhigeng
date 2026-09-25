export type ListNotes = {
  notes: {
    rel: string;
    title: string;
    status: string;
    kind: string;
    updatedMs: number;
    size: number;
  }[];
  vaultPath: string;
  indexed: number;
};

export type AppInfo = {
  version: string;
  vaultPath: string | null;
  indexNotes: number;
  schemaVersion: number;
};

export type CapturedOut = {
  rel: string;
  id: string;
  title: string;
  contentHash: string;
  created: string;
  indexMs: number;
};

export type NoteSource = {
  content: string;
  hash: string;
};

/** 与 `note_core::service::EditBlock` 对应。raw 是精确源切片，未改动的块靠它字节级回写 */
export type EditBlock = {
  kind: string;
  /** md-kernel 的块 ID，不含 `^`；源文本里的写法是 `^b-xxxxxxxxxx`，且**也在 `raw` 里** */
  id: string | null;
  /** 该块的精确源切片，**含自己那行的结尾换行**（含块 ID 标记）。未改动的块原样回写它 */
  raw: string;
  /** 与上一块之间的空白，只是"额外的空白"：块自带的换行不在这里 */
  gapBefore: string;
  /** 去掉前缀、缩进、块 ID 与行内字段之后的正文，仍含行内语法 */
  content: string;
  level: number | null;
  checked: boolean | null;
  /** 行内字段（`due::` / `done::`）。`content` 里没有它们，重新产出时必须写回 */
  fields: [string, string][];
  children: EditBlock[];
};

export type EditDoc = {
  frontMatter: string;
  trailingGap: string;
  blocks: EditBlock[];
};

export type TrashRow = {
  batch: string;
  rel: string;
  size: number;
  updatedMs: number;
};

export type CommandName =
  | "app_info"
  | "capture_text"
  | "hide_capture"
  | "list_notes"
  | "list_trash"
  | "note_create"
  | "note_edit_doc"
  | "note_move"
  | "note_rename"
  | "note_restore"
  | "note_trash"
  | "read_note"
  | "read_raw"
  | "save_note"
  | "vault_default_path"
  | "vault_open"
  | "search_keyword";
