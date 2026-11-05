//! 服务层：把 vault + index 编排成可被 UI / CLI / MCP 共用的命令。
//!
//! 这是 docs/03 §后端 = 本地服务层 里"只有服务层可被外部调用"的那一层。
//! 三条纪律在这里体现：
//! 1. 返回的都是 DTO，不把 `NoteFile`/`Block` 等内部结构泄漏给前端；
//! 2. 任何同步命令的预算是 8ms（G6），因此这里只做索引查询，不碰 AI 与网络；
//! 3. 同步命令的预算是 8ms（G6）。SQLite 侧因此是**两条连接**：前台一条（读写都短），
//!    后台补索引一条（长）。WAL 下读不挡写，所以"索引在后台"不再等于"读命令排队等锁"。
//!    两条连接同时想写时靠 `busy_timeout` 等，等的是写者，读者不受影响。

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::capture::Captured;
use crate::index::{Index, KeywordHit};
use crate::snapshot;
use crate::vault::{NoteKind, NoteStatus, Vault, INBOX_DIR, NOTES_DIR};
use crate::{Error, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub vault_path: Option<String>,
    pub index_notes: i64,
    pub schema_version: i64,
    /// 备份三态：目录 / 显式关掉 / 还没引导过（前端据此决定要不要提醒）。
    /// 判据来自 docs/03 §备份——"唯一副本 = 没有副本"。
    pub backup_dir: Option<String>,
    pub backup_disabled: bool,
    pub backup_unconfigured: bool,
    pub backup_last_at: Option<String>,
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
            backup_dir: None,
            backup_disabled: false,
            backup_unconfigured: false,
            backup_last_at: None,
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

/// 版本历史里的一条。**一条快照 = 一个曾经存在过的版本**，也就是那次操作
/// **之前**盘上的内容（撤销靠它，docs/04 §建议的生命周期）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionRow {
    pub id: i64,
    /// `manual` / `ai_applied` / `before_delete`
    pub reason: String,
    pub content_hash: String,
    /// epoch 毫秒
    pub created_at: i64,
    /// 人看得懂的时间（本地时区）
    pub created_at_text: String,
    /// 这一版有多少字节
    pub size: usize,
}

/// epoch 毫秒 → 本地时区的 RFC3339。
fn 时刻文本(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.with_timezone(&chrono::Local).to_rfc3339())
        .unwrap_or_default()
}

/// 反链面板里的一条。入链与出链共用一个形状：面板要说的都是"哪篇、哪块、什么写法、
/// 断没断"。入链的 `broken` 恒为 false（能算入链就说明目标就是本篇）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRow {
    /// 对方笔记的路径。悬空出链没有对方 → 空串
    pub rel: String,
    pub title: String,
    /// 对方的状态：active / inbox / archived；悬空出链是 "missing"
    pub status: String,
    /// 发起这条链的那个块的文字（已剥语法），面板拿它当上下文
    pub snippet: String,
    /// 这条链是不是指到某个具体块（`[[笔记#^b-xxx]]`），而不是整篇
    pub to_block: bool,
    /// 对方是不是一篇笔记。资产行的 `rel` 装的是 `attachments/…` 的**文件路径**，
    /// 不是笔记——面板要靠这一位决定"这一行能不能点开成一篇"。
    /// 反过来 `[[notes/乙.md]]` 的 `kind` 也是 `asset`（写法里有点），但它当然是笔记。
    pub to_note: bool,
    pub kind: String,
    /// 用户写下的原始写法。悬空时这是仅剩的信息
    pub target: String,
    pub broken: bool,
}

/// 一篇的链接图两半。`*Truncated` 说的是"这一半还有更多没取回来"——
/// 面板不能安静地把截断藏起来，用户会以为链到这就没了。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPanel {
    pub rel: String,
    pub incoming: Vec<LinkRow>,
    pub incoming_truncated: bool,
    pub outgoing: Vec<LinkRow>,
    pub outgoing_truncated: bool,
}

/// 打开后的应用级状态。`Hub` 不是 `Sync`（内含 rusqlite 连接），
/// 所以包在 `Mutex` 后面由调用方持有。
pub struct Hub {
    vault: Vault,
    index: Index,
    /// 后台索引专用的第二条连接（同一个库文件）。**这是把 2 秒从读路径上摘下来的全部机制**：
    /// 补索引不再握着主锁，读命令于是与它无关（WAL 下读不挡写）。docs/03 §后端调用纪律。
    ///
    /// **不变量：GUI 里主连接只读。** 所有写要么走这条 `bg`，要么在 `Hub` 的 `*_file`
    /// 方法里只动文件。前台一旦有人直接往 `self.index` 写，就会与后台那条形成
    /// **逻辑竞态**——两条连接各自对同一篇"先删后插"，`busy_timeout` 只让它们排队，
    /// 挡不住交错出来的重复行或丢更新。要加前台写，先让它走 `indexer()`。
    bg: std::sync::Arc<std::sync::Mutex<Index>>,
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

/// 编辑器的输入：整篇源文本 + 它的 hash。hash 要原样带回来才能做冲突判定。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSource {
    pub content: String,
    pub hash: String,
}

