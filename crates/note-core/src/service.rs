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

use crate::capture::Captured;
use crate::index::{Index, KeywordHit};
use crate::vault::{NoteKind, NoteStatus, Vault, INBOX_DIR, NOTES_DIR};
use crate::{Error, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub vault_path: Option<String>,
    pub index_notes: i64,
    pub schema_version: i64,
}

impl AppInfo {
    /// 还没选 Vault 时的占位。前端必须能区分"库里没内容"和"根本没选库"，
    /// 靠匹配错误字符串判定会随文案一起碎掉。
    pub fn no_vault() -> Self {
        Self {
            version: env!("CARGO_PKG_VERSION").to_string(),
            vault_path: None,
            index_notes: 0,
            schema_version: 0,
        }
    }
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

/// 回收站里的一条。`batch` + `rel` 一起才能定位，因为同一路径可能被删多次。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashRow {
    pub batch: String,
    pub rel: String,
    pub size: u64,
    pub updated_ms: i64,
}

/// 写路径只准落在"扫描器真的会索引"的位置。
///
/// 判据必须与 `is_indexable_rel` 同源，别自己写一份弱的：只挡首段的话，
/// `notes/.hidden/甲.md` 会顺利入库，而扫描器永不复现它——等于凭空造一条漂移行。
/// 少了这道闸，`save_note(".note/index.db")` 还能把整个索引覆盖掉。
fn check_note_rel(rel: &str) -> Result<()> {
    if !crate::vault::is_indexable_rel(rel) {
        return Err(Error::Invalid(format!(
            "该路径不会被当成笔记索引，拒绝写入: {rel}"
        )));
    }
    Ok(())
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

    /// 首启向导确认路径之后用：目录不存在就建出来，并放好 `inbox/` 与 `notes/`，
    /// 让新库在资源管理器里一眼看得懂。空目录不算 Vault 存在，所以必须先建再 open。
    pub fn open_or_create(root: &Path) -> Result<Self> {
        if !root.is_dir() {
            for dir in [
                root.to_path_buf(),
                root.join(INBOX_DIR),
                root.join(NOTES_DIR),
            ] {
                std::fs::create_dir_all(&dir).map_err(|e| Error::Io {
                    path: dir.display().to_string(),
                    source: e,
                })?;
            }
        }
        Self::open(root)
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
        check_note_rel(rel)?;
        let hash = self.vault.write_atomic(rel, content.as_bytes())?;
        // 只取这一个文件的元数据。以前这里 scan() 了整个 Vault 来拿一个 NoteFile，
        // 等于每次保存都要给全库算一遍 hash——5000 篇时早就爆掉 8ms 预算了。
        let file = self.vault.note_file(rel)?;
        self.index.index_file(&file, content)?;
        self.index.rebuild_links_of_note(rel)?;
        // 这篇新写出来的链接里，可能有别人早就悬空指向它的
        self.index.resolve_broken_to(rel)?;
        Ok(hash)
    }

    /// 新建一篇空笔记（标题只进 front-matter，正文留给用户写），返回相对路径。
    pub fn note_create(&mut self, title: &str) -> Result<String> {
        let title = title.trim();
        if title.is_empty() {
            return Err(Error::Invalid("标题不能为空".into()));
        }
        let rel = crate::capture::new_note_rel(&self.vault, title);
        let content = crate::capture::compose_new(
            title,
            &crate::capture::gen_note_id(),
            &crate::capture::today(),
        );
        self.save_note(&rel, &content)?;
        Ok(rel)
    }

    /// 移动或换目录（`notes/甲.md` → `archive/甲.md`）。
    ///
    /// 没有 front-matter `id:` 的笔记（手写与导入的占大多数）其 id 是从路径推的，
    /// 换路径等于换 id，旧行匹配不上就会留下指向已消失文件的幽灵行——照样能搜到。
    /// 所以先按旧路径把行清掉，再把指向它的入链标成悬空，最后按新路径接回来。
    /// 全程只碰与这篇有关的链接，不做全库重解析。
    pub fn note_move(&mut self, rel: &str, new_rel: &str) -> Result<()> {
        check_note_rel(new_rel)?;
        // 文件操作必须排在索引改动之前：反过来写的话，一次"目标已存在"的失败改名
        // 就会留下已经被置悬空的入链，而那篇笔记其实原地未动。
        self.vault.move_file(rel, new_rel)?;
        let content = String::from_utf8_lossy(&self.vault.read(new_rel)?).to_string();
        let file = self.vault.note_file(new_rel)?;
        self.index.break_incoming_links(rel)?;
        self.index.drop_note(rel)?;
        self.index.index_file(&file, &content)?;
        self.index.rebuild_links_of_note(new_rel)?;
        self.index.resolve_broken_to(new_rel)?;
        Ok(())
    }

    /// 改名。文件名与 front-matter 的 title 一起改——列表显示的是 title，
    /// 只动文件名的话用户会以为没改成功。
    pub fn note_rename(&mut self, rel: &str, new_stem: &str) -> Result<String> {
        let want = new_stem.trim();
        if want.is_empty() {
            return Err(Error::Invalid("新名字是空的".into()));
        }
        let stem = crate::vault::sanitize_file_stem(want);
        let dir = rel.rsplit_once('/').map(|(d, _)| format!("{d}/")).unwrap_or_default();
        let new_rel = format!("{dir}{stem}.md");
        if new_rel == rel {
            return Ok(rel.to_string());
        }
        // 先把要打的新内容算出来再动文件：读盘或改 YAML 失败时，改名整个不发生，
        // 不会留下"文件名改了、标题还是旧的"这种半状态。
        let content = String::from_utf8_lossy(&self.vault.read(rel)?).to_string();
        let patched = crate::capture::set_front_title(&content, &stem);
        self.note_move(rel, &new_rel)?;
        if patched != content {
            self.save_note(&new_rel, &patched)?;
        }
        Ok(new_rel)
    }

    /// 移进回收站。文件本身还在（`.note/trash/`），所以这条操作不丢内容；
    /// `note_versions` 的 before_delete 快照要等历史/撤销功能一起做（docs/02 §偏差）。
    pub fn note_trash(&mut self, rel: &str) -> Result<()> {
        self.vault.move_to_trash(rel)?;
        // 入链先置悬空再删行：直接删会被 ON DELETE CASCADE 一起带走，
        // 恢复时就没有"曾经指向它"的记录可接回来了。放在移文件之后是为了让
        // 失败的删除不先把索引改坏（理由同 note_move）。
        self.index.break_incoming_links(rel)?;
        self.index.drop_note(rel)?;
        Ok(())
    }

    pub fn list_trash(&self) -> Result<Vec<TrashRow>> {
        Ok(self
            .vault
            .list_trash()?
            .into_iter()
            .map(|t| TrashRow {
                batch: t.batch,
                rel: t.rel,
                size: t.size,
                updated_ms: t.mtime_ms,
            })
            .collect())
    }

    /// 从回收站移回原位并重新解析。原位已被同名笔记占用时报冲突，不覆盖。
    pub fn note_restore(&mut self, batch: &str, rel: &str) -> Result<()> {
        self.vault.restore_from_trash(batch, rel)?;
        let content = String::from_utf8_lossy(&self.vault.read(rel)?).to_string();
        let file = self.vault.note_file(rel)?;
        self.index.index_file(&file, &content)?;
        self.index.rebuild_links_of_note(rel)?;
        self.index.resolve_broken_to(rel)?;
        Ok(())
    }

    /// 捕获一篇速记：落盘 + 立刻索引。GUI 走的是拆分后的两步版本。
    pub fn capture(&mut self, raw: &str, source_url: Option<&str>) -> Result<Captured> {
        let mut cap = self.capture_write(raw, source_url, true)?;
        let t0 = std::time::Instant::now();
        self.index_captured(&cap.rel, &cap.content)?;
        cap.index_ms = t0.elapsed().as_millis() as u64;
        Ok(cap)
    }

    /// 第一步：落盘（默认含 fsync）。速记窗只需等这一步。
    pub fn capture_write(
        &mut self,
        raw: &str,
        source_url: Option<&str>,
        durable: bool,
    ) -> Result<Captured> {
        crate::capture::capture_text_opts(&self.vault, raw, source_url, durable)
    }

    /// 第二步：单篇增量索引。与落盘分开，这样速记窗不必等它（docs/04 §1）。
    pub fn index_captured(&mut self, rel: &str, content: &str) -> Result<()> {
        let file = self.vault.note_file(rel)?;
        self.index.index_file(&file, content)?;
        Ok(())
    }

    /// 原文。只在进入编辑态时才调——`read_note` 每次渲染都要走，把整篇 Markdown
    /// 塞进它的返回值里会让 3000 块的长文档在普通浏览时也付这份序列化代价。
    pub fn read_raw(&self, rel: &str) -> Result<String> {
        Ok(String::from_utf8_lossy(&self.vault.read(rel)?).to_string())
    }

    /// 自检：md 与 db 是否一致。UI 的"索引健康"与 CI 都读这两个。
    pub fn drift(&self) -> Result<i64> {
        self.index.drift(&self.vault)
    }

    pub fn orphan_counts(&self) -> Result<crate::index::Orphans> {
        self.index.orphan_counts()
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
