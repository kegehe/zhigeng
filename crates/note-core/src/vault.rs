//! Vault：目录约定、扫描排除、原子写、回收站、路径安全。
//!
//! 本模块是 docs/02 §Vault 目录结构 与 §写入与外部修改 的唯一实现处。
//! 规矩只有两条：
//! 1. **Markdown 是唯一真相源**，本模块只读写 Vault 内的文件；
//! 2. **`.note/` 之下除 trash/conflicts/versions 外都可再生**，扫描器永不进入。

use std::path::{Path, PathBuf};

use crate::hash::content_hash;
use crate::{Error, Result};

/// 应用私有目录名，扫描时整目录排除。
pub const META_DIR: &str = ".note";
pub const INBOX_DIR: &str = "inbox";
pub const NOTES_DIR: &str = "notes";
pub const ARCHIVE_DIR: &str = "archive";
pub const VIEWS_DIR: &str = "views";
pub const ATTACHMENTS_DIR: &str = "attachments";

/// 由所在目录推导的状态。docs/02：目录是权威，front-matter 不存 status。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteStatus {
    Inbox,
    Active,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteKind {
    Note,
    /// `views/` 下的动态视图定义：登记存在，但不进 blocks/chunks/FTS/向量。
    View,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteFile {
    /// 相对 Vault 的路径，一律正斜杠。
    pub rel: String,
    pub abs: PathBuf,
    pub status: NoteStatus,
    pub kind: NoteKind,
    pub size: u64,
    /// 文件 mtime 的毫秒时间戳，作为 updated_at 与"是否变化"的快速判据。
    pub mtime_ms: i64,
    pub content_hash: String,
}

/// 回收站里的一条。`rel` 是恢复目标（原相对路径），`batch` 是它所在的那一批。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashEntry {
    pub batch: String,
    pub rel: String,
    pub size: u64,
    pub mtime_ms: i64,
}

/// 一个打开的 Vault。root 必须已存在。
#[derive(Debug, Clone)]
pub struct Vault {
    root: PathBuf,
}

/// 首启默认路径（docs/03 §Windows 侧要点）：`D:\Notes`，没有 D 盘回落
/// `%USERPROFILE%\Notes`。这里只**算**路径，不创建——创建必须发生在用户
/// 在首启界面上确认之后，静默建库会让用户找不到自己的笔记在哪。
pub fn default_vault_path() -> PathBuf {
    if Path::new("D:\\").is_dir() {
        return PathBuf::from("D:\\Notes");
    }
    match std::env::var_os("USERPROFILE") {
        Some(home) => PathBuf::from(home).join("Notes"),
        None => PathBuf::from("Notes"),
    }
}

