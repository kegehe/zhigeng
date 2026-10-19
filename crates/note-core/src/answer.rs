//! 带引用的问答（M2 档 2a）：上下文组装 → 生成 → **引用完整性判定** → `ai_runs` 审计。
//!
//! 四条规矩：
//!
//! 1. **模型只许引用给定编号**。回答里出现没给过的编号就是幻觉，判违规后**重生成一次**，
//!    再违规就降级成"依据不足"。这条是 M2 验收里唯一**不需要真模型就能钉死**的硬门
//!    （幻觉率 = 0），所以判据全做成纯函数，用假回答就能跑红。
//! 2. **零候选不打模型**。库里没有依据时直接答"依据不足"——省钱，也省一次"模型硬编一段"
//!    的机会。docs/04 §拒答判定 的判定顺序就是"先算有没有任何依据，再算是否充分"。
//! 3. **阈值没标定之前不许假装标定过**。`docs/04` 说阈值由评测集标定，而 v1 评测集挂的是
//!    假向量（负样本的 rrf 比真命中还高），所以这一档**只用"有没有候选"这一条判据**，
//!    分数阈值留成显式常量并标着"未标定"，不在界面上吹"置信度"。
//! 4. **每次生成都落 `ai_runs`**，包括失败的那次。审计页要的是"这个库问过什么、
//!    引用了哪些块、花掉多少 token"，漏一条就是一条查无实据的账。

use std::collections::BTreeSet;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::retrieve;
use crate::vault::Vault;
use crate::{Error, Result};

/// 一条依据。`label` 是给模型看的那把短标签（K1、K2…），`block_id` 是还原成可点击链接
/// 要的真 ID。字段名走英文：跨边界的 DTO 一律 camelCase（护栏第 5 条）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct 依据 {
    pub label: String,
    pub block_id: String,
    pub path: String,
    pub title: String,
    pub crumb: String,
    pub snippet: String,
}

/// 一次问答送出去/收回来的量。定义在 `ai` 那边（`chat` 与 `embed` 都回它），这里只是转用。
pub use crate::ai::用量;

/// 组装上下文。**形状与 docs/04 §上下文组装 一字不差**：
///
/// ```text
/// [K3] 主动层设计 > 触发点 (b-k3x9m2v7qa)
/// 核心问题是"什么时候打断用户"。
/// ```
///
/// 括号里那串真实块 ID 是给程序还原成可点击链接用的，模型只会引用 `K3`。
pub fn 组装(依据: &[依据]) -> String {
    let mut 出 = String::new();
    for d in 依据 {
        出.push_str(&format!(
            "[{}] {} ({})\n{}\n\n",
            d.label, d.crumb, d.block_id, d.snippet
        ));
    }
    出.push_str("以上是可以引用的全部片段。");
    出
}

/// 系统提示。**"只能引用给定编号"这句是硬门的前半段**，后半段在 `越界引用` 里由程序判——
/// 提示词永远只是请求，不是保证。
pub const 系统提示: &str =
    "你是本地笔记助手。只依据用户给出的片段回答，每个论断后面标注它来自哪个片段编号，形如 [K2]。\
如果片段不足以回答，只回答「依据不足」并说明缺什么。绝不编造编号，也不引用没给过的片段。";

/// 抽出回答里出现过的所有编号（`[K3]` 与裸 `K3` 都认，只认大写 K + 数字）。
pub fn 引用编号(回答: &str) -> Vec<String> {
    let 字: Vec<char> = 回答.chars().collect();
    let mut 出 = Vec::new();
    let mut i = 0;
    while i < 字.len() {
        if 字[i] != 'K' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < 字.len() && 字[j].is_ascii_digit() {
            j += 1;
        }
        // 至少一位数字；后面紧跟字母数字的（`K1x`）不算编号，那是个词
        if j > i + 1 && !字.get(j).is_some_and(|c| c.is_alphanumeric()) {
            let 号: String = 字[i..j].iter().collect();
            if !出.contains(&号) {
                出.push(号);
            }
        }
        i = j.max(i + 1);
    }
    出
}

