//! 混合召回：关键词路（`chunks_fts` BM25）+ 语义路（`vec_<model>` KNN）→ 去重 →
//! 单篇配额 → RRF 合并。口径在 docs/04 §混合检索与问答，这里落地前两路。
//!
//! 三条不显然的：
//!
//! 1. **合并用的是名次而不是分数**。BM25 与余弦距离不同量纲、不同方向（一个越大越好、
//!    一个越小越好），把它们加权平均是在拿苹果加橘子；RRF 只看"你在自己那一排里第几"，
//!    两路谁挂了也不影响另一路出结果。
//! 2. **单篇配额是防一篇长文垄断结果**（docs/04：每篇最多 4 块）。没有这一步，3000 块
//!    那篇夹具能同时占掉关键词与语义两路的前茅，界面上看着就是"搜来搜去都是它"。
//! 3. **隐私过滤在两条路的 SQL 里各写一遍**（同 `search_keyword`）。视图文件也不进——
//!    它是查询定义，不是知识内容。

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

use crate::{Error, Result};

/// 每一路取回多少候选（docs/04 §召回 的配额）。
pub const 每路配额: usize = 30;
/// 合并后同一篇笔记最多贡献几块。
pub const 每篇配额: usize = 4;
/// RRF 的平滑常数。60 是原论文的经验值，也是各家实现事实上的默认——不在这儿调参，
/// 调它属于"评测集标定"那一步的活（docs/04 §评测集）。
const RRF_K: f64 = 60.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum 路 {
    Keyword,
    Semantic,
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
    /// 这条是被哪几路捞上来的。两路都命中是最强的信号，界面上要说得出来
    pub from: Vec<路>,
    pub rrf: f64,
}

/// 纯函数：两路各自的有序 chunk_id（附 note_id 用于配额）→ RRF 合并后的有序结果。
///
/// 判据全部可测，不打网络也不碰 SQLite——所以"配额把谁挤掉了""两路都命中排第一"
/// 这类事是被用例钉住的，不是看真机顺不顺眼。
pub fn 合并(
    关键词: &[(i64, String)],
    语义: &[(i64, String)],
    每篇: usize,
    输出: usize,
) -> Vec<(i64, f64, Vec<路>)> {
    let mut 分: std::collections::BTreeMap<i64, (f64, Vec<路>, String)> = Default::default();
    for (路名, 列) in [(路::Keyword, 关键词), (路::Semantic, 语义)] {
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

/// 一趟完整的混合检索：查询 → （一次网络）嵌入 → 两路 → 合并。
/// **含网络往返，别放在同步命令里**（G6 的 8ms 是给本地查询的，docs/03 §后端调用纪律）。
pub fn 混合(vault: &crate::vault::Vault, conn: &Connection, query: &str) -> Result<Vec<命中>> {
    let cfg = crate::ai::load(vault)?;
    let 模型 = cfg
        .embedding_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::Invalid("没填嵌入模型名，语义那一路走不了".into()))?;
    let 关键 = 关键词路(conn, query, 每路配额)?;
    let 向量 = crate::ai::embed(&cfg, &[query.to_string()])?;
    let 语义 = 语义路(conn, 模型, &向量[0], 每路配额)?;
    let 排 = 合并(&关键, &语义, 每篇配额, 每路配额);
    取详情(conn, &排)
}

/// 界面要的那一份：**没配模型 / 还没嵌过**时退回只走关键词，并说清为什么；
/// **配了但连不上**不退回——那是"试过了，失败"，混进"这一路没开"就是把错误吞成状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct 检索结果 {
    pub hits: Vec<命中>,
    pub semantic: bool,
    pub hint: Option<String>,
}

pub fn 混合或退回(
    vault: &crate::vault::Vault,
    conn: &Connection,
    query: &str,
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
    let (语, 提示) = match (&模型, 表在) {
        (None, _) => (
            Vec::new(),
            Some("没填嵌入模型名，这一趟只有关键词那一路。设置里填好再嵌一次。".into()),
        ),
        (Some(_), false) => (
            Vec::new(),
            Some(
                "还没嵌过向量，这一趟只有关键词那一路。跑 `note ai embed`，或在设置里点嵌入。"
                    .into(),
            ),
        ),
        (Some(m), true) => {
            // 这一支不兜底：连不上就报错，别把失败说成"没开"
            let v = crate::ai::embed(&cfg, &[query.to_string()])?;
            (语义路(conn, m, &v[0], 每路配额)?, None)
        }
    };
    let 排 = 合并(&关键, &语, 每篇配额, 每路配额);
    Ok(检索结果 {
        hits: 取详情(conn, &排)?,
        semantic: 表在 && 模型.is_some(),
        hint: 提示,
    })
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
    pub k: usize,
}

