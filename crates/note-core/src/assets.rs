//! 资产入库：图片字节 → 内容寻址路径 → `attachments/`，再登记进 `attachments` 表。
//!
//! 三条与 docs/02 对齐的规矩，改这个文件之前先读完：
//!
//! 1. **文件名就是内容的 sha256**（`hash::asset_path`）。"同一张图粘第二次"落到的天然是
//!    同一个路径，去重不靠约定、也不会在盘上攒出第二份——这是内容寻址唯一需要的性质。
//! 2. **`.md` 里只写引用，字节住在 `attachments/`**。Markdown 仍是唯一真相源（I1）：
//!    图片不是"第二种正文"，它是一行 `![[…]]` 指向的二进制。删掉那一行不会把文件删掉，
//!    这一点与 Obsidian 的默认行为一致，也是快照把 `attachments/` 整目录收进去的原因。
//! 3. **登记表是可丢的派生数据**（docs/02 §`.note/` 两分层）。`attachments` 那一行没写成功
//!    不影响图片显示——路径与 mime 都能从字节本身算回来。所以登记那一半允许走后台，
//!    同步返回的只有"文件已经在盘上了"。

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::hash::{asset_path, content_hash};
use crate::vault::Vault;
use crate::{Error, Result};

/// 单张图的字节上限。拒掉不是"存不下"，是"这条链路今天不该一口吞下它"：大文件要配
/// docs/03 承诺的缩略图预生成与懒加载，先把口径立住，别让 400MB 原图以"能存"的名义
/// 直接怼进正文渲染。
pub const MAX_ASSET_BYTES: usize = 20 * 1024 * 1024;

/// 认得的图像格式。这一批与 md-kernel 的 `is_image_target` 白名单同源——两处不一致
/// 就会出现"存得下来但渲染成文字链"，或者反过来"引用画成图但没人能存出这个文件"。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Format {
    pub ext: &'static str,
    pub mime: &'static str,
}

const PNG: Format = Format {
    ext: "png",
    mime: "image/png",
};
const JPG: Format = Format {
    ext: "jpg",
    mime: "image/jpeg",
};
const GIF: Format = Format {
    ext: "gif",
    mime: "image/gif",
};
const WEBP: Format = Format {
    ext: "webp",
    mime: "image/webp",
};
const BMP: Format = Format {
    ext: "bmp",
    mime: "image/bmp",
};
const AVIF: Format = Format {
    ext: "avif",
    mime: "image/avif",
};
const SVG: Format = Format {
    ext: "svg",
    mime: "image/svg+xml",
};

/// 从**字节本身**判格式，不看文件名。
///
/// 剪贴板给的名称今天是死的（截图永远叫 `image.png`），而用户改名、改错名、传空名都是
/// 常事。内容寻址的路径必须配真实的字节：拿文件名当扩展名，攒出来的就是"叫 .png 的
/// JPEG"这类永远修不完的脏数据。
pub fn sniff(bytes: &[u8]) -> Option<Format> {
    if bytes.len() >= 8 && bytes[..8] == [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a] {
        return Some(PNG);
    }
    if bytes.len() >= 3 && bytes[..3] == [0xff, 0xd8, 0xff] {
        return Some(JPG);
    }
    if bytes.starts_with(b"GIF8") {
        return Some(GIF);
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(WEBP);
    }
    if bytes.starts_with(b"BM") {
        return Some(BMP);
    }
    // ISO-BMFF：`长度(4) + "ftyp" + 品牌(4)`。avif 与 avis 两个品牌都按 avif 存
    if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis")
    {
        return Some(AVIF);
    }
    if 是svg(bytes) {
        return Some(SVG);
    }
    None
}

/// SVG 的判定：跳过 BOM 与空白，要么 `<svg`，要么 `<?xml … ?>` 之后紧跟 `<svg`。
///
/// SVG 能内嵌脚本，收它只有一个前提：界面**永远用 `<img>` 加载**（`render.ts` 与图片
/// NodeView 都只有 `<img>` 这一条路）。`<img>` 里的 SVG 是"图像"不是"文档"，脚本不会
/// 执行。将来若要把 SVG 内联进 DOM，必须先回到这里改判据。
fn 是svg(bytes: &[u8]) -> bool {
    let 起 = 跳空白(
        bytes,
        if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
            3
        } else {
            0
        },
    );
    let 余 = &bytes[起.min(bytes.len())..];
    if 余.starts_with(b"<svg") {
        return true;
    }
    if !余.starts_with(b"<?xml") {
        return false;
    }
    // 处理指令结束 `?>` 之后才是根元素；读不到就当不是 svg
    match 余.windows(2).position(|w| w == b"?>") {
        Some(i) => 余[跳空白(余, i + 2)..].starts_with(b"<svg"),
        None => false,
    }
}