/// 回答里**没给过**的编号。非空即违规。
pub fn 越界引用(回答: &str, 给定: &BTreeSet<String>) -> Vec<String> {
    引用编号(回答)
        .into_iter()
        .filter(|号| !给定.contains(号))
        .collect()
}

/// 生成结果。`依据不足` 为真时 `文本` 是那句拒答/降级话，`引用` 一定为空。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct 答复 {
    pub text: String,
    pub citations: Vec<依据>,
    pub insufficient: bool,
    /// 违规后重生成过一次（审计页上要能看出这一条不是第一次就过）
    pub retried: bool,
    pub candidates: usize,
    pub in_tokens: usize,
    pub out_tokens: usize,
    pub ms: u64,
    pub model: String,
}

/// 发问这一跳抽象出来，是为了**用假回答测硬门**：真模型有没有幻觉不由我们保证，
/// 但"出现了幻觉我们放没放过去"完全可以在用例里钉死。
pub trait 发问 {
    fn 问(&mut self, 内容: &str) -> Result<(String, 用量)>;
}

impl<F> 发问 for F
where
    F: FnMut(&str) -> Result<(String, 用量)>,
{
    fn 问(&mut self, 内容: &str) -> Result<(String, 用量)> {
        self(内容)
    }
}

/// 拒答门的阈值：候选里**最强的那条查询词覆盖率**低于它，就不打模型、直接答"依据不足"。
///
/// **标定于 2026-10-18 的评测集 v1（22 题，走的是"关键词 + 链接"，语义那一路没开）**：
/// 负样本最高 0.143（7 个词里碰上 1 个），正样本最低 0.500——间隙在 (0.143, 0.500) 之间，
/// 取 1/3 落在中间，两边都留了余量。这句话能直接解释给用户："至少三分之一的关键词
/// 出现在同一段里，才算你的笔记里真记过这件事"。
///
/// **它不是物理常数**：换语料、换分词口径、或把语义那一路开起来（那是另一把尺子，
/// 相似度普遍 0.7 以上，混进来这个阈值就白标），都必须重标。重标的入口：
/// `note eval <库> --suite testdata/eval/v1.toml`，看"依据强度分布"那一段。
pub const 依据下限: f64 = 1.0 / 3.0;

/// 候选里最强的依据强度。**纯函数**，判据只有一份：界面上、审计里、门上都读它。
///
/// 看的是"最强"而不是"第一名"：名次由 RRF 定而 RRF 不分强弱，只靠链接回来的那条排到第一时
/// top-1 覆盖率会是 0，把"库里有依据"误判成没有（这条在真数据上照出来过）。
pub fn 最强依据(命中: &[retrieve::命中]) -> f64 {
    命中.iter().map(|h| h.evidence).fold(0.0_f64, f64::max)
}

/// 门拦下来时的那条答复。**一次模型都不打**，所以 token 与 ms 都是 0——
/// 审计里看到 `in 0 / out 0` 就该知道是被门拦了，不是模型答的。
pub fn 无依据(问题: &str, 候选数: usize, 最强: f64) -> 答复 {
    答复 {
        text: if 候选数 == 0 {
            format!("我在你的笔记里没有找到关于「{问题}」的依据。要不要把这一条记下来？")
        } else {
            format!(
                "「{问题}」在你的笔记里最相关的一段也只对上 {:.0}% 的关键词，不到三分之一。\
                 这不算依据，所以没去问模型——要它答，它就会自己编。要不要把这一条记下来？",
                最强 * 100.0
            )
        },
        citations: Vec::new(),
        insufficient: true,
        retried: false,
        candidates: 候选数,
        in_tokens: 0,
        out_tokens: 0,
        ms: 0,
        model: String::new(),
    }
}

