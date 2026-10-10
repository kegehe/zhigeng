//! 每日增量快照到**第二个目录**（docs/03 §备份）。判据：唯一副本 = 没有副本。
//!
//! 布局：
//!
//! ```text
//! <备份目录>/<库名-路径hash>/
//!   manifest.jsonl                 每行一份快照，按时间递增
//!   20260926-091500/               一份快照一个目录
//!     notes/甲.md                  只放这份里**变化过**的文件（增量）
//! ```
//!
//! 三条刻意的选择：
//!
//! 1. **manifest 记的是"这份之后整个库的清单"**（rel → hash），不是这份目录里有几个文件。
//!    有了全量清单才判断得出"某篇最后一次出现在哪份"——误删的文件在新快照里缺席，
//!    但仍然躺在它被删之前的那一份里，这正是验收 ⑨ 要的那条路。
//! 2. **文件原样存，不压缩不打包**。备份目录是要能直接被资源管理器看懂、
//!    单个文件能直接拷回去的；gzip 让"救急"变成"必须先装我们的应用"。
//! 3. **先拷文件、后追加 manifest**。中途崩溃只会留下一个没登记的目录，
//!    下次按上一份的清单重算差异再拷一遍，不会记下一个指向半截文件的条目。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::hash::content_hash;
use crate::vault::Vault;
use crate::{Error, Result};

/// 保留多少份快照（docs/03 §备份：默认 30 份）。
pub const KEEP: usize = 30;

/// `<Vault>/.note/config.toml` 里的 `[backup]` 段。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupConfig {
    /// 第二个目录（另一块盘 / NAS 挂载点）。绝对路径，按用户输入原样存。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    /// 用户在首启里显式选了"我不备份"。与"还没引导过"必须可区分：
    /// 前者不再骚扰，后者每次启动都该提醒。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub disabled: bool,
}

impl BackupConfig {
    /// 快照该往哪儿跑。`None` = 关掉了或还没选目录（调用方据此决定提醒文案）。
    pub fn target(&self) -> Option<&str> {
        if self.disabled {
            return None;
        }
        self.dir.as_deref().filter(|s| !s.trim().is_empty())
    }
}

/// 一份快照。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    /// 目录名，本地时间到秒（`20260926-091500`），字典序即时间序。
    pub id: String,
    pub taken_at: String,
    /// 这份快照来自哪个库（绝对路径）。备份目录可以放多个库。
    pub vault: String,
    /// 这份目录里实际写了哪些文件（增量部分）。
    pub copied: Vec<String>,
    /// 这份之后整个库的清单：rel → 内容 hash。缺席即当时不存在。
    pub files: BTreeMap<String, String>,
}

impl Snapshot {
    fn day(&self) -> String {
        self.id.chars().take(8).collect()
    }
}

/// 读 `[backup]`。文件不存在或没有这一段都返回默认值（未引导）。
///
/// 段级读写本身在 `crate::config`——那个文件是全应用共享的配置面，
/// "读整篇、只换自己那一段、写回"这条纪律只能有一份实现。
pub fn load_config(vault: &Vault) -> Result<BackupConfig> {
    Ok(crate::config::read段(vault, "backup")?.unwrap_or_default())
}

/// 写 `[backup]`，**其余段原样保留**。
pub fn save_config(vault: &Vault, cfg: &BackupConfig) -> Result<()> {
    let 干净 = BackupConfig {
        dir: cfg
            .dir
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        disabled: cfg.disabled,
    };
    crate::config::write段(vault, "backup", &干净)
}

/// 某个库在备份目录下的子目录名。带上库根路径的 hash 前缀：
/// 只用人名的话，`D:\Notes` 与 `E:\备份\Notes` 会撞进同一个目录互相覆盖。
fn slug(vault_root: &Path) -> String {
    let name = vault_root
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "vault".into());
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let digest = content_hash(vault_root.display().to_string().as_bytes());
    format!("{}-{}", cleaned.trim_matches('-'), &digest[..8])
}

