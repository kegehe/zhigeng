//! 索引层：SQLite schema、重建器、混合检索的关键词侧。
//!
//! 三条来自 docs/02 的铁律在这里落地：
//! 1. `reindex = parse(all files)`，重建器与增量走同一份 `md-kernel`；
//! 2. `index.db` 是派生物，删掉必须能完整重建（有测试保证）；
//! 3. FTS5 与 vec 的 virtual table **不参与外键级联**，必须按"先取 rowid 再删主表"
//!    的顺序手工清理，否则留下孤儿索引行让 AI 引用到已删内容。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use md_kernel::{Block, Doc, Kind};
use rusqlite::{params, Connection, Row};

use crate::hash::content_hash_str;
use crate::schema::SCHEMA;
use crate::vault::{NoteFile, NoteKind, NoteStatus, Vault};
use crate::{Error, Result};

pub const SCHEMA_VERSION: i64 = 3;
pub const MD_FORMAT_VERSION: i64 = 1;

/// 切片预算（字符数近似 token：中文一字≈一 token，英文约 4 字符≈1 token）。
const CHUNK_TARGET_CHARS: usize = 400;

/// 打开（或创建）索引库。vec 扩展必须在任何连接建立前静态注册（ADR-003）。
pub struct Index {
    conn: Connection,
    path: PathBuf,
}

static VEC_REGISTERED: std::sync::Once = std::sync::Once::new();

impl Index {
    pub fn open(vault: &Vault) -> Result<Self> {
        let dir = vault.meta_dir();
        std::fs::create_dir_all(&dir).map_err(|e| Error::Io {
            path: dir.display().to_string(),
            source: e,
        })?;
        Self::open_path(&dir.join("index.db"))
    }

    /// 第二条连接指向同一个库。后台索引拿它干活，读命令就不会排这把写锁
    /// （WAL 下读与写互不挡）。docs/03 §后端调用纪律 的"隐形预算"就是这么来的。
    pub fn fork(&self) -> Result<Self> {
        Self::open_path(&self.path)
    }

