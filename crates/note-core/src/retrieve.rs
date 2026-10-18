//! 混合召回：关键词路（`chunks_fts` BM25）+ 语义路（`vec_<model>` KNN）+ 图扩展路
//! （前两路命中的篇 → 1 跳反链/出链）→ 去重 → 单篇配额 → RRF 合并。口径在 docs/04 §混合检索与问答。
//!
//! 四条不显然的：
//!
//! 1. **合并用的是名次而不是分数**。BM25 与余弦距离不同量纲、不同方向（一个越大越好、
//!    一个越小越好），把它们加权平均是在拿苹果加橘子；RRF 只看"你在自己那一排里第几"，
//!    某一路挂了也不影响其它路出结果。
//! 2. **单篇配额是防一篇长文垄断结果**（docs/04：每篇最多 4 块）。没有这一步，3000 块
//!    那篇夹具能同时占掉关键词与语义两路的前茅，界面上看着就是"搜来搜去都是它"。
//! 3. **隐私过滤在每一条路的 SQL 里各写一遍**（同 `search_keyword`）。视图文件也不进——
//!    它是查询定义，不是知识内容。图扩展这一路要特别注意：隐私位挡的是**邻居那一篇**，
//!    "谁提到了我的私密篇"这条边本身就是内容，所以入链方向同样带过滤条件。
//! 4. **图扩展是零 token、对任何 Key 都成立的那一路**（2026-10-10 档 A 之后重排到语义之前）。
//!    它不配模型也照跑，所以界面上那句话不许再写成"只有关键词"——走没走、走了哪几路，
//!    都由 `走了哪几路` 这一份拼出来。

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

use crate::{Error, Result};

/// 每一路取回多少候选（docs/04 §召回 的配额）。
pub const 每路配额: usize = 30;
/// 合并后同一篇笔记最多贡献几块。
pub const 每篇配额: usize = 4;
/// 图扩展那一路补几个（docs/04 §召回 的"补 top 10"）。
pub const 图配额: usize = 10;
/// 种子取前两路里前几**篇**。没上限的话一次检索要为第 40 名的候选跑两条 links 查询，
/// 而它的邻居几乎不可能比排在前面的更相关——上限是给规模定的，不是给当前语料定的。
const 种子上限: usize = 8;
/// 每个种子、每个方向最多带几个邻居。两个用处：把 SQL 往返数钉住，以及**当枢纽笔记的闸**——
/// 一篇被 1500 篇提到时，只取最近更新的那三个（排序口径见 `邻居`），而不是整片扇出涌进候选。
const 每方向上限: i64 = 3;
/// RRF 的平滑常数。60 是原论文的经验值，也是各家实现事实上的默认——不在这儿调参，
/// 调它属于"评测集标定"那一步的活（docs/04 §评测集）。
const RRF_K: f64 = 60.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum 路 {
    Keyword,
    Semantic,
    Graph,
}

impl 路 {
    /// 界面上、CLI 里、审计那句话用的同一个名字。**加一档路就必须改这里**，
    /// `src/ui/search.test.ts` 有一条用例拿枚举原文比对这几句话——两边不一致就红。
    pub fn 显示名(self) -> &'static str {
        match self {
            路::Keyword => "关键词",
            路::Semantic => "语义",
            路::Graph => "链接",
        }
    }
}

/// 三路按界面上的顺序排一次：关键词 → 链接 → 语义。
/// 加一档路只改这里，`走了哪几路` 与 `三路都开` 都从这张表走。
pub const 三路: [路; 3] = [路::Keyword, 路::Graph, 路::Semantic];

/// 这一趟到底走了哪几路。**只有一份**：界面上那句标题、CLI 那行总结、hint 那句话
/// 都从这里拼。写死的"关键词 + 语义两路合并"在图扩展接上之后就是一句谎，
/// 而"只有关键词"在没配嵌入模型时同样谎（链接那一路本来就在跑）。
///
/// 参数是**开了的那几路**而不是两个 bool：同类型的位置布尔传反了编译器一声不响，
/// 而这句话错了就是界面上当场可拆的谎。
pub fn 走了哪几路(开了: &[路]) -> String {
    三路
        .iter()
        .filter(|r| 开了.contains(r))
        .map(|r| r.显示名())
        .collect::<Vec<_>>()
        .join(" + ")
}

/// 重排生效时加在"走了哪几路"后面那一段。**界面上与 CLI 共用这一份**；
/// `src/ui/search.ts` 里那份镜像由 `search.test.ts` 逐字比对（改了这边忘了那边就红）。
pub const 重排尾巴: &str = " · 已重排";

/// 从两个"可开关"的标志还原这一趟开了哪几路。`检索结果`、`成绩`、CLI 与评测都读它——
/// 两边各写一份 filter，早晚会拼出两句不一样的话
pub fn 开了的(语义: bool, 图: bool) -> Vec<路> {
    三路
        .iter()
        .copied()
        .filter(|r| match r {
            路::Keyword => true,
            路::Graph => 图,
            路::Semantic => 语义,
        })
        .collect()
}

/// 一条混合命中。`snippet` 是切片正文的开头，`header_path` 是它的面包屑。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct 命中 {
    pub chunk_id: i64,
    pub note_id: String,
    pub path: String,
    pub title: String,
    pub header_path: String,
    pub snippet: String,
    pub status: String,
    /// 这条是被哪几路捞上来的。多路都命中是最强的信号，界面上要说得出**是哪几路**
    pub from: Vec<路>,
    pub rrf: f64,
}

/// 纯函数：三路各自的有序 chunk_id（附 note_id 用于配额）→ RRF 合并后的有序结果。
///
/// 判据全部可测，不打网络也不碰 SQLite——所以"配额把谁挤掉了""多路都命中排第一"
/// 这类事是被用例钉住的，不是看真机顺不顺眼。
pub fn 合并(
    关键词: &[(i64, String)],
    语义: &[(i64, String)],
    图: &[(i64, String)],
    每篇: usize,
    输出: usize,
) -> Vec<(i64, f64, Vec<路>)> {
    let mut 分: std::collections::BTreeMap<i64, (f64, Vec<路>, String)> = Default::default();
    for (路名, 列) in [(路::Keyword, 关键词), (路::Semantic, 语义), (路::Graph, 图)] {
        for (名次, (id, 笔记)) in 列.iter().enumerate() {
            let 项 = 分
                .entry(*id)
                .or_insert_with(|| (0.0, Vec::new(), 笔记.clone()));
            项.0 += 1.0 / (RRF_K + 名次 as f64 + 1.0);
            if !项.1.contains(&路名) {
                项.1.push(路名);
            }
        }
    }
    // 先按分数降序（同分按 chunk_id 升序，保证可重现），再走配额
    let mut 排: Vec<(i64, f64, Vec<路>, String)> = 分
        .into_iter()
        .map(|(id, (s, 路, 笔记))| (id, s, 路, 笔记))
        .collect();
    排.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    let mut 每篇计数: std::collections::BTreeMap<String, usize> = Default::default();
    let mut 出 = Vec::new();
    for (id, s, 路, 笔记) in 排 {
        let n = 每篇计数.entry(笔记).or_insert(0);
        if *n >= 每篇 {
            continue; // 配额满了：这一篇后面的块让位给别的篇
        }
        *n += 1;
        出.push((id, s, 路));
        if 出.len() >= 输出 {
            break;
        }
    }
    出
}

