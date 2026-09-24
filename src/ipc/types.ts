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

export type NoteDetail = {
  rel: string;
  title: string;
  blocks: {
    id: string;
    type: string;
    text: string;
    headingLevel: number | null;
    lineStart: number;
  }[];
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
  id: string | null;
  raw: string;
  gapBefore: string;
  content: string;
  level: number | null;
  checked: boolean | null;
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