    /// 一串写包进一个事务。rusqlite 的事务是**连接态**：`BEGIN` 之后这条连接上的
    /// 所有语句都在事务里，所以被包的这些方法照旧各用 `self.conn`，不必改签名。
    /// 2999 块的长文档逐条自动提交要 2 秒，事务里一次提交是几十毫秒量级。
    pub fn in_tx<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        let tx = self.conn.unchecked_transaction()?;
        match f() {
            Ok(v) => {
                tx.commit()?;
                Ok(v)
            }
            Err(e) => {
                // 未 commit 的 Transaction 在 drop 时回滚，不会把半截索引留在库里
                drop(tx);
                Err(e)
            }
        }
    }

    pub fn open_path(path: &Path) -> Result<Self> {
        VEC_REGISTERED.call_once(|| unsafe {
            // sqlite-vec 把入口点声明成无参无返回，而 SQLite 的 `auto_extension` 要的是
            // 三参 `xEntryPoint`（C ABI 下多传的参数被调用方忽略，所以转过去是安全的）。
            // 类型写全而不是裸 `transmute`：让编译器替我们盯住这个不匹配的签名。
            type VecInit = unsafe extern "C" fn(
                *mut rusqlite::ffi::sqlite3,
                *mut *mut std::ffi::c_char,
                *const rusqlite::ffi::sqlite3_api_routines,
            ) -> std::ffi::c_int;
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute::<*const (), VecInit>(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        });
        let conn = Connection::open(path).map_err(|e| Error::Io {
            path: path.display().to_string(),
            source: std::io::Error::other(e),
        })?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // 两条连接偶尔会同时想写（前台保存撞上后台补索引）。SQLite 单写者，
        // 让它等而不是直接报 SQLITE_BUSY——等的是那一条，读命令不受影响。
        conn.busy_timeout(std::time::Duration::from_millis(5000))
            .map_err(|e| Error::Io {
                path: path.display().to_string(),
                source: std::io::Error::other(e),
            })?;
        let me = Self {
            conn,
            path: path.to_path_buf(),
        };
        me.ensure_schema()?;
        Ok(me)
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    fn ensure_schema(&self) -> Result<()> {
        self.conn.execute_batch(SCHEMA)?;
        let got: Option<i64> = self
            .conn
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM meta WHERE key='schema_version'",
                [],
                |r| r.get(0),
            )
            .ok();
        match got {
            None => {
                self.set_meta(SCHEMA_VERSION, MD_FORMAT_VERSION)?;
            }
            Some(v) if v > SCHEMA_VERSION => {
                // 索引是派生物：新版程序写过的库不能退回旧版读
                return Err(Error::Io {
                    path: "index.db".into(),
                    source: std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("索引 schema 版本 {v} 高于本程序 {SCHEMA_VERSION}，请删除 index.db 重建"),
                    ),
                });
            }
            Some(v) => {
                if v < SCHEMA_VERSION {
                    self.migrate_from(v)?;
                    // **迁移跑完要把新版本号记下来**。这里原先只 `pragma_update(user_version, v)`
                    // ——写回去的还是旧值，而 `meta` 里那条压根没更新，于是每次开库都重跑一遍
                    // 迁移（对大库就是重扫全库的块重算链接图）。真机暴露它是因为这个 bug
                    // 让真库一直停在 v1，而 v1 那条分支正好撞上上面的迁移顺序错误。
                    //
                    // 只写 `schema_version` 那一列：`md_format_version` 是长在用户资产里的
                    // 版本号（docs/02 §版本，改它必须写数据迁移），不能跟着索引架构一起被顺手刷掉。
                    self.conn.execute(
                        "INSERT INTO meta(key,value) VALUES('schema_version',?1)
                         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        [SCHEMA_VERSION.to_string()],
                    )?;
                }
                self.conn
                    .pragma_update(None, "user_version", SCHEMA_VERSION)?;
            }
        }
        Ok(())
    }

    /// 低版本库就地升级。索引是**纯派生物**（G1），所以迁移的原则是"重算"而不是
    /// "改写"——而且尽量不碰文件系统。
    ///
    /// **顺序不能改**：先把所有要换形状的表 DROP 掉 → 跑一遍 `SCHEMA` 把新形状建回来 →
    /// 再重算内容。之前是"每档各自 drop/建/算"，于是 v1 库走 `from < 2` 那一档时
    /// `links` 还是旧形状，`rebuild_links` 插 `target` 列直接报
    /// `table links has no column named target`，整个库打不开（真机照的）。
    ///
    /// v1 → v2：`link_targets` 的旧主键是 `(from_block, target, kind)`，漏了 `to_block`。
    /// 于是同一段里指向同一篇的 `[[乙]]`、`[[乙#某标题]]`、`[[乙#^b-xxx]]` 塌成一行，
    /// **块级锚点被静默丢掉**（`INSERT OR IGNORE`，第一条赢），AI 引用溯源退化成
    /// "指向整篇"。每一篇的 markdown 就在 `blocks.markdown` 里，所以重灌暂存表 +
    /// 重解析链接图即可，不用重扫全库。
    ///
    /// v2 → v3：`links` 补上目标的原始写法（悬空链接在反链面板上唯一还能显示的信息）。
    fn migrate_from(&self, from: i64) -> Result<()> {
        if from < 2 {
            self.conn
                .execute_batch("DROP TABLE IF EXISTS link_targets;")?;
        }
        if from < 3 {
            self.conn.execute_batch("DROP TABLE IF EXISTS links;")?;
        }
        // SCHEMA 全是 IF NOT EXISTS，重跑一遍就把上面缺的形状建回来
        self.conn.execute_batch(SCHEMA)?;
        if from < 2 {
            let rows: Vec<(String, String)> = {
                let mut s = self.conn.prepare("SELECT id, markdown FROM blocks")?;
                let r = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                r.filter_map(|x| x.ok()).collect()
            };
            for (block_id, md) in &rows {
                for (target, anchor) in extract_links(md) {
                    self.conn.execute(
                        "INSERT OR IGNORE INTO link_targets(from_block, target, to_block, kind) VALUES(?1,?2,?3,?4)",
                        params![block_id, target, anchor.as_deref().unwrap_or(""), link_kind(&target)],
                    )?;
                }
            }
        }
        let n = rebuild_links(&self.conn)?;
        tracing::info!("索引 schema v{from} → v{SCHEMA_VERSION}：重算链接图 {n} 条");
        Ok(())
    }

    fn set_meta(&self, schema: i64, mdfmt: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meta(key,value) VALUES('schema_version',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [schema.to_string()],
        )?;
        self.conn.execute(
            "INSERT INTO meta(key,value) VALUES('md_format_version',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [mdfmt.to_string()],
        )?;
        Ok(())
    }

    /// 全量重建：清空派生表后逐篇索引。与增量走同一条 `index_file` 路径。
    pub fn rebuild_all(&self, vault: &Vault) -> Result<RebuildStats> {
        let t0 = std::time::Instant::now();
        self.conn
            .execute_batch("DELETE FROM blocks_fts; DELETE FROM chunks_fts; DELETE FROM notes;")?;
        // vec 表按模型存在与否逐个清空
        for name in self.vec_tables() {
            self.conn.execute(&format!("DELETE FROM {name}"), [])?;
        }
        let mut stats = RebuildStats::default();
        for f in vault.scan()? {
            let src = String::from_utf8_lossy(&vault.read(&f.rel)?).to_string();
            stats.merge(self.index_file(&f, &src)?);
        }
        stats.links = rebuild_links(&self.conn)?;
        stats.elapsed_ms = t0.elapsed().as_millis() as u64;
        Ok(stats)
    }

    /// 单篇重建（增量）。**顺序严格遵循 docs/02 §派生表的手工清理**。
    ///
    /// 关键约束：**不许顺手删掉 `notes` 行**。`links.to_note` 是 `ON DELETE CASCADE`，
    /// 删一次就把所有指向这篇笔记的反链带走了，而引用方一个字都没改。所以：
    /// 认得出同一篇（id 相同）就原地更新；认不出但路径上压着一行旧 id（用户改了
    /// front-matter 的 id）就把入链迁移到新行，再清旧行。
    pub fn index_file(&self, f: &NoteFile, src: &str) -> Result<RebuildStats> {
        let doc = md_kernel::parse(src);
        let note_id = note_id_for(&self.conn, &doc, &f.rel);
        let mut stats = RebuildStats::default();

        let stale: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM notes WHERE path=?1 AND id<>?2",
                params![f.rel, note_id],
                |r| r.get(0),
            )
            .ok();
        // `notes.path` 是 UNIQUE，所以占位的那行必须先让路；又不能让它的入链跟着
        // 级联消失，于是先记下这些 links 行、置空、插完新行再指回来。
        let stale_links: Vec<i64> = match &stale {
            Some(old) => {
                let mut s = self.conn.prepare("SELECT id FROM links WHERE to_note=?1")?;
                let r = s.query_map([old], |x: &Row| x.get::<_, i64>(0))?;
                r.filter_map(|x| x.ok()).collect()
            }
            None => Vec::new(),
        };
        if let Some(old) = &stale {
            self.conn.execute(
                "UPDATE links SET to_note=NULL, broken=1 WHERE to_note=?1",
                [old],
            )?;
            purge_children(&self.conn, old)?;
            self.conn.execute("DELETE FROM notes WHERE id=?1", [old])?;
        }
        let mine: bool = self
            .conn
            .query_row("SELECT 1 FROM notes WHERE id=?1", [&note_id], |_| Ok(true))
            .unwrap_or(false);
        if mine {
            purge_children(&self.conn, &note_id)?;
        }
        insert_note(&self.conn, f, src, &doc, &note_id, &mut stats)?;
        write_meta(&self.conn, &doc, &note_id, f.kind)?;
        for lid in stale_links {
            self.conn.execute(
                "UPDATE links SET to_note=?1, broken=0 WHERE id=?2",
                params![note_id, lid],
            )?;
        }
        stats.notes = 1;
        Ok(stats)
    }

    /// 笔记被删除/移进回收站后清掉它的全部索引。按路径清（此时 front-matter 里的
    /// id 已经不在手上），派生表清理顺序与 `index_file` 完全一致。
    pub fn drop_note(&self, rel: &str) -> Result<()> {
        purge_by_key(&self.conn, rel, "")
    }

    /// 全量重解析链接图。删除/恢复会让别人的入链悬空，只有全量能把它退回 `broken=1`。
    pub fn rebuild_links(&self) -> Result<usize> {
        rebuild_links(&self.conn)
    }

    /// 把指向某篇笔记的入链标成悬空（而不是随 `notes` 行级联消失）。
    /// 删除与移动的前半段用它的旧身份，恢复/移动的后半段用 `resolve_broken_to` 接回来。
    pub fn break_incoming_links(&self, rel: &str) -> Result<usize> {
        let Ok(id) = self
            .conn
            .query_row("SELECT id FROM notes WHERE path=?1", [rel], |r| {
                r.get::<_, String>(0)
            })
        else {
            return Ok(0);
        };
        let n = self.conn.execute(
            "UPDATE links SET to_note=NULL, broken=1 WHERE to_note=?1",
            [&id],
        )?;
        Ok(n)
    }

    /// 重新解析"当前悬空、且写法正好指向这篇笔记"的链接。
    /// 只扫 `link_targets.target` 的那几个等值/前缀形式，代价与全库笔记数无关。
    pub fn resolve_broken_to(&self, rel: &str) -> Result<usize> {
        let Some(id) = self
            .conn
            .query_row("SELECT id FROM notes WHERE path=?1", [rel], |r| {
                r.get::<_, String>(0)
            })
            .ok()
        else {
            return Ok(0);
        };
        let stem = rel.trim_end_matches(".md").trim_end_matches(".markdown");
        let file = stem.rsplit('/').next().unwrap_or(stem);
        // `key` 直接拼进 LIKE 的话，文件名里的 `_` 就成了通配符：`a_b` 会连 `axb`
        // 一起匹配上，把毫不相干的悬空链接错接到这篇。转义之后才是字面量前缀。
        let esc = |k: &str| k.replace('!', "!!").replace('%', "!%").replace('_', "!_");
        let mut n = 0usize;
        for key in [id.as_str(), rel, stem, file] {
            n += self.conn.execute(
                "UPDATE links SET to_note=?3, broken=0
                 WHERE broken=1 AND to_note IS NULL
                   AND from_block IN (
                     SELECT from_block FROM link_targets
                     WHERE target=?1 OR target LIKE ?2 || '#%' ESCAPE '!')",
                params![key, esc(key), id],
            )?;
        }
        // 按标题写的链接
        let title: Option<String> = self
            .conn
            .query_row("SELECT title FROM notes WHERE id=?1", [&id], |r| r.get(0))
            .ok();
        if let Some(t) = title.filter(|t| !t.is_empty()) {
            n += self.conn.execute(
                "UPDATE links SET to_note=?2, broken=0
                 WHERE broken=1 AND to_note IS NULL
                   AND from_block IN (
                     SELECT from_block FROM link_targets
                     WHERE target=?1 OR target LIKE ?3 || '#%' ESCAPE '!')",
                params![t, id, esc(&t)],
            )?;
        }
        Ok(n)
    }

    /// 只重算一篇笔记**发出**的链接。`links.to_note` 存的是 id，所以改名/移动不会
    /// 弄坏别人的入链，被指方不需要跟着重建——这点决定了写路径不必每次全量重建链接图。
    pub fn rebuild_links_of_note(&self, rel: &str) -> Result<usize> {
        let Ok(note_id) = self
            .conn
            .query_row("SELECT id FROM notes WHERE path=?1", [rel], |r| {
                r.get::<_, String>(0)
            })
        else {
            return Ok(0);
        };
        self.conn.execute(
            "DELETE FROM links WHERE from_block IN (SELECT id FROM blocks WHERE note_id=?1)",
            [&note_id],
        )?;
        let rows: Vec<(String, String, Option<String>, String)> = {
            let mut s = self.conn.prepare(
                "SELECT lt.from_block, lt.target, lt.to_block, lt.kind
                 FROM link_targets lt JOIN blocks b ON b.id = lt.from_block
                 WHERE b.note_id=?1",
            )?;
            let r = s.query_map([&note_id], |x: &Row| {
                // 空串 = 没有锚点（这一列 NOT NULL，因为 PRIMARY KEY 视 NULL 互不相等）
                let anchor: String = x.get(2)?;
                Ok((
                    x.get(0)?,
                    x.get(1)?,
                    (!anchor.is_empty()).then_some(anchor),
                    x.get(3)?,
                ))
            })?;
            r.filter_map(|x| x.ok()).collect()
        };
        if rows.is_empty() {
            // 绝大多数保存不写链接。这里提前退出，省掉下面的目标解析
            return Ok(0);
        }
        let mut n = 0usize;
        for (from, target, anchor, kind) in &rows {
            let base = target
                .split('#')
                .next()
                .unwrap_or(target)
                .trim()
                .to_string();
            let to = find_target(&self.conn, &base)?;
            put_link(
                &self.conn,
                from,
                target,
                to.as_deref(),
                anchor.as_ref().filter(|a| a.starts_with("b-")).cloned(),
                kind,
            )?;
            n += 1;
        }
        Ok(n)
    }

    pub fn vec_tables(&self) -> Vec<String> {
        vec_tables_of(&self.conn)
    }

    /// 关键词检索：jieba 预分词后的 BM25。隐私过滤在这里（SQL 层）完成，不靠 prompt。
    pub fn search_keyword(&self, query: &str, limit: usize) -> Result<Vec<KeywordHit>> {
        let seg = segment(query);
        let match_expr = format!("\"{}\"", seg.replace('"', "\" \""));
        let mut stmt = self.conn.prepare(
            "SELECT b.id, b.note_id, substr(b.text,1,120), bm25(blocks_fts), n.path, n.title, b.type, n.status
             FROM blocks_fts f
             JOIN blocks b ON b.rowid = f.rowid
             JOIN notes  n ON n.id = b.note_id
             WHERE blocks_fts MATCH ?1
               AND n.ai_private = 0 AND n.no_ai = 0
               AND n.status <> 'archived'
             ORDER BY bm25(blocks_fts)
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![match_expr, limit as i64], |r: &Row| {
            Ok(KeywordHit {
                block_id: r.get(0)?,
                note_id: r.get(1)?,
                snippet: r.get(2)?,
                score: r.get(3)?,
                path: r.get(4)?,
                title: r.get(5)?,
                kind: r.get(6)?,
                status: r.get(7)?,
            })
        })?;
        Ok(rows.filter_map(|x| x.ok()).collect())
    }

    /// 各表行数，用于"增量结果 == 全量重建结果"的逐表 diff。
    pub fn table_counts(&self) -> Result<BTreeMap<String, i64>> {
        let tables: Vec<String> = {
            let mut stmt = self.conn.prepare(
                "SELECT name FROM sqlite_master WHERE type='table'
                 AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%'
                 ORDER BY name",
            )?;
            let rows = stmt.query_map([], |r: &Row| r.get::<_, String>(0))?;
            rows.filter_map(|x| x.ok()).collect()
        };
        let mut out = BTreeMap::new();
        for t in tables {
            let n: i64 = self
                .conn
                .query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0))?;
            out.insert(t, n);
        }
        Ok(out)
    }

    /// 孤儿索引行：派生表里有、主表里没有。非零即红（docs/03 §可观测性）。
    /// 库里给这篇记的内容 hash。外部改动的收敛拿它判断"是不是真的变了"——
    /// 原子写一定会触发监听事件，没有这道闸门就每次保存都白跑两遍索引。
    pub fn stored_hash(&self, rel: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT content_hash FROM notes WHERE path=?1", [rel], |r| {
                r.get::<_, String>(0)
            })
            .ok())
    }

    pub fn orphan_counts(&self) -> Result<Orphans> {
        // 派生表里指向已不存在的笔记的行
        let dangling = |conn: &rusqlite::Connection, t: &str, col: &str| -> Result<i64> {
            Ok(conn.query_row(
                &format!("SELECT count(*) FROM {t} t LEFT JOIN notes n ON n.id=t.{col} WHERE n.id IS NULL"),
                [],
                |r| r.get::<_, i64>(0),
            )?)
        };
        let fts = |t: &str, main: &str| -> Result<i64> {
            Ok(self.conn.query_row(
                &format!(
                    "SELECT count(*) FROM {t} f LEFT JOIN {main} m ON m.rowid=f.rowid WHERE m.rowid IS NULL"
                ),
                [],
                |r| r.get::<_, i64>(0),
            )?)
        };
        Ok(Orphans {
            blocks_fts: fts("blocks_fts", "blocks")?,
            chunks_fts: fts("chunks_fts", "chunks")?,
            chunks_no_blocks: self.conn.query_row(
                "SELECT count(*) FROM chunks c LEFT JOIN blocks b ON b.id=c.start_block WHERE b.id IS NULL",
                [],
                |r| r.get(0),
            )?,
            tags: dangling(&self.conn, "tags", "note_id")?,
            props: dangling(&self.conn, "props", "note_id")?,
        })
    }

    /// md 与 db 的偏差：内容 hash 不一致或文件缺失。
    pub fn drift(&self, vault: &Vault) -> Result<i64> {
        let mut n = 0i64;
        let mut stmt = self.conn.prepare("SELECT path, content_hash FROM notes")?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r: &Row| Ok((r.get(0)?, r.get(1)?)))?
            .filter_map(|x| x.ok())
            .collect();
        drop(stmt);
        for (rel, hash) in rows {
            let on_disk = vault
                .read(&rel)
                .ok()
                .map(|b| content_hash_str(&String::from_utf8_lossy(&b)));
            if on_disk.as_deref() != Some(hash.as_str()) {
                n += 1;
            }
        }
        let indexed: i64 = self
            .conn
            .query_row("SELECT count(*) FROM notes", [], |r| r.get(0))?;
        let on_disk = vault.scan()?.len() as i64;
        Ok(n + (on_disk - indexed).abs())
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct RebuildStats {
    pub notes: usize,
    pub blocks: usize,
    pub chunks: usize,
    pub links: usize,
    pub unrecognized: usize,
    pub elapsed_ms: u64,
}

