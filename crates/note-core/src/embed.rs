//! 嵌入落库：`chunks` → 向量 → `vec_<model>` 虚拟表 + `embeddings` 登记行。
//!
//! 四条规矩，改这个文件之前先读完：
//!
//! 1. **永远不在写路径上打网络**（G6 的 8ms）。这里没有一处被 `index_file` 调过——
//!    只有显式的 `note ai embed`（以及将来的后台任务）会走。把嵌入塞进保存路径，
//!    等于让"打字"依赖一个云端 API 的可用性。
//! 2. **vec 表的 rowid 与 `chunks.id` 对齐**（docs/02 §派生表）。虚拟表不参与外键级联，
//!    所以删块时的清理仍由 `index::purge_children` 负责；`embeddings` 那张普通表
//!    靠 `ON DELETE CASCADE` 跟着走。
//! 3. **隐私位在源头就挡住**：`ai_private` / `no_ai` 的笔记**根本不嵌**。docs/04 那条硬门
//!    说的是"别进 AI 上下文"，而把字节发给云端 API 比进上下文更不可逆——只在召回时过滤，
//!    等于"已经发出去了，只是不显示给你看"。
//! 4. **换模型 = 建新表 + 全量重嵌**（docs/02 §派生表注释）。旧表**不猜着删**：
//!    删它是在花用户的 token 重做一遍，留给一条要点名的命令（`--prune`，还没做）。

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::hash::content_hash_str;
use crate::{Error, Result};

/// 一批送多少个切片。OpenAI 的 `input` 数组没有统一上限（各家网关从 16 到 2048 都有），
/// 64 是"够摊薄一次往返、又不至于被最严的网关整批拒掉"的折中。整批失败就报错，
/// **不许悄悄退回逐条重试**——那会把一次限流变成 64 次，还会把顺序问题藏起来。
pub const 批量: usize = 64;

/// 模型名 → vec 表名。
///
/// 表名要拼进 SQL 文本（虚拟表名不能走占位符），所以字符集先收窄到 `[a-z0-9_]`；
/// 再挂一段模型名的 hash：**`gpt-4` 与 `gpt_4` 归一后是同一个串**，撞进同一张表的话，
/// 两种模型的向量就混在一起，KNN 回来的距离不再有任何意义——而这件事不会报错。
pub fn 表名(模型: &str) -> String {
    let 净: String = 模型
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    let 瘦 = 净.trim_matches('_');
    let 瘦 = if 瘦.len() > 40 { &瘦[..40] } else { 瘦 };
    let 尾 = &content_hash_str(模型)[..6];
    format!("vec_{瘦}_{尾}")
}

/// f32 序列 → 小端字节。sqlite-vec 收的就是这个形状（docs/02 §派生表）。
pub fn 小端(向量: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(向量.len() * 4);
    for v in 向量 {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

fn 表在不在(conn: &Connection, 表: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
        [表],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// 这个模型登记过的维度（`embeddings` 是我们自己的账本，比去问虚拟表准）。
pub fn 已登记维度(conn: &Connection, 模型: &str) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT dims FROM embeddings WHERE model=?1 LIMIT 1",
            [模型],
            |r| r.get::<_, i64>(0),
        )
        .ok())
}

/// 建出（或认出）这个模型的 vec 表。**维度对不上直接报错**：往 384 维的表里插 1536 维，
/// 每次插入都会失败，而错误回上来时没人会想到根因是"换了模型没换表"。
pub fn 建表(conn: &Connection, 模型: &str, dims: usize) -> Result<String> {
    if dims == 0 {
        return Err(Error::Invalid("向量维度是 0，这个模型的回包不对".into()));
    }
    let 表 = 表名(模型);
    if 表在不在(conn, &表)? {
        if let Some(有的) = 已登记维度(conn, 模型)? {
            if 有的 as usize != dims {
                return Err(Error::Invalid(format!(
                    "模型 {模型} 之前登记的是 {有的} 维，这次回的是 {dims} 维——同一张表装不下两种维度，先确认模型名填对没有"
                )));
            }
        }
        return Ok(表);
    }
    // cosine：文本嵌入的事实标准距离，且与向量的长度无关（用户换一个归一化习惯不同的
    // 模型时，L2 的分数分布会整体漂移，而阈值是评测集标出来的）
    conn.execute_batch(&format!(
        "CREATE VIRTUAL TABLE {表} USING vec0(embedding float[{dims}] distance_metric=cosine)"
    ))?;
    Ok(表)
}