/// 组装 → 生成 → 判引用 → 违规就重生成一次 → 还违规就降级。
pub fn 生成(依据: &[依据], 问题: &str, 发问者: &mut impl 发问) -> Result<答复> {
    let 给定: BTreeSet<String> = 依据.iter().map(|d| d.label.clone()).collect();
    if 依据.is_empty() {
        // 零候选：一次模型都不打。省的不只是钱——没有片段可依据时，模型只会靠自己编
        return Ok(答复 {
            text: format!("我在你的笔记里没有找到关于「{问题}」的依据。要不要把这一条记下来？"),
            citations: Vec::new(),
            insufficient: true,
            retried: false,
            candidates: 0,
            in_tokens: 0,
            out_tokens: 0,
            ms: 0,
            model: String::new(),
        });
    }
    let 头 = format!("{}{}", 组装(依据), 问题尾(问题));
    let 起 = std::time::Instant::now();
    let (文本, 量) = 发问者.问(&头)?;
    let 一次 = 越界引用(&文本, &给定);
    let (最终, 重试过, 总用量) = if 一次.is_empty() {
        (文本, false, 量)
    } else {
        let 纠正 = format!(
            "{}\n\n你上一条引用了没给过的编号：{}。只允许这些：{}。请重答（不够依据就回答「依据不足」）。",
            头,
            一次.join("、"),
            给定.iter().cloned().collect::<Vec<_>>().join("、")
        );
        let (再答, 再量) = 发问者.问(&纠正)?;
        let 还越界 = 越界引用(&再答, &给定);
        if !还越界.is_empty() {
            // 第二次还有幻觉：不再赌第三次，直接降级。这是"幻觉率 = 0"的兑现方式——
            // 我们不敢保证模型不编，但保证**编了的东西不会作为答案递给用户**
            (
                format!(
                    "依据不足：模型两次都引用了不存在的片段编号（{}），这条回答没有采信。",
                    还越界.join("、")
                ),
                true,
                用量 {
                    in_tokens: 量.in_tokens + 再量.in_tokens,
                    out_tokens: 量.out_tokens + 再量.out_tokens,
                },
            )
        } else {
            (
                再答,
                true,
                用量 {
                    in_tokens: 量.in_tokens + 再量.in_tokens,
                    out_tokens: 量.out_tokens + 再量.out_tokens,
                },
            )
        }
    };
    let 用了 = 引用编号(&最终);
    let citations: Vec<依据> = 依据
        .iter()
        .filter(|d| 用了.contains(&d.label))
        .cloned()
        .collect();
    let 不足 = 最终.contains("依据不足") || citations.is_empty();
    Ok(答复 {
        text: 最终,
        insufficient: 不足,
        retried: 重试过,
        citations,
        candidates: 依据.len(),
        in_tokens: 总用量.in_tokens,
        out_tokens: 总用量.out_tokens,
        ms: 起.elapsed().as_millis() as u64,
        model: String::new(),
    })
}

fn 问题尾(问题: &str) -> String {
    format!("\n\n问题：{问题}")
}

/// 把检索命中换成带编号的依据。编号按给出顺序 K1、K2……（**名次就是编号**，
/// 模型看到 K1 排第一，不需要再猜我们的分数怎么算）。
pub fn 排依据(命中: &[retrieve::命中], 上限: usize) -> Vec<依据> {
    命中
        .iter()
        .take(上限)
        .enumerate()
        .map(|(i, h)| 依据 {
            label: format!("K{}", i + 1),
            block_id: h.chunk_id.to_string(),
            path: h.path.clone(),
            title: h.title.clone(),
            crumb: if h.header_path.is_empty() {
                h.title.clone()
            } else {
                format!("{} > {}", h.title, h.header_path)
            },
            snippet: h.snippet.clone(),
        })
        .collect()
}

