//! 资产入库：图片字节 → 内容寻址路径 → `attachments/`，再登记进 `attachments` 表。
//!
//! 三条与 docs/02 对齐的规矩，改这个文件之前先读完：
//!
//! 1. **文件名就是内容的 sha256**（`hash::asset_path`）。"同一张图粘第二次"落到的天然是
//!    同一个路径，去重不靠约定、也不会在盘上攒出第二份——这是内容寻址唯一需要的性质。
//! 2. **`.md` 里只写引用，字节住在 `attachments/`**。Markdown 仍是唯一真相源（I1）：
//!    图片不是"第二种正文"，它是一行 `![[…]]` 指向的二进制。删掉那一行不会把文件删掉，
//!    这一点与 Obsidian 的默认行为一致，也是快照把 `attachments/` 整目录收进去的原因。
//! 3. **登记表是派生数据，重建走 `attachments/` 目录本身**。`Index::rebuild_all` 会调
//!    `scan` 把内容寻址的那批登记回来（sha 写在文件名里，不需要重读字节），所以删掉
//!    `index.db` 之后这张表能自己长回来。要说清楚的两条边界：文件名不是 64 位十六进制的
//!    （Obsidian 手工拖进来的人名文件）**不登记**——给它编一个主键比少一行更坏；
//!    登记按**文件名声明**的 sha 记账，不校验字节，那是另一条命令的活（`note verify-assets`，还没做）。

use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::Path;

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
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        // GIF 的头就是这 6 个字节（`GIF8` 加版本号）。只认 `GIF8` 会把 "GIF8 开头的
        // 四个字母的文本" 当图片收进来
        return Some(GIF);
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(WEBP);
    }
    // BMP 的签名只有 `BM` 两个字母，任何以它开头的文本都会中招（仓库里那条
    // `sniff(b"BM........")` 的断言就是 10 个字节的东西被判成图片）。真实 BMP 至少
    // 要有文件头(14) + DIB 头(≥40)，所以再加一道长度与 DIB 大小的下限。
    if bytes.len() >= 54 && bytes.starts_with(b"BM") {
        let dib = u32::from_le_bytes([bytes[14], bytes[15], bytes[16], bytes[17]]);
        if (12..=124).contains(&dib) {
            return Some(BMP);
        }
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
            "这张图有 {:.1} MB，超过上限 {} MB，没存",
            bytes.len() as f64 / (1024.0 * 1024.0),
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
    // `is_file()` 而不是 `metadata().is_ok()`：目录、断掉的符号链接也算"is_ok"，
    // 那样会被判成"这一份已经有了"，从此既不重写也读不出字节（内容寻址的账就错了）
    let 已存在 = vault.resolve(&rel).map(|p| p.is_file()).unwrap_or(false);
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
    let 现在 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    register_at(conn, a, orig_name, 现在)
}

/// `register` 的那条插入，时间戳由调用方给。重建登记表时用的是**文件的 mtime**——
/// 写"此刻"会让每次 `reindex` 都把这张表的首见时间刷成新值，而那一列记的是"什么时候
/// 第一次见到这一份字节"。
pub(crate) fn register_at(
    conn: &Connection,
    a: &AssetOut,
    orig_name: Option<&str>,
    时候: i64,
) -> Result<()> {
    let 名 = orig_name.map(sanitize_name);
    // sha256 是主键，冲突就意味着**同一份字节已经登记过**，那时一个字都不该改：
    // 改 orig_name 会让"第一次粘时它叫什么"这条来源信息丢掉，改 path 是同值空转，
    // 而 first_seen_at 的语义会被悄悄换成"最后一次见到"。
    conn.execute(
        "INSERT OR IGNORE INTO attachments(sha256,path,orig_name,mime,size,first_seen_at)
         VALUES(?1,?2,?3,?4,?5,?6)",
        params![a.sha256, a.rel, 名, a.mime, a.size as i64, 时候],
    )?;
    Ok(())
}

/// 认得的扩展名 → 格式。`sniff` 的镜像，供**手里只有文件名**的那条路用（重建登记表
/// 不该为了知道 mime 把每张图再读一遍）。
fn format_by_ext(ext: &str) -> Option<Format> {
    [PNG, JPG, GIF, WEBP, BMP, AVIF, SVG]
        .into_iter()
        .find(|f| f.ext.eq_ignore_ascii_case(ext))
}

