/**
 * 侧栏某一层的自定义顺序。盘上是 `<Vault>/.note/tree.toml`，
 * 属 [02] §`.note/` 两分层里的不可丢层——重建索引不会把它冲掉。
 */
export type SiblingOrder = { parent: string; names: string[] };

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
  /** 这次只取了前 limit 篇（Rust 侧 `NoteList.truncated`）。目录树的篇数要说真话就靠它 */
  truncated: boolean;
};

export type AppInfo = {
  version: string;
  vaultPath: string | null;
  indexNotes: number;
  schemaVersion: number;
  /** 备份三态：目录 / 显式关掉 / 还没引导过（界面据此决定要不要提醒） */
  backupDir: string | null;
  backupDisabled: boolean;
  backupUnconfigured: boolean;
  backupLastAt: string | null;
};

/** 一次图片入库的返回。`rel` 是 Vault 根相对路径，正文里写的就是它 */
export type AssetOut = {
  rel: string;
  mime: string;
  size: number;
  sha256: string;
  /** 盘上早有这一份（同一张图粘第二次），true 时后端没再写文件 */
  existed: boolean;
};

/** 快照列表里的一行。全量清单留在 Rust 侧，两万条 hash 不该过 IPC */
export type SnapshotRow = {
  id: string;
  takenAt: string;
  copiedFiles: number;
  totalFiles: number;
};

/** 导入预览里的一行：源文件 → 库内路径 */
export type ImportEntry = {
  srcRel: string;
  destRel: string;
  alreadyThere: boolean;
  markdown: boolean;
};

export type ImportReport = {
  notes: string[];
  assets: string[];
  renamed: [string, string][];
  skipped: string[];
  bytes: number;
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

/** 反链面板里的一条。入链与出链共用一个形状（`note_core::service::LinkRow`） */
export type LinkRow = {
  /** 对方笔记的路径；悬空出链没有对方，是空串 */
  rel: string;
  title: string;
  /** active / inbox / archived；悬空出链是 "missing" */
  status: string;
  /** 发起这条链的块的文字（已剥语法） */
  snippet: string;
  /** 链的是具体块（`[[笔记#^b-xxx]]`）还是整篇 */
  toBlock: boolean;
  /** 对方是不是一篇笔记。资产行的 `rel` 是 `attachments/…` 的文件路径，不是笔记路径 */
  toNote: boolean;
  kind: string;
  /** 用户写下的原始写法。悬空时这是仅剩的信息 */
  target: string;
  broken: boolean;
};

export type LinkPanel = {
  rel: string;
  incoming: LinkRow[];
  /** 这一半取不完。面板要把它说出来，不能让用户以为链到这就没了 */
  incomingTruncated: boolean;
  outgoing: LinkRow[];
  outgoingTruncated: boolean;
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

/** AI 档 0 的视图。**没有 key 字段**——明文 Key 不进 WebView（docs/03 §后端调用纪律） */
export type AiView = {
  baseUrl: string;
  chatModel: string;
  embeddingModel: string;
  keySet: boolean;
  /** 形如 `…ab12（32 位）`，只用来认出"是哪把 Key" */
  keyHint: string | null;
};

/** 连通测试的一步。stage 是 "chat" / "embeddings" / "config" */
export type AiStep = { stage: string; ok: boolean; ms: number; detail: string };

export type AiProbeReport = { ok: boolean; steps: AiStep[] };

/** 混合检索的一条命中。`from` 说的是这一条被哪几路捞上来——两路都中是最强的信号 */
export type HybridHit = {
  chunkId: number;
  noteId: string;
  path: string;
  title: string;
  headerPath: string;
  snippet: string;
  status: string;
  from: ("keyword" | "semantic")[];
  rrf: number;
};

export type HybridResult = {
  hits: HybridHit[];
  /** 语义那一路这次到底开没开。没开时 `hint` 会说要它做什么 */
  semantic: boolean;
  hint: string | null;
};