impl RebuildStats {
    fn merge(&mut self, o: RebuildStats) {
        self.notes += o.notes;
        self.blocks += o.blocks;
        self.chunks += o.chunks;
        self.links += o.links;
        self.unrecognized += o.unrecognized;
        self.elapsed_ms = self.elapsed_ms.max(o.elapsed_ms);
    }
}

#[derive(Debug, Clone)]
pub struct KeywordHit {
    pub block_id: String,
    pub note_id: String,
    pub snippet: String,
    pub score: f64,
    pub path: String,
    pub title: String,
    pub kind: String,
    pub status: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Orphans {
    pub blocks_fts: i64,
    pub chunks_fts: i64,
    pub chunks_no_blocks: i64,
    /// 标签与属性指向已不存在的笔记。它们没有内容可还原，留着就是标签视图里的幽灵计数
    pub tags: i64,
    pub props: i64,
}

impl Orphans {
    pub fn is_clean(&self) -> bool {
        *self
            == Self {
                blocks_fts: 0,
                chunks_fts: 0,
                chunks_no_blocks: 0,
                tags: 0,
                props: 0,
            }
    }
}

/// 清理一篇笔记的全部派生与主表行。**顺序不可调换**（docs/02 §派生表的手工清理）：
/// 先取 rowid → 删 virtual table → 删主表。反过来做就必然留下孤儿索引。
fn purge_by_key(conn: &Connection, rel: &str, note_id: &str) -> Result<()> {
    let ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM notes WHERE path=?1 OR id=?2")?;
        let rows = stmt.query_map(params![rel, note_id], |r: &Row| r.get::<_, String>(0))?;
        rows.filter_map(|x| x.ok()).collect()
    };
    for id in ids {
        purge_children(conn, &id)?;
        conn.execute("DELETE FROM notes WHERE id=?1", [&id])?;
    }
    Ok(())
}