/// 从文件名解出内容寻址资产：`attachments/ab/abcdef…64hex.png`。
///
/// **按文件名声明的 sha 登记，不重读字节校验**。这不是偷懒，是这条路的定位：这张表是
/// 派生账本，重算它的代价不该是"把全库附件读一遍"。要真校验（文件名与内容是否相符）
/// 得单开一条 `note verify-assets`，那是全量 I/O，不该藏在 reindex 里。
/// 名字不是 64 位十六进制的（Obsidian 手工拖进来的人名文件）一律**不登记**——
/// 给它编一个 sha 主键比少一行更坏。
fn from_addressed_name(rel: &str) -> Option<AssetOut> {
    let 名 = rel.rsplit('/').next()?;
    let (主干, 扩展) = match 名.split_once('.') {
        Some((s, e)) => (s, e),
        None => (名, ""),
    };
    if 主干.len() != 64
        || !主干.bytes().all(|b| b.is_ascii_hexdigit())
        || !主干.bytes().all(|b| !b.is_ascii_uppercase())
    {
        return None;
    }
    let 式 = format_by_ext(扩展)?;
    Some(AssetOut {
        rel: rel.to_string(),
        mime: 式.mime.to_string(),
        size: 0,
        sha256: 主干.to_string(),
        existed: true,
    })
}

/// 扫 `attachments/` 出登记行——这是 docs/03 欠着的那条**重建路径**：删掉 `index.db`
/// 之后这张表今天真的能长回来了。
///
/// 只走 `attachments/` 一层，深度上限挡住"附件目录里套出一个仓库"这种怪形状；
/// 每个文件只 `metadata()` 拿大小，不读字节。
pub fn scan(root: &Path) -> Vec<AssetOut> {
    let 目录 = root.join(crate::vault::ATTACHMENTS_DIR);
    if !目录.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for e in walkdir::WalkDir::new(&目录)
        .follow_links(false)
        .max_depth(3)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let Some(相) = 库内相对(root, e.path()) else {
            continue;
        };
        let Some(mut 产) = from_addressed_name(&相) else {
            continue;
        };
        产.size = e.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(产);
    }
    out
}

/// 把引用写法归一成库内相对路径。三种来源（docs/02 §资产引用格式）都收到这一个函数里：
/// 本应用写的规范形（`attachments/ab/<sha>.png`）、Obsidian 的相对路径（`../../attachments/x.png`）、
/// 裸文件名（`图.png`，返回空串表示"只能按名字找"）。
///
/// `..` 与盘符在这里就剥不掉了——归一只承认"从 `attachments/` 开始的那一段"，
/// 剩下的越界企图由 `resolve_in` 判死。
fn 归一目标(target: &str) -> String {
    let 净 = target
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string();
    match 净.find(&format!("{}/", crate::vault::ATTACHMENTS_DIR)) {
        Some(i) => 净[i..].to_string(),
        None => 净,
    }
}

/// 资产链接的**存在性判据，唯一一份**（docs/02:165 与 docs/03:562 欠的就是这句话）。
/// 返回盘上真实存在的那个库内相对路径；找不到返回 `None`。
///
/// 三条查找顺序，从严到宽：
/// 1. 库内写法 → 直接按路径查盘（本应用粘出去的每一个引用都走这条，一次 stat 就到底）；
/// 2. `attachments` 表里等值或同尾名的行 → 查那一行的路径在不在盘上；
/// 3. 裸名或相对路径（Obsidian 手工拖进来的）→ 走查 `attachments/` 找同名文件。
///
/// 为什么判据必须只有这一份、又必须**在索引期和读路径各跑一次**：索引期那一次写进
/// `links.broken`，是面板排序用的缓存；读路径那一次覆盖它，因为外部删文件（Obsidian、
/// 同步盘、资源管理器）不会惊动任何一篇 `.md`，`watch::ignorable` 在攒批之前就把非
/// `.md` 挡了。缓存与现算不一致时以盘上为准——屏幕上那句"链空了"必须说的是**此刻的盘**。
pub fn exists(root: &Path, conn: &Connection, target: &str) -> Option<String> {
    let 净 = 归一目标(target);
    if 净.is_empty() {
        return None;
    }
    if crate::vault::is_attachment_rel(&净)
        && crate::vault::resolve_in(root, &净)
            .map(|p| p.is_file())
            .unwrap_or(false)
    {
        return Some(净);
    }
    let 名 = 净.rsplit('/').next().filter(|s| !s.is_empty())?;
    // 表里先找：`path=?1` 命中规范形，尾名匹配的 LIKE 用不上索引，所以只取候选。
    let 候选 = 表内候选(conn, 名, &净);
    for 路 in 候选 {
        // LIKE 命中的是**候选**，不是结论：`_` 在 LIKE 里是通配符，`axpng.png` 会被
        // `a_png.png` 的模式捞进来，所以相等必须在 Rust 里再判一次。尾名匹配也认
        // 路径边界（`/` 之后），不许 `attachments/ab/xa.png` 冒充 `attachments/ab/a.png`。
        let 同尾 = 路 == 净 || 路.ends_with(&format!("/{净}"));
        let 同名 = 路.rsplit('/').next().unwrap_or("") == 名;
        if (同名 || 同尾)
            && crate::vault::resolve_in(root, &路)
                .map(|p| p.is_file())
                .unwrap_or(false)
        {
            return Some(路);
        }
    }
    // 表里没有 ≠ 盘上没有（人名文件不登记），所以还走查一次。代价与附件数有关、与库的
    // 规模无关，且只在"裸名/相对路径"这一类上发生——规范形在上面第一条就返回了。
    let 目录 = root.join(crate::vault::ATTACHMENTS_DIR);
    for e in walkdir::WalkDir::new(&目录)
        .follow_links(false)
        .max_depth(3)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && e.file_name().to_string_lossy().as_ref() == 名)
    {
        if let Some(相) = 库内相对(root, e.path()) {
            if !相.is_empty() {
                return Some(相);
            }
        }
    }
    None
}

