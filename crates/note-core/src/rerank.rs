//! LLM listwise 重排（M2 档 4）：把 RRF 名次表交给**对话模型**排一遍。
//!
//! docs/04 §rerank 的首选是本地交叉编码器（`bge-reranker`），但那要带 ONNX 或依赖
//! 用户自装 Ollama；这一档走的是那条兜底路——**只依赖对话模型**，而对话模型是唯一
//! 人人都有的端点（10-10 档 A 拍板顺序时就是这个理由）。
//!
//! 四条规矩，全部做成纯函数可测：
//!
//! 1. **模型只许输出编号数组**。读不出编号就是失败，失败**退回 RRF 名次**而不是
//!    猜一个顺序——但绝不静默：界面上要说"这一趟没重排，因为…"。
//! 2. **重排只改顺序，不许删候选**。模型漏掉的编号**名次一格不动**：一个只回了 5 个
//!    编号的模型不该把第 2 名挤到最后。这是"AI 不许静默改写用户看到的东西"在检索层的
//!    同一条红线。
//! 3. **送出去的是摘录，不是整篇**。编号 + 标题 + 面包屑 + 120 字，块 ID 与路径都不送
//!    （重排不需要还原成链接，少送一个字段就少一分泄露面）。
//! 4. **默认关**。一次搜索多打一趟模型，不能替用户花这个钱；开关在设置里那格，
//!    代价写在旁边那句话上。

use std::collections::BTreeSet;

use crate::ai::{self, AiConfig};
use crate::retrieve::命中;
use crate::Result;

/// 送出去重排的候选数上限（docs/04 §rerank：top 30）。再多就是拿钱买噪音，
/// 而且模型的排序质量本身会随清单变长而掉。
pub const 候选上限: usize = 30;
/// 每条片段送出去的字数上限。
pub const 每条字数: usize = 120;
/// 回包里没有 `[...]` 时，允许在这么长的原文里 loose 地抓数字。超过这个长度还抓不出
/// 数组，说明模型在写文章而不是在排序——判失败，别猜。
const 回包长度上限: usize = 200;

pub const 系统提示: &str =
    "你在为一次检索重排候选片段。只输出一个 JSON 整数数组，元素是片段的编号，\
按与问题相关度从高到低排列。不要输出任何解释、标题或多余文字。";

/// 没改成顺序时接在原因后面那半句。**界面上与 CLI 读的是这一份**——两处各写一遍，
/// 早晚一个改了另一个没改（那句"两路都中"就是这么留下的）
pub const 退回话: &str = "——这一趟用 RRF 名次。";

/// 组装清单。**编号从 1 开始**（模型对 1-based 更稳，0-based 会把"第 0 条"当成哨兵）。
pub fn 提示(问题: &str, 候选: &[命中]) -> String {
    let 送 = 候选.len().min(候选上限);
    let mut 出 = format!("问题：{问题}\n\n候选片段：\n");
    for (i, h) in 候选.iter().take(送).enumerate() {
        let 摘: String = h.snippet.chars().take(每条字数).collect();
        出.push_str(&format!(
            "{}. {}{}｜{}\n",
            i + 1,
            h.title,
            if h.header_path.is_empty() {
                String::new()
            } else {
                format!(" › {}", h.header_path)
            },
            摘.replace('\n', " ")
        ));
    }
    出.push_str(&format!("\n只输出编号数组（编号范围 1..{送}）："));
    出
}

/// 把回包解析成 **0-based** 顺序：越界的丢、重复只认第一次、顺序照模型给的来。
///
/// 抓法两档：有 `[...]` 就只在那个区间里抓（模型照抄清单时不会污染结果）；没有方括号
/// 但整段很短，才 loose 地按出现顺序抓数字。都不满足 → 空，交回调用方判失败。
pub fn 解析序号(回包: &str, 候选数: usize) -> Vec<usize> {
    let 区 = match 回包.find('[') {
        Some(起) => {
            // `[` 与 `]` 都是 ASCII，按字节切片不会落在字符边界上
            let 尾 = 回包[起..]
                .find(']')
                .map(|o| 起 + o + 1)
                .unwrap_or(回包.len());
            &回包[起..尾]
        }
        None => {
            if 回包.chars().count() <= 回包长度上限 {
                回包
            } else {
                return Vec::new();
            }
        }
    };
    let mut 出 = Vec::new();
    let mut 见过 = BTreeSet::new();
    let mut 当前 = String::new();
    for c in 区.chars().chain(std::iter::once(' ')) {
        if c.is_ascii_digit() {
            当前.push(c);
            continue;
        }
        if 当前.is_empty() {
            continue;
        }
        // 一长串数字（模型回了个天文数字）parse 不下就当 0，后面按越界丢掉
        let 裸: usize = 当前.parse().unwrap_or(0);
        当前.clear();
        if 裸 == 0 || 裸 > 候选数 {
            continue;
        }
        let 号 = 裸 - 1;
        if 见过.insert(号) {
            出.push(号);
        }
    }
    出
}

