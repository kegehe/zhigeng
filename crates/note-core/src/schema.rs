//! 索引层 DDL。**与 docs/02 §索引层 Schema 逐字段对应**；改这里必须同时改文档。
//!
//! 与文档的两处有意偏差，都已回写文档：
//! - 无 `deleted_at`：回收站由 `.note/trash/` 目录承载，状态不进 DB（G1）；
//! - `notes.origin` 与 `notes.note_kind` 为派生列，服务注入防护与视图排除。

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS notes (
  id           TEXT PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  note_kind    TEXT NOT NULL DEFAULT 'note',
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TEXT NOT NULL DEFAULT '',
  updated_at   INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  ai_private   INTEGER NOT NULL DEFAULT 0,
  no_ai        INTEGER NOT NULL DEFAULT 0,
  origin       TEXT NOT NULL DEFAULT 'human',
  rev          INTEGER NOT NULL DEFAULT 0,
  device_id    TEXT
);

CREATE TABLE IF NOT EXISTS blocks (
  id            TEXT PRIMARY KEY,
  note_id       TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  parent_id     TEXT REFERENCES blocks(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,
  type          TEXT NOT NULL,
  heading_level INTEGER,
  text          TEXT NOT NULL DEFAULT '',
  markdown      TEXT NOT NULL,
  line_start    INTEGER NOT NULL DEFAULT 0,
  line_end      INTEGER NOT NULL DEFAULT 0,
  props_json    TEXT
);
CREATE INDEX IF NOT EXISTS blocks_note_idx ON blocks(note_id, ordinal);

CREATE TABLE IF NOT EXISTS chunks (
  id          INTEGER PRIMARY KEY,
  note_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  start_block TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  end_block   TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  header_path TEXT,
  token_count INTEGER NOT NULL DEFAULT 0,
  text        TEXT NOT NULL,
  source_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_note_idx ON chunks(note_id);

CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
  seg, tokenize="unicode61 remove_diacritics 2"
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  seg, tokenize="unicode61 remove_diacritics 2"
);

CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id    INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  model       TEXT NOT NULL,
  dims        INTEGER NOT NULL,
  embedded_at INTEGER NOT NULL,
  PRIMARY KEY (chunk_id, model)
);

CREATE TABLE IF NOT EXISTS tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);

CREATE TABLE IF NOT EXISTS props (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value_text TEXT, value_num REAL, value_date TEXT, value_json TEXT,
  PRIMARY KEY (note_id, key)
);

CREATE TABLE IF NOT EXISTS links (
  id         INTEGER PRIMARY KEY,
  from_block TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  -- 悬空链接没有目标笔记，必须可为空，否则 UI 无法标红（docs/02 已同步）
  to_note    TEXT REFERENCES notes(id) ON DELETE CASCADE,
  to_block   TEXT REFERENCES blocks(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'human',
  broken     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS links_to_idx ON links(to_note);

-- 链接目标的原始写法。插入期登记、rebuild_links 统一解析：
-- 全量重建按路径顺序进行，指向"后面才入库的笔记"的链接在插入时查不到目标。
CREATE TABLE IF NOT EXISTS link_targets (
  from_block TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  target     TEXT NOT NULL,
  -- [[笔记#^b-xxx]] 的块级锚点。丢了它，AI 引用溯源就退化成"指向整篇笔记"
  to_block   TEXT,
  kind       TEXT NOT NULL,
  PRIMARY KEY (from_block, target, kind)
);

CREATE TABLE IF NOT EXISTS suggestions (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  note_id      TEXT REFERENCES notes(id) ON DELETE CASCADE,
  block_id     TEXT REFERENCES blocks(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  basis_json   TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  model        TEXT,
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER
);

CREATE TABLE IF NOT EXISTS ai_runs (
  id TEXT PRIMARY KEY, task TEXT NOT NULL, model TEXT NOT NULL,
  trigger TEXT NOT NULL,
  in_tokens INTEGER, out_tokens INTEGER, cost_usd REAL,
  ok INTEGER NOT NULL, error TEXT, duration_ms INTEGER,
  cited_blocks_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL, pinned INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT NOT NULL,
  citations_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  cron TEXT, next_run_at INTEGER, last_run_at INTEGER,
  status TEXT NOT NULL DEFAULT 'ready',
  attempts INTEGER DEFAULT 0, payload_json TEXT, result_json TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
  sha256 TEXT PRIMARY KEY, path TEXT NOT NULL, orig_name TEXT, mime TEXT NOT NULL,
  size INTEGER NOT NULL, width INTEGER, height INTEGER,
  ocr_text TEXT, first_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS note_versions (
  id INTEGER PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL, blob_path TEXT NOT NULL,
  reason TEXT, created_at INTEGER NOT NULL,
  UNIQUE (note_id, content_hash)
);
"#;
