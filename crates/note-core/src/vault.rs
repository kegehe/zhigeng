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

/// 一个打开的 Vault。root 必须已存在。
#[derive(Debug, Clone)]
pub struct Vault {
    root: PathBuf,
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
                source: std::io::Error::new(std::io::ErrorKind::Other, e),
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
                f.sync_all()?; // Windows 上即 FlushFileBuffers
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

    pub fn read(&self, rel: &str) -> Result<Vec<u8>> {
        let p = self.resolve(rel)?;
        std::fs::read(&p).map_err(|e| Error::Io {
            path: rel.to_string(),
            source: e,
        })
    }

    /// 移入回收站。状态存在目录里（`.note/trash/<原相对路径>`），不进 DB —— 否则违反 G1。
    pub fn move_to_trash(&self, rel: &str) -> Result<PathBuf> {
        let src = self.resolve(rel)?;
        let dst = self
            .meta_dir()
            .join("trash")
            .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
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
    s = s.trim().split_whitespace().collect::<Vec<_>>().join(" ");
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
