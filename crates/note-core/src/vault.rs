//! Vault：目录约定、扫描排除、原子写、回收站、路径安全。
//!
//! 本模块是 docs/02 §Vault 目录结构 与 §写入与外部修改 的唯一实现处。
//! 规矩只有两条：
//! 1. **Markdown 是唯一真相源**，本模块只读写 Vault 内的文件；
//! 2. **`.note/` 之下除 trash/conflicts/versions 外都可再生**，扫描器永不进入。

use std::path::{Component, Path, PathBuf};

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
///
/// crate 内共用：任何拿绝对路径做包含比较的地方（备份目录那条判据）都必须走
/// 同一套归一化——一边带前缀一边不带，比较会静默失效。
pub(crate) fn strip_verbatim_prefix(p: PathBuf) -> PathBuf {
    let s = p.display().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

/// 把用户填的路径（备份目录、导入源）归一到与 `Vault::root()` **可比较**的形式：目标目录常常还不存在
/// （用户刚敲了个新名字），所以取最近的已存在祖先去 canonicalize，再拼回剩下的段。
///
/// 必须跟着 `Vault::open` 剥掉 Windows 的 `\\?\` 前缀：库根是不带前缀的，这边带上的话
/// `starts_with` 永远不成立，"不能在库里"这条判据就形同虚设（第一版就栽在这里，
/// 测试里那个"库内目录"居然通过了校验）。
pub(crate) fn anchored(target: &Path) -> PathBuf {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = target.to_path_buf();
    loop {
        if let Ok(c) = cur.canonicalize() {
            let mut out = strip_verbatim_prefix(c);
            for name in tail.iter().rev() {
                out.push(name);
            }
            return out;
        }
        match cur.file_name().map(|n| n.to_os_string()) {
            Some(name) => tail.push(name),
            None => break,
        }
        match cur.parent().map(|p| p.to_path_buf()) {
            Some(p) if !p.as_os_str().is_empty() => cur = p,
            _ => break,
        }
    }
    normalizable(target)
}

/// 不碰文件系统地把 `.`/`..` 消掉，用于目录还不存在时的包含关系判断。
pub(crate) fn normalizable(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
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
        resolve_in(&self.root, rel)
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

    /// 全部可见目录（库根相对、正斜杠、已排序）。
    ///
    /// 笔记树在前端由 `rel` 拼出来，但**空目录拼不出来**——目录得单独列一次，
    /// 否则刚建出来的空目录在侧栏里永远不出现，等于没建成。
    ///
    /// 走 `walkdir` 而不是自己递归 `read_dir`：排除规则与"不跟随符号链接"
    /// 必须与 `scan` 同源，不然列表里有、扫描器不认，用户建了个永远空着的目录。
    pub fn list_dirs(&self) -> Result<Vec<String>> {
        let mut out = Vec::new();
        for entry in walkdir::WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                if e.depth() == 0 {
                    return true;
                }
                if is_excluded_entry(e) {
                    return false;
                }
                let name = e.file_name().to_string_lossy();
                // 两棵有别的语义的树整棵剪掉：资产目录可能有几万张图，遍历它纯浪费
                !(e.depth() == 1 && (同名(&name, ATTACHMENTS_DIR) || 同名(&name, VIEWS_DIR)))
            })
        {
            let entry = match entry {
                Ok(e) => e,
                // 一个读不动的子目录不该让整棵树从侧栏消失
                Err(e) => {
                    tracing::warn!("列目录时跳过一个读不动的条目：{e}");
                    continue;
                }
            };
            if entry.depth() == 0 || !entry.file_type().is_dir() {
                continue;
            }
            let Ok(rel) = self.relative(entry.path()) else {
                continue;
            };
            if is_tree_dir(&rel) {
                out.push(rel);
            }
        }
        out.sort();
        Ok(out)
    }

    /// 建目录。`parent` 必须是已存在的笔记目录（空串 = 库根）。
    pub fn create_dir(&self, parent: &str, name: &str) -> Result<String> {
        let parent = norm_rel(parent);
        let name = check_dir_name(name)?;
        if parent.is_empty() {
            if is_reserved_top(&name) {
                return Err(Error::Invalid(format!("{name} 是保留目录名")));
            }
        } else if !is_tree_dir(&parent) {
            return Err(Error::Invalid(format!("不能在 {parent} 里建目录")));
        }
        let rel = if parent.is_empty() {
            name
        } else {
            format!("{parent}/{name}")
        };
        let abs = self.resolve(&rel)?;
        let at = abs
            .parent()
            .ok_or_else(|| Error::Invalid(format!("目录名不合法: {rel}")))?;
        if !at.is_dir() {
            return Err(Error::NotFound(parent));
        }
        if abs.exists() {
            return Err(Error::Conflict(rel));
        }
        std::fs::create_dir(&abs).map_err(|e| Error::Io {
            path: rel.clone(),
            source: e,
        })?;
        Ok(rel)
    }

    /// 空目录改名（同一层里换名字）。非空目录要连整棵子树搬、还要逐篇重索引，
    /// 路径即笔记 id，那是下一档，这里一律拒——**拒得早**比搬一半再失败好收拾。
    pub fn rename_dir(&self, rel: &str, new_name: &str) -> Result<String> {
        let rel = norm_rel(rel);
        if !is_tree_dir(&rel) || is_reserved_top(&rel) {
            return Err(Error::Invalid(format!("这个目录不能改名: {rel}")));
        }
        let name = check_dir_name(new_name)?;
        if name == base_name(&rel) {
            return Ok(rel);
        }
        let parent = parent_rel(&rel);
        let new_rel = if parent.is_empty() {
            name
        } else {
            format!("{parent}/{name}")
        };
        if is_reserved_top(&new_rel) {
            return Err(Error::Invalid(format!("{new_rel} 是保留目录名")));
        }
        let src = self.resolve(&rel)?;
        if !src.is_dir() {
            return Err(Error::NotFound(rel));
        }
        if !dir_is_empty(&src)? {
            return Err(Error::Invalid(
                "目录里还有东西——改名要连内容一起搬，这一版只改空目录".into(),
            ));
        }
        let dst = self.resolve(&new_rel)?;
        if dst.exists() {
            // 只差大小写：大小写不敏感的文件系统上 `dst` 与 `src` 是同一份，
            // 直接 rename 一次把盘上的大小写改过来。canonicalize 相等这一条比
            // "忽略大小写比较"更准——区分大小写的盘上 `Foo` 与 `foo` 是两个目录，
            // 那才是真冲突（直接 rename 在 POSIX 上会把空目录顶掉）。
            let 同一份 = matches!(
                (src.canonicalize(), dst.canonicalize()),
                (Ok(a), Ok(b)) if a == b
            );
            if !同一份 {
                return Err(Error::Conflict(new_rel));
            }
        }
        std::fs::rename(&src, &dst).map_err(|e| Error::Io {
            path: rel,
            source: e,
        })?;
        Ok(new_rel)
    }

    /// 删空目录。非空目录进回收站要整棵搬（回收站是文件级镜像），那是下一档。
    pub fn remove_dir(&self, rel: &str) -> Result<()> {
        let rel = norm_rel(rel);
        if !is_tree_dir(&rel) || is_reserved_top(&rel) {
            return Err(Error::Invalid(format!("这个目录不能删: {rel}")));
        }
        let abs = self.resolve(&rel)?;
        if !abs.is_dir() {
            return Err(Error::NotFound(rel));
        }
        if !dir_is_empty(&abs)? {
            return Err(Error::Invalid(
                "目录里还有东西——删除要连内容一起进回收站，这一版只删空目录".into(),
            ));
        }
        std::fs::remove_dir(&abs).map_err(|e| Error::Io {
            path: rel,
            source: e,
        })
    }

    /// 目录是不是**物理空**的。侧栏菜单据此决定要不要给"改名 / 删除"——
    /// 不拿 `list_notes` 那份被截断的结果推断：库里超过一页时，一个非空目录
    /// 在界面上看起来就是空的（菜单给了入口，后端才拒）。
    pub fn is_empty_dir(&self, rel: &str) -> Result<bool> {
        let rel = norm_rel(rel);
        if !is_tree_dir(&rel) {
            return Err(Error::Invalid(format!("不是笔记目录: {rel}")));
        }
        let abs = self.resolve(&rel)?;
        if !abs.is_dir() {
            return Err(Error::NotFound(rel));
        }
        dir_is_empty(&abs)
    }

    /// 新建笔记的父目录判据：必须已存在，且是笔记目录（不是附件/视图/元数据）。
    /// 返回归一后的路径——调用方拿它拼 `rel`，不能再拿用户原样输入的字符串。
    pub fn check_note_parent(&self, parent: &str) -> Result<String> {
        let parent = norm_rel(parent);
        if !is_tree_dir(&parent) {
            return Err(Error::Invalid(format!("不能在这里建笔记: {parent}")));
        }
        let abs = self.resolve(&parent)?;
        if !abs.is_dir() {
            return Err(Error::NotFound(parent));
        }
        Ok(parent)
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

/// 库根相对路径归一：反斜杠换正斜杠、去首尾斜杠。库根是空串。
///
/// 目录树、`tree.toml`、IPC 三条路都拿它做**相等比较**，所以归一只能有一份：
/// `notes/` 与 `notes\` 算两层的时侯，拖一次就会留下两条互不相认的顺序。
pub fn norm_rel(p: &str) -> String {
    p.replace('\\', "/").trim_matches('/').to_string()
}

/// 父目录路径。库根上的条目给空串。
fn parent_rel(rel: &str) -> &str {
    rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}

/// 路径末段（同一层里的名字）。
fn base_name(rel: &str) -> &str {
    rel.rsplit_once('/').map(|(_, n)| n).unwrap_or(rel)
}

/// Windows 保留名。大小写无关，且带扩展名的 `CON.txt` 一样不合法。
const WINDOWS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5",
];

