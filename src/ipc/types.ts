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

export type CommandName =
  | "app_info"
  | "capture_text"
  | "hide_capture"
  | "list_notes"
  | "read_note"
  | "save_note"
  | "vault_default_path"
  | "vault_open"
  | "search_keyword";