/// 去掉 Windows 的 `\\?\` 前缀；UNC 共享要还原成 `\\server\share`，
/// 否则 \\?\UNC\ 会被当成普通名字。非 Windows 路径原样返回。
fn strip_verbatim_prefix(p: PathBuf) -> PathBuf {
    let s = p.display().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

impl Vault {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref();
        if !root.is_dir() {
            return Err(Error::Io {
                path: root.display().to_string(),
                source: std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "vault directory not found",
                ),
            });
        }
        let root = root.canonicalize().map_err(|e| Error::Io {
            path: root.display().to_string(),
            source: e,
        })?;
        // Windows 的 canonicalize 会加 `\\?\` 扩展长度前缀。它属于 IO 调用的细节
        // （docs/03 §长路径：落盘前才加），一旦进标题栏、进 last-vault.txt 就成了
        // 用户看得见的乱码，所以在这里剥掉。
        let root = strip_verbatim_prefix(root);
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn meta_dir(&self) -> PathBuf {
        self.root.join(META_DIR)
    }

    /// 相对路径 → 绝对路径，并拒绝任何越出 Vault 的企图。
    /// 这是文件系统边界（本产品无账号无权限），必须在这里焊死。
    ///
    /// 前导 `/` 视为 **Vault 根相对**（docs/02 §资产引用格式 用的就是这个约定），
    /// 因此 `/attachments/x.png` 指向 Vault 内，而不是文件系统根。
    pub fn resolve(&self, rel: &str) -> Result<PathBuf> {
        let cleaned = rel.replace('\\', "/");
        let cleaned = cleaned.trim_start_matches('/');
        let mut out = self.root.clone();
        for seg in cleaned.split('/') {
            match seg {
                "" | "." => continue,
                ".." => return Err(Error::OutsideVault(rel.to_string())),
                s if s.contains(':') => return Err(Error::OutsideVault(rel.to_string())),
                s => out.push(s),
            }
        }
        if out == self.root || !out.starts_with(&self.root) {
            return Err(Error::OutsideVault(rel.to_string()));
        }
        Ok(out)
    }

    /// 绝对路径 → Vault 内相对路径（正斜杠）。
    pub fn relative(&self, abs: &Path) -> Result<String> {
        let rest = abs
            .strip_prefix(&self.root)
            .map_err(|_| Error::OutsideVault(abs.display().to_string()))?;
        let s = rest
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/");
        Ok(s)
    }

    /// 按 docs/02 §扫描与排除规则 遍历全部笔记文件。
    pub fn scan(&self) -> Result<Vec<NoteFile>> {
        let mut out = Vec::new();
        for entry in walkdir::WalkDir::new(&self.root)
            .follow_links(false)
            .sort_by_file_name()
            .into_iter()
            // 根目录本身可能被系统/临时目录命名成以点开头，不能被排除规则挡掉，
            // 否则整棵树剪枝为空——这个 bug 只有用临时目录测试才会暴露。
            .filter_entry(|e| e.depth() == 0 || !is_excluded_entry(e))
        {
            let entry = entry.map_err(|e| Error::Io {
                path: self.root.display().to_string(),
                source: std::io::Error::other(e),
            })?;
            if !entry.file_type().is_file() {
                continue;
            }
            let abs = entry.path().to_path_buf();
            let Some(rel) = self.relative(&abs).ok().filter(|r| !r.is_empty()) else {
                continue;
            };
            if !is_indexable_rel(&rel) {
                continue;
            }
            let md = std::fs::metadata(&abs).map_err(|e| Error::Io {
                path: rel.clone(),
                source: e,
            })?;
            let bytes = std::fs::read(&abs).map_err(|e| Error::Io {
                path: rel.clone(),
                source: e,
            })?;
            out.push(NoteFile {
                rel: rel.clone(),
                abs,
                status: status_of_rel(&rel).unwrap_or(NoteStatus::Active),
                kind: kind_of_rel(&rel),
                size: md.len(),
                mtime_ms: md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
                content_hash: content_hash(&bytes),
            });
        }
        out.sort_by(|a, b| a.rel.cmp(&b.rel));
        Ok(out)
    }

    /// 原子写入：同目录临时文件 → 刷盘 → rename 覆盖。
    /// 崩溃只可能留下临时文件，绝不会把笔记写成半截（docs/02 §写入与外部修改）。
    pub fn write_atomic(&self, rel: &str, bytes: &[u8]) -> Result<String> {
        self.write_atomic_opts(rel, bytes, true)
    }

    /// durable=false 只写到 OS 页缓存 + 原子改名：进程崩了不丢，
    /// 但断电可能丢。用来量 fsync 的占比，不代表产品可以随便关。
    #[doc(hidden)]
    pub fn write_atomic_opts(&self, rel: &str, bytes: &[u8], durable: bool) -> Result<String> {
        let target = self.resolve(rel)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| Error::Io {
                path: parent.display().to_string(),
                source: e,
            })?;
        }
        let tmp = sibling_tmp(&target);
        let write = (|| -> std::io::Result<()> {
            {
                use std::io::Write;
                let mut f = std::fs::File::create(&tmp)?;
                f.write_all(bytes)?;
                if durable {
                    f.sync_all()?; // Windows 上即 FlushFileBuffers
                }
            }
            std::fs::rename(&tmp, &target)?;
            Ok(())
        })();
        if let Err(e) = write {
            let _ = std::fs::remove_file(&tmp);
            return Err(Error::Io {
                path: rel.to_string(),
                source: e,
            });
        }
        Ok(content_hash(bytes))
    }

    /// 单个文件的元数据。给捕获路径用：新写完一篇就立刻索引它，
    /// 而不是 scan 整个库（2 万篇时 hash 全库要好几秒，必然超 8ms 预算）。
    pub fn note_file(&self, rel: &str) -> Result<NoteFile> {
        let abs = self.resolve(rel)?;
        let md = std::fs::metadata(&abs).map_err(|e| Error::Io {
            path: rel.to_string(),
            source: e,
        })?;
        let bytes = std::fs::read(&abs).map_err(|e| Error::Io {
            path: rel.to_string(),
            source: e,
        })?;
        Ok(NoteFile {
            rel: rel.to_string(),
            abs,
            status: status_of_rel(rel).unwrap_or(NoteStatus::Active),
            kind: kind_of_rel(rel),
            size: md.len(),
            mtime_ms: md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
            content_hash: content_hash(&bytes),
        })
    }

    pub fn read(&self, rel: &str) -> Result<Vec<u8>> {
        let p = self.resolve(rel)?;
        std::fs::read(&p).map_err(|e| Error::Io {
            path: rel.to_string(),
            source: e,
        })
    }

    /// 移入回收站。状态存在目录里（`.note/trash/<批次>/<原相对路径>`），不进 DB —— 否则违反 G1。
    ///
    /// 批次目录是必需的：同一篇笔记删两次（或删了又建同名再删）若直接按原路径镜像存放，
    /// `rename` 会**静默覆盖**上一次的回收件，等于用户删第二条时丢了第一条。
    pub fn move_to_trash(&self, rel: &str) -> Result<PathBuf> {
        let src = self.resolve(rel)?;
        // 落点用归一化后的相对路径算。直接拿调用方给的 `rel` 拼的话，
        // `/notes/甲.md` 与 `notes\甲.md` 会存成清单里对不上的位置，恢复就找不到原件。
        let norm = self.relative(&src)?;
        let dst = self
            .trash_dir(&trash_batch())
            .join(norm.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| Error::Io {
                path: parent.display().to_string(),
                source: e,
            })?;
        }
        std::fs::rename(&src, &dst).map_err(|e| Error::Io {
            path: rel.to_string(),
            source: e,
        })?;
        Ok(dst)
    }

    fn trash_dir(&self, batch: &str) -> PathBuf {
        self.meta_dir().join("trash").join(batch)
    }

    /// 回收站清单：扫目录得出，不存 DB（docs/02 §回收站的索引处理）。
    /// 返回的 `rel` 是**恢复目标路径**，`batch` 定位它在哪一批。
    pub fn list_trash(&self) -> Result<Vec<TrashEntry>> {
        let root = self.meta_dir().join("trash");
        if !root.is_dir() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for batch in std::fs::read_dir(&root).map_err(|e| Error::Io {
            path: root.display().to_string(),
            source: e,
        })? {
            let batch = batch.map_err(|e| Error::Io {
                path: root.display().to_string(),
                source: e,
            })?;
            if !batch.path().is_dir() {
                continue;
            }
            let name = batch.file_name().to_string_lossy().to_string();
            for entry in walkdir::WalkDir::new(batch.path()).follow_links(false) {
                let entry = entry.map_err(|e| Error::Io {
                    path: name.clone(),
                    source: std::io::Error::other(e),
                })?;
                if !entry.file_type().is_file() {
                    continue;
                }
                let Ok(rel) = self.relative(entry.path()) else {
                    continue;
                };
                // rel 形如 `.note/trash/<批次>/notes/甲.md`，剥掉三段前缀才是原路径
                let md = entry.metadata();
                let Some(orig) = rel
                    .strip_prefix(&format!("{META_DIR}/trash/{name}/"))
                    .map(str::to_owned)
                else {
                    continue;
                };
                out.push(TrashEntry {
                    batch: name.clone(),
                    rel: orig,
                    size: md.as_ref().map(|m| m.len()).unwrap_or(0),
                    mtime_ms: md
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0),
                });
            }
        }
        out.sort_by_key(|n| std::cmp::Reverse(n.mtime_ms));
        Ok(out)
    }

    /// 回收站里某个条目的绝对路径。`batch`/`rel` 来自 UI，必须先过一遍 `resolve`
    /// 的边界校验再拼接，否则 `../..` 就能借恢复操作往 Vault 外写文件。
    fn trash_path(&self, batch: &str, rel: &str) -> Result<PathBuf> {
        let checked = self.resolve(rel)?;
        let rel = self.relative(&checked)?;
        let batch = batch
            .split(['/', '\\'])
            .next_back()
            .filter(|s| !s.is_empty() && *s != "." && *s != "..")
            .ok_or_else(|| Error::OutsideVault(batch.to_string()))?;
        Ok(self
            .trash_dir(batch)
            .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR)))
    }

    /// 读回收站里的某一份。UI 要预览内容，测试要验证"两次删除各自完整"。
    pub fn read_from_trash(&self, batch: &str, rel: &str) -> Result<Vec<u8>> {
        let src = self.trash_path(batch, rel)?;
        std::fs::read(&src).map_err(|e| Error::Io {
            path: src.display().to_string(),
            source: e,
        })
    }

    /// 从回收站移回原位。原位已有文件时**拒绝**，不覆盖——那说明用户又建了同名笔记。
    pub fn restore_from_trash(&self, batch: &str, rel: &str) -> Result<()> {
        let src = self.trash_path(batch, rel)?;
        if !src.is_file() {
            return Err(Error::NotFound(rel.to_string()));
        }
        let dst = self.resolve(rel)?;
        if dst.exists() {
            return Err(Error::Conflict(dst.display().to_string()));
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| Error::Io {
                path: parent.display().to_string(),
                source: e,
            })?;
        }
        std::fs::rename(&src, &dst).map_err(|e| Error::Io {
            path: rel.to_string(),
            source: e,
        })
    }

    /// 改名或换目录。两者是同一个原语：目标已存在就报错，绝不静默覆盖。
    pub fn move_file(&self, rel: &str, new_rel: &str) -> Result<()> {
        let src = self.resolve(rel)?;
        let dst = self.resolve(new_rel)?;
        if src == dst {
            return Ok(());
        }
        if dst.exists() {
            return Err(Error::Conflict(dst.display().to_string()));
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| Error::Io {
                path: parent.display().to_string(),
                source: e,
            })?;
        }
        std::fs::rename(&src, &dst).map_err(|e| Error::Io {
            path: rel.to_string(),
            source: e,
        })
    }

    /// 冲突时保留磁盘版本（docs/02 表格第 2 行）。
    pub fn keep_conflict(&self, rel: &str, disk: &[u8]) -> Result<PathBuf> {
        let dst = self
            .meta_dir()
            .join("conflicts")
            .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = dst.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&dst, disk).map_err(|e| Error::Io {
            path: dst.display().to_string(),
            source: e,
        })?;
        Ok(dst)
    }
}