/// 清掉一篇笔记的块、切片与它们的派生表行，**但保留 `notes` 行本身**。
///
/// 重新索引同一篇笔记时必须走这里：`links.to_note` 是 `ON DELETE CASCADE`，
/// 删一次 `notes` 行就把所有指向它的反链一起带走了，而引用方的文本一个字都没变。
fn purge_children(conn: &Connection, note_id: &str) -> Result<()> {
    let block_rowids: Vec<i64> = {
        let mut s = conn.prepare("SELECT rowid FROM blocks WHERE note_id=?1")?;
        let r = s.query_map([note_id], |x: &Row| x.get(0))?;
        r.filter_map(|x| x.ok()).collect()
    };
    let chunk_ids: Vec<i64> = {
        let mut s = conn.prepare("SELECT id FROM chunks WHERE note_id=?1")?;
        let r = s.query_map([note_id], |x: &Row| x.get(0))?;
        r.filter_map(|x| x.ok()).collect()
    };
    for t in vec_tables_of(conn) {
        for cid in &chunk_ids {
            conn.execute(&format!("DELETE FROM {t} WHERE rowid=?1"), [*cid])?;
        }
    }
    for cid in &chunk_ids {
        conn.execute("DELETE FROM chunks_fts WHERE rowid=?1", [*cid])?;
    }
    for bid in &block_rowids {
        conn.execute("DELETE FROM blocks_fts WHERE rowid=?1", [*bid])?;
    }
    // blocks / chunks 自己有 ON DELETE CASCADE，但只在上层删 notes 时才会触发；
    // 这里要原地留着 notes 行，所以得自己删。
    conn.execute("DELETE FROM chunks WHERE note_id=?1", [note_id])?;
    conn.execute("DELETE FROM blocks WHERE note_id=?1", [note_id])?;
    // 标签与属性也是这篇的派生物：不一起删，改一次 front-matter 就留下洗不掉的旧标签
    conn.execute("DELETE FROM tags WHERE note_id=?1", [note_id])?;
    conn.execute("DELETE FROM props WHERE note_id=?1", [note_id])?;
    Ok(())
}

fn vec_tables_of(conn: &Connection) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vec_%'
         AND name NOT LIKE '%_rows' AND name NOT LIKE '%_info' AND name NOT LIKE '%_chunks'",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |r: &Row| r.get::<_, String>(0)) else {
        return Vec::new();
    };
    rows.filter_map(|x| x.ok()).collect()
}

/// 标签与属性：纯派生自 front-matter（docs/02 §标签/属性）。
///
/// 视图文件不收——它是查询定义，不是知识内容。收进来就会让"按标签筛选"的结果里
/// 混进视图自己，而 `views/` 下的东西本来就不该参与检索（与 chunks/FTS 同一口径）。
fn write_meta(conn: &Connection, doc: &Doc, note_id: &str, kind: NoteKind) -> Result<()> {
    if matches!(kind, NoteKind::View) {
        return Ok(());
    }
    let yaml = doc.front_matter.as_ref().map_or("", |fm| fm.yaml.as_str());
    let meta = crate::meta::parse(yaml);
    for tag in &meta.tags {
        conn.execute(
            "INSERT OR IGNORE INTO tags(note_id, tag) VALUES(?1,?2)",
            params![note_id, tag],
        )?;
    }
    for (key, value) in &meta.props {
        let (text, num, date, json) = value.columns();
        conn.execute(
            "INSERT OR REPLACE INTO props(note_id, key, value_text, value_num, value_date, value_json)
             VALUES(?1,?2,?3,?4,?5,?6)",
            params![note_id, key, text, num, date, json],
        )?;
    }
    Ok(())
}