/// 按模型给的顺序重排。**没被提到的编号名次一格不动**——被提到的那些占据原来那些位置，
/// 依次填进去。所以这一步既不增也不删候选。
pub fn 重排(候选: &[命中], 顺序: &[usize]) -> Vec<命中> {
    let 提到: BTreeSet<usize> = 顺序.iter().copied().filter(|i| *i < 候选.len()).collect();
    if 提到.is_empty() {
        return 候选.to_vec();
    }
    let 序: Vec<usize> = {
        let mut 见 = BTreeSet::new();
        顺序
            .iter()
            .copied()
            .filter(|i| 提到.contains(i) && 见.insert(*i))
            .collect()
    };
    let mut 出 = 候选.to_vec();
    for (槽, 原) in 提到.iter().copied().zip(序) {
        出[槽] = 候选[原].clone();
    }
    出
}

/// 纯函数那一半：回包 → 新候选表。读不出编号就回**一句话的原因**（不是 `Error`——
/// 这不是故障，是"这一趟没改成顺序"，套上 `输入不合法:` 那种前缀到界面上就成了噪音），
/// 让调用方去退回 RRF 并把这句话摆出来。
pub fn 按回包(回包: &str, 候选: &[命中]) -> std::result::Result<Vec<命中>, String> {
    let 送 = 候选.len().min(候选上限);
    let 序 = 解析序号(回包, 送);
    if 序.is_empty() {
        let 短: String = 回包.chars().take(120).collect();
        return Err(format!("重排回包读不出编号数组（回的是「{短}」）"));
    }
    let (前, 后) = 候选.split_at(送);
    let mut 出 = 重排(前, &序);
    // 超出上限的那一段根本没送给模型，照原名次跟在后面
    出.extend(后.iter().cloned());
    Ok(出)
}

/// 重排那一趟的结果。**`用量` 与成败无关**：回包读不出编号那一趟模型也答过了、钱也花了，
/// 说"没重排"不能顺带把 token 抹掉。
pub struct 一趟 {
    /// `Some` = 模型给的顺序（已按"没提到的名次一格不动"填回）；`None` = 这一趟没改顺序
    pub 顺序: Option<Vec<命中>>,
    /// 没改的原因。`None` 表示"压根没打"（少于两条候选，不值得花那一趟）
    pub 原因: Option<String>,
    pub 用量: ai::用量,
}