/// 回收站批次目录名。必须每次调用都不重复：批次撞车等于第二次删除覆盖第一次的回收件。
fn trash_batch() -> String {
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!(
        "{}-{:06}{:02}",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        nanos % 1_000_000,
        n % 100
    )
}

fn sibling_tmp(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "note.md".into());
    target.with_file_name(format!(".{name}.tmp"))
}

/// 排除规则（docs/02 §扫描与排除规则）。剪枝用，作用于目录与文件。
fn is_excluded_entry(e: &walkdir::DirEntry) -> bool {
    let name = e.file_name().to_string_lossy().to_string();
    if name.starts_with('.') {
        return true; // 含 .note、.git、以及任何点开头目录
    }
    matches!(name.as_str(), "node_modules" | "target")
}

/// 该相对路径是否作为笔记索引。
pub fn is_indexable_rel(rel: &str) -> bool {
    let rel = rel.replace('\\', "/");
    let segs: Vec<&str> = rel.split('/').collect();
    if segs.iter().any(|s| s.starts_with('.')) {
        return false;
    }
    if segs.iter().any(|s| matches!(*s, "node_modules" | "target")) {
        return false;
    }
    rel.ends_with(".md") || rel.ends_with(".markdown")
}

/// 附件与资产：不产生 notes/blocks，但登记进 attachments 表。
pub fn is_attachment_rel(rel: &str) -> bool {
    rel.replace('\\', "/").starts_with(ATTACHMENTS_DIR)
}

