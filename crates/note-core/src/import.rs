//! 导入外部 Markdown（Obsidian 库、别的目录里的一堆 `.md`）。
//!
//! 三条不能商量的规矩，都来自"导入是把别人的资产搬进来，不是把我们的偏好盖上去"：
//!
//! 1. **内容一个字节都不改**。换行符、BOM、front-matter、`[[wikilink]]` 原样进来
//!    （G5 与 docs/03 §长路径：换行跟随文件原有风格）。要改用户内容的动作
//!    （比如给无锚点块回写 ` ^b-xxx`）不在导入里做——那条 docs/02 明确要求先弹窗告知。
//! 2. **文件名只在 Windows 非法或撞名时才改**，改了的必须出现在报告的 `renamed` 里。
//!    Obsidian 的 `[[页面名]]` 按 basename 解析，悄悄改名等于把用户的链接全弄断。
//! 3. **绝不覆盖**。目标已有同内容 → 跳过（重复导入幂等）；不同内容 → 加 `-2` 另存
//!    一份，因为"哪个是真的"只有用户知道。
//!
//! 目录结构原样保留在 `into` 前缀下面。库里留下的私有目录（`.obsidian/` 配置、
//! `.trash/` Obsidian 的回收站）不算内容，一律不收。

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::hash::content_hash;
use crate::index::Index;
use crate::service::reindex_note;
use crate::vault::{anchored, sanitize_file_stem, Vault};
use crate::{Error, Result};

/// 导入的目标前缀：库里的 `notes/`，子目录结构保留在它下面。
pub const DEFAULT_INTO: &str = "notes";

/// 一个源文件的处置计划。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// 相对源根的路径（正斜杠）
    pub src_rel: String,
    /// 库内的相对路径
    pub dest_rel: String,
    /// 库里已经有一模一样的一篇（重复导入时的幂等判据）
    pub already_there: bool,
    /// 是不是 `.md`（否则按附件处理）
    pub markdown: bool,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// 真正写进库的笔记（也就是要重新索引的那批）
    pub notes: Vec<String>,
    /// 写进库的非 `.md` 文件（图片等），相对路径原样保留
    pub assets: Vec<String>,
    /// 因为非法字符或撞名改了路径的：源 → 库内
    pub renamed: Vec<(String, String)>,
    /// 内容已在库里，跳过没写
    pub skipped: Vec<String>,
    pub bytes: u64,
}

fn is_markdown(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".md") || n.ends_with(".markdown")
}

/// 私有目录与依赖目录：`.obsidian`、`.trash`、`.git`、`node_modules`、`target`。
fn is_junk_name(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "node_modules" | "target")
}

fn sources(root: &Path) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !is_junk_name(&e.file_name().to_string_lossy()))
    {
        let entry = entry.map_err(|e| Error::Io {
            path: root.display().to_string(),
            source: std::io::Error::other(e),
        })?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(root)
            .map(|r| r.to_string_lossy().replace('\\', "/"))
            .map_err(|_| {
                Error::Invalid(format!(
                    "{} 不在 {} 下面",
                    entry.path().display(),
                    root.display()
                ))
            })?;
        if !rel.is_empty() {
            out.push(rel);
        }
    }
    out.sort();
    Ok(out)
}

/// 源路径 → 库内路径。只在两种情况下改名：Windows 不允许（`a:b?.md`、`CON.md`），
/// 或这个名字已经被占（同一批里先到先得；库里已有**不同内容**的一篇也算被占）。
///
/// `unusable` 由调用方给：库里同名文件的内容与这篇不一致时必须往后让。
/// **绝不覆盖用户已有的笔记**——"哪个是真的"只有用户知道，静默覆盖是不可原谅的。
fn dest_for(
    into: &str,
    rel: &str,
    taken: &mut BTreeSet<String>,
    unusable: &impl Fn(&str) -> bool,
) -> String {
    let (dir, name) = match rel.rsplit_once('/') {
        Some((d, n)) => (format!("{into}/{d}"), n),
        None => (into.to_string(), rel),
    };
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let clean = sanitize_file_stem(stem);
    let base = format!("{dir}/{clean}{ext}");
    let mut candidate = base.clone();
    let mut n = 2;
    while taken.contains(&candidate) || unusable(&candidate) {
        candidate = format!("{dir}/{clean}-{n}{ext}");
        n += 1;
    }
    taken.insert(candidate.clone());
    candidate
}

/// 库里这个位置是否"已被别人占着"：存在且内容不同。同内容不算占——那是幂等重导。
fn occupied(vault: &Vault, dest: &str, bytes: &[u8]) -> bool {
    vault
        .read(dest)
        .map(|cur| content_hash(&cur) != content_hash(bytes))
        .unwrap_or(false)
}

