//! 服务层：把 vault + index 编排成可被 UI / CLI / MCP 共用的命令。
//!
//! 这是 docs/03 §后端 = 本地服务层 里"只有服务层可被外部调用"的那一层。
//! 三条纪律在这里体现：
//! 1. 返回的都是 DTO，不把 `NoteFile`/`Block` 等内部结构泄漏给前端；
//! 2. 任何同步命令的预算是 8ms（G6），因此这里只做索引查询，不碰 AI 与网络；
//! 3. M0 用一个 `Mutex` 串行化 SQLite 访问。连接池与单写者队列在 M1 引入，
//!    但**接口形状现在就这样定**，避免以后改所有调用点。

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::index::{Index, KeywordHit};
use crate::vault::{NoteKind, NoteStatus, Vault};
use crate::{Error, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub vault_path: Option<String>,
    pub index_notes: i64,
    pub schema_version: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRow {
    pub rel: String,
    pub title: String,
    pub status: String,
    pub kind: String,
    pub updated_ms: i64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteList {
    pub notes: Vec<NoteRow>,
    pub vault_path: String,
    pub indexed: i64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockRow {
    pub id: String,
    pub r#type: String,
    pub text: String,
    pub heading_level: Option<i64>,
    pub line_start: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDetail {
    pub rel: String,
    pub title: String,
    pub blocks: Vec<BlockRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HitRow {
    pub block_id: String,
    pub note_id: String,
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
}

/// 打开后的应用级状态。`Hub` 不是 `Sync`（内含 rusqlite 连接），
/// 所以包在 `Mutex` 后面由调用方持有。
pub struct Hub {
    vault: Vault,
    index: Index,
    root: PathBuf,
}

impl Hub {
    /// 打开 Vault 并确保索引存在。首启只建表不重建（重建交给显式任务，
    /// 否则冷启动会被全量索引拖过 1.5s 预算）。
    pub fn open(root: &Path) -> Result<Self> {
        let vault = Vault::open(root)?;
        let opened = vault.root().to_path_buf();
        let mut index = Index::open(&vault)?;
        // 首启只在这时建一次索引；后续启动交给显式任务，
        // 否则冷启动会被全量重建拖过 1.5s 预算。
        if index.count_notes()? == 0 {
            index.rebuild_all(&vault)?;
        }
        Ok(Self {
            vault,
            index,
            root: opened,
        })
    }

    pub fn app_info(&self) -> Result<AppInfo> {
        Ok(AppInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            vault_path: Some(self.root.display().to_string()),
            index_notes: self.index.count_notes()?,
            schema_version: self.index.schema_version()?,
        })
    }

    pub fn list_notes(&self, limit: usize) -> Result<NoteList> {
        let rows = self.index.list_notes(limit)?;
        Ok(NoteList {
            truncated: rows.len() == limit,
            notes: rows,
            vault_path: self.root.display().to_string(),
            indexed: self.index.count_notes()?,
        })
    }

    pub fn read_note(&self, rel: &str) -> Result<NoteDetail> {
        let (title, blocks) = self.index.note_blocks(rel)?;
        Ok(NoteDetail {
            rel: rel.to_string(),
            title,
            blocks,
        })
    }

    pub fn search_keyword(&self, query: &str, limit: usize) -> Result<Vec<HitRow>> {
        let hits = self.index.search_keyword(query, limit)?;
        Ok(hits.into_iter().map(Into::into).collect())
    }

    /// 供写路径使用：保存一篇笔记并增量重建它的索引。
    /// 返回内容 hash，UI 用它做乐观并发（下次保存前比对，不一致就是有人在外面改过）。
    pub fn save_note(&mut self, rel: &str, content: &str) -> Result<String> {
        let hash = self.vault.write_atomic(rel, content.as_bytes())?;
        let files = self.vault.scan()?;
        let file = files
            .iter()
            .find(|f| f.rel == rel)
            .ok_or_else(|| Error::NotFound(rel.to_string()))?;
        self.index.index_file(file, content)?;
        Ok(hash)
    }

    pub fn vault(&self) -> &Vault {
        &self.vault
    }
}

impl From<KeywordHit> for HitRow {
    fn from(h: KeywordHit) -> Self {
        Self {
            block_id: h.block_id,
            note_id: h.note_id,
            path: h.path,
            title: h.title,
            snippet: h.snippet,
            score: h.score,
        }
    }
}

pub fn status_label(s: NoteStatus) -> &'static str {
    match s {
        NoteStatus::Inbox => "inbox",
        NoteStatus::Active => "active",
        NoteStatus::Archived => "archived",
    }
}

pub fn kind_label(k: NoteKind) -> &'static str {
    match k {
        NoteKind::Note => "note",
        NoteKind::View => "view",
    }
}