/// 目录推导状态。`archive/` 子树整体归档；`inbox/` 待整理；其余在用。
pub fn status_of_rel(rel: &str) -> Option<NoteStatus> {
    let rel = rel.replace('\\', "/");
    if rel.starts_with(&format!("{INBOX_DIR}/")) {
        Some(NoteStatus::Inbox)
    } else if rel.starts_with(&format!("{ARCHIVE_DIR}/")) {
        Some(NoteStatus::Archived)
    } else if rel.starts_with(&format!("{META_DIR}/")) {
        None
    } else {
        Some(NoteStatus::Active)
    }
}

pub fn kind_of_rel(rel: &str) -> NoteKind {
    let rel = rel.replace('\\', "/");
    if rel.starts_with(&format!("{VIEWS_DIR}/")) {
        NoteKind::View
    } else {
        NoteKind::Note
    }
}

/// 新建笔记的默认落点：`notes/<title>.md`，冲突时加短后缀。
pub fn default_new_rel(root: &Path, title: &str) -> String {
    let stem = sanitize_file_stem(title);
    let mut rel = format!("{NOTES_DIR}/{stem}.md");
    let mut n = 1;
    while root.join(&rel).exists() {
        rel = format!("{NOTES_DIR}/{stem}-{n}.md");
        n += 1;
    }
    rel
}