/// 从源文本算出编辑器要的结构。单独拆出来是为了让 CLI 能把块结构导成 JSON 夹具——
/// 前端那个字节级往返测试必须吃**同一份解析结果**，否则两边各测各的，契约照样会破。
pub fn edit_doc_of(src: &str) -> EditDoc {
    let doc = md_kernel::parse(src);
    EditDoc {
        front_matter: doc
            .front_matter
            .as_ref()
            .map(|f| f.raw.clone())
            .unwrap_or_default(),
        trailing_gap: doc.trailing_gap,
        blocks: doc.blocks.iter().map(EditBlock::from).collect(),
    }
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

/// 编辑器要的块树。每个块带**精确源切片**：用户没碰过的块要能字节级原样写回（I4），
/// 只有真被改过的块才由前端重新产 Markdown。
///
/// 与索引走同一个 `md_kernel::parse`，不允许前端另建一套块模型。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditBlock {
    pub kind: String,
    pub id: Option<String>,
    /// 精确源切片（含块 ID 标记与结尾换行）。未改动的块靠它字节级回写。
    pub raw: String,
    pub gap_before: String,
    /// 去掉前缀、缩进与 ID 之后的正文，仍含行内语法。
    ///
    /// **不含 `due::` 这类行内字段**（与索引同口径，见 `md_kernel::extract_fields`），
    /// 所以字段另存在 `fields` 里：前端重新产出这一块时必须把它们写回，
    /// 否则勾选一次待办就把用户的 `due:: 2026-09-30` 洗掉。
    pub content: String,
    pub level: Option<i64>,
    pub checked: Option<bool>,
    /// `center` / `right` / `justify`；`None` 为默认靠左（docs/02 D40）。
    pub align: Option<String>,
    pub fields: Vec<(String, String)>,
    pub children: Vec<EditBlock>,
}

impl From<&md_kernel::Block> for EditBlock {
    fn from(b: &md_kernel::Block) -> Self {
        let (level, checked) = match b.kind {
            md_kernel::Kind::Heading { level, .. } => (Some(level as i64), None),
            md_kernel::Kind::Todo { checked } => (None, Some(checked)),
            _ => (None, None),
        };
        Self {
            kind: b.kind.as_str().to_string(),
            id: b.id.clone(),
            raw: b.raw.clone(),
            gap_before: b.gap_before.clone(),
            content: b.content.clone(),
            level,
            checked,
            align: b.align.clone(),
            fields: b.fields.clone(),
            children: b.children.iter().map(EditBlock::from).collect(),
        }
    }
}

/// 后台快照入口：只要一个 `Vault` 克隆，**不排主锁**。
/// 壳里的"当日首次启动后跑一次"用的就是这条（docs/03 §备份、§后端调用纪律）。
pub fn snapshot_vault(vault: &Vault, force: bool) -> Result<Option<SnapshotRow>> {
    Ok(snapshot::run(vault, force)?.map(SnapshotRow::of))
}

/// 外部改动的收敛（docs/05 验收 ⑤ 的"要么刷新"那一半）。返回动了几篇。
///
/// 两条判据都**不信监听器的分类**，只看现在的事实：
///
/// - 文件在，且磁盘 hash 与库里记的不一样 → 重索引。相等就是我们自己刚写的那一次
///   （原子写必然触发事件），于是 no-op——没有这道闸门，每次保存都会掀起一轮停不下来的事件。
/// - 文件不在，但库里有行 → 摘掉。监听器把改名报成 `Removed` 还是 `Touched` 都收敛到同一结果。
///
/// "在不在"是直接读出来的，不是先 `exists()` 再读：两次判断之间文件可能被删，
/// 而让那一次失败冒到上层等于**把整批其他路径一起丢掉**——事件不会再来第二次。
pub fn apply_external(
    vault: &Vault,
    index: &Index,
    changes: &[crate::watch::Change],
) -> Result<usize> {
    let mut done = 0usize;
    for c in changes {
        let rel = match c {
            crate::watch::Change::Touched(r) | crate::watch::Change::Removed(r) => r,
        };
        let on_disk = vault.read(rel).map(|b| crate::hash::content_hash(&b)).ok();
        let stored = index.stored_hash(rel)?;
        match (on_disk, stored) {
            (Some(h), Some(old)) if h == old => {} // 自己刚写的那一次
            // 扫描器不收的路径（被排除的目录、`.md` 之外的东西）也不能在这儿收进来：
            // 那会让索引里多出一行、全库自检从此报漂移，而监听器不知道这些规矩。
            // （2026-10-09 复查：这里曾改成"开头就 continue"，理由是"粘一张 5MB 的图会白读
            // 一遍"——那条理由**不成立**，`watch::ignorable` 在攒批之前就把非 `.md` 全挡了，
            // 事件根本到不了这里；而 continue 会连下面那条"盘上没了就摘掉"一起跳过。已回退。）
            (Some(_), _) if !crate::vault::is_indexable_rel(rel) => {}
            (Some(_), _) => {
                reindex_note(vault, index, rel)?;
                done += 1;
            }
            (None, Some(_)) => {
                unindex(vault, index, rel)?;
                done += 1;
            }
            (None, None) => {} // 盘上没有、库里也没有
        }
    }
    Ok(done)
}