/// 解析 + 落库。`reindex` 与增量走这一个函数（docs/02：重建器与解析器同源）。
fn insert_note(
    conn: &Connection,
    f: &NoteFile,
    src: &str,
    doc: &Doc,
    note_id: &str,
    stats: &mut RebuildStats,
) -> Result<()> {
    // 必须是 DO UPDATE 而不是 INSERT OR REPLACE：REPLACE 的语义是"先删后插"，
    // 删那一下会顺着 links.to_note 的 CASCADE 把别人的反链带走。
    conn.execute(
        "INSERT INTO notes(id,path,title,status,created_at,updated_at,content_hash,ai_private,no_ai,origin,note_kind)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
         ON CONFLICT(id) DO UPDATE SET
           path=excluded.path, title=excluded.title, status=excluded.status,
           created_at=excluded.created_at, updated_at=excluded.updated_at,
           content_hash=excluded.content_hash, ai_private=excluded.ai_private,
           no_ai=excluded.no_ai, origin=excluded.origin, note_kind=excluded.note_kind",
        params![
            note_id,
            f.rel,
            title_of(doc, f),
            status_str(f.status),
            created_of(doc),
            f.mtime_ms,
            content_hash_str(src),
            ai_flag(doc, "private"),
            ai_flag(doc, "no_ai"),
            origin_of(doc),
            kind_str(f.kind),
        ],
    )?;

    // 视图定义只是查询，不是知识内容：登记存在即可，不切块、不进向量与全文索引、不参与
    // AI 召回——否则"待补清单"这类视图会被自己的查询结果反复污染（docs/02）。
    if matches!(f.kind, NoteKind::View) {
        conn.execute(
            "INSERT OR REPLACE INTO notes(id,path,title,note_kind,status,created_at,updated_at,content_hash,ai_private,no_ai,origin,rev)
             VALUES(?1,?2,?3,'view','active',?4,?5,?6,1,1,'human',0)",
            params![
                note_id,
                f.rel,
                title_of(doc, f),
                created_of(doc),
                f.mtime_ms,
                content_hash_str(src),
            ],
        )?;
        stats.notes = 1;
        return Ok(());
    }

    // 块：先做一次前序遍历拿到稳定 ID，再落库。
    // 必须共用同一份 ID —— 之前 blocks 与 chunks 各自生成回退 ID，
    // 结果 chunk 指向不存在的块，外键直接失败。
    let plan = plan_blocks(doc, note_id);
    let mut rows: Vec<(i64, String, String)> = Vec::new(); // (rowid, id, seg)
    for pb in &plan {
        let b = pb.block;
        let text = b.plain_text();
        let plain = if text.is_empty() {
            md_kernel::plain_inline(&strip_fence_markers(&b.raw))
        } else {
            text
        };
        conn.execute(
            "INSERT INTO blocks(id,note_id,parent_id,ordinal,type,heading_level,text,markdown,line_start,line_end,props_json)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                pb.id,
                note_id,
                pb.parent,
                pb.ordinal,
                b.kind.as_str(),
                heading_level(&b.kind),
                plain,
                b.raw,
                b.line_start as i64,
                b.line_end as i64,
                block_props(b),
            ],
        )?;
        let rowid = conn.last_insert_rowid();
        rows.push((rowid, pb.id.clone(), segment(&plain)));
        stats.blocks += 1;
        if matches!(b.kind, Kind::Raw | Kind::Html) {
            stats.unrecognized += 1;
        }
    }

    // FTS 用显式 rowid 与 blocks 对齐
    for (rowid, _id, seg) in &rows {
        conn.execute(
            "INSERT INTO blocks_fts(rowid, seg) VALUES(?1, ?2)",
            params![rowid, seg],
        )?;
    }

    // 切片：只切根层块，保持"1..N 连续块"的语义
    let chunks = build_chunks(&plan);
    let mut chunk_rows: Vec<(i64, String, String)> = Vec::new();
    for ch in &chunks {
        conn.execute(
            "INSERT INTO chunks(note_id,start_block,end_block,header_path,token_count,text,source_hash)
             VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                note_id,
                ch.start_block,
                ch.end_block,
                ch.header_path,
                ch.text.chars().count() as i64,
                ch.text,
                content_hash_str(&ch.text),
            ],
        )?;
        let rowid = conn.last_insert_rowid();
        chunk_rows.push((rowid, ch.start_block.clone(), segment(&ch.text)));
        stats.chunks += 1;
    }
    for (rowid, _s, seg) in &chunk_rows {
        conn.execute(
            "INSERT INTO chunks_fts(rowid, seg) VALUES(?1, ?2)",
            params![rowid, seg],
        )?;
    }

    // 链接：登记"指向谁"的原始文本，真正的 to_note 由 rebuild_links 统一解析。
    // 必须遍历 plan（含自动分配的 ID），而不是只遍历有显式 ID 的块——
    // 绝大多数块没有手写 ID，用 b.id 会静默漏掉它们的全部出站链接。
    for pb in &plan {
        for (target, anchor) in extract_links(&pb.block.content) {
            conn.execute(
                "INSERT OR IGNORE INTO link_targets(from_block, target, to_block, kind) VALUES(?1,?2,?3,?4)",
                params![pb.id, target, anchor.as_deref().unwrap_or(""), link_kind(&target)],
            )?;
        }
    }
    stats.links = self_link_count(conn, note_id)?;
    Ok(())
}

/// 笔记主键优先用 front-matter 的 id（改名换路径不变）。缺失时退化为路径派生值，
/// 但绝不静默换主键——那会让历史链接指向空处。
pub fn note_id_of(doc: &Doc, rel: &str) -> String {
    doc.front_matter
        .as_ref()
        .and_then(|fm| {
            fm.yaml.lines().find_map(|l| {
                l.trim()
                    .strip_prefix("id:")
                    .map(|v| v.trim().trim_matches('"').to_string())
            })
        })
        .filter(|v: &String| !v.is_empty() && v.starts_with("n-"))
        .unwrap_or_else(|| format!("n-path-{}", stable_slug(rel)))
}

/// 这篇实际用哪个主键：front-matter 的 id **被另一篇占了就退回按路径的 id**。
///
/// `notes.id` 是主键，硬插会把对方那一行顶掉——索引里静默少一篇，比直接报错更坏
/// （导入真实 Vault 时这很常见：Obsidian 模板另存、Notion 导出重复页都带着同一个 id）。
/// 谁先谁后由扫描顺序决定（按路径排序），所以可重现：删库重建得到同样的归属。
fn note_id_for(conn: &Connection, doc: &Doc, rel: &str) -> String {
    let declared = note_id_of(doc, rel);
    if declared.starts_with("n-path-") {
        return declared; // 本来就是按路径推的，撞不上别人
    }
    let owner: Option<String> = conn
        .query_row("SELECT path FROM notes WHERE id=?1", [&declared], |r| {
            r.get(0)
        })
        .ok();
    match owner {
        Some(p) if p != rel => format!("n-path-{}", stable_slug(rel)),
        _ => declared,
    }
}

fn self_link_count(conn: &Connection, note_id: &str) -> Result<usize> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM links l JOIN blocks b ON b.id = l.from_block WHERE b.note_id=?1",
        [note_id],
        |r| r.get(0),
    )?;
    Ok(n as usize)
}