/// 跑一遍评测集。配了嵌入模型且有向量表 → 走混合；否则退回只量关键词那一路。
pub fn 评测(
    vault: &crate::vault::Vault,
    conn: &Connection,
    套件: &[问题],
    k: usize,
) -> Result<成绩> {
    let cfg = crate::ai::load(vault)?;
    let 模型 = cfg
        .embedding_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let 语义路开 = match &模型 {
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
    let mut 正 = 0;
    let mut 负 = 0;
    let mut 命中数 = 0;
    let mut 误给 = Vec::new();
    let mut 漏 = Vec::new();
    for 题 in 套件 {
        let 关 = 关键词路(conn, &题.q, 每路配额)?;
        let 语 = if 语义路开 {
            let v = crate::ai::embed(&cfg, std::slice::from_ref(&题.q))
                .map_err(|e| Error::Invalid(format!("评测里嵌查询失败：{e}")))?;
            语义路(conn, 模型.as_deref().unwrap_or(""), &v[0], 每路配额)?
        } else {
            Vec::new()
        };
        let 排 = 合并(&关, &语, 每篇配额, 每路配额);
        let 详情 = 取详情(conn, &排)?;
        let 前: Vec<&str> = 详情.iter().take(k).map(|h| h.path.as_str()).collect();
        if 题.expect_none {
            负 += 1;
            if let Some(首) = 详情.first() {
                // 报的是"进了候选"与它的分数，不是"错了"：阈值还没标定之前，
                // 把这个当失败计数会让人去改召回，而该改的是答案层的门
                let 来源 = 首
                    .from
                    .iter()
                    .map(|r| match r {
                        路::Keyword => "关键词",
                        路::Semantic => "语义",
                    })
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
        semantic: 语义路开,
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
        let 排 = 合并(&[n(1, "A"), n(2, "B")], &[n(3, "C")], 4, 10);
        assert_eq!(只id(&排), vec![1, 3, 2]);
    }

    #[test]
    fn 单篇配额把垄断的长文挤下去() {
        let 长: Vec<(i64, String)> = (1..=8).map(|i| n(i, "长文")).collect();
        let 排 = 合并(&长, &[], 4, 10);
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
            2,
            10,
        );
        assert_eq!(只id(&混), vec![1, 2, 5]);
    }

    #[test]
    fn 输出条数封顶() {
        let a: Vec<(i64, String)> = (1..=20).map(|i| ns(i, format!("篇{i}"))).collect();
        assert_eq!(合并(&a, &[], 4, 6).len(), 6);
    }

    #[test]
    fn 两路都空就是空结果不报错() {
        assert!(合并(&[], &[], 4, 10).is_empty());
    }

    #[test]
    fn 同分按切片号排所以可重现() {
        let 排 = 合并(&[n(7, "A")], &[n(3, "B")], 4, 10);
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

        let 排 = 合并(&关, &语, 4, 10);
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

    #[test]
    fn 没填模型名就说不填而不是搜出半套() {
        let dir = tempfile::tempdir().unwrap();
        let v = crate::vault::Vault::open(dir.path()).unwrap();
        let idx = crate::index::Index::open(&v).unwrap();
        let 错 = 混合(&v, idx.conn(), "随便问问").unwrap_err().to_string();
        assert!(错.contains("嵌入模型"), "{错}");
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
    fn 没模型时评测量的是关键词那一路并且说实话() {
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
        let 成 = 评测(&v, idx.conn(), &套, 8).unwrap();
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
        let 成 = 评测(&v, idx.conn(), &套, 8).unwrap();
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
    fn 没嵌过时退回关键词那一路并且说清为什么() {
        let (_d, v, idx) = 装库(三篇);
        let 结 = 混合或退回(&v, idx.conn(), "唯一副本").unwrap();
        assert!(!结.semantic);
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
            },
        )
        .unwrap();
        let 结2 = 混合或退回(&v, idx.conn(), "唯一副本").unwrap();
        assert!(!结2.semantic);
        assert!(结2.hint.unwrap().contains("还没嵌过"), "提示要指下一步");
        assert_eq!(结2.hits.len(), 1);
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