/// 一次问答的完整一趟：检索 → 组装 → 生成 → 落 `ai_runs`。
/// **含两次网络往返的可能（重生成），所以调用方必须在锁外跑它。**
pub fn ask(vault: &Vault, conn: &Connection, 问题: &str) -> Result<答复> {
    let cfg = crate::ai::load(vault)?;
    let 模型 = cfg
        .chat_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Error::Invalid("没填对话模型名。问答要有对话模型；嵌入模型只管检索那一路。".into())
        })?;
    let 检索 = crate::retrieve::混合或退回(vault, conn, 问题)?;
    // **拒答门在打模型之前**：候选里最强的覆盖率不到阈值，就一次网络都不发。
    // 省的是钱，但更重要的是不给模型"没依据也要编一段"的机会——幻觉率 = 0 这条硬门，
    // 到这一步才真正闭上：以前只闭住了"编出来的编号"，闭不住"有编号但不相干"。
    let 最强 = 最强依据(&检索.hits);
    let 拦了 = 最强 < 依据下限;
    let 依据 = if 拦了 {
        Vec::new()
    } else {
        排依据(&检索.hits, 引用上限)
    };
    let mut 答复 = if 拦了 {
        无依据(问题, 检索.hits.len(), 最强)
    } else {
        let mut 发问者 = |内容: &str| crate::ai::chat(&cfg, 系统提示, 内容);
        生成(&依据, 问题, &mut 发问者)?
    };
    // 重排那一趟的钱要并进同一笔账：用户看到的是"这次问 AI 花了多少"，
    // 把重排的 token 丢掉等于账面上少一笔真实支出。被门拦下时那两个数本来就是 0
    // （门在检索之后、发问之前，而重排发生在检索内部——拦下了就不会有重排的钱）
    答复.in_tokens += 检索.rerank_in;
    答复.out_tokens += 检索.rerank_out;
    答复.model = 模型.to_string();
    let 记 = 落审计 {
        conn,
        模型: 模型.to_string(),
        // 审计里的"候选"与界面那句「引用 x/y」的 y 是同一个数：被门拦下时它是检索
        // 实际返回的条数（有候选但都不够依据），不是 0——写成 0 会把"拦下来了"与
        // "什么都没搜到"混成同一笔账
        候选: 答复.candidates,
        语义路: 检索.semantic,
        图路: 检索.graph,
        重排: 检索.reranked,
    };
    if let Err(e) = 记.写(&答复) {
        // 审计写失败不能把答案吞掉：答案已经生成完了，钱也花完了。
        // 但也不能静默——那正是"账对不上"的来路
        tracing::warn!("ai_runs 没落进去（{e}），答案照给");
    }
    Ok(答复)
}

/// 送给模型的片段数。docs/04 的召回配额是每路 30，全塞进上下文既烧钱又稀释注意力。
pub const 引用上限: usize = 8;

/// 审计页上的一条。`ai_runs` 记的是"这个库问过什么"，界面上要能看出：
/// 有没有被采纳、引用了哪几块、是不是重试过、花了多少 token。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct 运行 {
    pub id: String,
    pub model: String,
    pub ok: bool,
    pub error: Option<String>,
    pub in_tokens: i64,
    pub out_tokens: i64,
    pub duration_ms: i64,
    pub cited: Vec<String>,
    pub retried: bool,
    pub semantic: bool,
    /// 这一趟图扩展那一路开没开。**旧记录缺这个键时按 false 读**——那几次它确实还没做，
    /// 不是"读不出来所以猜一个"
    pub graph: bool,
    /// 这一趟真被模型重排过没有。**开着开关但回包读不出**，这里也是 false——
    /// "配了"与"生效了"在审计页上必须是两栏
    pub reranked: bool,
    pub candidates: i64,
    pub created_at: i64,
}

/// 最近的若干次生成。**失败的那几次也要在**——审计页只列成功的就不是审计。
pub fn 最近运行(conn: &Connection, limit: i64) -> Result<Vec<运行>> {
    let mut s = conn.prepare(
        "SELECT id, model, ok, error, in_tokens, out_tokens, duration_ms, cited_blocks_json, created_at
         FROM ai_runs ORDER BY created_at DESC LIMIT ?1",
    )?;
    let rows = s.query_map([limit], |r| {
        let 裸: String = r.get(7)?;
        let 解: serde_json::Value = serde_json::from_str(&裸).unwrap_or_default();
        Ok(运行 {
            id: r.get(0)?,
            model: r.get(1)?,
            ok: r.get::<_, i64>(2)? != 0,
            error: r.get(3)?,
            in_tokens: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
            out_tokens: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
            duration_ms: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
            cited: 解
                .get("cited")
                .and_then(|c| c.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            retried: 解.get("retried").and_then(|x| x.as_bool()).unwrap_or(false),
            semantic: 解
                .get("semantic")
                .and_then(|x| x.as_bool())
                .unwrap_or(false),
            graph: 解.get("graph").and_then(|x| x.as_bool()).unwrap_or(false),
            reranked: 解
                .get("reranked")
                .and_then(|x| x.as_bool())
                .unwrap_or(false),
            candidates: 解.get("candidates").and_then(|x| x.as_i64()).unwrap_or(0),
            created_at: r.get(8)?,
        })
    })?;
    Ok(rows.filter_map(|x| x.ok()).collect())
}

struct 落审计<'a> {
    conn: &'a Connection,
    模型: String,
    候选: usize,
    /// 这一趟那两路**可开关**的路开没开。放在结构体里而不是 `写` 的位置参数上：
    /// 两个同类型 bool 挨着传，早晚会有一次传反
    语义路: bool,
    图路: bool,
    /// 这一趟的顺序是不是模型重排过的（"配了开关"与"生效了"是两件事）
    重排: bool,
}