/// 快照列表里的一行。**不把 `files` 全量清单带给前端**——那是两万条 hash，
/// 界面只要"哪一份、什么时候、动了几个文件"。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRow {
    pub id: String,
    pub taken_at: String,
    pub copied_files: usize,
    pub total_files: usize,
}

impl SnapshotRow {
    fn of(s: snapshot::Snapshot) -> Self {
        Self {
            id: s.id,
            taken_at: s.taken_at,
            copied_files: s.copied.len(),
            total_files: s.files.len(),
        }
    }
}

/// 一整篇给编辑器的输入。front-matter 与文件末尾空白**不是块**，
/// 不单独带回去的话，保存一次就把用户的 YAML 和结尾换行吃掉了。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditDoc {
    pub front_matter: String,
    pub trailing_gap: String,
    pub blocks: Vec<EditBlock>,
}

// 编辑器的保存输入仍是整篇 Markdown（未改动的块由前端原样回显），
// 所以这里不需要"逐块提交"的 DTO——少一条会与 `save_note` 分叉的写路径。
// （设计说明，不是下面那个函数的文档：夹在两个条目之间时会成为悬空注释）

/// 补一篇的索引：写内容与块 → 重建本篇出链 → 把别人悬空指向它的链接接回来。
///
/// 三步在**一个事务**里。2999 块逐条自动提交要 2 秒，一次提交是几十毫秒量级；
/// 而这段时间正是后台握着写者的长度。签名取 `&Index` 而不是 `&mut Hub`，
/// 是为了让 `spawn_blocking` 能拿着第二条连接做这件事，不把主锁一起带走。
pub fn reindex_note(vault: &Vault, index: &Index, rel: &str) -> Result<()> {
    let file = vault.note_file(rel)?;
    let content = String::from_utf8_lossy(&vault.read(rel)?).to_string();
    index.in_tx(|| {
        // 版本快照先落：它是"那次保存之前"的那一版，与索引重建无关，
        // 但得在同一趟里做完——不然同步那一半排进队列的东西没人认领。
        crate::versions::落待落(vault, index, rel)?;
        index.index_file(&file, &content)?;
        index.rebuild_links_of_note(rel)?;
        // 这篇新写出来的链接里，可能有别人早就悬空指向它的
        index.resolve_broken_to(rel)?;
        Ok(())
    })
}

/// 换路径（改名 / 归档 / 从回收站放回）。旧行先摘，再按新路径补。
pub fn reindex_moved(vault: &Vault, index: &Index, rel: &str, new_rel: &str) -> Result<()> {
    if rel == new_rel {
        return reindex_note(vault, index, new_rel);
    }
    unindex(vault, index, rel)?;
    // 版本历史跟着笔记一起搬：钥匙是路径，路径一换，历史就掉在旧路径上了。
    crate::versions::搬家(index, rel, new_rel)?;
    reindex_note(vault, index, new_rel)
}

/// 把一篇从索引里摘掉，并把它人的入链退回悬空（不随 `ON DELETE CASCADE` 静默消失）。
pub fn unindex(vault: &Vault, index: &Index, rel: &str) -> Result<()> {
    index.in_tx(|| {
        // 快照要在 `notes` 行被删**之前**落：那一行是"这篇当时叫什么"的唯一来源。
        // 落下来的版本本身不挂外键，所以删行之后它照样在（docs/02 §回收站的索引处理）。
        crate::versions::落待落(vault, index, rel)?;
        index.break_incoming_links(rel)?;
        index.drop_note(rel)?;
        Ok(())
    })
}

/// 速记落盘后的补索引：只有一篇新文件，没有链接要接，所以不套事务。
pub fn reindex_captured(vault: &Vault, index: &Index, rel: &str, content: &str) -> Result<()> {
    let file = vault.note_file(rel)?;
    index.index_file(&file, content)?;
    Ok(())
}