/// 校验源目录：必须存在，且不能是库自己或库里面的目录——往自己里面导会越写越多，
/// 永远不停。归一化与快照那条判据共用一份（Windows 的 `\\?\` 前缀会让两边对不上）。
pub fn check_src(vault: &Vault, src: &Path) -> Result<PathBuf> {
    let p = if src.is_absolute() {
        src.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| Error::Io {
                path: ".".into(),
                source: e,
            })?
            .join(src)
    };
    if !p.is_dir() {
        return Err(Error::Invalid(format!(
            "源目录不存在或不是目录：{}",
            p.display()
        )));
    }
    let canon = anchored(&p);
    if canon == vault.root() || canon.starts_with(vault.root()) {
        return Err(Error::Invalid(
            "源目录不能是 Vault 自己或它里面的目录（那等于往库里不断复制自己）".into(),
        ));
    }
    Ok(p)
}

/// 只算计划不写盘。界面与 CLI 都先拿它给用户看一眼再动手。
pub fn plan(vault: &Vault, src_root: &Path, into: &str) -> Result<Vec<Entry>> {
    let src = check_src(vault, src_root)?;
    let mut taken = BTreeSet::new();
    let mut out = Vec::new();
    for rel in sources(&src)? {
        let bytes =
            fs::read(src.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))).map_err(|e| {
                Error::Io {
                    path: rel.clone(),
                    source: e,
                }
            })?;
        let dest = dest_for(into, &rel, &mut taken, &|d| occupied(vault, d, &bytes));
        let already_there = vault
            .read(&dest)
            .map(|cur| content_hash(&cur) == content_hash(&bytes))
            .unwrap_or(false);
        let markdown = is_markdown(&rel);
        out.push(Entry {
            src_rel: rel,
            dest_rel: dest,
            already_there,
            markdown,
        });
    }
    Ok(out)
}

/// 按计划写盘（`dry_run` 只出报告）。
pub fn run(vault: &Vault, src_root: &Path, into: &str, dry_run: bool) -> Result<Report> {
    let src = check_src(vault, src_root)?;
    let mut report = Report::default();
    let mut taken = BTreeSet::new();
    for rel in sources(&src)? {
        let abs = src.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        let bytes = fs::read(&abs).map_err(|e| Error::Io {
            path: rel.clone(),
            source: e,
        })?;
        let dest = dest_for(into, &rel, &mut taken, &|d| occupied(vault, d, &bytes));
        // "改名"只算 basename/子路径变了。带 `into` 前缀的比较会把每个文件都误报成改名
        if dest != format!("{into}/{rel}") {
            report.renamed.push((rel.clone(), dest.clone()));
        }
        if vault
            .read(&dest)
            .map(|cur| content_hash(&cur) == content_hash(&bytes))
            .unwrap_or(false)
        {
            report.skipped.push(dest);
            continue;
        }
        report.bytes += bytes.len() as u64;
        if !dry_run {
            vault.write_atomic(&dest, &bytes)?;
        }
        if is_markdown(&rel) {
            report.notes.push(dest);
        } else {
            report.assets.push(dest);
        }
    }
    Ok(report)
}

/// 导入 + 把进来的每篇重新索引。索引走的是与保存、快照恢复完全同一条路
/// （`reindex_note`），所以 docs/03 点名的"CLI 导出来的索引和 UI 里操作出来的不一样"
/// 这个病，在这里从结构上不成立。
pub fn import_and_index(
    vault: &Vault,
    index: &Index,
    src_root: &Path,
    into: &str,
    dry_run: bool,
) -> Result<Report> {
    let report = run(vault, src_root, into, dry_run)?;
    if dry_run {
        return Ok(report);
    }
    for dest in &report.notes {
        reindex_note(vault, index, dest)?;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(names: &[&str]) -> Vec<String> {
        let mut taken = BTreeSet::new();
        names
            .iter()
            .map(|n| dest_for("notes", n, &mut taken, &|_| false))
            .collect()
    }

    #[test]
    fn 合法名字原样进来只有非法字符才改() {
        // 集成测试造不出这些名字（文件系统本身就拒绝），所以改名规则在这里单测。
        // 规则本身值得钉住：改一个名字等于把用户笔记里的 `[[旧名]]` 全弄断。
        let got = map(&[
            "某笔记.md",
            "子目录/另一篇.markdown",
            "CON.md",
            "带冒号:.md",
        ]);
        assert_eq!(got[0], "notes/某笔记.md");
        assert_eq!(got[1], "notes/子目录/另一篇.markdown");
        assert_eq!(got[2], "notes/_CON.md", "保留设备名: {got:?}");
        assert_eq!(got[3], "notes/带冒号.md", "非法字符与结尾空白: {got:?}");
    }

    #[test]
    fn 同一批里撞名的往后让且保留先到先得() {
        let got = map(&["a<b.md", "a>b.md", "a.md"]);
        assert_eq!(got, vec!["notes/a b.md", "notes/a b-2.md", "notes/a.md"]);
    }

    #[test]
    fn 空名字和超长名字也有落点() {
        let got = map(&[":::.md", &format!("{}.md", "长".repeat(120))]);
        assert_eq!(got[0], "notes/未命名.md", "{got:?}");
        assert!(
            got[1].starts_with("notes/") && got[1].chars().count() < 100,
            "{:?}",
            got[1].chars().count()
        );
    }
}