fn 跳空白(bytes: &[u8], 从: usize) -> usize {
    let mut i = 从;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// 一次入库的结果。`rel` 是 Vault 根相对路径，前端把它拼成 `![[rel]]` 写进正文。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetOut {
    pub rel: String,
    pub mime: String,
    pub size: u64,
    pub sha256: String,
    /// 盘上早就有这一份了（同一张图第二次粘贴）。true 时**没有再写文件**
    pub existed: bool,
}

/// 判格式、算 sha、拼路径，顺带把"空/超限/不是图片"三道关口立住。
///
/// 拆成纯函数是因为 `save_bytes` 要**先查存在再决定写不写**，两步之间不该夹判断逻辑。
pub fn plan(bytes: &[u8]) -> Result<(Format, String, String)> {
    if bytes.is_empty() {
        return Err(Error::Invalid("空的图片字节".into()));
    }
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(Error::Invalid(format!(
            "这张图有 {} MB，超过 {} MB 上限，没存",
            bytes.len() / (1024 * 1024),
            MAX_ASSET_BYTES / (1024 * 1024)
        )));
    }
    let 式 = sniff(bytes).ok_or_else(|| {
        Error::Invalid(
            "认不出这是哪种图片（只收 png / jpg / gif / webp / bmp / avif / svg）".into(),
        )
    })?;
    let sha = content_hash(bytes);
    Ok((式, sha.clone(), asset_path(&sha, 式.ext)))
}

/// 写字节，已存在就跳过。**必须走 `Vault::resolve`**（`write_atomic` 内部就走），
/// 越出库目录的企图在那里就死。内容寻址的名字是 64 位十六进制，不可能带 `..`，
/// 但判据不该依赖"我生成的一定安全"。
pub fn save_bytes(vault: &Vault, bytes: &[u8]) -> Result<AssetOut> {
    let (式, sha, rel) = plan(bytes)?;
    let 已存在 = std::fs::metadata(vault.resolve(&rel)?).is_ok();
    if !已存在 {
        vault.write_atomic(&rel, bytes)?;
    }
    Ok(AssetOut {
        rel,
        mime: 式.mime.to_string(),
        size: bytes.len() as u64,
        sha256: sha,
        existed: 已存在,
    })
}

/// 登记一行。`orig_name` 只作来源记录，**永远不参与路径拼接**（路径由 sha 决定）。
///
/// `first_seen_at` 用毫秒，与 `notes.updated_at` 同一口径（那边取的是 mtime_ms）。
/// width/height 这一档留空：像素尺寸的真值要解码，与占位渲染一起在档 3 谈，
/// 此刻写进去的只能是个估计——空着比写错诚实。
pub fn register(conn: &Connection, a: &AssetOut, orig_name: Option<&str>) -> Result<()> {
    let 名 = orig_name.map(sanitize_name);
    let 现在 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    // sha256 是主键，冲突就意味着**同一份字节已经登记过**，那时一个字都不该改：
    // 改 orig_name 会让"第一次粘时它叫什么"这条来源信息丢掉，改 path 是同值空转，
    // 而 first_seen_at 的语义会被悄悄换成"最后一次见到"。
    conn.execute(
        "INSERT OR IGNORE INTO attachments(sha256,path,orig_name,mime,size,first_seen_at)
         VALUES(?1,?2,?3,?4,?5,?6)",
        params![a.sha256, a.rel, 名, a.mime, a.size as i64, 现在],
    )?;
    Ok(())
}