/// 把查询变成 FTS5 的匹配表达式：**各词 OR，并丢掉没有区分力的高频词**。
///
/// 界面搜索（`Index::search_keyword`）与召回（`关键词路`）**共用这一份**。分成两份的代价
/// 真机照出来过：同一次搜索里，上面那块说"没有匹配的笔记"，下面那块说这一篇"两路都中"——
/// 屏幕上同时出现两句互相打脸的话，用户只会认为搜索坏了。
///
/// 表名走参数插值而不是占位符（SQLite 不给表名用 `?`），调用方传的都是本模块写死的常量；
/// 这里对外不接收户输入拼进表名的路径。
pub fn 匹配式(
    conn: &Connection,
    fts表: &str,
    全表: &str,
    query: &str,
) -> Result<Option<String>> {
    let 词: Vec<String> = crate::index::segment(query)
        .split_whitespace()
        .map(str::to_string)
        .collect();
    if 词.is_empty() {
        return Ok(None);
    }
    let 总: i64 = conn.query_row(&format!("SELECT count(*) FROM {全表}"), [], |r| r.get(0))?;
    let mut 留下 = Vec::new();
    if 词.len() >= 2 && 总 > 0 {
        for w in &词 {
            let n = 词频(conn, fts表, w).unwrap_or(0);
            if n * 2 <= 总 {
                留下.push(w.clone());
            }
        }
    }
    // 单条词、或全被当成高频丢掉时回到原样：宁可给一堆噪音，也不要静默返回空
    let 用 = if 留下.is_empty() { 词 } else { 留下 };
    Ok(Some(
        用.iter()
            .map(|w| format!("\"{}\"", w.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" OR "),
    ))
}

/// 一个词在这张 FTS 表里出现在多少行里（文档频率）。
fn 词频(conn: &Connection, fts表: &str, 词: &str) -> Result<i64> {
    let 包 = format!("\"{}\"", 词.replace('"', ""));
    Ok(conn.query_row(
        &format!("SELECT count(*) FROM {fts表} WHERE {fts表} MATCH ?1"),
        [包],
        |r| r.get::<_, i64>(0),
    )?)
}

/// 关键词那一跳：切片级 BM25。
pub fn 关键词路(conn: &Connection, query: &str, 配额: usize) -> Result<Vec<(i64, String)>> {
    let Some(match_expr) = 匹配式(conn, "chunks_fts", "chunks", query)? else {
        return Ok(Vec::new());
    };
    let mut s = conn.prepare(
        "SELECT c.id, c.note_id
         FROM chunks_fts f
         JOIN chunks c ON c.rowid = f.rowid
         JOIN notes  n ON n.id = c.note_id
         WHERE chunks_fts MATCH ?1
           AND n.ai_private = 0 AND n.no_ai = 0
           AND n.note_kind <> 'view'
         ORDER BY bm25(chunks_fts)
         LIMIT ?2",
    )?;
    let rows = s.query_map(params![match_expr, 配额 as i64], |r: &Row| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    })?;
    Ok(rows.filter_map(|x| x.ok()).collect())
}

/// 语义那一跳：查询向量 → KNN。向量本身由调用方去要（`ai::embed` 一次，只发查询文本）。
pub fn 语义路(
    conn: &Connection,
    模型: &str,
    查询向量: &[f32],
    配额: usize,
) -> Result<Vec<(i64, String)>> {
    if 查询向量.is_empty() {
        return Ok(Vec::new());
    }
    let 表 = crate::embed::表名(模型);
    let 有: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
        [&表],
        |r| r.get(0),
    )?;
    if 有 == 0 {
        return Err(Error::Invalid(format!(
            "还没有 {模型} 的向量表。先跑 `note ai embed`（或界面上点嵌入），再搜"
        )));
    }
    // KNN 那一段用 CTE 包着，**不给虚拟表起别名**：`v.k = ?` 这种写法在 vec0 上没验过，
    // 而 ADR-003 实测过的形状就是裸 `WHERE embedding MATCH ? AND k = ?`。不为了少写
    // 一个 CTE 去赌一个没跑过的语法。
    // 配额放大一倍再 JOIN：KNN 回来的 rowid 里可能有一批属于隐私笔记或视图，
    // 过滤完不够数就白丢了这一跳。
    let mut s = conn.prepare(&format!(
        "WITH 近 AS (
           SELECT rowid AS id, distance FROM {表} WHERE embedding MATCH ?1 AND k = ?2
         )
         SELECT 近.id, c.note_id
         FROM 近
         JOIN chunks c ON c.id = 近.id
         JOIN notes  n ON n.id = c.note_id
         WHERE n.ai_private = 0 AND n.no_ai = 0 AND n.note_kind <> 'view'
         ORDER BY 近.distance"
    ))?;
    let rows = s.query_map(
        params![crate::embed::小端(查询向量), (配额 * 2) as i64],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
    )?;
    let mut 出: Vec<(i64, String)> = rows.filter_map(|x| x.ok()).collect();
    出.truncate(配额);
    Ok(出)
}

/// 纯函数：前两路的命中 → 图扩展的**种子篇**。
///
/// 同一篇在两路里各出现一次时，按它在**任一路里的最好名次**只排一次。名次跨路不可比
/// （BM25 与余弦是两把尺子），"谁先被捞到"可比——这跟 `合并` 用名次不用分数是同一个道理。
/// 同名次时关键词那一路在前：它是必需路，也是唯一一条用户能自己复现的路。
pub fn 种子(关键词: &[(i64, String)], 语义: &[(i64, String)], 上限: usize) -> Vec<String> {
    let mut 最好: std::collections::BTreeMap<String, (usize, u8)> = Default::default();
    for (档, 列) in [(0u8, 关键词), (1u8, 语义)] {
        for (名次, (_, 笔记)) in 列.iter().enumerate() {
            let 项 = 最好.entry(笔记.clone()).or_insert((名次, 档));
            if 名次 < 项.0 || (名次 == 项.0 && 档 < 项.1) {
                *项 = (名次, 档);
            }
        }
    }
    let mut 排: Vec<(usize, u8, String)> = 最好
        .into_iter()
        .map(|(笔记, (名次, 档))| (名次, 档, 笔记))
        .collect();
    排.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    排.into_iter().take(上限).map(|(_, _, 笔记)| 笔记).collect()
}

/// 一跳邻居的两种形状：`Some(块 id)` = 入链方向，那块就是"提到种子"的那一块；
/// `None` = 出链方向，链接块长在种子自己身上（它已经是候选了），对方这边没有那块。
/// 一跳邻居：谁、提了几次、第一次那条链接的行号。
struct 邻居 {
    篇: String,
    提及: i64,
    首条链接: i64,
}

/// 一个方向上的邻居，按**它提到种子几次**从多到少取前几个。
///
/// 为什么不是按"最近更新"：一篇被 1500 篇提到的枢纽笔记，那些邻居的 mtime 全在同一秒
/// （导入就是这个样子），按时间排等于按入库顺序排——合成库上量过一次，真邻居被 1500 个
/// 噪音挤在后面出不了候选（见 docs/04 §图扩展那一路）。**提得最多**才说明这两篇真的
/// 在一起说过同一件事；时间与 links.id 只用来把同次数的排成确定的。
///
/// 两条 SQL 形状一样、方向相反，隐私与视图的过滤也一样。合成一条再拼字符串反而容易漏，
/// 这里宁可写两遍**同一条 WHERE**：过滤条件漏一边就是隐私漏一边。
fn 邻居(conn: &Connection, 种子: &str, 入链: bool, 上限: i64) -> Result<Vec<邻居>> {
    let 语句 = if 入链 {
        "SELECT b.note_id, COUNT(*), MIN(l.id)
         FROM links l
         JOIN blocks b ON b.id = l.from_block
         JOIN notes  n ON n.id = b.note_id
         WHERE l.to_note = ?1
           AND b.note_id <> ?1
           AND n.ai_private = 0 AND n.no_ai = 0
           AND n.note_kind <> 'view'
         GROUP BY b.note_id
         ORDER BY COUNT(*) DESC, MAX(n.updated_at) DESC, MIN(l.id)
         LIMIT ?2"
    } else {
        "SELECT t.id, COUNT(*), MIN(l.id)
         FROM links l
         JOIN blocks b ON b.id = l.from_block
         JOIN notes  t ON t.id = l.to_note
         WHERE b.note_id = ?1
           AND t.id <> ?1
           AND t.ai_private = 0 AND t.no_ai = 0
           AND t.note_kind <> 'view'
         GROUP BY t.id
         ORDER BY COUNT(*) DESC, MAX(t.updated_at) DESC, MIN(l.id)
         LIMIT ?2"
    };
    let mut s = conn.prepare(语句)?;
    let 行 = s.query_map(params![种子, 上限], |r: &Row| {
        Ok(邻居 {
            篇: r.get(0)?,
            提及: r.get(1)?,
            首条链接: r.get(2)?,
        })
    })?;
    Ok(行.filter_map(|x| x.ok()).collect())
}

