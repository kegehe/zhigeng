//! 版本快照：撤销与历史唯一的落点。
//!
//! **一条快照 = 一个曾经存在过的版本**，也就是那次操作**之前**盘上的内容。
//! 三种 reason 共用这一个语义：
//! - `manual`：用户改了一篇，落盘前把旧内容存一份；
//! - `ai_applied`：AI 落盘前的精确落点（撤销靠它，docs/04 §建议的生命周期）；
//! - `before_delete`：删除前的原件（docs/02 §回收站的索引处理）。
//!
//! 为什么不存"落盘之后"的那份：撤销要的是**回到没改之前**。存后像就等于存了
//! "再往前一版"，中间那一步永远撤不回来——而中间那一步正是用户要撤的那一步。
//! 所以一条快照统一是**前像**，三种 reason 只有"谁触发的"不同。
//!
//! **钥匙是路径，不是 note_id**：笔记进回收站时 `notes` 行会消失，而版本必须
//! 活得比笔记久（撤销与恢复都要它）。所以 `note_versions` 不挂外键（docs/02 的
//! DDL 原来挂的是 `ON DELETE CASCADE`——那一挂，版本就跟着笔记一起没了）。
//!
//! 30 分钟合并窗口只作用于 `manual`：连续编辑不该在历史里留下一串快照。
//! `ai_applied` 与 `before_delete` **不合并、不清理**——它们是撤销与恢复的落点，
//! 采样式的历史对它们没有意义。

use std::collections::HashSet;
use std::path::Path;
use std::sync::RwLock;

use rusqlite::params;

use crate::hash::content_hash;
use crate::index::Index;
use crate::vault::Vault;
use crate::{Error, Result};

/// 30 分钟合并窗口（毫秒）。窗口内的连续编辑只在历史里留一条。
pub const 合并窗口毫秒: i64 = 30 * 60 * 1000;

/// 每一篇最多留多少条 `manual` 快照，超出的从旧到新删。
pub const 手工保留上限: usize = 100;

/// 用户自己改的。
pub const 手工: &str = "manual";
/// AI 落盘（撤销的落点，不合并不清理）。
pub const AI落盘: &str = "ai_applied";
/// 删除之前（回收站之外的第二条退路，不合并不清理）。
pub const 删除前: &str = "before_delete";

/// 现在的 epoch 毫秒。索引里的时间列一律用它（docs/02 §时间列的类型）。
pub fn 现在() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 一条**待落**的快照。
///
/// 同步那一半只把前像读进内存排进队列；blob 与行由后台那一半落。理由见
/// [`落待落`]：同步路径要守 8ms 红线，而往 SQLite 写一行会跟后台那条连接
/// 抢写锁——主锁被后台事务占住时，前台任何一条命令都得排队。
#[derive(Clone)]
pub struct 待落 {
    /// 库根相对、正斜杠。**它是钥匙**：版本按路径分组。
    pub rel: String,
    /// 前像的字节：那次操作**之前**盘上的内容。
    pub 前像: Vec<u8>,
    pub reason: &'static str,
    /// 采集时刻（epoch 毫秒）。用采集那一刻而不是落盘那一刻：连着存几次的话，
    /// 合并窗口的分界会跟着后台线程的调度漂。
    pub 时刻: i64,
}

/// 历史里的一条。
#[derive(Debug, Clone)]
pub struct 版本行 {
    pub id: i64,
    pub path: String,
    pub note_id: String,
    pub content_hash: String,
    pub blob_path: String,
    pub reason: String,
    pub created_at: i64,
}

/// 目录名要消毒：note_id 来自 front-matter，是用户写的字符串，里面有 `..`
/// 或路径分隔符就能把文件写到 `.note/` 外面去。只留字母数字与 `-` `_`。
fn 安全名(s: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(48)
        .collect();
    if out.is_empty() {
        out.push('_');
    }
    out
}