/// 目标写法 → 笔记 id 的查找表。匹配顺序：front-matter id → 完整相对路径 →
/// 去扩展名的路径 → 文件名 → 标题。
fn link_lookup(conn: &Connection) -> Result<BTreeMap<String, String>> {
    let mut stmt = conn.prepare("SELECT id, path, title FROM notes")?;
    let notes: Vec<(String, String, String)> = stmt
        .query_map([], |r: &Row| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .filter_map(|x| x.ok())
        .collect();
    let mut lookup: BTreeMap<String, String> = BTreeMap::new();
    for (id, path, title) in &notes {
        let stem = path.trim_end_matches(".md").trim_end_matches(".markdown");
        let file = stem.rsplit('/').next().unwrap_or(stem);
        for key in [id.as_str(), path.as_str(), stem, file, title.as_str()] {
            lookup.entry(key.to_string()).or_insert_with(|| id.clone());
        }
    }
    Ok(lookup)
}

/// 把一条 `link_targets` 解析成 `links` 行。找不到目标也登记（`broken=1`），
/// UI 才标得出来并提示补上（docs/02 §块 ID）。
fn insert_resolved(
    conn: &Connection,
    lookup: &BTreeMap<String, String>,
    from_block: &str,
    target: &str,
    anchor: Option<&String>,
    kind: &str,
) -> Result<()> {
    let base = target.split('#').next().unwrap_or(target).trim();
    put_link(
        conn,
        from_block,
        target,
        lookup.get(base).map(String::as_str),
        anchor.filter(|a| a.starts_with("b-")).cloned(),
        kind,
    )
}

/// 写一行解析结果。`to_note=None` 即悬空，此时 `target`（用户写下的那个 `[[…]]` 里的
/// 原文）是界面上唯一还能显示的东西。
fn put_link(
    conn: &Connection,
    from_block: &str,
    target: &str,
    to_note: Option<&str>,
    to_block: Option<String>,
    kind: &str,
) -> Result<()> {
    // `link_targets.to_block` 存的是文件里的裸锚点（`b-xxx`），而 `blocks.id` 是
    // 带笔记前缀的限定形式。不拼回去就会撞上外键：锚点写着存在的块却"找不到"。
    // 锚点也可能写错或指向已删的块——那种情况置 NULL，链接本身仍然登记（broken 照旧）。
    let anchor = match (to_note, to_block) {
        (Some(note), Some(a)) => {
            let full = format!("{note}#{a}");
            conn.query_row("SELECT 1 FROM blocks WHERE id=?1", [&full], |_| Ok(true))
                .unwrap_or(false)
                .then_some(full)
        }
        _ => None,
    };
    let anchor = anchor.as_deref();
    match to_note {
        Some(to) => conn.execute(
            "INSERT INTO links(from_block,target,to_note,to_block,kind,provenance,broken)
             VALUES(?1,?2,?3,?4,?5,'human',0)",
            params![from_block, target, to, anchor, kind],
        )?,
        None => conn.execute(
            "INSERT INTO links(from_block,target,to_note,to_block,kind,provenance,broken)
             VALUES(?1,?2,NULL,?3,?4,'human',1)",
            params![from_block, target, anchor, kind],
        )?,
    };
    Ok(())
}

/// 把一条 `[[写法]]` 解析到具体笔记。键的优先级与 `link_lookup` 一致：
/// front-matter id → 完整路径 → 去扩展名路径 → 文件名 → 标题。
///
/// 刻意不建全库查找表：那玩意每保存一次就要扫全库并插两万遍 BTreeMap
/// （实测 2000 篇时 11.6ms，单这一步就吃掉 8ms 预算的一大半）。
/// 这里改成按目标做索引查询，代价与库的规模无关。
fn find_target(conn: &Connection, base: &str) -> Result<Option<String>> {
    let exact: Option<String> = conn
        .query_row(
            "SELECT id FROM notes
             WHERE id=?1 OR path=?1 OR title=?1 OR path=?1||'.md' OR path=?1||'.markdown'
             LIMIT 1",
            [base],
            |r| r.get(0),
        )
        .ok();
    if exact.is_some() {
        return Ok(exact);
    }
    // 只写文件名的 wikilink（`[[甲]]` 指向 `notes/甲.md`）。LIKE 用不上索引，
    // 所以只取候选再在 Rust 里判等——`_` 在 LIKE 里是通配符，直接采信会误配。
    let mut stmt = conn.prepare(
        "SELECT id, path FROM notes
         WHERE path LIKE '%/'||?1||'.md' OR path LIKE '%/'||?1||'.markdown'",
    )?;
    let rows = stmt.query_map([base], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    for row in rows.flatten() {
        let tail = row.1.rsplit('/').next().unwrap_or(&row.1);
        if tail == format!("{base}.md") || tail == format!("{base}.markdown") {
            return Ok(Some(row.0));
        }
    }
    Ok(None)
}

/// 全量解析链接图：把 `link_targets` 的原始写法映射到具体笔记。
pub fn rebuild_links(conn: &Connection) -> Result<usize> {
    conn.execute("DELETE FROM links", [])?;
    let lookup = link_lookup(conn)?;
    let mut t = conn.prepare("SELECT from_block, target, to_block, kind FROM link_targets")?;
    let targets: Vec<(String, String, Option<String>, String)> = t
        .query_map([], |r: &Row| {
            let anchor: String = r.get(2)?;
            Ok((
                r.get(0)?,
                r.get(1)?,
                (!anchor.is_empty()).then_some(anchor),
                r.get(3)?,
            ))
        })?
        .filter_map(|x| x.ok())
        .collect();
    let mut n = 0usize;
    for (from_block, target, anchor, kind) in &targets {
        insert_resolved(conn, &lookup, from_block, target, anchor.as_ref(), kind)?;
        n += 1;
    }
    Ok(n)
}

/// 一次前序遍历得到的块清单：ID 规则只有一处，blocks 与 chunks 共用。
pub struct Planned<'a> {
    pub id: String,
    pub parent: Option<String>,
    pub ordinal: i64,
    pub block: &'a Block,
}

fn plan_blocks<'a>(doc: &'a Doc, note_id: &str) -> Vec<Planned<'a>> {
    fn go<'a>(
        b: &'a Block,
        note_id: &str,
        parent: Option<&str>,
        ord: &mut i64,
        seen: &mut BTreeSet<String>,
        out: &mut Vec<Planned<'a>>,
    ) {
        *ord += 1;
        // 块 ID 必须带笔记前缀才是全局唯一：模板、复制文件、Obsidian 里另存一份
        // 都会让两篇笔记出现同一个 `^b-xxx`，用裸锚点当主键会让索引直接建不起来。
        // 文件里写的仍然是裸锚点（docs/02 §块 ID），只有库内的键是限定形式。
        let named = match &b.id {
            Some(anchor) => format!("{note_id}#{anchor}"),
            None => format!("{note_id}#{ord}"),
        };
        // 同一篇里也可能重：`> 文字 ^b-xxx` 这种容器块，锚点会同时被外层块和它
        // 内部的段落认走。前序遍历，**外层优先**（Obsidian 也是把块 ID 挂在顶层块上），
        // 后到的那个退回按序号的 ID——总得有个唯一键，且不能整篇索引失败。
        // 按序号的键不会撞：ord 在整篇内单调递增，而锚点一律以 `b-` 开头。
        let id = if seen.insert(named.clone()) {
            named
        } else {
            format!("{note_id}#{ord}")
        };
        out.push(Planned {
            id: id.clone(),
            parent: parent.map(str::to_string),
            ordinal: *ord,
            block: b,
        });
        for c in &b.children {
            go(c, note_id, Some(&id), ord, seen, out);
        }
    }
    let mut out = Vec::new();
    let mut ord = 0i64;
    let mut seen = BTreeSet::new();
    for b in &doc.blocks {
        go(b, note_id, None, &mut ord, &mut seen, &mut out);
    }
    out
}