/// 某个库在备份目录下的子目录。也是"这个备份目录能不能用"的校验入口：
/// 落在 Vault 里直接拒绝（会在库里给自己做备份，体积按平方增长）。
pub fn vault_dir(vault: &Vault, backup_dir: &str) -> Result<PathBuf> {
    let root = vault.root();
    let target = Path::new(backup_dir);
    let target = if target.is_absolute() {
        target.to_path_buf()
    } else {
        root.join(target)
    };
    let target_abs = crate::vault::anchored(target.as_path());
    if target_abs == root || target_abs.starts_with(root) {
        return Err(Error::Invalid(format!(
            "备份目录不能放在 Vault 里面（会在库里给自己做备份）：{}",
            target_abs.display()
        )));
    }
    Ok(target_abs.join(slug(root)))
}

// anchored / normalizable 两个路径归一 helper 在 vault.rs：快照与导入共用同一份

fn manifest_path(dir: &Path) -> PathBuf {
    dir.join("manifest.jsonl")
}

/// 读某个库的全部快照（按时间递增）。目录或清单不存在 ⇒ 空（从没备份过）。
pub fn list(dir: &Path) -> Result<Vec<Snapshot>> {
    let text = match fs::read_to_string(manifest_path(dir)) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(Error::Io {
                path: manifest_path(dir).display().to_string(),
                source: e,
            })
        }
    };
    let mut out = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        // 一行坏掉不能带走整份清单：跳过它，其余仍可恢复
        if let Ok(s) = serde_json::from_str::<Snapshot>(line) {
            out.push(s);
        }
    }
    // 按 taken_at 排而不是按目录名排：同一秒内撞名会加 -01/-02 后缀，字典序在跨过
    // 一位数之后就与时间序脱节，于是"保留最近 30 份"会删错方向。
    out.sort_by(|a, b| a.taken_at.cmp(&b.taken_at).then(a.id.cmp(&b.id)));
    Ok(out)
}

/// 库里该进快照的内容：`.md` 之外还有 `attachments/` 里的二进制，所以自己走一遍树
/// （`Vault::scan` 只返回可索引的笔记）。点开头目录与 `node_modules`/`target` 剪掉，
/// 原子写的临时文件（`.名字.md.tmp`）因此天然被排除。
fn inventory(vault: &Vault) -> Result<BTreeMap<String, (String, u64)>> {
    let mut out = BTreeMap::new();
    for entry in walkdir::WalkDir::new(vault.root())
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy().to_string();
            !name.starts_with('.') && !matches!(name.as_str(), "node_modules" | "target")
        })
    {
        let entry = entry.map_err(|e| Error::Io {
            path: vault.root().display().to_string(),
            source: std::io::Error::other(e),
        })?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(vault.root())
            .map(|r| r.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if rel.is_empty() {
            continue;
        }
        let bytes = fs::read(entry.path()).map_err(|e| Error::Io {
            path: rel.clone(),
            source: e,
        })?;
        out.insert(rel, (content_hash(&bytes), bytes.len() as u64));
    }
    Ok(out)
}