/// blob 落在 `.note/versions/<目录>/<内容 hash>`。
///
/// 内容寻址：同一份内容永远落同一个文件，所以重复写是幂等的，而不同笔记里
/// 相同的内容只占一份。目录名用那一篇的 id（认得出是哪篇）；认不出时用
/// 路径的文件名——两份同名笔记共用一个目录也没关系，它们指向的是同一个
/// 内容寻址的文件。
fn blob_rel(note_id: &str, rel: &str, hash: &str) -> String {
    let 目录 = if note_id.trim().is_empty() {
        let 名 = rel.rsplit('/').next().unwrap_or(rel);
        安全名(名.trim_end_matches(".md").trim_end_matches(".markdown"))
    } else {
        安全名(note_id)
    };
    format!(".note/versions/{目录}/{hash}")
}

/// 把队列里属于 `rel` 的待落快照落成 blob + 行。
///
/// **落在后台那一半**（跟索引重建同一趟），不是同步落盘那一半：同步那一半要守
/// 8ms 红线，而往 SQLite 写一行会跟后台那条连接抢写锁——主锁被后台事务占住时，
/// 前台任何一条命令都得排队（那是 3.26 秒那次事故的形状）。读盘不花钱：冲突
/// 判定本来就要读同一份。
pub fn 落待落(vault: &Vault, index: &Index, rel: &str) -> Result<()> {
    let 待落们 = index.取待落(rel);
    for (i, 待) in 待落们.iter().enumerate() {
        if let Err(e) = 落一条(vault, index, 待) {
            // `取待落` 是取走即离队：不补回去的话，失败这一条之后的所有快照都
            // 凭空消失（磁盘满、blob 路径被占这些情况下会一次丢好几版）。
            for 剩 in &待落们[i..] {
                index.推待落(剩.clone());
            }
            return Err(e);
        }
    }
    Ok(())
}

fn 落一条(vault: &Vault, index: &Index, 待: &待落) -> Result<()> {
    let hash = content_hash(&待.前像);
    let note_id: String = index
        .conn()
        .query_row("SELECT id FROM notes WHERE path=?1", [&待.rel], |r| {
            r.get(0)
        })
        .unwrap_or_default();
    let rel_blob = blob_rel(&note_id, &待.rel, &hash);
    if !vault.root().join(&rel_blob).is_file() {
        // 走 Vault 的原子写：临时文件 → 刷盘 → 改名。半截的 blob 会被
        // `读回` 的 hash 核对挡下来，但不该先写出来再指望下游发现。
        vault.write_atomic(&rel_blob, &待.前像)?;
    }
    if 待.reason == 手工 {
        合并窗口内合并(index, &待.rel, &hash, 待.时刻)?;
    }
    index.conn().execute(
        "INSERT OR IGNORE INTO note_versions(path,note_id,content_hash,blob_path,reason,created_at)
         VALUES(?1,?2,?3,?4,?5,?6)",
        params![待.rel, note_id, hash, rel_blob, 待.reason, 待.时刻],
    )?;
    Ok(())
}

