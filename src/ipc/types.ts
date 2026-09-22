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
};

export type CommandName =
  | "app_info"
  | "list_notes"
  | "read_note"
  | "vault_open"
  | "search_keyword";