/// 跑一次快照。返回 `None` = 今天已经做过（或压根没配备份目录），调用方不必报错。
///
/// `force = true` 给"立即备份"按钮用：不等第二天。
pub fn run(vault: &Vault, force: bool) -> Result<Option<Snapshot>> {
    let cfg = load_config(vault)?;
    let Some(dir) = cfg.target() else {
        return Ok(None);
    };
    let dir = vault_dir(vault, dir)?;
    let today = chrono::Local::now().format("%Y%m%d").to_string();
    let done = list(&dir)?;
    if !force {
        if let Some(last) = done.last() {
            if last.day() == today {
                return Ok(None);
            }
        }
    }

    let here = inventory(vault)?;
    let prev: BTreeMap<String, String> = done.last().map(|s| s.files.clone()).unwrap_or_default();
    let changed: Vec<String> = here
        .iter()
        .filter(|(rel, (hash, _))| prev.get(*rel).map(|h| h != hash).unwrap_or(true))
        .map(|(rel, _)| rel.clone())
        .collect();

    // 带毫秒：只到秒的话，"保留 30 份"删掉最老目录之后，同一秒内的下一轮会探到那个
    // 名字又空出来而复用它——清单不会坏，但"按 id 恢复"就不该依赖这种巧合。
    let id = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f").to_string();
    let at = chrono::Local::now().to_rfc3339();
    let snap_dir = dir.join(&id);
    // 同一秒里连点两次"立即备份"会撞同一个目录名：撞了就往后让一秒，
    // 而不是把上一份的目录覆盖掉。
    let mut n = 0;
    let snap_dir = loop {
        let candidate = if n == 0 {
            snap_dir.clone()
        } else {
            dir.join(format!("{id}-{n:02}"))
        };
        if !candidate.exists() {
            break candidate;
        }
        n += 1;
    };
    let id = snap_dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(id);

    let mut copied = Vec::new();
    for rel in &changed {
        let from = vault
            .root()
            .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        let to = snap_dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|e| Error::Io {
                path: parent.display().to_string(),
                source: e,
            })?;
        }
        match fs::copy(&from, &to) {
            Ok(_) => copied.push(rel.clone()),
            // 列完清单后它被删了：这份里就是不包含它，下一轮自然对上
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(Error::Io {
                    path: rel.clone(),
                    source: e,
                })
            }
        }
    }

    let snap = Snapshot {
        id,
        taken_at: at,
        vault: vault.root().display().to_string(),
        copied,
        files: here.into_iter().map(|(r, (h, _))| (r, h)).collect(),
    };

    // 文件都落地了才登记：崩溃不会留下指向半截文件的条目
    fs::create_dir_all(&dir).map_err(|e| Error::Io {
        path: dir.display().to_string(),
        source: e,
    })?;
    let mut line = serde_json::to_string(&snap).map_err(|e| Error::Io {
        path: manifest_path(&dir).display().to_string(),
        source: std::io::Error::other(e),
    })?;
    line.push('\n');
    use std::io::Write;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(manifest_path(&dir))
        .map_err(|e| Error::Io {
            path: manifest_path(&dir).display().to_string(),
            source: e,
        })?;
    f.write_all(line.as_bytes()).map_err(|e| Error::Io {
        path: manifest_path(&dir).display().to_string(),
        source: e,
    })?;
    drop(f);

    prune(&dir)?;
    Ok(Some(snap))
}

/// 只留最近 `KEEP` 份：先删目录再改清单，反过来会留下找不回来的孤儿目录。
fn prune(dir: &Path) -> Result<()> {
    let snaps = list(dir)?;
    if snaps.len() <= KEEP {
        return Ok(());
    }
    let drop_count = snaps.len() - KEEP;
    for old in snaps.iter().take(drop_count) {
        let p = dir.join(&old.id);
        if p.exists() {
            let _ = fs::remove_dir_all(&p);
        }
    }
    let kept = &snaps[drop_count..];
    let mut text = String::new();
    for s in kept {
        text.push_str(&serde_json::to_string(s).unwrap_or_default());
        text.push('\n');
    }
    fs::write(manifest_path(dir), text).map_err(|e| Error::Io {
        path: manifest_path(dir).display().to_string(),
        source: e,
    })
}

/// 某篇文件的历史：从新到旧，哪些快照目录里真的有它。
///
/// 只看 `copied` 而不是 `files`——清单里有它只说明"那会儿它存在"，
/// 不代表这份目录里存了实体（增量可能没动它）。
pub fn history_of(dir: &Path, rel: &str) -> Result<Vec<Snapshot>> {
    let mut out: Vec<Snapshot> = list(dir)?
        .into_iter()
        .filter(|s| s.copied.iter().any(|r| r == rel))
        .collect();
    out.reverse();
    Ok(out)
}