/// 30 分钟合并窗口：同一篇里，窗口内的**上一条** `manual` 快照作废。
///
/// 找的是"上一条**别的内容**的 manual"：同 hash 的那一条就是它自己（文件没变
/// 又存了一遍），把它删掉等于把历史里那份内容一起删了。
fn 合并窗口内合并(index: &Index, path: &str, hash: &str, 时刻: i64) -> Result<()> {
    let prev: Option<(i64, String, i64)> = index
        .conn()
        .query_row(
            "SELECT id, blob_path, created_at FROM note_versions
             WHERE path=?1 AND reason=?2 AND content_hash<>?3
             ORDER BY created_at DESC, id DESC LIMIT 1",
            params![path, 手工, hash],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    let Some((id, blob, at)) = prev else {
        return Ok(());
    };
    if 时刻 - at >= 合并窗口毫秒 {
        // 隔得够久：是另一次编辑，不该合并
        return Ok(());
    }
    删行连blob(index, id, &blob)?;
    Ok(())
}

/// 删一行；那份 blob **没有别的行指着**时一起删。
///
/// blob 是内容寻址的：同一份内容可能既是 `manual` 又是 `ai_applied`（用户把 AI
/// 改的那版又手动存了一遍）。先删 blob 会把另一行的落点一起删掉。
fn 删行连blob(index: &Index, id: i64, blob_rel: &str) -> Result<()> {
    index
        .conn()
        .execute("DELETE FROM note_versions WHERE id=?1", [id])?;
    let 还有: i64 = index.conn().query_row(
        "SELECT count(*) FROM note_versions WHERE blob_path=?1",
        [blob_rel],
        |r| r.get(0),
    )?;
    if 还有 == 0 {
        let _ = std::fs::remove_file(index.root().join(blob_rel));
    }
    Ok(())
}

/// 换路径时把版本历史一起搬过去。
///
/// **钥匙是路径**，所以路径一换，历史就"掉"在旧路径上了——撤销会找不到落点，
/// 用户改过的那些版本也就看不见了。改名、从回收站放回都走这里。
///
/// 先按内容去重再改钥匙：新路径上可能已经有同内容的一行（那篇以前在这个路径上
/// 存在过，又被换回来），`UNIQUE(path, content_hash)` 会撞。
pub fn 搬家(index: &Index, 老路径: &str, 新路径: &str) -> Result<()> {
    if 老路径 == 新路径 {
        return Ok(());
    }
    // 两条语句都要在闸里：中间让清扫插进来，按老路径删行的查询会读到半搬的状态。
    写事务(|| {
        index.conn().execute(
            "DELETE FROM note_versions WHERE path=?2 AND content_hash IN
               (SELECT content_hash FROM note_versions WHERE path=?1)",
            params![老路径, 新路径],
        )?;
        index.conn().execute(
            "UPDATE note_versions SET path=?2 WHERE path=?1",
            params![老路径, 新路径],
        )?;
        Ok(())
    })
}

/// 某一篇的历史（新的在前）。
pub fn 列出(index: &Index, path: &str) -> Result<Vec<版本行>> {
    let mut s = index.conn().prepare(
        "SELECT id,path,note_id,content_hash,blob_path,reason,created_at FROM note_versions
         WHERE path=?1 ORDER BY created_at DESC, id DESC",
    )?;
    let 行 = s.query_map([path], |r| {
        Ok(版本行 {
            id: r.get(0)?,
            path: r.get(1)?,
            note_id: r.get(2)?,
            content_hash: r.get(3)?,
            blob_path: r.get(4)?,
            reason: r.get(5)?,
            created_at: r.get(6)?,
        })
    })?;
    Ok(行.filter_map(|x| x.ok()).collect())
}

/// 读回某一版的内容。**核对 hash**：对不上就是坏档，宁可报错也不把半截内容
/// 当成用户的旧版本还回去。
pub fn 读回(root: &Path, 行: &版本行) -> Result<Vec<u8>> {
    let bytes = std::fs::read(root.join(&行.blob_path)).map_err(|e| Error::Io {
        path: 行.blob_path.clone(),
        source: e,
    })?;
    if content_hash(&bytes) != 行.content_hash {
        return Err(Error::Invalid(format!(
            "快照 {} 读回来对不上 hash（文件坏了）：{}",
            行.id, 行.blob_path
        )));
    }
    Ok(bytes)
}

/// 清理：每一篇的 `manual` 快照最多留 `上限` 条，超出的从旧到新删。
///
/// `ai_applied` 与 `before_delete` **永不删**：它们是撤销与恢复的落点，
/// 留着是因为留着才有意义，不是"忘了清"。
///
/// 私有的理由：它要跟 [`清扫`] 一起拿写闸，单独暴露出去迟早有人在锁外调它。
fn 清理(index: &Index, 上限: usize) -> Result<usize> {
    let 路径集: Vec<String> = {
        let mut s = index
            .conn()
            .prepare("SELECT DISTINCT path FROM note_versions WHERE reason=?1")?;
        let r = s.query_map([手工], |r| r.get::<_, String>(0))?;
        r.filter_map(|x| x.ok()).collect()
    };
    let mut 删了 = 0usize;
    for p in 路径集 {
        let 多余: Vec<(i64, String)> = {
            let mut s = index.conn().prepare(
                "SELECT id, blob_path FROM note_versions
                 WHERE path=?1 AND reason=?2
                 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?3",
            )?;
            let r = s.query_map(params![p, 手工, 上限 as i64], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
            r.filter_map(|x| x.ok()).collect()
        };
        for (id, blob) in 多余 {
            删行连blob(index, id, &blob)?;
            删了 += 1;
        }
    }
    Ok(删了)
}

/// 版本库的写闸：**读闸 = 有一个会写版本行的事务在跑；写闸 = 清扫在跑。**
///
/// 落快照是"先写 blob、再插行"，而插进去的行要等**外层事务提交**别人才看得见。
/// 清扫按"行里有没有人指着"判孤儿——两件事撞上，刚写好的 blob 会被当成孤儿删掉，
/// 随后提交的行就指向一个不存在的文件。所以闸必须罩到**提交**为止，
/// 不能只罩 `落一条`（它返回时事务还没提交）。
///
/// 以前清扫在开库那一刻同步跑，不可能与保存重叠，用不着这把闸；现在它挪到了
/// 界面起来之后的后台，重叠就成了常态。
static 写闸: RwLock<()> = RwLock::new(());

/// 把一个**会写版本行**的事务包进读闸，事务提交后才放行。
pub fn 写事务<T>(f: impl FnOnce() -> Result<T>) -> Result<T> {
    let _闸 = 写闸.read().unwrap_or_else(|e| e.into_inner());
    f()
}

/// 空闲清扫：两件事一起做——`manual` 超上限的删掉，没有行指着的 blob 删掉。
///
/// **不在开库时同步跑**：`清孤儿` 要遍历整个 `.note/versions/`，而每篇最多留
/// 上百份，库用久了这个目录会有很多文件。它也不是正确性的一环（多留几份快照、
/// 几个孤儿文件只是占盘），所以壳在界面起来之后才把它丢进后台。
///
/// 整趟拿写闸（见 `写闸`）：清扫期间进来的版本写事务会等它做完。等的是
/// 后台补索引，不是界面的读命令——读走的是另一条只读连接。
pub fn 清扫(index: &Index) -> Result<(usize, usize)> {
    let _闸 = 写闸.write().unwrap_or_else(|e| e.into_inner());
    let 删行 = 清理(index, 手工保留上限)?;
    let 删文件 = 清孤儿(index)?;
    Ok((删行, 删文件))
}

/// 清掉没有行指着的 blob（写完 blob、还没插上行就断了的那种残留）。
///
/// 它是全目录遍历，只该在空闲清扫（[`清扫`]）里跑，不要塞进开库路径。
/// 私有同 [`清理`]：锁外的调用就是"把刚落下的 blob 当孤儿删掉"那条 bug。
fn 清孤儿(index: &Index) -> Result<usize> {
    let 根 = index.root().join(".note/versions");
    if !根.is_dir() {
        return Ok(0);
    }
    let 指着: HashSet<String> = {
        let mut s = index
            .conn()
            .prepare("SELECT blob_path FROM note_versions")?;
        let r = s.query_map([], |r| r.get::<_, String>(0))?;
        r.filter_map(|x| x.ok()).collect()
    };
    let mut 删了 = 0usize;
    for 条 in walkdir::WalkDir::new(&根)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !条.file_type().is_file() {
            continue;
        }
        // **比的是库根相对路径**（`.note/versions/<目录>/<hash>`），不是相对
        // `.note/versions/` 的那一截——行里存的是前者。两边口径不一致的话
        // 每一份快照都会被当成孤儿删掉，而撤销的落点正是这些文件。
        let Ok(相对) = 条.path().strip_prefix(index.root()) else {
            continue;
        };
        let 相对 = 相对.to_string_lossy().replace('\\', "/");
        if 指着.contains(&相对) {
            continue;
        }
        let _ = std::fs::remove_file(条.path());
        删了 += 1;
    }
    Ok(删了)
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // 测试名是给人读的中文短语

    use super::*;
    use crate::service::Hub;

    fn 造库() -> (tempfile::TempDir, Hub) {
        let d = tempfile::tempdir().unwrap();
        let hub = Hub::open(d.path()).unwrap();
        (d, hub)
    }

    fn 写(hub: &mut Hub, rel: &str, 正文: &str) {
        hub.save_note(rel, 正文).unwrap();
    }

    /// 列出某一篇的历史。
    ///
    /// 走**后台那条连接**：主连接在 GUI 里是只读的（docs/03 §后端调用纪律），
    /// 测试也不该顺手破坏这条不变量。两条连接指向同一个库文件，看得到同一批行。
    fn 列(hub: &Hub, rel: &str) -> Vec<版本行> {
        let h = hub.indexer();
        let g = h.lock().unwrap();
        列出(&g, rel).unwrap()
    }

    /// 直接动库（挪时间、插一行）。测试要绕过写路径时用。
    fn 动库<F, R>(hub: &Hub, f: F)
    where
        F: FnOnce(&crate::index::Index) -> R,
    {
        let h = hub.indexer();
        let g = h.lock().unwrap();
        f(&g);
    }

    /// 前像就是"那次操作之前盘上的内容"：存一版之后历史里躺着的是**上一版**。
    #[test]
    fn 快照存的是改之前那一份() {
        let (d, mut hub) = 造库();
        写(&mut hub, "notes/甲.md", "第一版\n");
        写(&mut hub, "notes/甲.md", "第二版\n");
        let 行 = 列(&hub, "notes/甲.md");
        assert_eq!(行.len(), 1, "合并窗口内只留一条：{行:?}");
        assert_eq!(
            读回(d.path(), &行[0]).unwrap(),
            "第一版\n".as_bytes(),
            "快照该是改之前那一份"
        );
    }

    /// 存了没改过的文件不该凭空多出一条。
    #[test]
    fn 存了没改过的文件不多出一条() {
        let (_d, mut hub) = 造库();
        写(&mut hub, "notes/甲.md", "第一版\n");
        写(&mut hub, "notes/甲.md", "第一版\n");
        let 行 = 列(&hub, "notes/甲.md");
        assert_eq!(行.len(), 1, "{行:?}");
    }

    /// 隔得够久就是另一次编辑，不该被合并掉。
    ///
    /// 存三遍才有两版可看：**新文件没有前像**，所以第一遍存完历史还是空的，
    /// 第二遍才把"第一版"记下来。
    #[test]
    fn 隔过合并窗口的历史都留着() {
        let (_d, mut hub) = 造库();
        写(&mut hub, "notes/甲.md", "第一版\n");
        写(&mut hub, "notes/甲.md", "第二版\n");
        assert_eq!(列(&hub, "notes/甲.md").len(), 1, "第二遍才记下第一版");
        // 把上一条挪到窗口之外：合并窗口看的是时间，测试不该去等 30 分钟
        动库(&hub, |ix| {
            ix.conn()
                .execute(
                    "UPDATE note_versions SET created_at=created_at-?1 WHERE path=?2",
                    params![合并窗口毫秒 + 1000, "notes/甲.md"],
                )
                .unwrap();
        });
        写(&mut hub, "notes/甲.md", "第三版\n");
        let 行 = 列(&hub, "notes/甲.md");
        assert_eq!(行.len(), 2, "两次编辑该留两版：{行:?}");
    }

    /// `ai_applied` 是撤销的落点：它不参与合并，也不被清理。
    #[test]
    fn AI落盘那条不合并不清理() {
        let (_d, mut hub) = 造库();
        写(&mut hub, "notes/甲.md", "第一版\n");
        // 直接插一条 AI 落盘快照（AI 那条路是 M3 后面几档的事）
        动库(&hub, |ix| {
            ix.conn()
                .execute(
                    "INSERT INTO note_versions(path,note_id,content_hash,blob_path,reason,created_at)
                     VALUES('notes/甲.md','','deadbeef','.note/versions/x/deadbeef',?1,0)",
                    [AI落盘],
                )
                .unwrap();
        });
        写(&mut hub, "notes/甲.md", "第二版\n");
        let 行 = 列(&hub, "notes/甲.md");
        assert!(
            行.iter().any(|r| r.reason == AI落盘),
            "AI 那条不该被合并掉：{行:?}"
        );
        动库(&hub, |ix| 清理(ix, 0).unwrap());
        let 行 = 列(&hub, "notes/甲.md");
        assert!(
            行.iter().any(|r| r.reason == AI落盘),
            "清理不该动 AI 那条：{行:?}"
        );
        assert!(
            !行.iter().any(|r| r.reason == 手工),
            "手工那条该被清掉：{行:?}"
        );
    }

    /// **走真实保存路径**的那一笔：对话框点「替换」之后落盘，前像必须记成
    /// `ai_applied`，并且连着两次各留一条——不许被 `manual` 那条 30 分钟合并窗口
    /// 合成一条。真机实测过后果：两次 AI 改写相隔一分钟只留下一条前像，
    /// 模型动手之前的那份原文就此取不回来。
    #[test]
    fn AI落的那一笔走保存路径也各留一条() {
        let (d, mut hub) = 造库();
        // 新建那一次没有前像可记（盘上本来没这篇）
        hub.save_note_write("notes/甲.md", "第一版\n", None, 手工)
            .unwrap();
        hub.save_note_write("notes/甲.md", "第二版\n", None, AI落盘)
            .unwrap();
        hub.save_note_write("notes/甲.md", "第三版\n", None, AI落盘)
            .unwrap();
        // 同步那一半只排队，blob 与行由后台那一半落（守 8ms 红线）：手动冲一次，
        // 等价于后台跑过一趟。真机上是 reindex 那一趟带的
        动库(&hub, |ix| {
            落待落(hub.vault(), ix, "notes/甲.md").unwrap();
        });
        let 行 = 列(&hub, "notes/甲.md");
        let AI的: Vec<&版本行> = 行.iter().filter(|r| r.reason == AI落盘).collect();
        assert_eq!(AI的.len(), 2, "两次 AI 落盘该各留一条：{行:?}");
        let mut 前像: Vec<String> = AI的
            .iter()
            .map(|r| String::from_utf8(读回(d.path(), r).unwrap()).unwrap())
            .collect();
        前像.sort();
        assert_eq!(
            前像,
            vec!["第一版\n".to_string(), "第二版\n".to_string()],
            "前像必须是各自改之前那一份"
        );
    }

    /// 删掉一篇之后，版本必须还在（它活得比笔记久）。
    #[test]
    fn 笔记进了回收站版本还在() {
        let (d, mut hub) = 造库();
        写(&mut hub, "notes/甲.md", "第一版\n");
        hub.note_trash_file("notes/甲.md").unwrap();
        hub.index_trashed("notes/甲.md").unwrap();
        let 行 = 列(&hub, "notes/甲.md");
        assert_eq!(行.len(), 1, "删除前那一份得留下：{行:?}");
        assert_eq!(行[0].reason, 删除前);
        assert_eq!(读回(d.path(), &行[0]).unwrap(), "第一版\n".as_bytes());
    }

    /// blob 读回来对不上 hash 就是坏档：宁可报错也不还原半截内容。
    #[test]
    fn 坏掉的快照读不回来() {
        let (d, mut hub) = 造库();
        写(&mut hub, "notes/甲.md", "第一版\n");
        写(&mut hub, "notes/甲.md", "第二版\n");
        let 行 = 列(&hub, "notes/甲.md");
        assert_eq!(行.len(), 1, "{行:?}");
        let 坏 = d.path().join(&行[0].blob_path);
        std::fs::write(&坏, "被截断了").unwrap();
        assert!(读回(d.path(), &行[0]).is_err(), "坏档必须报错而不是还回去");
    }

    /// 库里没有这一篇时，列历史是空的而不是报错。
    #[test]
    fn 没有这篇就空表() {
        let (_d, hub) = 造库();
        assert!(列(&hub, "notes/没有.md").is_empty());
    }

    /// 改名之后历史得跟着走。**钥匙是路径**，不搬的话历史就掉在旧路径上，
    /// 撤销在新路径下找不到落点。
    #[test]
    fn 改名之后历史跟着走() {
        let (d, mut hub) = 造库();
        写(&mut hub, "notes/甲.md", "第一版\n");
        写(&mut hub, "notes/甲.md", "第二版\n");
        assert_eq!(列(&hub, "notes/甲.md").len(), 1, "先有一版");
        hub.note_move("notes/甲.md", "notes/乙.md").unwrap();
        assert!(
            列(&hub, "notes/甲.md").is_empty(),
            "旧路径不该还留着行：{:?}",
            列(&hub, "notes/甲.md")
        );
        let 行 = 列(&hub, "notes/乙.md");
        assert_eq!(行.len(), 1, "历史得跟着笔记一起搬：{行:?}");
        assert_eq!(读回(d.path(), &行[0]).unwrap(), "第一版\n".as_bytes());
    }

    /// **重开一次库，快照不许丢**。
    ///
    /// 清扫里的"清孤儿"（没有行指着的 blob 删掉）钉的是"行里存的 blob 路径"
    /// 与目录遍历两边口径一致：曾经一边存库根相对、另一边比 `.note/versions/`
    /// 相对，于是**每一份快照都被当成孤儿删掉**——而撤销的落点正是这些文件。
    /// 行还在、文件没了，读回当场报错。
    ///
    /// 开库本身不扫（见 `Hub::清扫版本历史`），所以这里显式跑一趟。
    #[test]
    fn 重开库之后快照还在() {
        let (d, mut hub) = 造库();
        写(&mut hub, "notes/甲.md", "第一版\n");
        写(&mut hub, "notes/甲.md", "第二版\n");
        let 行 = 列(&hub, "notes/甲.md");
        assert_eq!(行.len(), 1, "{行:?}");
        drop(hub);
        let 重开的 = Hub::open(d.path()).unwrap();
        重开的.清扫版本历史().unwrap();
        let 行 = 列(&重开的, "notes/甲.md");
        assert_eq!(行.len(), 1, "行不该被清掉：{行:?}");
        assert_eq!(
            读回(d.path(), &行[0]).unwrap(),
            "第一版\n".as_bytes(),
            "blob 文件不该被当成孤儿删掉"
        );
    }

    /// 真的没有行指着的 blob 该被清掉（写完 blob、还没插行就断了的残留）。
    ///
    /// 同时钉住"开库不做清扫"：重开之后残留还在，清扫跑完才消失——
    /// 否则这个目录遍历又悄悄回到了冷启动路径上。
    #[test]
    fn 没有行指着的blob要等清扫才被清掉() {
        let (d, mut hub) = 造库();
        写(&mut hub, "notes/甲.md", "第一版\n");
        写(&mut hub, "notes/甲.md", "第二版\n");
        let 残留 = d.path().join(".note/versions/残留目录/0123456789abcdef");
        std::fs::create_dir_all(残留.parent().unwrap()).unwrap();
        std::fs::write(&残留, "没人要的东西").unwrap();
        drop(hub);
        let 重开的 = Hub::open(d.path()).unwrap();
        assert!(残留.exists(), "开库不该同步扫版本目录");
        重开的.清扫版本历史().unwrap();
        assert!(!残留.exists(), "没人指着的残留该被清掉");
    }

    /// 落不下来的时候，没落成的那些要回到队列里——不能"取走即丢"。
    ///
    /// 触发条件很实在：磁盘满、`.note/versions` 被同名文件顶掉、权限没了。
    #[test]
    fn 落不下来时快照留在队列里() {
        let (d, hub) = 造库();
        std::fs::create_dir_all(d.path().join(".note")).unwrap();
        // 拿同名文件顶掉 blob 目录：写 blob 必然失败
        std::fs::write(d.path().join(".note/versions"), "占位").unwrap();
        let h = hub.indexer();
        let g = h.lock().unwrap();
        for 正文 in ["第一版\n", "第二版\n"] {
            g.推待落(待落 {
                rel: "notes/甲.md".into(),
                前像: 正文.as_bytes().to_vec(),
                reason: 手工,
                时刻: 现在(),
            });
        }
        assert!(落待落(hub.vault(), &g, "notes/甲.md").is_err());
        assert_eq!(
            g.取待落("notes/甲.md").len(),
            2,
            "两条都没落成，都得回到队列里"
        );
    }
}