/// 入链方向那条链接长在哪个块上——`代表切片` 要的就是这一块所在的切片。
fn 链接所在块(conn: &Connection, 链接: i64) -> Result<Option<String>> {
    let 出 = conn.query_row("SELECT from_block FROM links WHERE id=?1", [链接], |r| {
        r.get::<_, String>(0)
    });
    match 出 {
        Ok(块) => Ok(Some(块)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => {
            tracing::warn!("图扩展读链接 {链接} 的发起块失败：{e}");
            Err(e.into())
        }
    }
}

/// 一个邻居贡献哪一块：**与这层链接关系有关的那一块**。
///
/// 入链方向给"提到种子的那一块"所在的切片——用户问"谁说过这件事"时，答案恰恰是那句
/// 提及，不是对方笔记的开头。出链方向没有这一说（那块在种子身上），退回对方的首块。
/// 两个方向走同一个函数，只是 `提及块` 有没有值。
fn 代表切片(conn: &Connection, 笔记: &str, 提及块: Option<&str>) -> Result<Option<i64>> {
    let 出 = match 提及块 {
        Some(块) => conn.query_row(
            "SELECT c.id
             FROM chunks c
             JOIN blocks tb ON tb.id = ?2
             JOIN blocks s  ON s.id = c.start_block
             JOIN blocks e  ON e.id = c.end_block
             WHERE c.note_id = ?1
               AND s.ordinal <= tb.ordinal
               AND tb.ordinal <= e.ordinal
             ORDER BY s.ordinal
             LIMIT 1",
            params![笔记, 块],
            |r| r.get::<_, i64>(0),
        ),
        None => conn.query_row(
            "SELECT c.id
             FROM chunks c
             JOIN blocks s ON s.id = c.start_block
             WHERE c.note_id = ?1
             ORDER BY s.ordinal
             LIMIT 1",
            [笔记],
            |r| r.get::<_, i64>(0),
        ),
    };
    match 出 {
        Ok(id) => Ok(Some(id)),
        // 邻居一篇切片都没有（空笔记、或只有 front-matter）。少一个邻居比报错好，
        // 但这不是"不存在"的意思——判据函数不许把 Err 折成不存在，故留一行日志
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => {
            tracing::warn!("图扩展取 {笔记} 的代表切片失败：{e}");
            Err(e.into())
        }
    }
}

/// 图扩展那一跳：种子篇 → 1 链邻居 → 每个邻居交出一块。**纯本地，零 token，不配模型也照跑**。
///
/// 四条口径：
/// 1. **邻居不许是种子自己**（它已经在候选里了，再交一块只是占掉那篇的配额）；
/// 2. **同一篇邻居只交一块**，但从两个种子都到达它时提及次数**累加**——一篇被这次命中的
///    两篇各自提到，比只被一篇提到的那篇更该进来；
/// 3. 名次按"提及次数 → 最好种子名次 → 切片号"，所以结果**可重现**，评测里能钉；
///    每个种子每个方向只取前 `每方向上限` 个（那是枢纽笔记的闸）。
/// 4. 入链方向交的是**提到种子的那一块**所在切片，出链方向交对方的首块（见 `代表切片`）。
pub fn 图路(conn: &Connection, 种子: &[String], 配额: usize) -> Result<Vec<(i64, String)>> {
    // 键 = 邻居篇。值 = (累计提及次数, 最好的种子名次, 代表切片)
    let mut 收集: std::collections::BTreeMap<String, (i64, usize, i64)> = Default::default();
    let 是种子: std::collections::BTreeSet<String> = 种子.iter().cloned().collect();
    for (名次, 种) in 种子.iter().enumerate() {
        for (入链, 列) in [
            (true, 邻居(conn, 种, true, 每方向上限)?),
            (false, 邻居(conn, 种, false, 每方向上限)?),
        ] {
            for 项 in 列 {
                if 是种子.contains(&项.篇) {
                    continue;
                }
                let 提及块 = if 入链 {
                    链接所在块(conn, 项.首条链接)?
                } else {
                    None
                };
                let Some(切片) = 代表切片(conn, &项.篇, 提及块.as_deref())? else {
                    continue;
                };
                let 槽 = 收集.entry(项.篇.clone()).or_insert((0, 名次, 切片));
                槽.0 += 项.提及;
                槽.1 = 槽.1.min(名次);
            }
        }
    }
    let mut 排: Vec<(i64, usize, i64, String)> = 收集
        .into_iter()
        .map(|(篇, (提及, 名次, 切片))| (提及, 名次, 切片, 篇))
        .collect();
    排.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    Ok(排
        .into_iter()
        .take(配额)
        .map(|(_, _, 切片, 篇)| (切片, 篇))
        .collect())
}

/// 把合并后的 chunk_id 补成界面要的那份形状。**顺序按 `合并` 给的来**，不再排。
pub fn 取详情(conn: &Connection, 排好: &[(i64, f64, Vec<路>)]) -> Result<Vec<命中>> {
    let mut 出 = Vec::new();
    for (id, s, 路) in 排好 {
        let 行 = conn.query_row(
            "SELECT c.note_id, n.path, n.title, COALESCE(c.header_path,''), substr(c.text,1,160), n.status
             FROM chunks c JOIN notes n ON n.id = c.note_id WHERE c.id=?1",
            [id],
            |r: &Row| {
                Ok(命中 {
                    chunk_id: *id,
                    note_id: r.get(0)?,
                    path: r.get(1)?,
                    title: r.get(2)?,
                    header_path: r.get(3)?,
                    snippet: r.get(4)?,
                    status: r.get(5)?,
                    from: 路.clone(),
                    rrf: *s,
                })
            },
        );
        match 行 {
            Ok(v) => 出.push(v),
            // 两路之间隔了一次网络往返，这期间那篇可能被删了。少一条比报错好，
            // 但也不能静默——留日志，别让"结果少了一条"变成查不到的事
            Err(e) => tracing::warn!("混合检索丢掉切片 {id}：{e}"),
        }
    }
    Ok(出)
}

/// 一趟完整的混合检索：查询 → （可能一次网络）嵌入 → 三路 → 合并 → （可选）重排。
/// **含网络往返时别放在同步命令里**（G6 的 8ms 是给本地查询的，docs/03 §后端调用纪律）。
///
/// 2026-10-18 起这一条是**唯一一份**实现。原先这里还有个严格版 `混合`（没配嵌入模型就报错），
/// 而图扩展接上之后"没配嵌入模型"不再等于"这一趟跑不了"——留着两条路径，早晚一条改了
/// 一条没改，评测量的就不是界面上跑的那一趟了。
///
/// 这一趟怎么跑。开关放结构体里而不是位置参数上：`跑一趟(v, c, q, true, false)` 那种调用
/// 没人读得懂，而这两个开关传反一次就是一句谎或一次白花钱。
#[derive(Debug, Clone, Copy, Default)]
pub struct 跑法 {
    /// 图扩展那一路开不开。false 只给 `note eval --no-graph` 当对照档
    pub 开图: bool,
    /// 覆盖配置里的重排开关：`None` = 听配置（界面上与问答里都走这条）
    pub 重排: Option<bool>,
}

/// 常规跑法：三路全开，重排听配置。
pub const 常规: 跑法 = 跑法 {
    开图: true,
    重排: None,
};

/// 对照档：摘掉图扩展那一路。量新增那一路的增益必须有一个"没有它"的数。
pub const 对照无图: 跑法 = 跑法 {
    开图: false,
    重排: None,
};

/// 界面上、问答里跑的那一趟。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct 检索结果 {
    pub hits: Vec<命中>,
    /// 语义那一路这次到底开没开。没开时 `hint` 会说要它做什么
    pub semantic: bool,
    /// 图扩展那一路这次跑没跑。**它对任何 Key 都成立**，所以这一档今天恒真——
    /// 但界面上那句话是从这两个布尔拼出来的，不是写死的（档 A 的教训：
    /// "两个探针都通了"那种写死的话会在下一次改动里变成谎）
    pub graph: bool,
    /// 这一趟的**顺序**是不是模型重排过的。false 有两种原因（没开 / 开了但没成），
    /// 哪一种都得由 `hint` 说清——"没重排"与"重排失败"不是一回事
    pub reranked: bool,
    /// 重排那一趟的 token。**回包读不出也要记账**：那一趟模型确实答过、钱确实花了，
    /// 说"没重排"不能顺带把数字抹掉。搜索本身不落 `ai_runs`，但问答会把这两个数并进去
    pub rerank_in: usize,
    pub rerank_out: usize,
    pub hint: Option<String>,
}

impl 检索结果 {
    /// 界面上、CLI 上那句"这一趟走了哪几路"。**由两个布尔拼出来，不写死**；
    /// 重排不是"一路"，是合并之后的一道工序，所以只加尾巴
    pub fn 走了(&self) -> String {
        走了哪几路(&开了的(self.semantic, self.graph))
    }