impl Hub {
    /// 打开 Vault 并确保索引存在。首启只建表不重建（重建交给显式任务，
    /// 否则冷启动会被全量索引拖过 1.5s 预算）。
    pub fn open(root: &Path) -> Result<Self> {
        let vault = Vault::open(root)?;
        let opened = vault.root().to_path_buf();
        let index = Index::open(&vault)?;
        // 首启只在这时建一次索引；后续启动交给显式任务，
        // 否则冷启动会被全量重建拖过 1.5s 预算。
        if index.count_notes()? == 0 {
            index.rebuild_all(&vault)?;
        }
        // 后台那条连接先 fork 出来：版本历史的清理要**写库**（删行、删 blob），
        // 而 GUI 里**主连接只读**——写一律走后台那条，前台那条一笔都不写。
        let bg = index.fork()?;
        // 版本历史的清理放在开库这一刻：那时没有前台命令在等，做点清理不占谁的 8ms。
        // 失败只记日志——历史多了几条不影响别的功能，清理失败不该挡住开库。
        if let Err(e) = crate::versions::清理(&bg, crate::versions::手工保留上限) {
            tracing::warn!("清理版本历史失败：{e}");
        }
        if let Err(e) = crate::versions::清孤儿(&bg) {
            tracing::warn!("清理版本残留失败：{e}");
        }
        Ok(Self {
            vault,
            bg: std::sync::Arc::new(std::sync::Mutex::new(bg)),
            index,
            root: opened,
        })
    }

