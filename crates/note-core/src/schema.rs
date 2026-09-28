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
-- title 没有索引，而链接可以只按标题写（[[某笔记的标题]]）。
-- path 已由 UNIQUE 建了隐式索引，再建一个是白付写放大。
CREATE INDEX IF NOT EXISTS notes_title_idx ON notes(title);

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
-- 外键列在**被引用侧删行**时是要查的：没有索引，SQLite 就对每个被删的块全表扫一次。
-- 增量索引一篇 3000 块的笔记 = 先删 2999 行，于是 2999 × 全表扫。实测（release，
-- 2026-09-24）一次保存后第一个同步读命令要等 22.5 秒；8 块的短笔记只有 126 毫秒。
CREATE INDEX IF NOT EXISTS blocks_parent_idx ON blocks(parent_id);
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
-- 同上：删块时这两条外键也要查 chunks
CREATE INDEX IF NOT EXISTS chunks_start_idx ON chunks(start_block);
CREATE INDEX IF NOT EXISTS chunks_end_idx ON chunks(end_block);

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
  -- 链接目标的**原始写法**（schema v2 → v3 补）。`to_note` 为空时它是仅剩的信息：
  -- 界面要能说出"这篇链到了不存在的 [[某写法]]"，否则反链面板只能报一个数字。
  -- 与 `link_targets.target` 有意重复：那张表是解析前的暂存，会被按篇重灌，
  -- 而 links 是解析结果，读一次就够——面板不该为了显示写法再去join暂存表。
  target     TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'human',
  broken     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS links_to_idx ON links(to_note);
-- 两条外键都要在 links 里找引用行（删块时 CASCADE / SET NULL）。没有索引时 SQLite 对
-- 每个被删的块全表扫一次 links。注意：**这不是"保存 3000 块长文档后读命令卡 23 秒"的
-- 原因**（补上这两个索引实测没变化，2026-09-24 release 构建），那条缺陷仍未定位。
-- 这里补索引是按规模该做的事，不是那次修复的功劳。
CREATE INDEX IF NOT EXISTS links_from_idx ON links(from_block);
CREATE INDEX IF NOT EXISTS links_to_block_idx ON links(to_block);

-- 链接目标的原始写法。插入期登记、rebuild_links 统一解析：
-- 全量重建按路径顺序进行，指向"后面才入库的笔记"的链接在插入时查不到目标。
CREATE TABLE IF NOT EXISTS link_targets (
  from_block TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  target     TEXT NOT NULL,
  -- [[笔记#^b-xxx]] 的块级锚点。丢了它，AI 引用溯源就退化成"指向整篇笔记"。
  -- 空串表示"没有锚点"而不是 NULL：SQLite 的 PRIMARY KEY 视 NULL 互不相等，
  -- 用 NULL 的话同一段里两条无锚点的链接会重复登记。
  to_block   TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL,
  -- 主键必须带上 to_block：只按 (from_block,target,kind) 的话，同一段里指向同一篇的
  -- `[[乙]]`、`[[乙#某标题]]`、`[[乙#^b-xxx]]` 会塌成一行，块级锚点被静默丢掉。
  PRIMARY KEY (from_block, target, kind, to_block)
);
-- 恢复/新建一篇笔记时，要找出"之前指向它而当时解析失败"的链接。没有这个索引就是全表扫。
CREATE INDEX IF NOT EXISTS link_targets_target_idx ON link_targets(target);

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