/// 还有哪些切片没嵌过。**隐私过滤在这里，不在召回那里**（见模块头第 3 条）。
pub fn 待嵌(conn: &Connection, 模型: &str, 批量上限: usize) -> Result<Vec<(i64, String)>> {
    let mut s = conn.prepare(
        "SELECT c.id, c.text
         FROM chunks c
         JOIN notes n ON n.id = c.note_id
         LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.model = ?1
         WHERE e.chunk_id IS NULL
           AND n.ai_private = 0 AND n.no_ai = 0
           AND n.note_kind <> 'view'
         ORDER BY c.id
         LIMIT ?2",
    )?;
    let rows = s.query_map(params![模型, 批量上限 as i64], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    })?;
    Ok(rows.filter_map(|x| x.ok()).collect())
}

/// 进度。**DTO 的字段名一律英文**：`#[serde(rename_all)]` 碰到中文字段名会在字符边界上
/// 切片、derive 阶段直接 panic（`ai::Step` 那条注释记的是同一个坑的第二次）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct 进度 {
    pub model: String,
    pub table: String,
    /// 可以嵌但还没嵌的（隐私位与视图已排除）
    pub pending: i64,
    pub embedded: i64,
    /// 因为隐私位或视图身份**永远不会**被嵌的切片数。不报这个数，"pending + embedded ≠ 全部"
    /// 就成了一笔对不上的账
    pub excluded: i64,
}

pub fn 进度of(conn: &Connection, 模型: &str) -> Result<进度> {
    let 待嵌: i64 = conn.query_row(
        "SELECT count(*) FROM chunks c JOIN notes n ON n.id=c.note_id
         LEFT JOIN embeddings e ON e.chunk_id=c.id AND e.model=?1
         WHERE e.chunk_id IS NULL AND n.ai_private=0 AND n.no_ai=0 AND n.note_kind<>'view'",
        [模型],
        |r| r.get(0),
    )?;
    let 已嵌: i64 = conn.query_row(
        "SELECT count(*) FROM embeddings e JOIN chunks c ON c.id=e.chunk_id WHERE e.model=?1",
        [模型],
        |r| r.get(0),
    )?;
    let 不收: i64 = conn.query_row(
        "SELECT count(*) FROM chunks c JOIN notes n ON n.id=c.note_id
         WHERE n.ai_private=1 OR n.no_ai=1 OR n.note_kind='view'",
        [],
        |r| r.get(0),
    )?;
    Ok(进度 {
        model: 模型.into(),
        table: 表名(模型),
        pending: 待嵌,
        embedded: 已嵌,
        excluded: 不收,
    })
}

/// 写一批向量。`行` 是 `(chunk_id, 向量)`。**同一批里维度必须一致**：不一致说明
/// 客户端或网关把顺序打乱了，那比报错更坏的是让它安静落库。
pub fn 写入(
    conn: &Connection, 模型: &str, 表: &str, 行: &[(i64, Vec<f32>)]
) -> Result<usize> {
    let 时候 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut n = 0;
    for (id, v) in 行 {
        // **先删后插**，不用 `INSERT OR REPLACE`：vec0 是虚拟表，REPLACE 那条路径它没实现，
        // 重嵌同一个切片会直接 `UNIQUE constraint failed on vec_… primary key`（真跑出来的）
        conn.execute(&format!("DELETE FROM {表} WHERE rowid=?1"), [id])?;
        conn.execute(
            &format!("INSERT INTO {表}(rowid, embedding) VALUES(?1,?2)"),
            params![id, 小端(v)],
        )?;
        conn.execute(
            "INSERT INTO embeddings(chunk_id,model,dims,embedded_at) VALUES(?1,?2,?3,?4)
             ON CONFLICT(chunk_id,model) DO UPDATE SET dims=excluded.dims, embedded_at=excluded.embedded_at",
            params![id, 模型, v.len() as i64, 时候],
        )?;
        n += 1;
    }
    Ok(n)
}