    /// 后台索引的句柄。给 `spawn_blocking` 之前先拿这个，**拿完就把主锁还回去**——
    /// 让读命令等一把锁等到补完 2999 块，就是上一版 3.26 秒的来源。
    pub fn indexer(&self) -> std::sync::Arc<std::sync::Mutex<Index>> {
        self.bg.clone()
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
        let cfg = snapshot::load_config(&self.vault)?;
        let last = match cfg.target() {
            Some(dir) => snapshot::vault_dir(&self.vault, dir)
                .ok()
                .and_then(|d| snapshot::list(&d).ok())
                .and_then(|v| v.last().map(|s| s.taken_at.clone())),
            None => None,
        };
        Ok(AppInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            vault_path: Some(self.root.display().to_string()),
            index_notes: self.index.count_notes()?,
            schema_version: self.index.schema_version()?,
            backup_dir: cfg.dir.clone(),
            backup_disabled: cfg.disabled,
            // 既没选目录也没显式关掉 = 还没引导过，界面该提醒而不是安静地不备份
            backup_unconfigured: cfg.dir.is_none() && !cfg.disabled,
            backup_last_at: last,
        })
    }

    // ---- 备份与快照（docs/03 §备份：每日一次增量快照到第二个目录）----

    /// 设备份目录，或显式关掉（`disabled = true`）。非法路径直接报错，不写坏配置。
    pub fn set_backup(&self, dir: Option<&str>, disabled: bool) -> Result<()> {
        let cfg = snapshot::BackupConfig {
            dir: dir.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            disabled,
        };
        if let Some(target) = cfg.target() {
            let per_vault = snapshot::vault_dir(&self.vault, target)?;
            std::fs::create_dir_all(&per_vault).map_err(|e| Error::Io {
                path: per_vault.display().to_string(),
                source: e,
            })?;
        }
        snapshot::save_config(&self.vault, &cfg)
    }

    /// 跑一次快照。`None` = 今天已经做过，或压根没配备份目录。
    ///
    /// 走 `Hub` 的那条路会握着主锁跑完整库遍历——两万篇时又是几十秒的读命令阻塞，
    /// 与刚拆掉的索引抢锁是同一个病。后台触发一律用自由函数 [`snapshot_vault`]，
    /// 它只要一个 `Vault` 克隆（这里保留的方法给 CLI 与测试）。
    pub fn snapshot_now(&self, force: bool) -> Result<Option<SnapshotRow>> {
        snapshot_vault(&self.vault, force)
    }

    fn backup_dir_of(&self) -> Result<Option<std::path::PathBuf>> {
        let cfg = snapshot::load_config(&self.vault)?;
        match cfg.target() {
            Some(d) => Ok(Some(snapshot::vault_dir(&self.vault, d)?)),
            None => Ok(None),
        }
    }

    /// 最近的几份快照（新的在前）。
    pub fn snapshots_recent(&self, limit: usize) -> Result<Vec<SnapshotRow>> {
        let Some(dir) = self.backup_dir_of()? else {
            return Ok(Vec::new());
        };
        let mut rows: Vec<SnapshotRow> = snapshot::list(&dir)?
            .into_iter()
            .map(SnapshotRow::of)
            .collect();
        rows.reverse();
        rows.truncate(limit);
        Ok(rows)
    }

    /// 某篇文件的快照历史（新的在前）。只看哪些快照目录里真的有它的实体。
    pub fn snapshots_of(&self, rel: &str) -> Result<Vec<SnapshotRow>> {
        let Some(dir) = self.backup_dir_of()? else {
            return Ok(Vec::new());
        };
        Ok(snapshot::history_of(&dir, rel)?
            .into_iter()
            .map(SnapshotRow::of)
            .collect())
    }

    /// 把某篇从某份快照里取回来。**只落盘，不索引**——与保存同一条纪律
    /// （同步那一半 ≤ 8ms，索引交给后台）。当前版本与快照不同时会先存进
    /// `.note/conflicts/`：恢复是覆盖动作，被覆盖的那份得留得下来。
    pub fn snapshot_restore(&mut self, rel: &str, id: &str) -> Result<String> {
        let dir = self
            .backup_dir_of()?
            .ok_or_else(|| Error::Invalid("还没配置备份目录".into()))?;
        let bytes = snapshot::read_file(&dir, id, rel)?;
        // 恢复是覆盖动作，盘上现在那份要被换掉。前像照旧存一份——
        // 不存的话"恢复之后再撤销"就没有落点了（`.note/conflicts/` 是另一条退路：
        // 它留的是文件副本，不进版本历史，撤销那条路读不到它）。
        let 当前 = self.vault.read(rel).ok();
        if let Some(cur) = &当前 {
            if cur.as_slice() != bytes.as_slice() {
                self.vault.keep_conflict(rel, cur)?;
            }
        }
        self.记前像(rel, crate::versions::手工, 当前);
        self.vault.write_atomic(rel, &bytes)
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

    /// 侧栏目录树的自定义顺序（`<Vault>/.note/tree.toml`）。
    ///
    /// 两个方向都不碰 SQLite：顺序既不是笔记内容，也不是可再生索引，而是第三类
    /// （[02] §`.note/` 两分层里的不可丢层）。所以读它不需要索引在，写它不会让任何
    /// 一篇重解析——一次拖拽只落一个小文件，这是它能压在 G6 的 8ms 里的原因。
    pub fn tree_order(&self) -> Result<Vec<crate::tree_order::TreeOrder>> {
        crate::tree_order::load(&self.vault)
    }

    pub fn save_tree_order(&self, orders: &[crate::tree_order::TreeOrder]) -> Result<()> {
        crate::tree_order::save(&self.vault, orders)
    }

    /// 侧栏要展示的全部目录（含空目录、任意层级）。
    ///
    /// 递归遍历是文件系统活，库大了会超过同步命令的 8ms——GUI 侧走
    /// `spawn_blocking`（见 `src-tauri/src/lib.rs` 的 `dir_list`），CLI 与测试里直接调。
    pub fn list_dirs(&self) -> Result<Vec<String>> {
        self.vault.list_dirs()
    }

    pub fn create_dir(&self, parent: &str, name: &str) -> Result<String> {
        self.vault.create_dir(parent, name)
    }

    /// 改名之后跟着改 `tree.toml`。顺序文件写失败**不回滚改名**：
    /// 文件系统那一步已经成功了，报失败只会让界面以为没改成、再点一次就是冲突。
    /// 代价是一层的自定义序退回默认，比"目录改了一半"轻得多。
    pub fn rename_dir(&self, rel: &str, new_name: &str) -> Result<String> {
        let new_rel = self.vault.rename_dir(rel, new_name)?;
        if new_rel != rel {
            if let Err(e) = crate::tree_order::rename_path(&self.vault, rel, &new_rel) {
                tracing::warn!("目录改名后更新 tree.toml 失败：{e}");
            }
        }
        Ok(new_rel)
    }

    pub fn delete_dir(&self, rel: &str) -> Result<()> {
        self.vault.remove_dir(rel)?;
        if let Err(e) = crate::tree_order::remove_path(&self.vault, rel) {
            tracing::warn!("目录删除后更新 tree.toml 失败：{e}");
        }
        Ok(())
    }

    /// 菜单里"能不能改名 / 删除"的判据。一次 `read_dir`，同步命令守得住 8ms。
    pub fn dir_is_empty(&self, rel: &str) -> Result<bool> {
        self.vault.is_empty_dir(rel)
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

    /// 审计页：最近的生成记录（含失败的）。纯读，走主连接。
    pub fn ai_runs(&self, limit: i64) -> Result<Vec<crate::answer::运行>> {
        crate::answer::最近运行(self.index.conn(), limit)
    }

    /// 反链面板：一篇的入链与出链。纯读命令，走主连接（GUI 里那条只读），
    /// 预算与 `read_note` 同档——它只查 `links_to_idx` 与本篇的块，代价与库的规模无关。
    pub fn note_links(&self, rel: &str, limit: usize) -> Result<LinkPanel> {
        let (incoming, 入截, outgoing, 出截) = self.index.note_links(rel, limit as i64)?;
        Ok(LinkPanel {
            rel: rel.to_string(),
            incoming,
            incoming_truncated: 入截,
            outgoing,
            outgoing_truncated: 出截,
        })
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
        reindex_captured(&self.vault, &self.index, rel, content)
    }

    /// 编辑器加载一篇：内容和 hash 一起给。前端把 hash 原样带回来，
    /// 服务端才判断得出"你要存的这份，还是不是磁盘上那份"。
    pub fn read_raw(&self, rel: &str) -> Result<NoteSource> {
        let bytes = self.vault.read(rel)?;
        Ok(NoteSource {
            hash: crate::hash::content_hash(&bytes),
            content: String::from_utf8_lossy(&bytes).to_string(),
        })
    }

    /// 编辑器加载：front-matter + 块树 + 尾部空白，每块带精确源切片。
    /// 走的是与索引同一个 `md_kernel::parse`，前端不许自己再切一遍块。
    pub fn note_edit_doc(&self, rel: &str) -> Result<EditDoc> {
        let src = String::from_utf8_lossy(&self.vault.read(rel)?).to_string();
        Ok(edit_doc_of(&src))
    }

    /// 属性面板：front-matter 里用户能看懂的那几项（标签 / 属性 / AI 开关）。
    /// 带盘上 hash，保存时原样带回做冲突判定。
    pub fn note_meta(&self, rel: &str) -> Result<crate::meta_edit::MetaView> {
        let bytes = self.vault.read(rel)?;
        Ok(crate::meta_edit::view(
            &String::from_utf8_lossy(&bytes),
            &crate::hash::content_hash(&bytes),
        ))
    }

    /// **同步那一半**：只改属性面板提交的那几行，其余字节原样保留。
    ///
    /// 冲突判定与普通保存同一条：`expect_hash` 对不上就拒绝，绝不静默覆盖。
    /// 没有实际变化时连 `write_atomic` 都不走——面板上按一次「保存」不该产生一次
    /// 版本快照，也不该刷新 mtime。
    pub fn note_meta_save(
        &mut self,
        rel: &str,
        patch: &crate::meta_edit::MetaPatch,
        expect_hash: Option<&str>,
    ) -> Result<String> {
        let bytes = self.vault.read(rel)?;
        let 当前 = crate::hash::content_hash(&bytes);
        if let Some(want) = expect_hash {
            if 当前 != want {
                return Err(Error::Conflict(rel.to_string()));
            }
        }
        let content = String::from_utf8_lossy(&bytes).to_string();
        let next = crate::meta_edit::apply(&content, patch)?;
        if next == content {
            return Ok(当前);
        }
        self.save_note_write(rel, &next, expect_hash, crate::versions::手工)
    }

    /// **同步那一半**：校验 + 冲突判定 + 原子落盘，返回写后的 hash。
    ///
    /// `expect_hash` 是编辑器加载时拿到的 hash。磁盘上的已经变了就说明有人在外面
    /// 改过（Obsidian、另一台机器同步、自己另开的窗口），这时**拒绝写入**而不是
    /// 静默覆盖——docs/02 §写入与外部修改 的底线。传 `None` 表示不做判定（导入、
    /// 迁移等自有顺序的批量路径用）。
    ///
    /// `来源` 决定这条版本前像记成什么：`手工` 走 30 分钟合并窗口与保留上限，
    /// `AI落盘` 两条都不走。对话框点「替换」那一笔必须分开记，否则两次 AI 改写
    /// 会被合并成一条，事后再也分不清哪句是模型写的（docs/02 §版本快照）。
    pub fn save_note_write(
        &mut self,
        rel: &str,
        content: &str,
        expect_hash: Option<&str>,
        来源: &'static str,
    ) -> Result<String> {
        check_note_rel(rel)?;
        // 前像：落盘**之前**盘上那一份。它一次读干两件事——冲突判定要读它，
        // 版本快照要的也是它（docs/02 §写入与外部修改 的保存路径）。
        let 前像 = self.读前像(rel, expect_hash)?;
        self.记前像(rel, 来源, 前像);
        self.vault.write_atomic(rel, content.as_bytes())
    }

    /// 读落盘前盘上那一份（冲突判定与快照前像共用这一次读）。
    ///
    /// 读不出来就当"没有可比对的版本"：新文件本来就没有。冲突判定原先也是
    /// 这么判的（`if let Ok(cur) = ...`），这里保持一致。
    fn 读前像(&self, rel: &str, expect_hash: Option<&str>) -> Result<Option<Vec<u8>>> {
        let Ok(bytes) = self.vault.read(rel) else {
            return Ok(None);
        };
        if let Some(want) = expect_hash {
            if crate::hash::content_hash(&bytes) != want {
                return Err(Error::Conflict(rel.to_string()));
            }
        }
        Ok(Some(bytes))
    }

    /// 记一条前像快照。
    ///
    /// **同步这一半只读盘、只排队**：blob 与行由后台那一半落（versions::落待落）。
    /// 往 SQLite 写一行要跟后台那条连接抢写锁，而主锁被后台事务占住时前台
    /// 任何一条命令都得排队——那是 3.26 秒那次事故的形状，不能在写路径上再买一次。
    fn 记前像(&self, rel: &str, reason: &'static str, 前像: Option<Vec<u8>>) {
        let Some(bytes) = 前像 else {
            return; // 还没有这篇（新建），没有前像可记
        };
        self.index.推待落(crate::versions::待落 {
            rel: rel.to_string(),
            前像: bytes,
            reason,
            时刻: crate::versions::现在(),
        });
    }

    /// 某一篇的版本历史（新的在前）。
    pub fn note_versions(&self, rel: &str) -> Result<Vec<VersionRow>> {
        let rel = rel.replace('\\', "/");
        let 行 = crate::versions::列出(&self.index, &rel)?;
        Ok(行.into_iter().map(|r| self.版本行转显示(r)).collect())
    }

    /// 某一版的正文。**读回来先核对 hash**：对不上就是坏档，宁可报错也不把
    /// 半截内容当成用户的旧版本。
    pub fn note_version_content(&self, rel: &str, id: i64) -> Result<String> {
        let rel = rel.replace('\\', "/");
        let 行 = crate::versions::列出(&self.index, &rel)?
            .into_iter()
            .find(|r| r.id == id)
            .ok_or_else(|| Error::NotFound(format!("{rel} 的第 {id} 版")))?;
        let bytes = crate::versions::读回(self.vault.root(), &行)?;
        Ok(String::from_utf8_lossy(&bytes).to_string())
    }

    fn 版本行转显示(&self, r: crate::versions::版本行) -> VersionRow {
        VersionRow {
            id: r.id,
            reason: r.reason,
            content_hash: r.content_hash,
            created_at: r.created_at,
            created_at_text: 时刻文本(r.created_at),
            size: std::fs::metadata(self.vault.root().join(&r.blob_path))
                .map(|m| m.len() as usize)
                .unwrap_or(0),
        }
    }

    /// **后台那一半**：按磁盘现状重建这一篇的索引与链接。
    /// 与落盘分开是因为它实测要 8–10ms，留在同步路径上就把 G6 顶穿了
    /// （docs/03 §后端调用纪律：8ms–300ms 一律异步 + 乐观 UI）。
    pub fn index_one(&mut self, rel: &str) -> Result<()> {
        reindex_note(&self.vault, &self.index, rel)
    }

    /// 落盘 + 索引一起做。CLI、测试与批量路径用；GUI 走拆分后的两步。
    pub fn save_note(&mut self, rel: &str, content: &str) -> Result<String> {
        let hash = self.save_note_write(rel, content, None, crate::versions::手工)?;
        self.index_one(rel)?;
        Ok(hash)
    }

    /// 新建一篇空笔记的**落盘**部分，返回相对路径（索引留给 `index_one`）。
    ///
    /// `parent` 是"在哪一层新建"（侧栏某个目录）；`None` = 默认的 `notes/`。
    /// 默认那条要顺手把 `notes/` 建出来：老库可能只有根上的散篇，当初是
    /// `write_atomic` 顺手建父目录，现在落点先验存在，不补这一步就会建不出来。
    pub fn note_create_file(&mut self, title: &str, parent: Option<&str>) -> Result<String> {
        let title = title.trim();
        if title.is_empty() {
            return Err(Error::Invalid("标题不能为空".into()));
        }
        let parent = match parent.map(str::trim).filter(|p| !p.is_empty()) {
            Some(p) => self.vault.check_note_parent(p)?,
            None => {
                let abs = self.vault.resolve(NOTES_DIR)?;
                if !abs.is_dir() {
                    std::fs::create_dir_all(&abs).map_err(|e| Error::Io {
                        path: abs.display().to_string(),
                        source: e,
                    })?;
                }
                NOTES_DIR.to_string()
            }
        };
        let rel = crate::capture::new_note_rel_in(&self.vault, title, &parent)?;
        let content = crate::capture::compose_new(
            title,
            &crate::capture::gen_note_id(),
            &crate::capture::today(),
        );
        self.save_note_write(&rel, &content, None, crate::versions::手工)?;
        Ok(rel)
    }

    /// 新建一篇空笔记（标题只进 front-matter，正文留给用户写），返回相对路径。
    pub fn note_create(&mut self, title: &str, parent: Option<&str>) -> Result<String> {
        let rel = self.note_create_file(title, parent)?;
        self.index_one(&rel)?;
        Ok(rel)
    }

    /// **同步那一半**：改名或换目录的文件操作。目标已存在会在这里失败，
    /// 索引一个字都没动——失败的删除/改名不该先把索引改坏。
    pub fn note_move_file(&mut self, rel: &str, new_rel: &str) -> Result<()> {
        check_note_rel(new_rel)?;
        self.vault.move_file(rel, new_rel)
    }

    /// **后台那一半**：把旧路径的行清掉并按新路径重建。
    ///
    /// 没有 front-matter `id:` 的笔记（手写与导入的占大多数）其 id 是从路径推的，
    /// 换路径等于换 id，旧行匹配不上就会留下指向已消失文件的幽灵行——照样能搜到。
    /// 入链先置悬空再删行，最后按新路径接回来；全程只碰与这篇相关的链接。
    pub fn index_moved(&mut self, rel: &str, new_rel: &str) -> Result<()> {
        reindex_moved(&self.vault, &self.index, rel, new_rel)
    }

    /// 移动或换目录（`notes/甲.md` → `archive/甲.md`），落盘 + 索引一起做。
    pub fn note_move(&mut self, rel: &str, new_rel: &str) -> Result<()> {
        self.note_move_file(rel, new_rel)?;
        self.index_moved(rel, new_rel)
    }

    /// **同步那一半**：改名 = 算好新内容 + 移文件 + 覆写补丁，全部不碰索引。
    /// 先把要打的内容算出来再动文件：读盘或改 YAML 失败时改名整个不发生。
    pub fn note_rename_file(&mut self, rel: &str, new_stem: &str) -> Result<String> {
        let want = new_stem.trim();
        if want.is_empty() {
            return Err(Error::Invalid("新名字是空的".into()));
        }
        let stem = crate::vault::sanitize_file_stem(want);
        let dir = rel
            .rsplit_once('/')
            .map(|(d, _)| format!("{d}/"))
            .unwrap_or_default();
        let new_rel = format!("{dir}{stem}.md");
        if new_rel == rel {
            return Ok(rel.to_string());
        }
        let content = String::from_utf8_lossy(&self.vault.read(rel)?).to_string();
        let patched = crate::capture::set_front_title(&content, &stem);
        self.note_move_file(rel, &new_rel)?;
        if patched != content {
            self.save_note_write(&new_rel, &patched, None, crate::versions::手工)?;
        }
        Ok(new_rel)
    }

    /// 改名。文件名与 front-matter 的 title 一起改——列表显示的是 title，
    /// 只动文件名的话用户会以为没改成功。
    pub fn note_rename(&mut self, rel: &str, new_stem: &str) -> Result<String> {
        let new_rel = self.note_rename_file(rel, new_stem)?;
        self.index_moved(rel, &new_rel)?;
        Ok(new_rel)
    }

    /// **同步那一半**：把文件移进回收站。
    pub fn note_trash_file(&mut self, rel: &str) -> Result<()> {
        // 删除前的原件：移走之后文件就在回收站的批次目录里了，路径变了，
        // 前像要在这之前读（docs/02 §回收站的索引处理）。
        let 前像 = self.读前像(rel, None)?;
        self.记前像(rel, crate::versions::删除前, 前像);
        self.vault.move_to_trash(rel).map(|_| ())
    }

    /// **后台那一半**：入链置悬空 + 删掉索引行。
    /// 直接删行会被 `ON DELETE CASCADE` 把入链一起带走，恢复时就没有
    /// "曾经指向它"的记录可接回来了。
    pub fn index_trashed(&mut self, rel: &str) -> Result<()> {
        unindex(self.vault(), &self.index, rel)
    }

    /// 移进回收站。文件本身还在（`.note/trash/`），所以这条操作不丢内容；
    /// `note_versions` 的 before_delete 快照要等历史/撤销功能一起做（docs/02 §偏差）。
    pub fn note_trash(&mut self, rel: &str) -> Result<()> {
        self.note_trash_file(rel)?;
        self.index_trashed(rel)
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

    /// **同步那一半**：从回收站移回原位。原位已被同名笔记占用时报冲突，不覆盖。
    pub fn note_restore_file(&mut self, batch: &str, rel: &str) -> Result<()> {
        self.vault.restore_from_trash(batch, rel)
    }

    /// 恢复并重新解析。
    pub fn note_restore(&mut self, batch: &str, rel: &str) -> Result<()> {
        self.note_restore_file(batch, rel)?;
        self.index_one(rel)
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