/// 打这一趟。**含一次网络往返**，所以调用方不许握着任何锁（同 `search_hybrid`）。
///
/// 返回 `Err` 只留给"连不上 / 没配对话模型"这种 chat 自己的失败；**回包读不出编号不是失败**，
/// 那是"这一趟没改成顺序"，交回调用方去退回 RRF 并说明原因。
/// 少于两条候选不打：一趟网络换一个"顺序不变"，是白花钱。
pub fn 试(配置: &AiConfig, 问题: &str, 候选: &[命中]) -> Result<一趟> {
    if 候选.len() < 2 {
        return Ok(一趟 {
            顺序: None,
            原因: None,
            用量: ai::用量 {
                in_tokens: 0,
                out_tokens: 0,
            },
        });
    }
    let (回包, 量) = ai::chat(配置, 系统提示, &提示(问题, 候选))?;
    match 按回包(&回包, 候选) {
        Ok(新) => Ok(一趟 {
            顺序: Some(新),
            原因: None,
            用量: 量,
        }),
        Err(e) => Ok(一趟 {
            顺序: None,
            原因: Some(format!("{e}{}", 退回话)),
            用量: 量,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::retrieve::路;

    fn 命(id: i64, 篇: &str, 摘: &str) -> 命中 {
        命中 {
            chunk_id: id,
            note_id: format!("n-{id}"),
            path: format!("notes/{篇}.md"),
            title: 篇.into(),
            header_path: String::new(),
            snippet: 摘.into(),
            status: "active".into(),
            from: vec![路::Keyword],
            rrf: 1.0,
            evidence: 1.0,
            similarity: 0.0,
        }
    }

    fn 只id(出: &[命中]) -> Vec<i64> {
        出.iter().map(|h| h.chunk_id).collect()
    }

    #[test]
    fn 清单从一号开始且不送路径与块() {
        let 候选 = [命(1, "甲", "第一段摘录"), 命(2, "乙", "第二段摘录")];
        let 请 = 提示("问个问题", &候选);
        assert!(请.starts_with("问题：问个问题"), "{请}");
        assert!(请.contains("1. 甲｜第一段摘录"), "{请}");
        assert!(请.contains("2. 乙｜第二段摘录"), "{请}");
        // 泄露面：路径与块 ID 都不该出去
        assert!(!请.contains("notes/"), "{请}");
        assert!(!请.contains("n-1"), "{请}");
        assert!(请.contains("只输出编号数组"), "{请}");
    }

    #[test]
    fn 送出去的条数与摘录长度都有上限() {
        let 多: Vec<命中> = (1..=32)
            .map(|i| 命(i, "篇", &"很长的摘录".repeat(60)))
            .collect();
        let 请 = 提示("问", &多);
        assert!(请.contains("编号范围 1..30"), "送出去的就是前 30 条：{请}");
        assert!(!请.contains("31. 篇"), "第 31 条不送");
        let 一条 = 请
            .lines()
            .find(|l| l.starts_with("1. 篇"))
            .unwrap_or_default()
            .to_string();
        assert!(
            一条.chars().count() < 每条字数 + 12,
            "单条摘录没截住：{} 字",
            一条.chars().count()
        );
    }

    #[test]
    fn 解析认方括号里的数组() {
        assert_eq!(解析序号("[3,1,2]", 3), vec![2, 0, 1]);
        assert_eq!(解析序号("排序如下：[2, 1]\n完毕", 3), vec![1, 0]);
        // 越界与 0 丢掉、重复只认第一次
        assert_eq!(解析序号("[9,1,0,1,2]", 3), vec![0, 1]);
        // 一长串数字 parse 不下也不能 panic
        assert_eq!(解析序号("[99999999999999999999999,2]", 3), vec![1]);
    }

    #[test]
    fn 没有方括号时只认短回包() {
        assert_eq!(解析序号("2, 1, 3", 3), vec![1, 0, 2]);
        // 模型在写文章：不猜
        let 文章 = format!(
            "我认为第 2 条最相关，因为{} 第 1 条次之。",
            "论".repeat(300)
        );
        assert!(解析序号(&文章, 3).is_empty(), "长回包必须判读不出");
    }

    #[test]
    fn 重排只改顺序不删候选也不动没提的名次() {
        let 候选 = [
            命(1, "甲", ""),
            命(2, "乙", ""),
            命(3, "丙", ""),
            命(4, "丁", ""),
        ];
        // 模型只回了两个编号：被提到的那两个位置内部换了序，第 3、4 名一格不动
        assert_eq!(只id(&重排(&候选, &[1, 0])), vec![2, 1, 3, 4]);
        // 全提到时完全照模型的顺序
        assert_eq!(只id(&重排(&候选, &[3, 2, 1, 0])), vec![4, 3, 2, 1]);
        // 空顺序 = 原样，不是清空
        assert_eq!(只id(&重排(&候选, &[])), vec![1, 2, 3, 4]);
        // 越界的编号不参与，也不会 panic
        assert_eq!(只id(&重排(&候选, &[7, 0])), vec![1, 2, 3, 4]);
    }

    #[test]
    fn 读不出编号就回一句原因而不是猜一个顺序() {
        let 候选 = [命(1, "甲", ""), 命(2, "乙", "")];
        let 错 = 按回包("抱歉，我无法排序。", &候选).unwrap_err();
        assert!(错.contains("读不出编号数组"), "{错}");
        // 界面上那句话直接摆这句，不许带 `输入不合法:` 那种错误前缀
        assert!(!错.contains("输入不合法"), "{错}");
    }

    #[test]
    fn 超出上限的候选照原名次跟在后面() {
        let 多: Vec<命中> = (1..=32).map(|i| 命(i, "篇", "")).collect();
        let 出 = 按回包("[2,1,30]", &多).unwrap();
        assert_eq!(出.len(), 32, "一条都不许丢");
        assert_eq!(只id(&出)[..3], [2, 1, 3], "被提到的两位换了序，第 3 名不动");
        assert_eq!(只id(&出)[29], 30, "第 30 条被提到、也填回自己那个位置");
        assert_eq!(
            &只id(&出)[30..],
            &[31, 32],
            "没送给模型的那两条跟在原位后面"
        );
    }

    #[test]
    fn 少于两条候选不打那一趟() {
        let 配置 = AiConfig {
            base_url: None,
            chat_model: None,
            embedding_model: None,
            ..Default::default()
        };
        let 一条 = [命(1, "甲", "")];
        let 出 = 试(&配置, "问", &一条).unwrap();
        assert!(出.顺序.is_none(), "一条候选没什么可排");
        assert!(出.原因.is_none(), "没打就不是失败，不该有话要说");
        assert_eq!(出.用量.in_tokens, 0, "一次网络都没发，token 记 0 而不是猜");
        // 空候选同样不打
        assert!(试(&配置, "问", &[]).unwrap().顺序.is_none());
    }
}