    /// 上面那句 + 重排生效时的尾巴。界面上右上角与 CLI 那行总结读的是**同一个**方法——
    /// 两边各拼一次，早晚一边改了另一边没改
    pub fn 走了那句(&self) -> String {
        if self.reranked {
            format!("{}{重排尾巴}", self.走了())
        } else {
            self.走了()
        }
    }
}

/// **没配模型 / 还没嵌过**时退回剩下的路，并说清为什么；
/// **配了但连不上**不退回——那是"试过了，失败"，混进"这一路没开"就是把错误吞成状态。
fn 跑一趟(
    vault: &crate::vault::Vault,
    conn: &Connection,
    query: &str,
    法: 跑法,
) -> Result<检索结果> {
    let cfg = crate::ai::load(vault)?;
    let 模型 = cfg
        .embedding_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let 关键 = 关键词路(conn, query, 每路配额)?;
    let 表在 = match &模型 {
        Some(m) => {
            let n: i64 = conn.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [&crate::embed::表名(m)],
                |r| r.get(0),
            )?;
            n > 0
        }
        None => false,
    };
    let (语, 语义开) = match (&模型, 表在) {
        (None, _) => (Vec::new(), false),
        (Some(_), false) => (Vec::new(), false),
        (Some(m), true) => {
            // 这一支不兜底：连不上就报错，别把失败说成"没开"
            let v = crate::ai::embed(&cfg, &[query.to_string()])?;
            (语义路(conn, m, &v[0], 每路配额)?, true)
        }
    };
    let 种 = 种子(&关键, &语, 种子上限);
    let 图 = if 法.开图 {
        图路(conn, &种, 图配额)?
    } else {
        Vec::new()
    };
    let 走了 = 走了哪几路(&开了的(语义开, 法.开图));
    // 提示攒成一条清单再拼：语义那一路没开 与 重排没成 可以同时成立，
    // 各写各的字段早晚有一个被覆盖掉
    let mut 提示 = Vec::new();
    if !语义开 {
        提示.push(match &模型 {
            None => format!(
                "没填嵌入模型名，语义那一路没开，这一趟走{走了}。要加语义那一路：设置里填好，再点嵌入。"
            ),
            Some(_) => format!(
                "还没嵌过向量，语义那一路没开，这一趟走{走了}。跑 `note ai embed`，或在设置里点嵌入。"
            ),
        });
    }
    let 排 = 合并(&关键, &语, &图, 每篇配额, 每路配额);
    let 详情 = 取详情(conn, &排)?;
    let (详情, 重排过, 重进, 重出) = 重排这一趟(&cfg, 法, query, 详情, &mut 提示);
    Ok(检索结果 {
        hits: 详情,
        semantic: 语义开,
        graph: 法.开图,
        reranked: 重排过,
        rerank_in: 重进,
        rerank_out: 重出,
        hint: if 提示.is_empty() {
            None
        } else {
            Some(提示.join(" "))
        },
    })
}

/// 重排那一趟：开关来自配置（**默认关**，那是每次搜索一次付费），`法.重排` 只给 CLI 对照档用。
///
/// 失败不吞也不炸：顺序退回 RRF（重排只是增益，不该因为它读不出就把手里的结果扔掉），
/// 但原因必须进 `提示`——"没重排"与"重排失败"必须分得开（1b 那条老规矩）。
/// token 无论成败都带回去，读不出编号那一趟钱照样花掉了。
fn 重排这一趟(
    cfg: &crate::ai::AiConfig,
    法: 跑法,
    问题: &str,
    候选: Vec<命中>,
    提示: &mut Vec<String>,
) -> (Vec<命中>, bool, usize, usize) {
    if !法.重排.unwrap_or(cfg.rerank) {
        return (候选, false, 0, 0);
    }
    // 没填对话模型就别去打个必然失败的请求：这一格是"配了开关但配不齐"，
    // 说清缺什么比抛一个 HTTP 错误有用
    let 有对话 = cfg
        .chat_model
        .as_deref()
        .map(str::trim)
        .is_some_and(|s| !s.is_empty());
    if !有对话 {
        提示.push("开了重排但没填对话模型，这一趟没重排。".into());
        return (候选, false, 0, 0);
    }
    // 连不上也不炸：重排只是增益，把手里的结果换成一句红色报错是拿功能换诚实。
    // 但失败必须写进提示——"没重排"与"重排失败"不是一回事（1b 那条老规矩）
    match crate::rerank::试(cfg, 问题, &候选) {
        Ok(出) => match (出.顺序, 出.原因, 出.用量) {
            (Some(新), _, 量) => (新, true, 量.in_tokens, 量.out_tokens),
            (None, 原因, 量) => {
                if let Some(话) = 原因 {
                    提示.push(话);
                }
                (候选, false, 量.in_tokens, 量.out_tokens)
            }
        },
        Err(e) => {
            提示.push(format!("重排没成功（{e}）{}", crate::rerank::退回话));
            (候选, false, 0, 0)
        }
    }
}

pub fn 混合或退回(
    vault: &crate::vault::Vault,
    conn: &Connection,
    query: &str,
) -> Result<检索结果> {
    检索(vault, conn, query, 常规)
}

/// 按指定跑法跑一趟。CLI 的两个对照档（`--rerank` / `--no-graph`）走这里——
/// **量一个开关的增益，必须能把它关掉再量一次**，否则报出来的永远是加了东西之后的好数字。
pub fn 检索(
    vault: &crate::vault::Vault,
    conn: &Connection,
    query: &str,
    法: 跑法,
) -> Result<检索结果> {
    跑一趟(vault, conn, query, 法)
}

/// 对照档：摘掉图扩展那一路。只给 `note eval --no-graph` 用——
/// 量新那一路的增益必须有一个"没有它"的数，不然报出来的永远是加了东西之后的好数字。
pub fn 无图对照(
    vault: &crate::vault::Vault,
    conn: &Connection,
    query: &str,
) -> Result<检索结果> {
    检索(vault, conn, query, 对照无图)
}

/// 评测集里的一条。`expect_none = true` 是**负样本**：库里没有依据，正确行为是搜不出东西。
/// docs/04 §评测集 要的不只是"找得回来"，还有"不该答的时候别硬答"。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct 问题 {
    pub q: String,
    /// 期望出现在前 K 里的笔记路径（任一命中即算命中）
    #[serde(default)]
    pub expect_paths: Vec<String>,
    #[serde(default)]
    pub expect_none: bool,
}

/// TOML 的顶层只能是"一个值"，所以套件文件长这样：`[[q]]` 若干段。
#[derive(Debug, Deserialize)]
struct 套件文件 {
    q: Vec<问题>,
}

pub fn 读套件(文本: &str) -> Result<Vec<问题>> {
    let v: 套件文件 =
        toml::from_str(文本).map_err(|e| Error::Invalid(format!("评测集读不回来：{e}")))?;
    if v.q.is_empty() {
        return Err(Error::Invalid("评测集是空的".into()));
    }
    let mut 出 = v.q;
    for 题 in &mut 出 {
        题.q = 题.q.trim().to_string();
    }
    for 题 in &出 {
        if 题.q.is_empty() {
            return Err(Error::Invalid("评测集里有空问题".into()));
        }
        if 题.expect_none && !题.expect_paths.is_empty() {
            return Err(Error::Invalid(format!(
                "「{}」既标了 expect_none 又给了期望路径，判不了对错",
                题.q
            )));
        }
        if !题.expect_none && 题.expect_paths.is_empty() {
            return Err(Error::Invalid(format!(
                "「{}」没给期望路径，也没标 expect_none",
                题.q
            )));
        }
    }
    Ok(出)
}