/// KNN。返回 `(chunk_id, 距离)`，距离越小越像。
pub fn 最近(conn: &Connection, 表: &str, 查询: &[f32], k: usize) -> Result<Vec<(i64, f64)>> {
    let mut s = conn.prepare(&format!(
        "SELECT rowid, distance FROM {表} WHERE embedding MATCH ?1 AND k = ?2 ORDER BY distance"
    ))?;
    let rows = s.query_map(params![小端(查询), k as i64], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?))
    })?;
    Ok(rows.filter_map(|x| x.ok()).collect())
}

/// 一轮补齐的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct 补齐报告 {
    pub model: String,
    pub table: String,
    /// 这一轮嵌进去多少切片
    pub embedded: usize,
    pub batches: usize,
    /// 还剩多少（隐私与视图那部分永远不在这里，另算在 `excluded`）
    pub pending: i64,
    pub excluded: i64,
}

/// 把没嵌过的切片一批批送去嵌。**只在显式命令与后台任务里调**（模块头第 1 条）。
///
/// 失败即中止并报错：`ai::embed` 那条判据保证"半批不落库"，而已经落库的批次保留——
/// 下次再跑从 `待嵌` 继续，所以这条命令天然可续，不需要断点记录。
pub fn 补齐(
    vault: &crate::vault::Vault,
    conn: &Connection,
    上限: Option<usize>,
) -> Result<补齐报告> {
    let cfg = crate::ai::load(vault)?;
    let 模型 = cfg
        .embedding_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Error::Invalid(
                "没填嵌入模型名。设置里把「嵌入模型」填上再嵌——不猜默认模型名，猜错会白烧一遍 token"
                    .into(),
            )
        })?;
    let mut 嵌了 = 0usize;
    let mut 批次 = 0usize;
    loop {
        let 剩 = 上限.map(|u| u.saturating_sub(嵌了)).unwrap_or(批量);
        if 剩 == 0 {
            break;
        }
        let 批 = 待嵌(conn, 模型, 批量.min(剩))?;
        if 批.is_empty() {
            break;
        }
        let 文本: Vec<String> = 批.iter().map(|(_, t)| t.clone()).collect();
        let 向量 = crate::ai::embed(&cfg, &文本)?;
        if 向量.len() != 批.len() {
            return Err(Error::Invalid(format!(
                "嵌入回包条数与送出去的不符（{} vs {}），这批不落库",
                向量.len(),
                批.len()
            )));
        }
        let 表 = 建表(conn, 模型, 向量[0].len())?;
        let 行: Vec<(i64, Vec<f32>)> = 批.iter().zip(向量).map(|((id, _), v)| (*id, v)).collect();
        写入(conn, 模型, &表, &行)?;
        嵌了 += 行.len();
        批次 += 1;
    }
    let 进 = 进度of(conn, 模型)?;
    Ok(补齐报告 {
        model: 模型.into(),
        table: 进.table,
        embedded: 嵌了,
        batches: 批次,
        pending: 进.pending,
        excluded: 进.excluded,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn 建好() -> Connection {
        // **注册必须在开连接之前**：`sqlite3_auto_extension` 只对之后新建的连接生效，
        // 先 open 再注册的结果是"no such module: vec0"（这条顺序在 Index::open_path 里
        // 也是同一个前提，只是那里不容易踩到）
        crate::index::注册向量扩展();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema::SCHEMA).unwrap();
        conn.execute("PRAGMA foreign_keys=ON", []).unwrap();
        conn
    }

    /// `chunks.id` 是 INTEGER 主键（vec 表按 rowid 对齐，只能用它），所以切片号显式给。
    /// `chunks.start_block/end_block` 是指向 `blocks` 的外键，FK 开着时必须先有块。
    fn 塞切片(
        conn: &Connection, 笔记: &str, 路径: &str, 隐私: i64, 种类: &str, 片号: i64
    ) {
        conn.execute(
            "INSERT INTO notes(id,path,title,ai_private,no_ai,note_kind,content_hash) VALUES(?1,?2,'题',?3,0,?4,'h')",
            params![笔记, 路径, 隐私, 种类],
        )
        .unwrap();
        let 块 = format!("{笔记}#b1");
        conn.execute(
            "INSERT INTO blocks(id,note_id,ordinal,type,markdown,text) VALUES(?1,?2,0,'paragraph','正文','正文')",
            params![块, 笔记],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunks(id,note_id,start_block,end_block,text,source_hash) VALUES(?1,?2,?3,?3,'正文','h')",
            params![片号, 笔记, 块],
        )
        .unwrap();
    }

    /// 只造一篇公开笔记 + 若干切片，给 KNN 那类用例当骨架
    fn 塞几片(conn: &Connection, 片号: &[i64]) {
        let 首 = *片号.first().unwrap();
        塞切片(conn, "n-k", "notes/框.md", 0, "note", 首);
        let 块 = "n-k#b1";
        for p in &片号[1..] {
            conn.execute(
                "INSERT INTO chunks(id,note_id,start_block,end_block,text,source_hash) VALUES(?1,'n-k',?2,?2,'正文','h')",
                params![p, 块],
            )
            .unwrap();
        }
    }

    #[test]
    fn 表名稳定且不同模型不撞() {
        assert_eq!(表名("bge-m3"), 表名("bge-m3"));
        assert_ne!(
            表名("gpt-4"),
            表名("gpt_4"),
            "归一后是同一个串，撞表等于两种模型的向量混在一起"
        );
        assert_ne!(
            表名("text-embedding-3-small"),
            表名("text-embedding-3-large")
        );
        assert!(表名("very/long/model/name-with-dashes-and-more").starts_with("vec_"));
        assert!(
            表名("甲乙丙")
                .chars()
                .all(|c| c == '_' || c.is_ascii_alphanumeric()),
            "表名只能是安全字符"
        );
    }

    #[test]
    fn 小端换算与维度对得上() {
        let b = 小端(&[1.0, -2.5]);
        assert_eq!(b.len(), 8);
        assert_eq!(b, vec![0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x20, 0xc0]);
        assert!(小端(&[]).is_empty());
    }

    #[test]
    fn 建表认得已有维度也不许两种维度混() {
        let conn = 建好();
        塞切片(&conn, "n-x", "notes/x.md", 0, "note", 1);
        let 表 = 建表(&conn, "m1", 4).unwrap();
        assert_eq!(表, 表名("m1"));
        assert_eq!(建表(&conn, "m1", 4).unwrap(), 表, "再建一次该认出已有表");
        写入(&conn, "m1", &表, &[(1, vec![0.0, 0.0, 0.0, 1.0])]).unwrap();
        assert_eq!(已登记维度(&conn, "m1").unwrap(), Some(4));
        let 错 = 建表(&conn, "m1", 8).unwrap_err().to_string();
        assert!(
            错.contains("4 维") && 错.contains("8 维"),
            "要说清两个数: {错}"
        );
        assert!(建表(&conn, "m2", 0).is_err(), "0 维不是合法向量");
    }

    #[test]
    fn knn_按余弦距离排且回的是块号() {
        let conn = 建好();
        塞几片(&conn, &[10, 20, 30]);
        let 表 = 建表(&conn, "mm", 2).unwrap();
        写入(
            &conn,
            "mm",
            &表,
            &[
                (10, vec![1.0, 0.0]),
                (20, vec![0.7, 0.7]),
                (30, vec![0.0, 1.0]),
            ],
        )
        .unwrap();
        let 近 = 最近(&conn, &表, &[1.0, 0.0], 2).unwrap();
        assert_eq!(近.len(), 2);
        assert_eq!(近[0].0, 10, "同方向的该排第一");
        assert_eq!(近[1].0, 20);
        assert!(近[0].1 <= 近[1].1, "距离要单调: {近:?}");
        // k 比行数大不能报错，也不能返回不存在的行
        assert_eq!(最近(&conn, &表, &[1.0, 0.0], 99).unwrap().len(), 3);
    }

    #[test]
    fn 待嵌在源头就排除隐私笔记与视图() {
        let conn = 建好();
        塞切片(&conn, "n-pub", "notes/公.md", 0, "note", 101);
        塞切片(&conn, "n-priv", "notes/私.md", 1, "note", 102);
        塞切片(&conn, "n-view", "views/看板.md", 0, "view", 103);
        let 待 = 待嵌(&conn, "mm", 10).unwrap();
        assert_eq!(
            待.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            vec![101],
            "只有公开那篇的切片该被送去嵌——发出去的字节收不回来"
        );
        let 进 = 进度of(&conn, "mm").unwrap();
        assert_eq!(进.pending, 1);
        assert_eq!(进.embedded, 0);
        assert_eq!(进.excluded, 2, "隐私那篇与视图那篇都算'永远不会嵌'");
    }

    #[test]
    fn 嵌过的不再出现而换模型要重来() {
        let conn = 建好();
        塞切片(&conn, "n-a", "notes/甲.md", 0, "note", 7);
        let 表 = 建表(&conn, "m1", 2).unwrap();
        写入(&conn, "m1", &表, &[(7, vec![1.0, 0.0])]).unwrap();
        assert!(待嵌(&conn, "m1", 10).unwrap().is_empty(), "m1 已经嵌过");
        assert_eq!(待嵌(&conn, "m2", 10).unwrap().len(), 1, "换模型 = 全量重嵌");
        // 重嵌同一块不该攒出第二行（主键是 (chunk_id, model)），也不该在 vec 表里留两份
        写入(&conn, "m1", &表, &[(7, vec![0.0, 1.0])]).unwrap();
        let 行: i64 = conn
            .query_row("SELECT count(*) FROM embeddings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(行, 1);
        let 在表里: i64 = conn
            .query_row(
                &format!("SELECT count(*) FROM {表} WHERE rowid=7"),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(在表里, 1, "重嵌是覆盖不是叠加，否则 KNN 会把同一块数两次");
        assert_eq!(
            最近(&conn, &表, &[0.0, 1.0], 1).unwrap()[0].0,
            7,
            "新向量该顶掉旧的"
        );
    }

    #[test]
    fn 没填模型名就不嵌也不烧_token() {
        let dir = tempfile::tempdir().unwrap();
        let v = crate::vault::Vault::open(dir.path()).unwrap();
        let 错 = 补齐(&v, &建好(), None).unwrap_err().to_string();
        assert!(错.contains("嵌入模型"), "要说清缺哪一格: {错}");
        assert!(错.contains("不猜"), "要说出为什么不猜: {错}");
    }

    #[test]
    fn 连不上时报的是那一跳而不是静默零进度() {
        let dir = tempfile::tempdir().unwrap();
        let v = crate::vault::Vault::open(dir.path()).unwrap();
        crate::ai::save(
            &v,
            &crate::ai::AiConfig {
                base_url: Some("http://127.0.0.1:9/v1".into()),
                chat_model: None,
                embedding_model: Some("没人听的模型".into()),
            },
        )
        .unwrap();
        let conn = 建好();
        塞切片(&conn, "n-c", "notes/丙.md", 0, "note", 21);
        let 错 = 补齐(&v, &conn, None).unwrap_err().to_string();
        assert!(错.contains("连不上"), "{错}");
        assert_eq!(
            进度of(&conn, "没人听的模型").unwrap().embedded,
            0,
            "一批都没成"
        );
    }

    #[test]
    fn 删了块账本跟着走而虚拟表不会() {
        let conn = 建好();
        塞切片(&conn, "n-b", "notes/乙.md", 0, "note", 9);
        let 表 = 建表(&conn, "m3", 2).unwrap();
        写入(&conn, "m3", &表, &[(9, vec![1.0, 1.0])]).unwrap();
        conn.execute("DELETE FROM notes WHERE id='n-b'", [])
            .unwrap();
        let 账: i64 = conn
            .query_row(
                "SELECT count(*) FROM embeddings WHERE chunk_id=9",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(账, 0, "embeddings 靠 ON DELETE CASCADE 跟着删");
        // vec 是虚拟表、不参与级联。这条断言钉的是"我们知道它留着"——
        // 真正清它的是 index::purge_children（那边有索引层的用例）
        let 留: i64 = conn
            .query_row(
                &format!("SELECT count(*) FROM {表} WHERE rowid=9"),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(留, 1);
    }
}