/// Windows 保留字符与保留名都要处理，否则 create 报晦涩错误。
pub fn sanitize_file_stem(title: &str) -> String {
    const BAD: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let mut s: String = title
        .chars()
        .map(|c| if BAD.contains(&c) { ' ' } else { c })
        .collect();
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.is_empty() {
        s = "未命名".to_string();
    }
    // Windows 不允许结尾的点与空格，且保留名大小写无关
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5",
    ];
    let head = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED.contains(&head.as_str()) {
        s = format!("_{s}");
    }
    if s.chars().count() > 80 {
        s = s.chars().take(80).collect();
    }
    s
}

/// 外部修改三情形判定的输入。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    /// mtime 变了但内容 hash 相同：编辑器自动保存噪音，忽略。
    Ignore,
    /// 内容变了，且本地无未保存改动：直接重解析。
    Reload,
    /// 内容变了且本地也有未保存改动：冲突，绝不静默覆盖。
    Conflict,
}

pub fn classify_change(
    last_written_hash: &str,
    disk_hash: &str,
    unsaved_hash: Option<&str>,
) -> Change {
    if last_written_hash == disk_hash {
        return Change::Ignore;
    }
    match unsaved_hash {
        Some(u) if u != disk_hash && u != last_written_hash => Change::Conflict,
        _ => Change::Reload,
    }
}