/// 一轮评测的成绩。**语义那一路开没开要写在结果里**：没配模型时这个数只反映关键词，
/// 拿它当"AI 检索达标了"是假的。字段名走英文（见 `scripts/guard.mjs` 第 5 条：
/// `#[serde(rename_all)]` 碰中文字段名会在 derive 里 panic）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct 成绩 {
    pub entries: usize,
    pub positives: usize,
    pub negatives: usize,
    pub hits: usize,
    pub recall_at_k: f64,
    /// **进了候选的负样本**（附 top-1 的 RRF 分与来源）。召回层给候选是它的本职，
    /// "库里没依据就不该答"由答案层的分数阈值判（docs/04 §拒答判定 要的就是这条阈值，
    /// 而它规定阈值由评测集标定）。所以这一栏是**标定材料**，不是失败计数。
    pub negatives_with_candidates: Vec<String>,
    pub misses: Vec<String>,
    pub semantic: bool,
    /// 这一轮图扩展那一路开没开。**报 recall 的数必须连着这个说**——
    /// `--no-graph` 那一档是给"新增那一路到底增益了多少"当对照的
    pub graph: bool,
    /// 这一轮有没有真的重排过（配置里开着、且模型回了能读的编号）。
    /// 开着开关但一路都没改成顺序，这个数就是 false——别拿"配了"当"生效了"
    pub reranked: bool,
    pub k: usize,
}

impl 成绩 {
    /// 报这个数的时候必须连着说这一趟走了哪几路——`--no-graph` 那档量的是基线
    pub fn 走了(&self) -> String {
        走了哪几路(&开了的(self.semantic, self.graph))
    }
}