/// 取出某份快照里那个文件的字节。
pub fn read_file(dir: &Path, snapshot_id: &str, rel: &str) -> Result<Vec<u8>> {
    let p = dir
        .join(snapshot_id)
        .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    fs::read(&p).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Error::NotFound(format!("{snapshot_id} 里没有 {rel}")),
        _ => Error::Io {
            path: p.display().to_string(),
            source: e,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault_at(dir: &Path) -> Vault {
        fs::create_dir_all(dir.join("notes")).unwrap();
        fs::create_dir_all(dir.join("inbox")).unwrap();
        Vault::open(dir).unwrap()
    }

    fn write(v: &Vault, rel: &str, body: impl AsRef<str>) {
        v.write_atomic(rel, body.as_ref().as_bytes()).unwrap();
    }

    /// 备份目录与库同级的兄弟目录：真机上它就是"另一块盘"的位置。
    fn backup_dir(root: &Path) -> PathBuf {
        let p = root.parent().unwrap().join("backup-target");
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn configured(root: &Path) -> (Vault, PathBuf) {
        let v = vault_at(root);
        let b = backup_dir(root);
        let dir = vault_dir(&v, &b.display().to_string()).unwrap();
        save_config(
            &v,
            &BackupConfig {
                dir: Some(b.display().to_string()),
                disabled: false,
            },
        )
        .unwrap();
        (v, dir)
    }

    #[test]
    fn 首次快照收全部内容并登记清单() {
        let d = tempfile::tempdir().unwrap();
        let (v, dir) = configured(d.path());
        write(&v, "notes/甲.md", "内容甲\n");
        write(&v, "attachments/ab.png", "假图片字节");

        let snap = run(&v, false).unwrap().expect("该做出第一份");
        assert_eq!(snap.files.len(), 2, "{:?}", snap.files);
        assert!(snap.copied.contains(&"notes/甲.md".to_string()));
        // 附件也要在：备份要盖得住"整个库"，不是只盖笔记
        assert!(dir.join(&snap.id).join("attachments/ab.png").exists());
        assert!(dir.join(&snap.id).join("notes/甲.md").exists());
    }

    #[test]
    fn 第二次只收变化过的那一篇() {
        let d = tempfile::tempdir().unwrap();
        let (v, _dir) = configured(d.path());
        write(&v, "notes/甲.md", "内容甲\n");
        write(&v, "notes/乙.md", "内容乙\n");
        let first = run(&v, false).unwrap().unwrap();
        assert_eq!(first.copied.len(), 2);

        write(&v, "notes/甲.md", "内容甲改\n");
        let second = run(&v, true).unwrap().unwrap();
        assert_eq!(second.copied, vec!["notes/甲.md".to_string()]);
        // 清单仍是全量：缺席意味着"真没了"，不能与"没变化"混为一谈
        assert_eq!(second.files.len(), 2, "{:?}", second.files);
    }

    #[test]
    fn 没到第二天就不重复做快照() {
        let d = tempfile::tempdir().unwrap();
        let (v, dir) = configured(d.path());
        write(&v, "notes/甲.md", "a\n");
        assert!(run(&v, false).unwrap().is_some());
        assert!(
            run(&v, false).unwrap().is_none(),
            "同一天第二次应当直接跳过"
        );
        assert_eq!(list(&dir).unwrap().len(), 1);
        // "立即备份"按钮可以越过这条
        assert!(run(&v, true).unwrap().is_some());
    }

    #[test]
    fn 删掉的笔记能从它消失前的那份里取回() {
        // 验收 ⑨：从快照里能完整恢复一篇被误删改的文件
        let d = tempfile::tempdir().unwrap();
        let (v, dir) = configured(d.path());
        let original = "# 重要的一篇\n\n别丢。\n";
        write(&v, "notes/重要.md", original);
        let snap = run(&v, false).unwrap().unwrap();
        assert!(snap.files.contains_key("notes/重要.md"), "第一份里应当有它");
        fs::remove_file(v.root().join("notes").join("重要.md")).unwrap();

        let after = run(&v, true).unwrap().unwrap();
        assert!(!after.files.contains_key("notes/重要.md"));

        let hist = history_of(&dir, "notes/重要.md").unwrap();
        assert_eq!(hist.len(), 1);
        let got = read_file(&dir, &hist[0].id, "notes/重要.md").unwrap();
        assert_eq!(std::str::from_utf8(&got).unwrap(), original);
    }

    #[test]
    fn 未配置的库不做任何事() {
        let d = tempfile::tempdir().unwrap();
        let v = vault_at(d.path());
        write(&v, "notes/甲.md", "a\n");
        assert!(run(&v, false).unwrap().is_none());
        // 显式"我不备份"与"还没引导"在配置里可区分，行为上都不快照
        save_config(
            &v,
            &BackupConfig {
                dir: None,
                disabled: true,
            },
        )
        .unwrap();
        assert!(run(&v, true).unwrap().is_none());
        assert!(load_config(&v).unwrap().disabled);
    }

    #[test]
    fn 备份目录落在库里直接拒绝() {
        let d = tempfile::tempdir().unwrap();
        let v = vault_at(d.path());
        write(&v, "notes/甲.md", "a\n");
        save_config(
            &v,
            &BackupConfig {
                dir: Some(v.root().join("backups").display().to_string()),
                disabled: false,
            },
        )
        .unwrap();
        let err = run(&v, false).unwrap_err().to_string();
        assert!(err.contains("不能放在 Vault 里面"), "{err}");
    }

    #[test]
    fn 私有目录与原子写的临时文件不进快照() {
        let d = tempfile::tempdir().unwrap();
        let (v, dir) = configured(d.path());
        write(&v, "notes/甲.md", "a\n");
        fs::create_dir_all(v.meta_dir().join("trash")).unwrap();
        fs::write(v.meta_dir().join("trash/被删的.md"), "不该备份这个").unwrap();
        fs::write(v.root().join("notes/.甲.md.tmp"), "半截文件").unwrap();

        let snap = run(&v, false).unwrap().unwrap();
        assert_eq!(snap.files.keys().collect::<Vec<_>>(), vec!["notes/甲.md"]);
        assert!(!dir.join(&snap.id).join(".note").exists());
    }

    #[test]
    fn 超过三十份就丢最老的() {
        let d = tempfile::tempdir().unwrap();
        let (v, dir) = configured(d.path());
        write(&v, "notes/甲.md", "初版\n");
        let mut ids = Vec::new();
        for i in 0..(KEEP + 3) {
            write(&v, "notes/甲.md", format!("第 {i} 版\n"));
            // force：同一秒内连做，绕开"一天一次"（同一秒撞名往后让的分支也因此被走到）
            ids.push(run(&v, true).unwrap().unwrap().id);
        }
        let snaps = list(&dir).unwrap();
        assert_eq!(snaps.len(), KEEP, "清单没裁到 30 份");
        // 被丢掉的是最早的三份：清单里没有，目录也不能留在盘上（否则清理只是假装）
        for gone in ids.iter().take(3) {
            assert!(!snaps.iter().any(|s| &s.id == gone), "{gone} 还在清单里");
            assert!(!dir.join(gone).exists(), "{gone} 的目录没删掉");
        }
        let last = snaps.last().unwrap();
        assert_eq!(last.id, ids[ids.len() - 1]);
        assert!(dir.join(&snaps[0].id).join("notes/甲.md").exists());
        assert_eq!(
            last.files["notes/甲.md"],
            content_hash(format!("第 {} 版\n", KEEP + 2).as_bytes())
        );
    }

    #[test]
    fn 写备份配置不会抹掉config里的其他键() {
        let d = tempfile::tempdir().unwrap();
        let v = vault_at(d.path());
        let path = v.meta_dir().join("config.toml");
        fs::create_dir_all(v.meta_dir()).unwrap();
        fs::write(
            &path,
            "other_key = '将来别的东西'\n\n[backup]\ndisabled = false\n",
        )
        .unwrap();

        save_config(
            &v,
            &BackupConfig {
                dir: Some("E:\\备份".into()),
                disabled: false,
            },
        )
        .unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("other_key"), "{text}");
        assert_eq!(load_config(&v).unwrap().dir.as_deref(), Some("E:\\备份"));
    }
}