/// 附件表里与这个写法**可能**同名的行。命中的是候选，不是结论——判等由调用方在 Rust
/// 里做（`_` 在 LIKE 里是通配符，直接采信会把 `axpng.png` 算成 `a_png.png` 的答案）。
///
/// 查询失败**不当成"没有候选"**：那等于把一次 SQL 故障说成"你的图丢了"。
/// 表里没有候选仍然会继续走查目录，所以这条路不阻断判定，只是留下日志。
fn 表内候选(conn: &Connection, 名: &str, 净: &str) -> Vec<String> {
    let 跑 = || -> rusqlite::Result<Vec<String>> {
        let mut s = conn.prepare(
            "SELECT path FROM attachments WHERE path=?1 OR path LIKE '%/'||?1 OR path=?2",
        )?;
        let 行 = s.query_map(params![名, 净], |r| r.get::<_, String>(0))?;
        Ok(行.filter_map(|x| x.ok()).collect())
    };
    match 跑() {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("附件表候选查询失败（继续按盘上走查）：{e}");
            Vec::new()
        }
    }
}

/// 绝对路径 → 库内相对路径（正斜杠）。`Vault::relative` 同一条换算的自由函数形式：
/// 这一档手里只有根路径。
fn 库内相对(root: &Path, abs: &Path) -> Option<String> {
    Some(
        abs.strip_prefix(root)
            .ok()?
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/"),
    )
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

    /// 一个够真的最小 BMP：14 字节文件头 + 40 字节 DIB 头
    fn bmp() -> Vec<u8> {
        let mut v = b"BM".to_vec();
        v.extend_from_slice(&54u32.to_le_bytes());
        v.extend_from_slice(&[0, 0, 0, 0]);
        v.extend_from_slice(&54u32.to_le_bytes());
        v.extend_from_slice(&40u32.to_le_bytes());
        v.resize(54, 0);
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
        assert_eq!(sniff(&bmp()).unwrap().ext, "bmp");
        // 只有签名、没有头的东西不是图片：`BM` 两个字母会命中任何以它开头的文本
        assert_eq!(sniff(b"BM........"), None);
        assert_eq!(sniff(b"Budget report for Q3"), None);
        assert_eq!(sniff(b"GIF8 not really a gif"), None);
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

    /// 内容寻址的名字：64 位十六进制，前缀目录取前两位
    fn 内容名(c: char) -> String {
        c.to_string().repeat(64)
    }

    #[test]
    fn 存在性判据认三种写法但只认盘上() {
        let dir = tempfile::tempdir().unwrap();
        let 根 = dir.path();
        let conn = 建表();
        let 名 = 内容名('a');
        let 规范 = format!("attachments/aa/{名}.png");
        std::fs::create_dir_all(根.join("attachments/aa")).unwrap();
        std::fs::write(根.join(&规范), "一张图".as_bytes()).unwrap();
        std::fs::write(根.join("attachments/图.png"), "人名文件".as_bytes()).unwrap();

        assert_eq!(
            exists(根, &conn, &规范).as_deref(),
            Some(规范.as_str()),
            "本应用粘出去的规范形一次 stat 就到底"
        );
        assert_eq!(
            exists(根, &conn, &format!("../../{规范}")).as_deref(),
            Some(规范.as_str()),
            "Obsidian 的相对写法归一后是同一条路径"
        );
        assert_eq!(
            exists(根, &conn, &format!("/{规范}")).as_deref(),
            Some(规范.as_str()),
            "前导 `/` 是库根相对（docs/02 §资产引用格式）"
        );
        assert_eq!(
            exists(根, &conn, "图.png").as_deref(),
            Some("attachments/图.png"),
            "裸文件名靠走查——表里没有 ≠ 盘上没有"
        );
        assert_eq!(exists(根, &conn, "没有这张.png"), None);
        assert_eq!(exists(根, &conn, ""), None, "空写法不配占一行");
    }

    #[test]
    fn 表里的候选要在_rust_里判等() {
        // LIKE 的 `_` 是通配符：`a_png.png` 的模式能捞到 `axpng.png`。
        // 直接采信候选 = 面板指着一张根本没被引用的图说"它在库内"。
        let dir = tempfile::tempdir().unwrap();
        let 根 = dir.path();
        let conn = 建表();
        std::fs::create_dir_all(根.join("attachments/ab")).unwrap();
        std::fs::write(根.join("attachments/ab/axpng.png"), b"x").unwrap();
        register(
            &conn,
            &AssetOut {
                rel: "attachments/ab/axpng.png".into(),
                mime: "image/png".into(),
                size: 1,
                sha256: 内容名('b'),
                existed: true,
            },
            None,
        )
        .unwrap();
        assert_eq!(exists(根, &conn, "a_png.png"), None, "通配符不算命中");
        assert_eq!(
            exists(根, &conn, "axpng.png").as_deref(),
            Some("attachments/ab/axpng.png"),
            "真名才算"
        );
    }

    #[test]
    fn 越出库目录的写法判不存在() {
        let dir = tempfile::tempdir().unwrap();
        let 根 = dir.path();
        let conn = 建表();
        std::fs::create_dir_all(根.join("attachments/aa")).unwrap();
        // 这篇真的在库根上（不在 attachments/ 里）。判据要是顺着 `..` 走或者去走查全库，
        // 就会指着它说"图在库内"——那是比"链空了"更坏的一句谎。
        std::fs::write(根.join("库外.png"), "不是我附件目录里的".as_bytes()).unwrap();
        assert_eq!(exists(根, &conn, "attachments/../../库外.png"), None);
        assert_eq!(
            exists(根, &conn, r"attachments\..\..\库外.png"),
            None,
            "反斜杠同一条判据"
        );
        assert_eq!(
            exists(根, &conn, "库外.png"),
            None,
            "走查不许越出 attachments/"
        );
        assert_eq!(
            exists(根, &conn, "C:/Windows/win.ini"),
            None,
            "盘符写法不进文件系统"
        );
    }

    #[test]
    fn 扫描只登记名字里写着_sha_的那些() {
        let dir = tempfile::tempdir().unwrap();
        let 根 = dir.path();
        std::fs::create_dir_all(根.join("attachments/aa")).unwrap();
        std::fs::create_dir_all(根.join("attachments/cc")).unwrap();
        let 名 = 内容名('a');
        std::fs::write(
            根.join(format!("attachments/aa/{名}.png")),
            "七个字节".as_bytes(),
        )
        .unwrap();
        // 人名文件与"名字像 sha 但不是十六进制"的文件都不登记：给它编一个主键比少一行更坏
        std::fs::write(根.join("attachments/aa/截图.png"), b"x").unwrap();
        std::fs::write(根.join("attachments/cc/GGH.png"), b"x").unwrap();

        let 行 = scan(根);
        assert_eq!(行.len(), 1, "{行:?}");
        assert_eq!(行[0].sha256, 名);
        assert_eq!(行[0].mime, "image/png");
        assert!(
            行[0].existed,
            "扫描看到的是盘上既有事实，不是刚写出去的字节"
        );
        // 大小是真读出来的，不是 0
        assert_eq!(行[0].size, "七个字节".len() as u64);

        let conn = 建表();
        register_at(&conn, &行[0], None, 123).unwrap();
        let 时候: i64 = conn
            .query_row("SELECT first_seen_at FROM attachments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            时候, 123,
            "重建用的是 mtime，不是'此刻'——那一列记的是第一次见到这份字节"
        );
    }

    #[test]
    fn 没有附件目录时扫描是空表而不是报错() {
        let dir = tempfile::tempdir().unwrap();
        assert!(scan(dir.path()).is_empty());
    }
}