/// 跑一遍评测集。**走的是界面上同一个 `跑一趟`**：评测量的是产品实际跑的那条通路，
/// 不是另写一份"看起来一样"的实现——分成两份的代价在 `匹配式` 那儿已经付过一次
/// （同一次搜索里上面说"没有匹配的笔记"、下面说这一篇"两路都中"）。
pub fn 评测(
    vault: &crate::vault::Vault,
    conn: &Connection,
    套件: &[问题],
    k: usize,
    法: 跑法,
) -> Result<成绩> {
    let mut 正 = 0;
    let mut 负 = 0;
    let mut 命中数 = 0;
    let mut 误给 = Vec::new();
    let mut 漏 = Vec::new();
    let mut 语义开 = false;
    let mut 重排过 = false;
    for 题 in 套件 {
        let 结 = 跑一趟(vault, conn, &题.q, 法)?;
        语义开 |= 结.semantic;
        重排过 |= 结.reranked;
        let 详情 = 结.hits;
        let 前: Vec<&str> = 详情.iter().take(k).map(|h| h.path.as_str()).collect();
        if 题.expect_none {
            负 += 1;
            if let Some(首) = 详情.first() {
                // 报的是"进了候选"与它的分数，不是"错了"：阈值还没标定之前，
                // 把这个当失败计数会让人去改召回，而该改的是答案层的门
                let 来源 = 首
                    .from
                    .iter()
                    .map(|r| r.显示名())
                    .collect::<Vec<_>>()
                    .join("+");
                误给.push(format!("{}｜top1 rrf={:.4} {来源}", 题.q, 首.rrf));
            }
            continue;
        }
        正 += 1;
        if 前.iter().any(|p| 题.expect_paths.iter().any(|e| e == p)) {
            命中数 += 1;
        } else {
            漏.push(format!("{}｜给了 {:?}", 题.q, 前));
        }
    }
    Ok(成绩 {
        entries: 套件.len(),
        positives: 正,
        negatives: 负,
        hits: 命中数,
        recall_at_k: if 正 == 0 {
            0.0
        } else {
            命中数 as f64 / 正 as f64
        },
        negatives_with_candidates: 误给,
        misses: 漏,
        semantic: 语义开,
        graph: 法.开图,
        reranked: 重排过,
        k,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn n(id: i64, 篇: &str) -> (i64, String) {
        (id, 篇.into())
    }
    fn ns(id: i64, 篇: String) -> (i64, String) {
        (id, 篇)
    }
    fn 只id(排: &[(i64, f64, Vec<路>)]) -> Vec<i64> {
        排.iter().map(|x| x.0).collect()
    }

    #[test]
    fn 两路都命中的排第一() {
        let 排 = 合并(
            &[n(1, "A"), n(2, "A"), n(3, "B")],
            &[n(3, "B"), n(9, "C")],
            &[],
            4,
            10,
        );
        assert_eq!(只id(&排)[0], 3, "两路都捞到的是最强信号");
        assert_eq!(排[0].2, vec![路::Keyword, 路::Semantic]);
    }

    #[test]
    fn 名次比分数重要_rrf() {
        // 关键词第 2 名 vs 语义第 1 名：RRF 下语义略胜（1/61 > 1/62），
        // 这条钉的是"我们用的是名次"，不是某个自定义加权
        let 排 = 合并(&[n(1, "A"), n(2, "B")], &[n(3, "C")], &[], 4, 10);
        assert_eq!(只id(&排), vec![1, 3, 2]);
    }

    #[test]
    fn 单篇配额把垄断的长文挤下去() {
        let 长: Vec<(i64, String)> = (1..=8).map(|i| n(i, "长文")).collect();
        let 排 = 合并(&长, &[], &[], 4, 10);
        assert_eq!(只id(&排), vec![1, 2, 3, 4], "每篇最多 4 块");
        // 配额之后继续让别篇进来，不是截断成 4 条就完事
        let 混 = 合并(
            &[
                n(1, "长文"),
                n(2, "长文"),
                n(3, "长文"),
                n(4, "长文"),
                n(5, "别的"),
            ],
            &[],
            &[],
            2,
            10,
        );
        assert_eq!(只id(&混), vec![1, 2, 5]);
    }

    #[test]
    fn 输出条数封顶() {
        let a: Vec<(i64, String)> = (1..=20).map(|i| ns(i, format!("篇{i}"))).collect();
        assert_eq!(合并(&a, &[], &[], 4, 6).len(), 6);
    }

    #[test]
    fn 两路都空就是空结果不报错() {
        assert!(合并(&[], &[], &[], 4, 10).is_empty());
    }

    #[test]
    fn 同分按切片号排所以可重现() {
        let 排 = 合并(&[n(7, "A")], &[n(3, "B")], &[], 4, 10);
        // 两路各自第 1 名分数相同（1/61）→ 小的在前
        assert_eq!(只id(&排), vec![3, 7]);
        assert!((排[0].1 - 排[1].1).abs() < f64::EPSILON);
    }

    #[test]
    fn 没嵌过就明说而不是给半截结果() {
        crate::index::注册向量扩展();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema::SCHEMA).unwrap();
        let 错 = 语义路(&conn, "没建表的模型", &[1.0, 0.0], 30)
            .unwrap_err()
            .to_string();
        assert!(
            错.contains("还没有") && 错.contains("note ai embed"),
            "{错}"
        );
    }

    #[test]
    fn 空查询与空向量都不打那一跳() {
        crate::index::注册向量扩展();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema::SCHEMA).unwrap();
        assert!(关键词路(&conn, "   ", 30).unwrap().is_empty());
        let 表 = crate::embed::建表(&conn, "m", 2).unwrap();
        assert!(
            语义路(&conn, "m", &[], 30).unwrap().is_empty(),
            "空向量别去问虚拟表"
        );
        assert!(
            语义路(&conn, "m", &[1.0, 0.0], 30).unwrap().is_empty(),
            "空表回空，不是错"
        );
        let _ = 表;
    }

    /// 端到端（不打网络）：真索引一篇 → 关键词路能命中 → 手工塞向量 → 语义路能命中 →
    /// 合并把两路捏在一起。
    #[test]
    fn 两路在真索引上都能回东西() {
        let dir = tempfile::tempdir().unwrap();
        let v = crate::vault::Vault::open(dir.path()).unwrap();
        v.write_atomic(
            "notes/甲.md",
            "---\nid: n-hyb00001\ntitle: 向量检索\n---\n\n向量检索把文本变成可比较的数。\n"
                .as_bytes(),
        )
        .unwrap();
        v.write_atomic(
            "notes/乙.md",
            "---\nid: n-hyb00002\ntitle: 爬山\n---\n\n周末去爬山，带了两瓶水。\n".as_bytes(),
        )
        .unwrap();
        let idx = crate::index::Index::open(&v).unwrap();
        idx.rebuild_all(&v).unwrap();
        let conn = idx.conn();

        let 关 = 关键词路(conn, "向量检索", 30).unwrap();
        assert_eq!(关.len(), 1, "只有甲篇该命中: {关:?}");
        let 甲 = 关[0].0;
        assert!(关键词路(conn, "银行卡", 30).unwrap().is_empty());

        let 表 = crate::embed::建表(conn, "mm", 2).unwrap();
        let 全部: Vec<i64> = {
            let mut s = conn.prepare("SELECT id FROM chunks ORDER BY id").unwrap();
            s.query_map([], |r| r.get(0))
                .unwrap()
                .filter_map(|x| x.ok())
                .collect()
        };
        for (i, id) in 全部.iter().enumerate() {
            let 向 = if *id == 甲 {
                vec![1.0, 0.0]
            } else {
                vec![0.0, 1.0]
            };
            crate::embed::写入(conn, "mm", &表, &[(*id, 向)]).unwrap();
            let _ = i;
        }
        let 语 = 语义路(conn, "mm", &[0.9, 0.1], 30).unwrap();
        assert_eq!(语[0].0, 甲, "最近的该是甲篇");

        let 排 = 合并(&关, &语, &[], 4, 10);
        assert_eq!(排[0].0, 甲);
        assert_eq!(排[0].2, vec![路::Keyword, 路::Semantic]);
        let 详 = 取详情(conn, &排).unwrap();
        assert_eq!(详[0].title, "向量检索");
        assert!(详[0].snippet.contains("可比较的数"));
    }

    #[test]
    fn 隐私笔记与视图两条路都不给() {
        let dir = tempfile::tempdir().unwrap();
        let v = crate::vault::Vault::open(dir.path()).unwrap();
        v.write_atomic(
            "notes/私.md",
            "---\nid: n-priv0001\ntitle: 私密\nai:\n  private: true\n---\n\n向量检索的私密记录。\n"
                .as_bytes(),
        )
        .unwrap();
        v.write_atomic(
            "views/看板.md",
            "---\nid: n-view0001\ntitle: 看板\nview:\n  kind: smart\n  query: 向量检索\n---\n"
                .as_bytes(),
        )
        .unwrap();
        let idx = crate::index::Index::open(&v).unwrap();
        idx.rebuild_all(&v).unwrap();
        assert!(
            关键词路(idx.conn(), "向量检索", 30).unwrap().is_empty(),
            "私密那篇不该被关键词路捞到"
        );
    }

    /// 这一条原先叫"没填模型名就说不填而不是搜出半套"，走的是严格版 `混合`。
    /// 2026-10-18 图扩展接上之后**它不成立了**：没配嵌入模型不再等于"这一趟跑不了"，
    /// 关键词与链接两路照给。严格版删掉，界面上与评测里跑的是同一份 `跑一趟`。
    #[test]
    fn 没填模型名照样出东西并且说清少了哪一路() {
        let dir = tempfile::tempdir().unwrap();
        let v = crate::vault::Vault::open(dir.path()).unwrap();
        v.write_atomic(
            "notes/甲.md",
            "---\nid: n-gmp00001\ntitle: 甲\n---\n\n关键词与链接两路都要能回东西。\n".as_bytes(),
        )
        .unwrap();
        let idx = crate::index::Index::open(&v).unwrap();
        idx.rebuild_all(&v).unwrap();
        let 结 = 混合或退回(&v, idx.conn(), "关键词").unwrap();
        assert!(结.graph, "链接那一路不配模型也在跑");
        assert!(!结.semantic);
        let 提 = 结.hint.unwrap();
        assert!(提.contains("没填嵌入模型名"), "{提}");
        assert!(
            提.contains("关键词 + 链接"),
            "少了什么要说清，走了什么也要说清：{提}"
        );
    }

    /// 评测集与语料都装进一个临时库，跑一遍真索引再量。
    fn 装库(
        篇: &[(&str, &str)],
    ) -> (tempfile::TempDir, crate::vault::Vault, crate::index::Index) {
        let dir = tempfile::tempdir().unwrap();
        let v = crate::vault::Vault::open(dir.path()).unwrap();
        for (路径, 内容) in 篇 {
            v.write_atomic(路径, 内容.as_bytes()).unwrap();
        }
        let idx = crate::index::Index::open(&v).unwrap();
        idx.rebuild_all(&v).unwrap();
        (dir, v, idx)
    }

    const 三篇: &[(&str, &str)] = &[
        (
            "notes/检索.md",
            "---\nid: n-eval0001\ntitle: 检索策略\n---\n\n向量检索把文本变成可比较的数，召回先看名次再看分数。\n",
        ),
        (
            "notes/备份.md",
            "---\nid: n-eval0002\ntitle: 备份\n---\n\n每日快照到第二个目录，保留三十份。唯一副本等于没有副本。\n",
        ),
        (
            "notes/打扰.md",
            "---\nid: n-eval0003\ntitle: 打扰预算\n---\n\n什么时候打断用户是主动层的核心问题，推送要有预算上限。\n",
        ),
    ];

    #[test]
    fn 没模型时评测量的是关键词与链接两路并且说实话() {
        let (_d, v, idx) = 装库(三篇);
        let 套 = 读套件(
            r#"
[[q]]
q = "唯一副本"
expect_paths = ["notes/备份.md"]
[[q]]
q = "打断用户 预算"
expect_paths = ["notes/打扰.md"]
[[q]]
q = "zzz 完全没记过的东西 qqq"
expect_none = true
"#,
        )
        .unwrap();
        let 成 = 评测(&v, idx.conn(), &套, 8, 常规).unwrap();
        assert!(!成.semantic, "没建向量表就该只量关键词");
        assert_eq!(成.entries, 3);
        assert_eq!(成.positives, 2);
        assert_eq!(成.negatives, 1);
        assert_eq!(成.hits, 2, "漏了谁：{:?}", 成.misses);
        assert!((成.recall_at_k - 1.0).abs() < f64::EPSILON);
        assert!(
            成.negatives_with_candidates.is_empty(),
            "这条负样本该空手：{:?}",
            成.negatives_with_candidates
        );
    }

    #[test]
    fn 漏了要报哪一条误给也要报哪一条() {
        let (_d, v, idx) = 装库(三篇);
        let 套 = 读套件(
            r#"
[[q]]
q = "唯一副本"
expect_paths = ["notes/打扰.md"]
[[q]]
q = "快照"
expect_none = true
"#,
        )
        .unwrap();
        let 成 = 评测(&v, idx.conn(), &套, 8, 常规).unwrap();
        assert_eq!(成.hits, 0);
        assert_eq!(成.misses.len(), 1, "{:?}", 成.misses);
        assert!(
            成.misses[0].contains("唯一副本"),
            "漏的清单要能认出是哪条: {:?}",
            成.misses
        );
        assert_eq!(
            成.negatives_with_candidates.len(),
            1,
            "负样本进了候选，要连着分数报出来"
        );
        assert!(
            成.negatives_with_candidates[0].contains("rrf="),
            "{:?}",
            成.negatives_with_candidates
        );
    }

    #[test]
    fn 多词查询按各词或匹配而不是整句短语() {
        // "打断用户 预算" 在正文里不相邻。整句包成一串是 FTS 的短语查询，
        // 那样召回会把最该中的长文档整批漏掉——这条钉的是"我们用的是 OR"
        let (_d, _v, idx) = 装库(三篇);
        let 中 = 关键词路(idx.conn(), "打断用户 预算", 30).unwrap();
        assert_eq!(中.len(), 1, "该靠两个词各自命中同一篇: {中:?}");
        let 篇 = idx
            .conn()
            .query_row("SELECT note_id FROM chunks WHERE id=?1", [中[0].0], |r| {
                r.get::<_, String>(0)
            })
            .unwrap();
        assert_eq!(篇, "n-eval0003");
    }

    #[test]
    fn 没有区分力的高频词在匹配式里就丢掉() {
        let (_d, _v, idx) = 装库(三篇);
        let conn = idx.conn();
        // 三篇正文里"的"出现在每一片，"副本"只在一篇里
        assert_eq!(
            匹配式(conn, "chunks_fts", "chunks", "的 副本")
                .unwrap()
                .unwrap(),
            "\"副本\"",
            "只留能区分的那个"
        );
        // 只剩一个词时不丢：没得挑，宁可给噪音也不要静默空手
        assert_eq!(
            匹配式(conn, "chunks_fts", "chunks", "的").unwrap().unwrap(),
            "\"的\""
        );
        // 兜底：一个都不剩时回到原样，绝不静默把查询清空
        assert_eq!(
            匹配式(conn, "chunks_fts", "chunks", "的 的")
                .unwrap()
                .unwrap(),
            "\"的\" OR \"的\""
        );
        assert!(匹配式(conn, "chunks_fts", "chunks", "   ")
            .unwrap()
            .is_none());
    }

    #[test]
    fn 没嵌过时退回关键词与链接并且说清为什么() {
        let (_d, v, idx) = 装库(三篇);
        let 结 = 混合或退回(&v, idx.conn(), "唯一副本").unwrap();
        assert!(!结.semantic);
        assert!(结.graph, "链接那一路不该因为没配模型就关掉");
        assert_eq!(结.hits.len(), 1, "关键词那一路照样要出结果");
        assert!(结.hits[0].path.ends_with("备份.md"));
        assert!(结.hint.unwrap().contains("没填嵌入模型名"));

        // 配了模型但一张向量表都没有 → 提示换一条，仍然不报错
        crate::ai::save(
            &v,
            &crate::ai::AiConfig {
                base_url: Some("http://127.0.0.1:4310/v1".into()),
                chat_model: None,
                embedding_model: Some("还没嵌的模型".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let 结2 = 混合或退回(&v, idx.conn(), "唯一副本").unwrap();
        assert!(!结2.semantic);
        assert!(结2.hint.unwrap().contains("还没嵌过"), "提示要指下一步");
        assert_eq!(结2.hits.len(), 1);
    }

    // ---- 图扩展那一路 -------------------------------------------------------

    /// 切片正文。用来证明"入链方向交的是提到它的那一块，不是对方笔记的开头"——
    /// 这件事光看条数看不出来。
    fn 切片正文(conn: &Connection, id: i64) -> String {
        conn.query_row("SELECT text FROM chunks WHERE id=?1", [id], |r| {
            r.get::<_, String>(0)
        })
        .unwrap_or_default()
    }

    /// 六篇：种子（正文有关键词、出链到「被链到」）+ 入链方（提及块在**第二节**，
    /// 所以它落在第二个切片里）+ 出链方 + 私密 + 视图 + 断链。
    const 链接图: &[(&str, &str)] = &[
        (
            "notes/种子.md",
            "---\nid: n-gra00001\ntitle: 种子\n---\n\n向量检索把文本变成可比较的数，顺手见 [[被链到]] 和 [[根本不存在的那一篇]]。\n",
        ),
        (
            "notes/提到它的.md",
            "---\nid: n-gra00002\ntitle: 提到它的\n---\n\n# 第一节\n\n这一节讲的是完全无关的爬山装备。\n\n# 第二节\n\n[[种子]] 那篇的说法我不同意。\n",
        ),
        (
            "notes/被链到.md",
            "---\nid: n-gra00003\ntitle: 被链到\n---\n\n被链到的首块讲的是备份目录留三十份。\n",
        ),
        (
            "notes/私密.md",
            "---\nid: n-gra00004\ntitle: 私密\nai:\n  private: true\n---\n\n[[种子]] 也被这篇提到。\n",
        ),
        (
            "views/看板.md",
            "---\nid: n-gra00005\ntitle: 看板\nview:\n  kind: smart\n  query: 向量检索\n---\n\n[[种子]] 被视图引用。\n",
        ),
        (
            "notes/断链.md",
            "---\nid: n-gra00006\ntitle: 断链\n---\n\n这里写着 [[根本不存在的那一篇]]。\n",
        ),
    ];

    #[test]
    fn 图路把邻居带回来而私密与视图与断链都不给() {
        let (_d, _v, idx) = 装库(链接图);
        let conn = idx.conn();
        let 种 = vec!["n-gra00001".to_string()];
        let 图 = 图路(conn, &种, 图配额).unwrap();
        let 篇: Vec<&str> = 图.iter().map(|(_, n)| n.as_str()).collect();
        assert_eq!(
            篇,
            vec!["n-gra00002", "n-gra00003"],
            "两篇都只被提一次，按切片号定先后（提到它的 先入库）：{篇:?}"
        );

        // 入链方向交的是**提到它的那一块**：那一句在第二节，不在首块。
        // （`chunks.text` 存的是解析后的正文，`[[种子]]` 到了这儿是"种子"两个字——
        // 所以判据用那一句独有的词，不去判写法）
        let 甲 = 切片正文(conn, 图[0].0);
        assert!(甲.contains("不同意"), "该是提及那一段：{甲}");
        assert!(!甲.contains("爬山"), "不该是对方笔记的开头：{甲}");
        // 出链方向没有"提及块"这回事（那块在种子身上），交对方首块
        assert!(切片正文(conn, 图[1].0).contains("备份目录"));
    }

    #[test]
    fn 一篇邻居只交一块而两个种子都到达时提及累加() {
        let 四篇 = [
            (
                "notes/种一.md",
                "---\nid: n-gra40001\ntitle: 种一\n---\n\n种一的正文有独有词 甲甲甲。\n",
            ),
            (
                "notes/种二.md",
                "---\nid: n-gra40002\ntitle: 种二\n---\n\n种二的正文有独有词 乙乙乙。\n",
            ),
            (
                "notes/共同提到.md",
                "---\nid: n-gra40003\ntitle: 共同提到\n---\n\n一边提 [[种一]] 一边提 [[种二]]。\n",
            ),
            (
                "notes/只提一种.md",
                "---\nid: n-gra40004\ntitle: 只提一种\n---\n\n只提 [[种一]]。\n",
            ),
        ];
        let (_d, _v, idx) = 装库(&四篇);
        let 种 = vec!["n-gra40001".to_string(), "n-gra40002".to_string()];
        let 图 = 图路(idx.conn(), &种, 图配额).unwrap();
        let 篇: Vec<&str> = 图.iter().map(|(_, n)| n.as_str()).collect();
        assert!(!篇.contains(&"n-gra40001"), "种子自己不作邻居：{篇:?}");
        assert!(!篇.contains(&"n-gra40002"), "同上：{篇:?}");
        assert_eq!(
            篇.iter().filter(|p| **p == "n-gra40003").count(),
            1,
            "两个种子都到达的那篇只交一块：{篇:?}"
        );
        assert_eq!(
            篇,
            vec!["n-gra40003", "n-gra40004"],
            "被两篇都提到的，该压过只被一篇提到的"
        );
    }

    /// 枢纽笔记的反面：一篇被很多篇提到时，该带回**提到它次数最多**的那几篇。
    /// 时间在这里不可信——导入进来的邻居 mtime 全在同一秒，按"最近更新"排等于按入库顺序排
    /// （合成库上就是这么把真邻居挤掉第一条评测题的，见 docs/04 §图扩展那一路）。
    #[test]
    fn 邻居按提及次数排而不是按入库顺序() {
        let 这组 = [
            (
                "notes/种子三.md",
                "---\nid: n-gra30001\ntitle: 种子三\n---\n\n这一篇的正文有独有词 甲甲甲。\n",
            ),
            (
                "notes/提一次但最新.md",
                "---\nid: n-gra30002\ntitle: 提一次但最新\n---\n\n提到 [[种子三]]。\n",
            ),
            (
                "notes/提两次.md",
                "---\nid: n-gra30003\ntitle: 提两次\n---\n\n先提一次 [[种子三]]。\n\n后来又提一次 [[种子三]]。\n",
            ),
        ];
        let (_d, _v, idx) = 装库(&这组);
        // 把"只提一次"那篇的更新时间推到最晚：时间赢不了次数
        idx.conn()
            .execute(
                "UPDATE notes SET updated_at=?1 WHERE id='n-gra30002'",
                [i64::MAX],
            )
            .unwrap();
        let 图 = 图路(idx.conn(), &["n-gra30001".into()], 图配额).unwrap();
        let 篇: Vec<&str> = 图.iter().map(|(_, n)| n.as_str()).collect();
        assert_eq!(
            篇[0], "n-gra30003",
            "提两次的该压过时间最靠前的那篇：{篇:?}"
        );
    }

    #[test]
    fn 配额与每方向上限都收得住() {
        let (_d, _v, idx) = 装库(链接图);
        // 配额给 1 就该停在第一个（入链那一篇），不是把整张图跑完再截
        let 少 = 图路(idx.conn(), &["n-gra00001".into()], 1).unwrap();
        assert_eq!(少.len(), 1);
        assert_eq!(少[0].1, "n-gra00002");

        // 五个邻居都只链向种子 → 每方向上限（3）才是真闸：种子多也带不多
        // （`多的` 必须声明在 `篇` 之前：篇 里的 &str 指着它，反了就是 drop 顺序错）
        let 多的: Vec<(String, String)> = (1..=5)
            .map(|i| {
                (
                    format!("notes/链入{i}.md"),
                    format!(
                        "---\nid: n-gra1000{i}\ntitle: 链入{i}\n---\n\n都提到 [[种子]] 这一篇。\n"
                    ),
                )
            })
            .collect();
        let 多的引: Vec<(&str, &str)> = 多的
            .iter()
            .map(|(路径, 内容)| (路径.as_str(), 内容.as_str()))
            .collect();
        let 篇: Vec<(&str, &str)> = {
            let mut v: Vec<(&str, &str)> = 链接图.to_vec();
            v.extend(多的引.iter().map(|(路径, 内容)| (*路径, *内容)));
            v
        };
        let (_d2, _v2, idx2) = 装库(&篇);
        let 图 = 图路(idx2.conn(), &["n-gra00001".into()], 图配额).unwrap();
        assert_eq!(
            图.len(),
            每方向上限 as usize + 1,
            "入链被每方向上限拦住，出链那一条照常：{:?}",
            图.iter().map(|(_, n)| n).collect::<Vec<_>>()
        );
    }

    #[test]
    fn 种子按最好名次去重而跨路比名次不比分数() {
        let 关键词 = [n(1, "甲"), n(2, "乙"), n(3, "甲")];
        let 语义 = [n(9, "丙"), n(8, "甲")];
        // 甲 在关键词第 1（名次 0）→ 排最前；丙 在语义第 1（名次 0，档 1）→ 第二；
        // 乙 最好名次是 1 → 第三。同名次时关键词那一路在前。
        assert_eq!(种子(&关键词, &语义, 8), vec!["甲", "丙", "乙"]);
        assert_eq!(种子(&关键词, &语义, 2), vec!["甲", "丙"], "上限是真的闸");
        assert!(种子(&[], &[], 8).is_empty());
    }

    #[test]
    fn 走了哪几路那句话只有一份() {
        assert_eq!(走了哪几路(&[路::Keyword]), "关键词");
        assert_eq!(走了哪几路(&[路::Keyword, 路::Graph]), "关键词 + 链接");
        assert_eq!(走了哪几路(&[路::Keyword, 路::Semantic]), "关键词 + 语义");
        assert_eq!(走了哪几路(&三路), "关键词 + 链接 + 语义");
        // 顺序由 三路 那张表定：调用方给乱序，屏幕上那句话也一样
        assert_eq!(
            走了哪几路(&[路::Semantic, 路::Graph, 路::Keyword]),
            "关键词 + 链接 + 语义"
        );
        // 每档路的名字只有一份定义：CLI、评测、审计、界面都读 显示名
        assert_eq!(路::Graph.显示名(), "链接");
        assert_eq!(路::Keyword.显示名(), "关键词");
        assert_eq!(路::Semantic.显示名(), "语义");
    }

    /// 这一条是**这一档的存在理由**：有一篇笔记正文里一个查询词都没有，只因为
    /// 它提到了命中那一篇，就该被带回来。摘掉图扩展那一路它就回不来——
    /// 所以 `评测 --no-graph` 的对照数不是仪式，是这一条在评测集盘上的版本。
    #[test]
    fn 关键词搜不到的那一篇靠链接回得来() {
        let 两篇 = &[
            (
                "notes/甲.md",
                "---\nid: n-gra20001\ntitle: 检索口径\n---\n\n向量检索把文本变成可比较的数。\n",
            ),
            (
                "notes/乙.md",
                "---\nid: n-gra20002\ntitle: 读后\n---\n\n[[检索口径]] 那条我记在这儿：周末去爬山带两瓶水。\n",
            ),
        ];
        let (_d, v, idx) = 装库(两篇);
        let 关 = 关键词路(idx.conn(), "爬山 瓶子", 30).unwrap();
        assert_eq!(关.len(), 1, "查询词只在乙的正文里，命中的该是它自己");
        assert_eq!(关[0].1, "n-gra20002");

        // 换个问法：词只在甲里出现过，而"旁边记了一笔"的那篇该被带回来
        let 结 = 混合或退回(&v, idx.conn(), "向量检索").unwrap();
        let 篇: Vec<&str> = 结.hits.iter().map(|h| h.note_id.as_str()).collect();
        assert!(
            篇.contains(&"n-gra20002"),
            "链接那一路该把邻居带进来：{篇:?}"
        );
        let 乙 = 结.hits.iter().find(|h| h.note_id == "n-gra20002").unwrap();
        assert_eq!(
            乙.from,
            vec![路::Graph],
            "它是**只靠链接**回来的：{:?}",
            乙.from
        );

        let 对照 = 无图对照(&v, idx.conn(), "向量检索").unwrap();
        assert!(
            !对照.hits.iter().any(|h| h.note_id == "n-gra20002"),
            "摘掉这一路它就不在——增益是量出来的不是说的"
        );
        assert!(!对照.graph);
    }

    #[test]
    fn 图扩展开没开要落在成绩里() {
        let (_d, v, idx) = 装库(链接图);
        let 套 = 读套件(
            r#"
[[q]]
q = "向量检索"
expect_paths = ["notes/提到它的.md"]
"#,
        )
        .unwrap();
        let 开 = 评测(&v, idx.conn(), &套, 8, 常规).unwrap();
        assert!(开.graph, "成绩要写清这一轮开着哪一路");
        assert_eq!(
            开.hits, 1,
            "只靠链接可达的那一篇，开着图扩展就该召回：{:?}",
            开.misses
        );
        let 关 = 评测(&v, idx.conn(), &套, 8, 对照无图).unwrap();
        assert!(!关.graph);
        assert_eq!(
            关.hits, 0,
            "对照档里这一条必须漏，否则说明题目本身关键词就能答"
        );
    }

    /// 重排开关的两态之一：**没配对话模型时不许把整趟搜索打挂**，也不许静默——
    /// 顺序退回 RRF，原因写进 hint。（真打模型那一趟由假端点在真机那一轮演）
    #[test]
    fn 开了重排但没填对话模型就退回名次并且说清() {
        let (_d, v, idx) = 装库(三篇);
        crate::ai::save(
            &v,
            &crate::ai::AiConfig {
                base_url: Some("http://127.0.0.1:4310/v1".into()),
                chat_model: None,
                embedding_model: None,
                rerank: true,
            },
        )
        .unwrap();
        let 结 = 混合或退回(&v, idx.conn(), "唯一副本").unwrap();
        assert!(!结.reranked);
        assert_eq!(
            结.rerank_in + 结.rerank_out,
            0,
            "一次网络都没打，token 记 0"
        );
        assert_eq!(结.hits.len(), 1, "开关配不齐不该把手里的结果一起扔掉");
        let 提 = 结.hint.unwrap();
        assert!(提.contains("开了重排但没填对话模型"), "{提}");
        assert!(提.contains("没填嵌入模型名"), "两句都该在：{提}");
    }

    #[test]
    fn 套件的自相矛盾在读的时候就挡掉() {
        assert!(读套件("").is_err(), "空套件");
        assert!(读套件("not toml = = 1").is_err(), "坏 TOML");
        let 错 = 读套件(
            r#"
[[q]]
q = "甲"
expect_none = true
expect_paths = ["notes/甲.md"]
"#,
        )
        .unwrap_err()
        .to_string();
        assert!(错.contains("判不了对错"), "{错}");
        let 错2 = 读套件(
            r#"
[[q]]
q = "乙"
"#,
        )
        .unwrap_err()
        .to_string();
        assert!(错2.contains("没给期望路径"), "{错2}");
    }

    #[test]
    fn 仓库里那份评测集本身是能跑的() {
        let 套 = 读套件(include_str!("../../../testdata/eval/v1.toml")).unwrap();
        assert!(套.len() >= 20, "v1 要 20 条，实际 {}", 套.len());
        let 负 = 套.iter().filter(|x| x.expect_none).count();
        assert!(负 >= 4, "负样本（该拒答的）不能少于 4 条，实际 {负}");
        // 每条正样本期望的路径都得在语料里存在——否则评测永远"漏"，而没人怀疑是套件写错了
        let 语料 = include_str!("../../../testdata/eval/corpus.list");
        for 题 in 套.iter().filter(|x| !x.expect_none) {
            for p in &题.expect_paths {
                assert!(
                    语料.lines().any(|l| l.trim() == p.as_str()),
                    "「{}」期望 {}，可语料里没有这一篇",
                    题.q,
                    p
                );
            }
        }
    }
}