const BAD_NAME_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// ASCII 名比较。**NTFS 与 APFS 都是大小写不敏感的**：`NOTES` 与 `notes`
/// 在盘上是同一个目录，所以保留名与扫描排除名一律按这一条比——精确比较的话，
/// 用户建一个 `NOTES` 就同时绕过了保留名检查与树外过滤（新库上 `notes/` 是
/// 第一次建笔记才补出来的，这一下真能建成功）。
fn 同名(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// 扫描排除的目录名。大小写同样不敏感（`Node_Modules` 在 Windows 上就是同一个目录）。
fn 是排除名(s: &str) -> bool {
    同名(s, "node_modules") || 同名(s, "target")
}

/// 顶层那几个有语义的目录：改名/删除/新建同名一律拒绝。
/// 往它们**里面**建子目录是另一回事（`notes/工作/` 完全正常）。
fn is_reserved_top(rel: &str) -> bool {
    !rel.contains('/')
        && [
            META_DIR,
            INBOX_DIR,
            NOTES_DIR,
            ARCHIVE_DIR,
            VIEWS_DIR,
            ATTACHMENTS_DIR,
        ]
        .iter()
        .any(|n| 同名(rel, n))
}

/// 侧栏里该出现的目录，也是"能往里建笔记/建子目录"的唯一判据。
///
/// 排除三类：点开头的（`.note` 等应用私有）、扫描规则里的 `node_modules`/`target`、
/// 以及 `attachments/` 与 `views/` 这两棵有别的语义的树（资产与视图定义）。
pub fn is_tree_dir(rel: &str) -> bool {
    let rel = norm_rel(rel);
    if rel.is_empty() {
        return false;
    }
    let segs: Vec<&str> = rel.split('/').collect();
    if segs
        .iter()
        .any(|s| s.is_empty() || s.starts_with('.') || 是排除名(s))
    {
        return false;
    }
    !同名(segs[0], ATTACHMENTS_DIR) && !同名(segs[0], VIEWS_DIR)
}

/// 目录名判据：**拒绝而不是改写**。文件名那边 `sanitize_file_stem` 会悄悄换字，
/// 目录名是用户刚在输入框里敲的，被换掉他会看到一个不是自己写的名字。
pub fn check_dir_name(name: &str) -> Result<String> {
    // **只拒不改**：首尾带空格就报错，不替用户修剪——他敲的是「 项目 」，目录名
    // 却变成「项目」，看到的不是自己写的名字。前端的输入框已经 trim 过一次，
    // 走到这里的空白只会是从别处（脚本 / 手改）进来的。
    if name.trim() != name {
        return Err(Error::Invalid("目录名首尾不能有空格".into()));
    }
    if name.is_empty() {
        return Err(Error::Invalid("目录名不能为空".into()));
    }
    if name == "." || name == ".." {
        return Err(Error::Invalid("目录名不能是 . 或 ..".into()));
    }
    if name.starts_with('.') {
        return Err(Error::Invalid(
            "目录名不能以点开头（点开头是应用私有目录）".into(),
        ));
    }
    if name
        .chars()
        .any(|c| BAD_NAME_CHARS.contains(&c) || c.is_control())
    {
        return Err(Error::Invalid(
            r#"目录名不能带 \ / : * ? " < > | 或控制字符"#.into(),
        ));
    }
    if name.ends_with('.') {
        return Err(Error::Invalid("目录名不能以点结尾".into()));
    }
    if name.chars().count() > 80 {
        return Err(Error::Invalid("目录名太长（上限 80 字）".into()));
    }
    if 是排除名(name) {
        return Err(Error::Invalid(format!(
            "{name} 是扫描排除目录，建了也不会进索引"
        )));
    }
    let head = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if WINDOWS_RESERVED.contains(&head.as_str()) {
        return Err(Error::Invalid(format!(
            "{name} 是 Windows 保留名，换个名字"
        )));
    }
    Ok(name.to_string())
}

/// 目录里有没有东西。**物理空**才算空：隐藏文件、临时文件都算占着位置——
/// 改名/删除是按目录搬的，看得见的文件搬得动，看不见的一样得搬。
fn dir_is_empty(abs: &Path) -> Result<bool> {
    let mut it = std::fs::read_dir(abs).map_err(|e| Error::Io {
        path: abs.display().to_string(),
        source: e,
    })?;
    match it.next() {
        None => Ok(true),
        Some(Ok(_)) => Ok(false),
        Some(Err(e)) => Err(Error::Io {
            path: abs.display().to_string(),
            source: e,
        }),
    }
}

/// 排除规则（docs/02 §扫描与排除规则）。剪枝用，作用于目录与文件。
fn is_excluded_entry(e: &walkdir::DirEntry) -> bool {
    let name = e.file_name().to_string_lossy().to_string();
    if name.starts_with('.') {
        return true; // 含 .note、.git、以及任何点开头目录
    }
    是排除名(&name)
}

/// 该相对路径是否作为笔记索引。
pub fn is_indexable_rel(rel: &str) -> bool {
    let rel = rel.replace('\\', "/");
    let segs: Vec<&str> = rel.split('/').collect();
    if segs.iter().any(|s| s.starts_with('.')) {
        return false;
    }
    if segs.iter().any(|s| 是排除名(s)) {
        return false;
    }
    rel.ends_with(".md") || rel.ends_with(".markdown")
}

/// 附件与资产：不产生 notes/blocks，但登记进 attachments 表。
pub fn is_attachment_rel(rel: &str) -> bool {
    rel.replace('\\', "/").starts_with(ATTACHMENTS_DIR)
}

/// `Vault::resolve` 的自由函数形式：判据只有一份，而**资产链接的存在性判定只拿得到根路径**
/// （`Index` 揣着 root，不揣着 Vault）。把它复制进 assets.rs 就是分叉的开始——分叉的
/// 那一头是"用户可以写一行 `![[../../x]]`"，两个实现只要有一个松了口就漏出库目录。
pub fn resolve_in(root: &Path, rel: &str) -> Result<PathBuf> {
    let cleaned = rel.replace('\\', "/");
    let cleaned = cleaned.trim_start_matches('/');
    let mut out = root.to_path_buf();
    for seg in cleaned.split('/') {
        match seg {
            "" | "." => continue,
            ".." => return Err(Error::OutsideVault(rel.to_string())),
            s if s.contains(':') => return Err(Error::OutsideVault(rel.to_string())),
            s => out.push(s),
        }
    }
    if out == root || !out.starts_with(root) {
        return Err(Error::OutsideVault(rel.to_string()));
    }
    Ok(out)
}

/// 目录推导状态。`archive/` 子树整体归档；`inbox/` 待整理；其余在用。
pub fn status_of_rel(rel: &str) -> Option<NoteStatus> {
    let rel = rel.replace('\\', "/");
    // 首段按大小写不敏感比：盘上真有一个 `Inbox/` 的话，它就是 `inbox/`。
    match rel.split_once('/') {
        Some((首, _)) if 同名(首, INBOX_DIR) => Some(NoteStatus::Inbox),
        Some((首, _)) if 同名(首, ARCHIVE_DIR) => Some(NoteStatus::Archived),
        Some((首, _)) if 同名(首, META_DIR) => None,
        _ => Some(NoteStatus::Active),
    }
}

pub fn kind_of_rel(rel: &str) -> NoteKind {
    let rel = rel.replace('\\', "/");
    match rel.split_once('/') {
        Some((首, _)) if 同名(首, VIEWS_DIR) => NoteKind::View,
        _ => NoteKind::Note,
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
    let mut s: String = title
        .chars()
        .map(|c| if BAD_NAME_CHARS.contains(&c) { ' ' } else { c })
        .collect();
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.is_empty() {
        s = "未命名".to_string();
    }
    // Windows 不允许结尾的点与空格，且保留名大小写无关
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    let head = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    if WINDOWS_RESERVED.contains(&head.as_str()) {
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