fn strip_fence_markers(raw: &str) -> String {
    raw.lines()
        .filter(|l| !(l.trim_start().starts_with("```") || l.trim_start().starts_with("~~~")))
        .collect::<Vec<_>>()
        .join("\n")
}

fn heading_level(kind: &Kind) -> Option<i64> {
    match kind {
        Kind::Heading { level, .. } => Some(*level as i64),
        _ => None,
    }
}

fn block_props(b: &Block) -> Option<String> {
    let mut m = serde_json::Map::new();
    if let Kind::Code { info, .. } = &b.kind {
        m.insert("lang".into(), serde_json::Value::String(info.clone()));
    }
    if let Kind::Todo { checked } = &b.kind {
        m.insert("checked".into(), serde_json::Value::Bool(*checked));
    }
    if let Kind::Callout { ty, folded, .. } = &b.kind {
        m.insert("callout".into(), serde_json::Value::String(ty.clone()));
        m.insert("folded".into(), serde_json::Value::Bool(*folded));
    }
    for (k, v) in &b.fields {
        m.insert(k.clone(), serde_json::Value::String(v.clone()));
    }
    if m.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(m).to_string())
    }
}

/// 切片：按根层块累积到 CHUNK_TARGET..CHUNK_MAX 字符，遇到标题重开并记录面包屑。
fn build_chunks(plan: &[Planned]) -> Vec<Chunk> {
    #[derive(Default)]
    struct Acc {
        start: Option<String>,
        end: String,
        text: String,
    }
    let mut out = Vec::new();
    let mut acc = Acc::default();
    let mut trail: Vec<(u8, String)> = Vec::new();

    let flush = |acc: &mut Acc, out: &mut Vec<Chunk>, trail: &[(u8, String)]| {
        if let Some(s) = acc.start.take() {
            let header = trail
                .iter()
                .map(|(_, t)| t.as_str())
                .collect::<Vec<_>>()
                .join(" > ");
            let text = if header.is_empty() {
                acc.text.clone()
            } else {
                format!("{header}\n{}", acc.text)
            };
            out.push(Chunk {
                start_block: s,
                end_block: acc.end.clone(),
                header_path: (!header.is_empty()).then_some(header),
                text,
            });
        }
        acc.text.clear();
        let _ = trail;
    };

    for pb in plan.iter().filter(|p| p.parent.is_none()) {
        let b = pb.block;
        if let Kind::Heading { level, .. } = &b.kind {
            flush(&mut acc, &mut out, &trail);
            while let Some((l, _)) = trail.last() {
                if *l >= *level {
                    trail.pop();
                } else {
                    break;
                }
            }
            trail.push((*level, b.content.clone()));
        }
        let piece = {
            let t = b.plain_text();
            if t.is_empty() {
                md_kernel::plain_inline(&strip_fence_markers(&b.raw))
            } else {
                t
            }
        };
        if piece.trim().is_empty() {
            continue;
        }
        if acc.start.is_none() {
            acc.start = Some(pb.id.clone());
        }
        acc.end = pb.id.clone();
        acc.text.push_str(&piece);
        acc.text.push('\n');
        // 到目标长度就在块边界切一刀，避免 chunk 过长
        if acc.text.chars().count() >= CHUNK_TARGET_CHARS {
            flush(&mut acc, &mut out, &trail);
        }
    }
    flush(&mut acc, &mut out, &trail);
    out
}

#[derive(Debug, Clone)]
struct Chunk {
    start_block: String,
    end_block: String,
    header_path: Option<String>,
    text: String,
}

/// 从正文抽出 wikilink，返回 (目标写法, 块级锚点)。
/// 只取目标会把 `[[笔记#^b-xxx]]` 的锚点丢掉，AI 引用溯源会退化成指向整篇。
fn extract_links(content: &str) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    let mut rest = content;
    while let Some(a) = rest.find("[[") {
        let tail = &rest[a + 2..];
        let Some(b) = tail.find("]]") else { break };
        let inner = &tail[..b];
        let head = inner.split('|').next().unwrap_or("");
        let (target, anchor) = match head.split_once('#') {
            Some((t, a)) => (t, Some(a.trim_start_matches('^').to_string())),
            None => (head, None),
        };
        let target = target.trim();
        if !target.is_empty() {
            out.push((target.to_string(), anchor.filter(|a| !a.is_empty())));
        }
        rest = &tail[b + 2..];
    }
    out
}

fn link_kind(target: &str) -> &'static str {
    if target.contains('.') {
        "asset"
    } else {
        "ref"
    }
}

fn title_of(doc: &Doc, f: &NoteFile) -> String {
    if let Some(fm) = &doc.front_matter {
        if let Some(t) = fm.yaml.lines().find_map(|l| {
            l.trim()
                .strip_prefix("title:")
                .map(|v| v.trim().trim_matches('"').to_string())
        }) {
            if !t.is_empty() {
                return t;
            }
        }
    }
    if let Some(h) = doc
        .blocks
        .iter()
        .find(|b| matches!(b.kind, Kind::Heading { .. }))
    {
        return h.content.clone();
    }
    Path::new(&f.rel)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| f.rel.clone())
}

fn created_of(doc: &Doc) -> String {
    doc.front_matter
        .as_ref()
        .and_then(|fm| {
            fm.yaml.lines().find_map(|l| {
                l.trim()
                    .strip_prefix("created:")
                    .map(|v| v.trim().to_string())
            })
        })
        .unwrap_or_default()
}

fn ai_flag(doc: &Doc, key: &str) -> i64 {
    let Some(fm) = doc.front_matter.as_ref() else {
        return 0;
    };
    let mut in_ai = false;
    for l in fm.yaml.lines() {
        let t = l.trim_end();
        if !l.starts_with(' ') && !l.starts_with('\t') {
            in_ai = t.trim_end_matches(':') == "ai";
            continue;
        }
        if !in_ai {
            continue;
        }
        if let Some(v) = t.trim().strip_prefix(&format!("{key}:")) {
            let v = v.trim().trim_matches('"').to_ascii_lowercase();
            return i64::from(v == "true" || v == "yes" || v == "1");
        }
    }
    0
}