/// 客户端递来的原文件名，什么都可能发生：折行、控制字符、超长。它只进 `orig_name`
/// 这一列文本，所以这里只保证"作为一列文本是干净的"。
fn sanitize_name(名: &str) -> String {
    let 去 = 名.replace(['\r', '\n', '\t'], " ");
    let 瘦: String = 去.chars().filter(|c| !c.is_control()).collect();
    let 瘦 = 瘦.trim();
    if 瘦.is_empty() {
        return String::new();
    }
    瘦.chars().take(200).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 只到签名 + IHDR 头，测试不关心像素
    fn png() -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        v.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R']);
        v.extend_from_slice(&2u32.to_be_bytes());
        v.extend_from_slice(&3u32.to_be_bytes());
        v
    }

    fn 建表() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema::SCHEMA).unwrap();
        conn
    }

    #[test]
    fn sniff_看字节不看名字() {
        assert_eq!(sniff(&png()).unwrap().ext, "png");
        assert_eq!(sniff(&[0xff, 0xd8, 0xff, 0xe0, 0, 0]).unwrap().ext, "jpg");
        assert_eq!(sniff(b"GIF89a....").unwrap().ext, "gif");
        assert_eq!(sniff(b"BM........").unwrap().ext, "bmp");
        let mut w = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
        w.extend_from_slice(&[0u8; 8]);
        assert_eq!(sniff(&w).unwrap().ext, "webp");
        let 假avif = |品牌: &[u8]| {
            let mut v = vec![0, 0, 0, 24];
            v.extend_from_slice(b"ftyp");
            v.extend_from_slice(品牌);
            v.extend_from_slice(b"majorminor");
            v
        };
        assert_eq!(sniff(&假avif(b"avif")).unwrap().ext, "avif");
        assert_eq!(sniff(&假avif(b"avis")).unwrap().ext, "avif");
        assert_eq!(sniff(&假avif(b"isom")), None); // MP4 不是图片
        assert_eq!(sniff(b"<svg xmlns='x'></svg>").unwrap().ext, "svg");
        assert_eq!(
            sniff(b"<?xml version='1.0'?>\n<svg></svg>").unwrap().ext,
            "svg"
        );
        assert_eq!(sniff("\u{feff}  <svg/>".as_bytes()).unwrap().ext, "svg");
        // 不是图就不收：别把 txt / html 当 png 存
        assert_eq!(sniff(b"plain text"), None);
        assert_eq!(sniff(b"<html><body>"), None);
        assert_eq!(sniff(b"<?xml version='1.0'?><table></table>"), None);
    }

    #[test]
    fn 计划是内容寻址且可复现() {
        let a = png();
        let (式, s1, r1) = plan(&a).unwrap();
        let (_, s2, r2) = plan(&a).unwrap();
        assert_eq!(式.ext, "png");
        assert_eq!(s1, s2);
        assert_eq!(r1, r2);
        assert!(r1.starts_with("attachments/"), "{r1}");
        assert_eq!(r1.split('/').count(), 3, "{r1}");
        assert!(r1.ends_with(".png"), "{r1}");
        assert!(r1.contains(&s1[..2]), "{r1}");
    }

    #[test]
    fn 空与超限与不像图的都拒() {
        assert!(plan(b"").is_err());
        assert!(plan("这不是图".as_bytes()).is_err());
        let mut 大 = png();
        大.resize(MAX_ASSET_BYTES + 1, 0);
        let 错 = plan(&大).unwrap_err().to_string();
        assert!(错.contains("超过"), "{错}");
        assert!(错.contains("没存"), "{错}");
    }

    #[test]
    fn 登记同一份字节只留第一行() {
        let conn = 建表();
        let a = AssetOut {
            rel: "attachments/aa/bb.png".into(),
            mime: "image/png".into(),
            size: 12,
            sha256: "aabb".into(),
            existed: false,
        };
        register(&conn, &a, Some("截图 2026-10-09.png")).unwrap();
        register(&conn, &a, Some("第二次粘的名字.png")).unwrap();
        let 行: Vec<(String, String)> = conn
            .prepare("SELECT path, orig_name FROM attachments")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .filter_map(|x| x.ok())
            .collect();
        assert_eq!(行.len(), 1, "同 sha 粘两次攒出了第二行");
        assert_eq!(行[0].1, "截图 2026-10-09.png", "第二次不该改来源名");
    }

    #[test]
    fn 原文件名当文本处理不当路径() {
        let conn = 建表();
        let a = AssetOut {
            rel: "attachments/cc/dd.png".into(),
            mime: "image/png".into(),
            size: 1,
            sha256: "ccdd".into(),
            existed: false,
        };
        register(&conn, &a, Some("../../逃出去\n带换行.png")).unwrap();
        let (p, n): (String, String) = conn
            .query_row("SELECT path, orig_name FROM attachments", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(p, "attachments/cc/dd.png", "名字不该影响路径");
        assert_eq!(n, "../../逃出去 带换行.png");
    }

    #[test]
    fn 名字收口() {
        assert_eq!(sanitize_name("  甲  "), "甲");
        assert_eq!(sanitize_name("\u{1}ok\u{7}"), "ok");
        assert_eq!(sanitize_name("x\ny"), "x y");
        assert_eq!(sanitize_name("\u{1}\u{2}"), "", "全是控制字符就是空");
        assert_eq!(sanitize_name(&"长".repeat(400)).chars().count(), 200);
    }
}
