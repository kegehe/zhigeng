//! 捕获：速记窗 / 拖入 / CLI 共用的落盘路径。
//!
//! 这条路径的第一原则是**先保证不丢**（docs/04 §1）：
//! 落盘同步、不依赖 AI、不依赖网络、不依赖有没有配 key。
//! 索引紧随其后但只处理这一篇（实测在亚毫秒级，见 `note capture --bench`）。

use std::path::Path;

use serde::Serialize;

use crate::vault::{sanitize_file_stem, Vault};
use crate::{Error, Result};

/// 笔记 ID：`n-` + 8 位小写字母数字（docs/02 §front-matter）。
const ID_ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";

pub fn gen_note_id() -> String {
    use rand::Rng;
    let mut s = String::from("n-");
    let mut rng = rand::rng();
    for _ in 0..8 {
        s.push(ID_ALPHABET[rng.random_range(0..ID_ALPHABET.len())] as char);
    }
    s
}

/// 本地时间戳。用 `offset +08:00` 这类显式偏移，避免以后时区改动导致
/// 同一篇笔记的 created 在文件与索引之间对不上。
pub fn now_rfc3339() -> String {
    let now = chrono::Local::now();
    now.to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

pub fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Captured {
    /// front-matter 里的 created，回读时不必再解析 YAML
    pub created: String,
    /// 实际落盘的完整内容。索引必须建在"磁盘上确实是这样"的内容上，
    /// 所以由这里一次生成并随结果带出，绝不在调用方再拼一遍。
    #[serde(skip)]
    pub content: String,
    pub rel: String,
    pub id: String,
    pub title: String,
    pub content_hash: String,
    /// 落盘后重建这一篇索引的耗时，用来盯"捕获必须 100ms 内"的预算
    pub index_ms: u64,
}

/// 从一段原始文本决定标题：取第一行非空内容，截断到 40 字。
/// 纯符号/空白时退化成"速记 + 时间"，不会产出空标题。
pub fn derive_title(raw: &str) -> String {
    for line in raw.lines() {
        let t = line.trim().trim_start_matches('#').trim();
        let t = t
            .trim_start_matches(['-', '*', '+', '>', '[', ']', ' '])
            .trim();
        if t.is_empty() {
            continue;
        }
        let cut: String = t.chars().take(40).collect();
        let cut = cut.trim_end();
        if !cut.is_empty() {
            return cut.to_string();
        }
    }
    format!("速记 {}", chrono::Local::now().format("%H:%M"))
}

/// 构造要落盘的 Markdown。**只有这里决定 inbox 文件的格式**，别处不要复制这段。
///
/// 标题写进 front-matter，**不再往正文里插一个 `# 标题`**：速记的标题是从第一行推出来的，
/// 再插一次就是把同一句话写进两块里——搜索会重复命中，用户看到的也是重复内容。
pub fn compose_capture(raw: &str, id: &str, created: &str, source_url: Option<&str>) -> String {
    let body = raw.trim_end().replace("\r\n", "\n");
    let title = derive_title(&body);
    let mut fm = format!(
        "---\nid: {id}\ntitle: {}\ncreated: {created}\n",
        yaml_quote(&title)
    );
    if let Some(u) = source_url.filter(|u| !u.trim().is_empty()) {
        // props.source_url 存在即 origin=clipped，决定它是否受注入防护对待（docs/04）
        fm.push_str("props:\n  source_url: ");
        fm.push_str(&yaml_quote(u));
        fm.push('\n');
    }
    fm.push_str("---\n\n");
    format!("{fm}{body}\n")
}

fn yaml_quote(s: &str) -> String {
    // URL 里出现 `: ` 或 `#` 会让 YAML 解析出意外，统一加引号最省事
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// 目标路径：`inbox/YYYY-MM-DD-<slug>.md`，重名自动加序号，绝不覆盖已有笔记。
pub fn capture_rel(vault: &Vault, title: &str) -> String {
    let stem = sanitize_file_stem(title);
    let day = today();
    let mut rel = format!("inbox/{day}-{stem}.md");
    let mut n = 1;
    while vault.resolve(&rel).map(|p| p.exists()).unwrap_or(false) {
        rel = format!("inbox/{day}-{stem}-{n}.md");
        n += 1;
    }
    rel
}

/// 落盘 + 增量索引一篇速记。调用方负责持锁串行化（见 `Hub::capture`）。
pub fn capture_text(vault: &Vault, raw: &str, source_url: Option<&str>) -> Result<Captured> {
    capture_text_opts(vault, raw, source_url, true)
}

/// durable=false 仅用于测量 fsync 占比，产品路径必须走 true。
pub fn capture_text_opts(
    vault: &Vault,
    raw: &str,
    source_url: Option<&str>,
    durable: bool,
) -> Result<Captured> {
    let raw = normalize(raw);
    if raw.trim().is_empty() {
        return Err(Error::Io {
            path: "capture".into(),
            source: std::io::Error::new(std::io::ErrorKind::InvalidInput, "内容为空，未落盘"),
        });
    }
    let id = gen_note_id();
    let created = now_rfc3339();
    let content = compose_capture(&raw, &id, &created, source_url);
    let title = derive_title(&raw);
    let rel = capture_rel(vault, &title);
    let t0 = std::time::Instant::now();
    let content_hash = vault.write_atomic_opts(&rel, content.as_bytes(), durable)?;
    Ok(Captured {
        rel,
        id,
        title,
        content_hash,
        created,
        content,
        index_ms: t0.elapsed().as_millis() as u64,
    })
}

/// Windows 侧常见输入带 `\r\n` 与 BOM，统一成 LF 再去 BOM。
fn normalize(s: &str) -> String {
    s.replace("\r\n", "\n")
        .trim_start_matches('\u{feff}')
        .to_string()
}

/// 供 CLI 直接用的临时 Vault 入口（真机上 Vault 由用户选）。
pub fn open(path: &Path) -> Result<Vault> {
    std::fs::create_dir_all(path).map_err(|e| Error::Io {
        path: path.display().to_string(),
        source: e,
    })?;
    Vault::open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("inbox")).unwrap();
        d
    }

    #[test]
    fn id_唯一且格式正确() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..2000 {
            let id = gen_note_id();
            assert!(id.starts_with("n-") && id.len() == 10, "{id}");
            assert!(id[2..]
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
            assert!(seen.insert(id), "ID 撞了");
        }
    }

    #[test]
    fn 标题取首行并截断() {
        assert_eq!(
            derive_title("给 M4 想清楚触发条件\n第二行"),
            "给 M4 想清楚触发条件"
        );
        assert_eq!(derive_title("   \n\n  真标题  "), "真标题");
        assert_eq!(derive_title("# 带井号"), "带井号");
        assert_eq!(
            derive_title("----"),
            "速记 ".to_string() + &chrono::Local::now().format("%H:%M").to_string()
        );
        let long = "字".repeat(120);
        assert_eq!(derive_title(&long).chars().count(), 40);
    }

    #[test]
    fn 落盘内容含_frontmatter_且正文不重复() {
        let d = tmp();
        let v = open(d.path()).unwrap();
        let c = capture_text(&v, "第一条想法\n再补一句", None).unwrap();
        let body = String::from_utf8(v.read(&c.rel).unwrap()).unwrap();
        assert!(body.starts_with("---\nid: n-"), "{body}");
        assert!(
            body.contains("title: \"第一条想法\""),
            "标题没进 front-matter: {body}"
        );
        assert!(body.contains(&format!("id: {}", c.id)), "{body}");
        assert!(body.contains("created: 20"), "{body}");
        assert!(body.ends_with("再补一句\n"), "{body}");
        // 回归：曾经在正文里插一个 `# 标题`，而标题就是第一行本身 → 同一句话在正文写两遍，
        // 用户看到的是重复内容，搜索也会重复命中。判据只看正文部分（front-matter 里出现
        // 一次标题是应有的）。
        let body_only = body.splitn(3, "\n---\n").nth(1).unwrap_or("");
        assert_eq!(
            body_only.matches("第一条想法").count(),
            1,
            "正文重复:\n{body}"
        );
        assert!(!body.contains("# 第一条想法"), "不该再往正文插 H1:\n{body}");
        assert!(
            c.rel.starts_with("inbox/") && c.rel.ends_with(".md"),
            "{}",
            c.rel
        );
    }

    #[test]
    fn 标题里的冒号与井号不会破坏_yaml() {
        let d = tmp();
        let v = open(d.path()).unwrap();
        let c = capture_text(&v, "a: b # c\n第二行", None).unwrap();
        let content = String::from_utf8(v.read(&c.rel).unwrap()).unwrap();
        let fm = content.split("\n---\n").next().unwrap_or("");
        assert!(fm.contains("title: \"a: b # c\""), "{content}");
        // 标题推导与 front-matter 必须一致，否则列表显示的标题和文件里的对不上
        assert_eq!(c.title, "a: b # c");
    }

    #[test]
    fn 重名不覆盖而是加序号() {
        let d = tmp();
        let v = open(d.path()).unwrap();
        let a = capture_text(&v, "同一标题", None).unwrap();
        let b = capture_text(&v, "同一标题", None).unwrap();
        let c = capture_text(&v, "同一标题", None).unwrap();
        assert_ne!(a.rel, b.rel);
        assert_ne!(b.rel, c.rel);
        assert!(b.rel.contains("-1.md"), "{b:?}");
        assert!(c.rel.contains("-2.md"), "{c:?}");
        // 三条独立存在；内容 hash 必然不同（front-matter 里的 id 与 created 都不一样）
        let rels: Vec<String> = v.scan().unwrap().into_iter().map(|f| f.rel).collect();
        assert_eq!(rels.len(), 3, "{rels:?}");
        for r in [&a.rel, &b.rel, &c.rel] {
            assert!(rels.contains(r), "文件不存在 {r}");
        }
        assert_ne!(a.content_hash, b.content_hash);
    }

    #[test]
    fn 空内容不落盘() {
        let d = tmp();
        let v = open(d.path()).unwrap();
        assert!(capture_text(&v, "   \n\n  ", None).is_err());
        assert_eq!(v.scan().unwrap().len(), 0);
    }

    #[test]
    fn 带来源链接时标成_clipped() {
        let d = tmp();
        let v = open(d.path()).unwrap();
        let c = capture_text(&v, "读完的一句话", Some("https://example.com/a?x=1#h")).unwrap();
        let body = String::from_utf8(v.read(&c.rel).unwrap()).unwrap();
        assert!(
            body.contains("source_url: \"https://example.com/a?x=1#h\""),
            "{body}"
        );
    }

    #[test]
    fn 反斜杠与_bom_被规范化() {
        let d = tmp();
        let v = open(d.path()).unwrap();
        let c = capture_text(&v, "\u{feff}甲\r\n乙\r\n", None).unwrap();
        let body = String::from_utf8(v.read(&c.rel).unwrap()).unwrap();
        assert!(!body.contains('\r'), "残留 CR: {body:?}");
        assert!(!body.contains('\u{feff}'));
    }
}