fn origin_of(doc: &Doc) -> &'static str {
    let has = |k: &str| {
        doc.front_matter
            .as_ref()
            .map(|fm| fm.yaml.lines().any(|l| l.trim_start().starts_with(k)))
            .unwrap_or(false)
    };
    if has("source_url:") {
        "clipped"
    } else {
        "human"
    }
}

fn status_str(s: NoteStatus) -> &'static str {
    match s {
        NoteStatus::Inbox => "inbox",
        NoteStatus::Active => "active",
        NoteStatus::Archived => "archived",
    }
}

fn kind_str(k: NoteKind) -> &'static str {
    match k {
        NoteKind::Note => "note",
        NoteKind::View => "view",
    }
}

fn stable_slug(s: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// 中文分词。FTS5 的 unicode61 不分中文词，必须先分词再入库。
/// 中文分词。FTS5 的 unicode61 不分中文词，必须先分词再入库（docs/02）。
/// 词典加载有成本，用 OnceLock 全局复用。
pub fn segment(text: &str) -> String {
    static JIEBA: std::sync::OnceLock<jieba_rs::Jieba> = std::sync::OnceLock::new();
    let jieba = JIEBA.get_or_init(jieba_rs::Jieba::new);
    jieba
        .cut(text, false)
        .into_iter()
        .map(|t| t.word)
        .filter(|w| !w.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// 读侧查询：服务层与 UI 用的窄接口。都是单表查询，预算 8ms（G6）。
// ---------------------------------------------------------------------------

impl Index {
    pub fn count_notes(&self) -> Result<i64> {
        Ok(self
            .conn
            .query_row("SELECT count(*) FROM notes", [], |r| r.get(0))?)
    }

    pub fn schema_version(&self) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT CAST(value AS INTEGER) FROM meta WHERE key='schema_version'",
            [],
            |r| r.get(0),
        )?)
    }

    /// 笔记列表：默认按更新时间倒序。视图定义排在最后（它不是内容）。
    pub fn list_notes(&self, limit: usize) -> Result<Vec<crate::service::NoteRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT path, title, status, note_kind, updated_at
             FROM notes 
             ORDER BY (note_kind='view'), updated_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit as i64], |r: &Row| {
            Ok(crate::service::NoteRow {
                rel: r.get(0)?,
                title: r.get(1)?,
                status: r.get(2)?,
                kind: r.get(3)?,
                updated_ms: r.get(4)?,
                size: 0,
            })
        })?;
        Ok(rows.filter_map(|x| x.ok()).collect())
    }

    /// 单篇的块序列（渲染用）。返回 (标题, 块)。
    pub fn note_blocks(&self, rel: &str) -> Result<(String, Vec<crate::service::BlockRow>)> {
        let title: String =
            self.conn
                .query_row("SELECT title FROM notes WHERE path=?1", [rel], |r| r.get(0))?;
        let mut stmt = self.conn.prepare(
            "SELECT b.id, b.type, b.text, b.heading_level, b.line_start
             FROM blocks b JOIN notes n ON n.id = b.note_id
             WHERE n.path = ?1
             ORDER BY b.ordinal",
        )?;
        let rows = stmt.query_map([rel], |r: &Row| {
            Ok(crate::service::BlockRow {
                id: r.get(0)?,
                r#type: r.get(1)?,
                text: r.get(2)?,
                heading_level: r.get(3)?,
                line_start: r.get(4)?,
            })
        })?;
        Ok((title, rows.filter_map(|x| x.ok()).collect()))
    }

    /// 一篇的链接图两半：**入链**（谁链到我）与**出链**（我链到谁，含悬空的）。
    ///
    /// 三条口径：
    /// - 视图文件（`note_kind='view'`）不进出链的对方，也不当入链的来源。它不是笔记，
    ///   把它列进面板等于把"查询定义"混进"我的笔记"。
    /// - **归档的照收，但带着 `status`**。归档是"不主动想起它"，不是"它不存在"——
    ///   一条来自归档笔记的入链是真结构，藏起来会让面板说谎。界面按状态淡化。
    /// - 悬空出链没有 `to_note`，此时 `target`（用户写下的原文）是唯一还能显示的信息，
    ///   所以 schema v3 把它抄进了 `links`。面板要说的正是"这篇链到了一个不存在的东西"。
    ///
    /// 隐私位（`ai_private` / `no_ai`）**不过滤**：那条硬门管的是"别进 AI 上下文"
    /// （docs/04），而这是人自己在看自己的库。
    pub fn note_links(
        &self,
        rel: &str,
        limit: i64,
    ) -> Result<(
        Vec<crate::service::LinkRow>,
        bool,
        Vec<crate::service::LinkRow>,
        bool,
    )> {
        let 一行 = |r: &Row| {
            Ok(crate::service::LinkRow {
                rel: r.get(0)?,
                title: r.get(1)?,
                status: r.get(2)?,
                snippet: r.get(3)?,
                to_block: r.get::<_, i64>(4)? != 0,
                kind: r.get(5)?,
                target: r.get(6)?,
                broken: r.get::<_, i64>(7)? != 0,
            })
        };
        // 多取一条只为了知道"后面还有没有"：面板上那句「还有更多没列出」不能靠前端猜
        // 数组长度——猜就等于把截断藏起来
        let 取 = limit + 1;
        let mut stmt = self.conn.prepare(
            "SELECT n.path, n.title, n.status, substr(b.text,1,140),
                    (l.to_block IS NOT NULL), l.kind, l.target, 0
             FROM links l
             JOIN blocks b ON b.id = l.from_block
             JOIN notes n ON n.id = b.note_id
             WHERE l.to_note = (SELECT id FROM notes WHERE path = ?1)
               AND n.note_kind <> 'view'
             ORDER BY n.updated_at DESC, b.ordinal
             LIMIT ?2",
        )?;
        let mut 入链: Vec<crate::service::LinkRow> = stmt
            .query_map(params![rel, 取], 一行)?
            .filter_map(|x| x.ok())
            .collect();
        let 入截 = 入链.len() as i64 > limit;
        入链.truncate(limit as usize);
        let mut stmt = self.conn.prepare(
            "SELECT COALESCE(n.path,''), COALESCE(n.title, l.target), COALESCE(n.status,'missing'),
                    substr(b.text,1,140),
                    (l.to_block IS NOT NULL), l.kind, l.target, l.broken
             FROM links l
             JOIN blocks b ON b.id = l.from_block
             LEFT JOIN notes n ON n.id = l.to_note
             WHERE b.note_id = (SELECT id FROM notes WHERE path = ?1)
               AND (n.id IS NULL OR n.note_kind <> 'view')
             ORDER BY l.broken DESC, b.ordinal
             LIMIT ?2",
        )?;
        let mut 出链: Vec<crate::service::LinkRow> = stmt
            .query_map(params![rel, 取], 一行)?
            .filter_map(|x| x.ok())
            .collect();
        let 出截 = 出链.len() as i64 > limit;
        出链.truncate(limit as usize);
        Ok((入链, 入截, 出链, 出截))
    }
}