impl 落审计<'_> {
    fn 写(self, 答: &答复) -> Result<()> {
        let id = format!("r-{}", &crate::capture::gen_note_id()[2..]);
        let 时候 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let 引用: Vec<String> = 答.citations.iter().map(|c| c.block_id.clone()).collect();
        self.conn.execute(
            "INSERT INTO ai_runs(id,task,model,trigger,in_tokens,out_tokens,cost_usd,ok,error,duration_ms,cited_blocks_json,created_at)
             VALUES(?1,'ask',?2,'user',?3,?4,NULL,?5,?6,?7,?8,?9)",
            params![
                id,
                self.模型,
                答.in_tokens as i64,
                答.out_tokens as i64,
                !答.insufficient as i64,
                if 答.insufficient { Some("依据不足或降级") } else { None },
                答.ms as i64,
                serde_json::to_string(&serde_json::json!({
                    "cited": 引用,
                    "candidates": self.候选,
                    "retried": 答.retried,
                    "semantic": self.语义路,
                    "graph": self.图路,
                    "reranked": self.重排,
                }))
                .map_err(|e| Error::Invalid(format!("审计的引用清单序列化失败：{e}")))?,
                时候,
            ],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn 依据集(n: usize) -> Vec<依据> {
        (0..n)
            .map(|i| 依据 {
                label: format!("K{}", i + 1),
                block_id: format!("9{i}"),
                path: format!("notes/甲{i}.md"),
                title: format!("甲{i}"),
                crumb: format!("甲{i} > 节"),
                snippet: "正文内容".into(),
            })
            .collect()
    }

    fn 给定(依据: &[依据]) -> BTreeSet<String> {
        依据.iter().map(|d| d.label.clone()).collect()
    }

    /// 一台会照本宣科的假模型：按脚本依次回话，并记下每次收到的内容
    struct 假 {
        脚本: RefCell<Vec<String>>,
        收到: Rc<RefCell<Vec<String>>>,
    }

    impl 发问 for 假 {
        fn 问(&mut self, 内容: &str) -> Result<(String, 用量)> {
            self.收到.borrow_mut().push(内容.to_string());
            let 文本 = {
                let mut 脚 = self.脚本.borrow_mut();
                if 脚.is_empty() {
                    panic!("假模型的话用完了：用例没准备这么多次调用");
                }
                脚.remove(0)
            };
            Ok((
                文本,
                用量 {
                    in_tokens: 10,
                    out_tokens: 5,
                },
            ))
        }
    }

    #[test]
    fn 组装的形状与规格一致() {
        let 文 = 组装(&依据集(2));
        assert!(文.starts_with("[K1] 甲0 > 节 (90)\n正文内容\n\n"), "{文}");
        assert!(文.contains("[K2] 甲1 > 节 (91)"), "{文}");
        assert!(文.ends_with("以上是可以引用的全部片段。"), "{文}");
        assert!(
            组装(&[]).ends_with("全部片段。"),
            "空依据也要能组装（调用方会先挡住）"
        );
    }

    #[test]
    fn 编号抽取认方括号也认裸写() {
        assert_eq!(
            引用编号("见 [K1] 与 [K2]。"),
            vec!["K1".to_string(), "K2".to_string()]
        );
        assert_eq!(引用编号("K3 里说过"), vec!["K3".to_string()]);
        assert_eq!(
            引用编号("[K10] 和 [K1]"),
            ["K10".to_string(), "K1".to_string()]
        );
        // 重复引用只记一次
        assert_eq!(引用编号("[K1]…[K1]"), vec!["K1".to_string()]);
        // `K1x` 是个词不是编号；小写 k 也不算
        assert!(
            引用编号("K1x 和 k2").is_empty(),
            "{:?}",
            引用编号("K1x 和 k2")
        );
        assert!(引用编号("没有编号").is_empty());
    }

    #[test]
    fn 没给过的编号立刻判违规() {
        let 给定 = 给定(&依据集(3));
        assert!(越界引用("[K1] 与 [K3]", &给定).is_empty());
        assert_eq!(越界引用("[K9] 我编的", &给定), vec!["K9".to_string()]);
        assert_eq!(
            越界引用("[K1] [K4] [K9]", &给定),
            ["K4".to_string(), "K9".to_string()]
        );
    }

    #[test]
    fn 零候选一次模型都不打() {
        let 收到 = Rc::new(RefCell::new(Vec::new()));
        let mut 假模型 = 假 {
            脚本: RefCell::new(vec![]),
            收到: 收到.clone(),
        };
        let 答 = 生成(&[], "红烧肉怎么做", &mut 假模型).unwrap();
        assert!(答.insufficient);
        assert!(答.text.contains("没有找到"), "{}", 答.text);
        assert!(答.citations.is_empty());
        assert_eq!(答.candidates, 0);
        assert!(收到.borrow().is_empty(), "零依据还去打模型就是白烧 token");
    }

    #[test]
    fn 规矩的回答留下可点击的引用() {
        let 依 = 依据集(3);
        let 收到 = Rc::new(RefCell::new(Vec::new()));
        let mut 假模型 = 假 {
            脚本: RefCell::new(vec!["快照要写到第二个目录 [K2]。".into()]),
            收到: 收到.clone(),
        };
        let 答 = 生成(&依, "备份去哪", &mut 假模型).unwrap();
        assert!(!答.insufficient);
        assert!(!答.retried);
        assert_eq!(答.citations.len(), 1);
        assert_eq!(答.citations[0].label, "K2");
        assert_eq!(
            答.citations[0].block_id, "91",
            "引用要能还原成块 ID，不然点不动"
        );
        let 第一趟 = 收到.borrow()[0].clone();
        assert!(
            第一趟.contains("[K2] 甲1 > 节 (91)"),
            "上下文得把编号与块 ID 一起给出去"
        );
        assert!(第一趟.ends_with("问题：备份去哪"), "{第一趟}");
    }

    #[test]
    fn 出现幻觉就重生成一次并把违规说回去() {
        let 依 = 依据集(2);
        let 收到 = Rc::new(RefCell::new(Vec::new()));
        let mut 假模型 = 假 {
            脚本: RefCell::new(vec!["[K9] 里说过。".into(), "正文在 [K1]。".into()]),
            收到: 收到.clone(),
        };
        let 答 = 生成(&依, "问", &mut 假模型).unwrap();
        assert!(答.retried, "要能看出这条是第二次才过的");
        assert!(!答.insufficient);
        assert_eq!(答.citations[0].label, "K1");
        assert_eq!(答.in_tokens, 20, "两趟的量要累加进审计");
        let 第二趟 = 收到.borrow()[1].clone();
        assert!(第二趟.contains("没给过的编号：K9"), "{第二趟}");
        assert!(第二趟.contains("只允许这些：K1、K2"), "{第二趟}");
    }

    #[test]
    fn 第二次还有幻觉就降级绝不递给用户() {
        let 依 = 依据集(2);
        let 收到 = Rc::new(RefCell::new(Vec::new()));
        let mut 假模型 = 假 {
            脚本: RefCell::new(vec!["[K7] 编的".into(), "还是 [K8]".into()]),
            收到,
        };
        let 答 = 生成(&依, "问", &mut 假模型).unwrap();
        assert!(答.insufficient, "幻觉答案绝不能作为答案返回");
        assert!(答.text.contains("没有采信"), "{}", 答.text);
        assert!(
            答.text.contains("K8"),
            "降级话要说出是哪个编号: {}",
            答.text
        );
        assert!(答.citations.is_empty());
        assert!(答.retried);
    }

    #[test]
    fn 回答自称依据不足就照实降级() {
        let 依 = 依据集(2);
        let 收到 = Rc::new(RefCell::new(Vec::new()));
        let mut 假模型 = 假 {
            脚本: RefCell::new(vec!["依据不足：片段里没提到糖色。".into()]),
            收到,
        };
        let 答 = 生成(&依, "红烧肉", &mut 假模型).unwrap();
        assert!(答.insufficient);
        assert!(答.citations.is_empty());
        assert!(!答.retried, "规矩地拒答不该被算成违规重试");
    }

    #[test]
    fn 没引用任何编号的回答也算依据不足() {
        let 依 = 依据集(2);
        let 收到 = Rc::new(RefCell::new(Vec::new()));
        let mut 假模型 = 假 {
            脚本: RefCell::new(vec!["备份很重要，记得做。".into()]),
            收到,
        };
        let 答 = 生成(&依, "备份", &mut 假模型).unwrap();
        assert!(
            答.insufficient,
            "没有编号就没有依据，这种泛泛而谈不能算答案"
        );
    }

    /// 拒答门的尺子：**阈值必须落在实测间隙里**，两头都留余量。
    /// 数字来自 2026-10-18 的 `note eval`（v1 套件 22 题，走"关键词 + 链接"，16 篇与
    /// 1216 篇两个库量出来一样）：负样本最高 0.143，正样本最低 0.500。
    ///
    /// 这条**故意是常量对常量的断言**（clippy 不喜欢，所以显式 expect）：它不是测运行时行为，
    /// 是一个"改了口径或换了语料就去重标"的绊线。真跑数据的那半在 `note eval` 的输出里。
    #[expect(
        clippy::assertions_on_constants,
        reason = "这是标定绊线，不是运行时判据"
    )]
    #[test]
    fn 阈值落在标定过的间隙里() {
        assert!(
            依据下限 > 0.143 && 依据下限 < 0.5,
            "阈值 {依据下限} 掉出实测间隙 (0.143, 0.500)：要么覆盖率口径变了，要么该重标"
        );
    }

    #[test]
    fn 最强依据看的是最强那条而不是第一名() {
        let 造 = |e: f64| retrieve::命中 {
            chunk_id: 1,
            note_id: "n-1".into(),
            path: "notes/甲.md".into(),
            title: "甲".into(),
            header_path: String::new(),
            snippet: "正文".into(),
            status: "active".into(),
            from: vec![retrieve::路::Keyword],
            rrf: 0.0164,
            evidence: e,
            similarity: 0.0,
        };
        // 名次第一的是只靠链接回来的（evidence 0），依据在第二条上
        let 列 = vec![造(0.0), 造(0.75)];
        assert!(
            (最强依据(&列) - 0.75).abs() < 1e-9,
            "取的是最大值，不是 top-1"
        );
        assert!(最强依据(&[]) < 依据下限, "空候选当然拦");
    }

    /// 只靠链接回来的候选**不能单独把一次提问送进模型**（用户拍板：能进上下文，
    /// 不能单独当依据）。这条钉的就是那个"不能"。
    #[test]
    fn 只有链接命中时门拦下来() {
        let 一条 = retrieve::命中 {
            chunk_id: 3,
            note_id: "n-3".into(),
            path: "notes/读完一句.md".into(),
            title: "读完一句".into(),
            header_path: String::new(),
            snippet: "下午和老周聊完".into(),
            status: "active".into(),
            from: vec![retrieve::路::Graph],
            rrf: 0.0164,
            evidence: 0.0,
            similarity: 0.0,
        };
        assert!(最强依据(&[一条]) < 依据下限);
    }

    #[test]
    fn 门拦下那条答复不打模型也说得清() {
        let 答 = 无依据("深蹲一百公斤要练多久", 5, 0.143);
        assert!(答.insufficient);
        assert!(答.citations.is_empty());
        assert_eq!(答.in_tokens + 答.out_tokens, 0, "一次网络都没打");
        assert_eq!(答.candidates, 5, "有候选但都不够依据，这个数不能记成 0");
        assert!(答.text.contains("14%"), "要说清对上几个词：{}", 答.text);
        assert!(答.text.contains("没去问模型"), "{}", 答.text);
        // 真空手是另一句话，别混成"覆盖率不够"
        let 空 = 无依据("红烧肉怎么炒糖色", 0, 0.0);
        assert!(空.text.contains("没有找到"), "{}", 空.text);
        assert!(!空.text.contains("%"), "没候选就别报百分比：{}", 空.text);
    }

    #[test]
    fn 每次生成都落账包括降级那次() {
        crate::index::注册向量扩展();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema::SCHEMA).unwrap();
        let 依 = 依据集(2);
        let 收到 = Rc::new(RefCell::new(Vec::new()));
        let mut 假模型 = 假 {
            脚本: RefCell::new(vec!["[K7] 编的".into(), "还是 [K8]".into()]),
            收到,
        };
        let 答 = 生成(&依, "问", &mut 假模型).unwrap();
        落审计 {
            conn: &conn,
            模型: "m1".into(),
            候选: 依.len(),
            语义路: true,
            图路: true,
            重排: true,
        }
        .写(&答)
        .unwrap();
        let 行 = 最近运行(&conn, 10).unwrap();
        assert_eq!(行.len(), 1);
        assert!(!行[0].ok, "降级那次要记成不 ok");
        assert_eq!(行[0].error.as_deref(), Some("依据不足或降级"));
        assert!(行[0].retried, "重试过要看得出来");
        assert!(行[0].semantic, "这一趟语义路开着");
        assert!(行[0].graph, "链接那一路开没开也要落在同一笔账里");
        assert_eq!(行[0].candidates, 2);
        assert_eq!(行[0].in_tokens, 20, "两趟的 token 累加");
        assert!(行[0].cited.is_empty(), "降级没有可采信的引用");
    }

    /// 审计读的是 json 里的键。**2026-10-18 之前那几笔没有 `graph` 键**，缺键必须读成
    /// "那一次确实没开"，不能读成开了——否则审计页上会出现一条从没存在过的通路。
    #[test]
    fn 旧记录里缺链接那个键就读成没开() {
        crate::index::注册向量扩展();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema::SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO ai_runs(id,task,model,trigger,in_tokens,out_tokens,cost_usd,ok,error,duration_ms,cited_blocks_json,created_at)
             VALUES('r-old0001','ask','m1','user',1,1,NULL,1,NULL,5,'{\"cited\":[],\"candidates\":1,\"retried\":false,\"semantic\":true}',1)",
            [],
        )
        .unwrap();
        let 行 = 最近运行(&conn, 10).unwrap();
        assert_eq!(行.len(), 1);
        assert!(行[0].semantic, "旧记录里写着的键照旧读得出来");
        assert!(!行[0].graph, "缺键不是\"未知\"，是\"那一次没开\"");
    }

    #[test]
    fn 编号按名次排且片段数有上限() {
        let 命中: Vec<retrieve::命中> = (0..12)
            .map(|i| retrieve::命中 {
                chunk_id: i,
                note_id: format!("n{i}"),
                path: format!("notes/{i}.md"),
                title: format!("篇{i}"),
                header_path: String::new(),
                snippet: "正文".into(),
                status: "active".into(),
                from: vec![retrieve::路::Keyword],
                rrf: 1.0 / (60.0 + i as f64),
                evidence: 1.0,
                similarity: 0.0,
            })
            .collect();
        let 依 = 排依据(&命中, 引用上限);
        assert_eq!(依.len(), 引用上限, "上下文不是越满越好");
        assert_eq!(依[0].label, "K1");
        assert_eq!(依[0].crumb, "篇0", "没有面包屑时退回标题，不留空");
        assert_eq!(依[7].label, "K8");
    }
}
