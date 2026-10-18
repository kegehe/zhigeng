//! AI 档 0：模型配置、API Key、连通测试。
//!
//! 三条规矩，改这个文件之前先读完：
//!
//! 1. **Key 只进 Windows 凭据管理器**（`keyring`，docs/03 §技术选型 的"凭据"那一行）。
//!    不落盘、不进日志、**永不回传前端**——界面上要显示"配过了"只能靠末 4 位。
//!    **`keyring` 必须带 `windows-native` feature**：3.x 没有默认 feature，漏了它就编译成
//!    进程内的 mock 存储，写入返回 Ok 而操作系统里什么都没有（真机照出来过一次，
//!    用例 `存进的是真凭据管理器而不是进程内的假存储` 钉住它）。
//!    docs/02 的目录树里预留了 `.note/secrets.keyref`（"只存条目名"），这一档**没写它**：
//!    条目名是固定的（下面的 [`CRED_SERVICE`] / [`CRED_USER`]），能推导出来的东西不需要
//!    再存一份第二真相；等真支持多 provider（一个库两把 Key）时再引入，那时条目名才真的需要记账。
//! 2. **探针只发固定文本**（`"ping"`），绝不含用户笔记内容。这条要在界面上说出来——
//!    本地优先的产品里，"我按了测试会不会把笔记发出去"是用户会问的真问题。
//! 3. **这一档不碰笔记**：不写 `.md`、不写索引、不建表。配置写在 `config.toml` 的 `[ai]` 段
//!    （它是这个库的属性，与 `[backup]` 同理，docs/03 §路径归属）。

use serde::{Deserialize, Serialize};

use crate::config;
use crate::vault::Vault;
use crate::{Error, Result};

/// 凭据管理器的服务名。与 bundle id 同源，改它等于让所有老用户"Key 丢了"。
pub const CRED_SERVICE: &str = "dev.note.service";
/// 一个服务下只有一把 Key（单用户自带 Key，docs/01 §2）。
pub const CRED_USER: &str = "ai";

/// Key 的长度上限。凭据管理器对 blob 有上限（~5KB），超了要在写之前就拦住，
/// 而不是让操作系统回一句看不懂的"数据太长"。
const MAX_KEY_BYTES: usize = 4096;

/// `[ai]` 段。刻意**不存 Key**，也不存 provider 名字：形态只有一种（OpenAI 兼容），
/// base_url + 两个模型名足够描述它（docs/04 §模型路由 那几档将来才需要更多）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiConfig {
    /// 打到 `<base>/chat/completions` 与 `<base>/embeddings`，所以通常**填到 `/v1` 为止**。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding_model: Option<String>,
    /// 检索时多打一趟模型把候选排一遍。**默认关**：那是每次搜索一次付费，
    /// 不能替用户决定。`skip_serializing_if` 让"没开"这件事不在 config.toml 里留一行——
    /// 老库的配置因此一个字节都不变。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub rerank: bool,
}

/// 给界面的那一份：**结构里没有 Key 这个字段**，只有"有没有"与末 4 位。
/// 连通测试的结论不在这里——那是这一次会话里的事，前端自己揣着（后端存它就得再有一处状态，
/// 而"重启之后还显示上次是绿的"是一句会过期的谎）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiView {
    pub base_url: String,
    pub chat_model: String,
    pub embedding_model: String,
    /// 重排开没开。界面上那格勾选框的初值就是它
    pub rerank: bool,
    pub key_set: bool,
    /// 形如 `…ab12（32 位）`。界面上认出"是哪把 Key"用，别拿它当身份。
    pub key_hint: Option<String>,
}

pub fn load(vault: &Vault) -> Result<AiConfig> {
    Ok(config::read段(vault, "ai")?.unwrap_or_default())
}

pub fn save(vault: &Vault, cfg: &AiConfig) -> Result<()> {
    let mut 新 = cfg.clone();
    新.base_url = 归一(&新.base_url.unwrap_or_default());
    新.chat_model = 归一(&新.chat_model.unwrap_or_default());
    新.embedding_model = 归一(&新.embedding_model.unwrap_or_default());
    config::write段(vault, "ai", &新)
}

fn 归一(s: &str) -> Option<String> {
    let 瘦 = s.trim().trim_end_matches('/');
    (!瘦.is_empty()).then(|| 瘦.to_string())
}

/// 视图：读配置 + 问凭据管理器"有没有"，**不把 Key 带出去**。
pub fn view(vault: &Vault) -> Result<AiView> {
    let cfg = load(vault)?;
    let 有 = key_hint();
    Ok(AiView {
        base_url: cfg.base_url.unwrap_or_default(),
        chat_model: cfg.chat_model.unwrap_or_default(),
        embedding_model: cfg.embedding_model.unwrap_or_default(),
        rerank: cfg.rerank,
        key_set: 有.is_some(),
        key_hint: 有,
    })
}

/// 存 Key。空串按"删掉"处理（界面上清空那一格就是想要没 Key）。
pub fn set_key(key: &str) -> Result<()> {
    let 瘦 = key.trim();
    if 瘦.is_empty() {
        return delete_key();
    }
    if 瘦.len() > MAX_KEY_BYTES {
        return Err(Error::Invalid(format!(
            "这把 Key 有 {} 字节，超过 {} 字节上限，没存",
            瘦.len(),
            MAX_KEY_BYTES
        )));
    }
    if 瘦.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "这把 Key 里带控制字符（多半是从终端里复制带出来的），先粘到别处清一遍再填".into(),
        ));
    }
    条目于(CRED_SERVICE, CRED_USER)?
        .set_password(瘦)
        .map_err(凭据失败)
}

pub fn delete_key() -> Result<()> {
    删把于(CRED_SERVICE, CRED_USER)
}

/// 末 4 位 + 长度。**读不到就当没配**（凭据管理器被组策略挡住时应用要照常能用，
/// AI 那一档本来就允许缺席——M1 验收 ④）。
pub fn key_hint() -> Option<String> {
    尾注于(CRED_SERVICE, CRED_USER)
}

/// 测试与将来的多 provider 用另一对名字——**用例不许往用户真在用的那一条上写**。
fn 条目于(服务: &str, 用户: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(服务, 用户).map_err(凭据失败)
}

fn 删把于(服务: &str, 用户: &str) -> Result<()> {
    match 条目于(服务, 用户)?.delete_credential() {
        // 没存过时各家后端回的是 NotFound 类错误——那正是我们想要的结果，别报成失败
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(凭据失败(e)),
    }
}

fn 尾注于(服务: &str, 用户: &str) -> Option<String> {
    let k = 条目于(服务, 用户).ok()?.get_password().ok()?;
    let 尾: String = k
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    Some(format!("…{尾}（{} 位）", k.chars().count()))
}

fn 凭据失败(e: keyring::Error) -> Error {
    Error::Invalid(format!(
        "Windows 凭据管理器没能写入：{e}（Key 没有落盘，也没有进日志；重试或改用本地模型）"
    ))
}

/// 一次连通测试的每一步结果。
///
/// 字段名走英文：`#[serde(rename_all)]` 遇到单个汉字字段名会在字符边界上切片直接
/// panic（derive 阶段的报错，比写错字段更难懂），而这个 crate 的 DTO 本来就是
/// "英文字段 + 中文注释"那一套（`LinkRow` 同形）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    /// `"chat"` / `"embeddings"` / `"embeddings-off"`（没填嵌入模型，这一步**没发请求**）
    /// / `"config"`
    pub stage: String,
    pub ok: bool,
    pub ms: u64,
    /// 给用户看的那句话：成功时报维度/模型，失败时报状态码与对方原文（截断）
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub ok: bool,
    pub steps: Vec<Step>,
}

impl Report {
    fn 收(&mut self, 步: Step) {
        self.ok &= 步.ok;
        self.steps.push(步);
    }
}

/// 设置面板里那枚"问端点要清单"的按钮**文案**。后端在指引用户用它的时候必须逐字引用，
/// 而 `src/ui/ai.test.ts` 有一条用例同时读这两个文件钉住等值——改一处就会红。
pub const 发现按钮名: &str = "看看这家有哪些模型";

/// 缺哪几项。空 = 齐了。**Key 不在里面**：本地模型（Ollama）不需要它。
///
/// **嵌入模型也不在里面**——这是档 A 的核心一条：DeepSeek 这类只有对话端点，Kimi 的嵌入要
/// 单独申请，把"没填嵌入模型"算成"没配好"会逼用户去填一个他家根本没有的东西。留空的后果
/// 不是"配置不完整"，而是"语义那一路不开、检索只走关键词与链接"，这是一条正常配置。
/// 这一份与 `src/ui/ai.ts` 的 `缺项` 必须同规则：改一处要改两处，两边的用例各自钉着同一批事实。
pub fn 缺项(cfg: &AiConfig) -> Vec<&'static str> {
    let mut 缺 = Vec::new();
    if cfg.base_url.as_deref().unwrap_or("").trim().is_empty() {
        缺.push("base_url");
    }
    if cfg.chat_model.as_deref().unwrap_or("").trim().is_empty() {
        缺.push("chat_model");
    }
    缺
}

/// base_url 的校验。返回 `Err(能看懂的话)`，不猜、不悄悄补 `/v1`。
pub fn 端点(base: &str) -> std::result::Result<String, String> {
    let 瘦 = base.trim().trim_end_matches('/');
    if 瘦.is_empty() {
        return Err("地址是空的".into());
    }
    if 瘦.split_once("://").is_none() {
        return Err(
            "地址要以 http:// 或 https:// 开头（本地模型是 http://localhost:11434/v1）".into(),
        );
    }
    if !瘦.starts_with("http://") && !瘦.starts_with("https://") {
        return Err("只认 http:// 与 https://，别的协议不走网络栈".into());
    }
    if 瘦.chars().any(char::is_whitespace) {
        return Err("地址里有空格，多半是复制时带进来的".into());
    }
    if 瘦.contains('?') || 瘦.contains('#') {
        return Err("地址不许带查询串或锚点，它只到路径为止".into());
    }
    Ok(瘦.to_string())
}

/// 404 时那句"要不要试试末尾加 /v1"的判据。猜了就要说出来，绝不悄悄改用户填的地址。
fn 建议补_v1(status: u16, base: &str) -> bool {
    status == 404 && !base.ends_with("/v1")
}

/// 把对方的错误原文压成一行能读的（很多 provider 回的是 JSON，里面那句才是人话）。
fn 原文截(body: &str) -> String {
    let 一 = body.replace(['\r', '\n', '\t'], " ").trim().to_string();
    if 一.chars().count() <= 240 {
        return 一;
    }
    format!("{}…", 一.chars().take(240).collect::<String>())
}

/// 打两个最小请求。**在 `spawn_blocking` 里调**（reqwest 的 blocking 客户端会自己起运行时，
/// 放在异步线程上会炸），且绝不持 Hub 主锁——这一趟是网络往返，几百毫秒到几秒都正常。
pub fn probe(cfg: &AiConfig) -> Report {
    let mut 报 = Report {
        ok: true,
        steps: Vec::new(),
    };
    let 缺 = 缺项(cfg);
    if !缺.is_empty() {
        报.收(Step {
            stage: "config".into(),
            ok: false,
            ms: 0,
            detail: format!("还差这几项没填：{}。没填齐就不发请求。", 缺.join(" / ")),
        });
        return 报;
    }
    let base = match 端点(cfg.base_url.as_deref().unwrap_or("")) {
        Ok(b) => b,
        Err(e) => {
            报.收(Step {
                stage: "config".into(),
                ok: false,
                ms: 0,
                detail: e,
            });
            return 报;
        }
    };
    let 客 = match 客户端() {
        Ok(c) => c,
        Err(e) => {
            报.收(Step {
                stage: "config".into(),
                ok: false,
                ms: 0,
                detail: format!("建不出 HTTP 客户端：{e}"),
            });
            return 报;
        }
    };
    let 钥 = 钥();
    if 钥.is_none() {
        // 不带 Key 也照打：本地 Ollama 就是这么活的。这一句要出现在两步的详情里，
        // 否则"401 未授权"会被误读成"应用坏了"。
        报.收(Step {
            stage: "config".into(),
            ok: true,
            ms: 0,
            detail: "没有 API Key，请求不带 Authorization（本地模型不需要；云端多半会回 401）"
                .into(),
        });
    }
    报.收(打(
        &客,
        "chat",
        &base,
        "/chat/completions",
        &serde_json::json!({
            "model": cfg.chat_model,
            "messages": [{ "role": "user", "content": "ping" }],
            // 探针只要"对方认这个模型名"，不要它真的写东西
            "max_tokens": 1,
        }),
        钥.as_deref(),
    ));
    let 嵌 = cfg.embedding_model.as_deref().unwrap_or("").trim();
    if 嵌.is_empty() {
        // 没填嵌入模型不是"这一步失败"，而是"这一路没开"。报 ok=true 是因为它确实不该红——
        // 但必须单独占一步、说清少了什么，否则界面上会安静地变成"探针都通了"那句谎。
        报.收(Step {
            stage: "embeddings-off".into(),
            ok: true,
            ms: 0,
            // 那句里点名的按钮文案要和界面上**一字不差**（真机第一版这里写的是
            // 「看看这家有哪些嵌入模型」，而按钮叫「看看这家有哪些模型」，用户按着找就找不到）
            detail: format!(
                "没填嵌入模型：语义那一路没开，检索只走关键词与链接。这一家没有嵌入接口的话\
                 （DeepSeek、Anthropic 就没有），这样才是对的；想开就点上面那个「{发现按钮名}」。"
            ),
        });
    } else {
        报.收(打(
            &客,
            "embeddings",
            &base,
            "/embeddings",
            &serde_json::json!({ "model": 嵌, "input": "ping" }),
            钥.as_deref(),
        ));
    }
    报
}

fn 打(
    客: &reqwest::blocking::Client,
    名: &str,
    base: &str,
    路径: &str,
    体: &serde_json::Value,
    钥: Option<&str>,
) -> Step {
    let url = format!("{base}{路径}");
    let 尾 = if 钥.is_some() {
        ""
    } else {
        "（未带 Key）"
    };
    let 起 = std::time::Instant::now();
    let 请 = 客.post(&url).json(体);
    let 请 = match 钥 {
        Some(k) => 请.header("authorization", format!("Bearer {k}")),
        None => 请,
    };
    let 答 = match 请.send() {
        Ok(r) => r,
        Err(e) => {
            return Step {
                stage: 名.into(),
                ok: false,
                ms: 起.elapsed().as_millis() as u64,
                detail: format!("{url} 连不上：{e}{尾}"),
            }
        }
    };
    let 状 = 答.status();
    let 文 = 答.text().unwrap_or_default();
    let ms = 起.elapsed().as_millis() as u64;
    if !状.is_success() {
        return Step {
            stage: 名.into(),
            ok: false,
            ms,
            detail: format!(
                "HTTP {}{尾}：{}{}",
                状.as_u16(),
                原文截(&文),
                if 建议补_v1(状.as_u16(), base) {
                    "｜这个地址末尾可能要加 /v1（例如 https://api.openai.com/v1）"
                } else {
                    ""
                }
            ),
        };
    }
    // 200 不等于通：有些网关会回一个 HTML 登录页。认一下 JSON 里该有的那个字段。
    let 判 = serde_json::from_str::<serde_json::Value>(&文);
    match (名, 判) {
        ("embeddings", Ok(v)) => {
            let 维 = v
                .get("data")
                .and_then(|d| d.get(0))
                .and_then(|d| d.get("embedding"))
                .and_then(|e| e.as_array())
                .map(|a| a.len());
            match 维 {
                Some(n) => Step {
                    stage: 名.into(),
                    ok: true,
                    ms,
                    detail: format!("维度 {n}{尾}"),
                },
                None => Step {
                    stage: 名.into(),
                    ok: false,
                    ms,
                    detail: format!("回的是 200 但读不到 data[0].embedding：{}{尾}", 原文截(&文)),
                },
            }
        }
        (_, Ok(v)) => {
            let 有 = v.get("choices").and_then(|c| c.get(0)).is_some();
            Step {
                stage: 名.into(),
                ok: 有,
                ms,
                detail: if 有 {
                    format!("模型认这个请求{尾}")
                } else {
                    format!("回的是 200 但没有 choices：{}{尾}", 原文截(&文))
                },
            }
        }
        (_, Err(e)) => Step {
            stage: 名.into(),
            ok: false,
            ms,
            detail: format!("回的不是 JSON（{e}）：{}{尾}", 原文截(&文)),
        },
    }
}

/// 一次"看看这家有什么模型"的结果。
///
/// 字段名走英文（护栏第 5 条）。`all` 是对方给的全部 id，`embed_candidates` 是其中**能当嵌入
/// 模型用的候选**——两者都交给界面，因为"挑哪一个"是用户的事实不是程序的猜测。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct 发现 {
    pub all: Vec<String>,
    pub embed_candidates: Vec<String>,
    pub ms: u64,
}

/// 把 `/v1/models` 的回包解析成 id 清单。**纯函数**，所以"200 但形状不对"这种情况有用例。
///
/// OpenAI 的形状是 `{"data":[{"id":…}]}`；Ollama 的 `/v1/models` 也是这一套，但有些网关把
/// 它放在 `models` 下、条目里只写 `name`。三种都认，认不出来就报错——**不返回空清单**，
/// 因为"这家一个模型都没有"和"我没读懂它的回包"是两件必须分开的事
/// （同 1b 那条"配了但连不上 ≠ 这一路没开"）。
pub fn 解析模型清单(体: &str) -> Result<Vec<String>> {
    let 解: serde_json::Value = serde_json::from_str(体)
        .map_err(|e| Error::Invalid(format!("模型清单不是 JSON（{e}）：{}", 原文截(体))))?;
    let 列 = 解
        .get("data")
        .or_else(|| 解.get("models"))
        .and_then(|d| d.as_array())
        .ok_or_else(|| {
            Error::Invalid(format!(
                "模型清单里没有 data[]（或 models[]）：{}",
                原文截(体)
            ))
        })?;
    let mut 出: Vec<String> = 列
        .iter()
        .filter_map(|m| {
            m.get("id")
                .or_else(|| m.get("name"))
                .and_then(|i| i.as_str())
        })
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    出.sort();
    出.dedup();
    Ok(出)
}

/// 从清单里挑出**像嵌入模型**的那些：id 里含 `embed`（不区分大小写），按字典序给回。
///
/// 为什么只认这一个词：各家命名虽乱（`text-embedding-3-small` / `bge-m3` / `nomic-embed-text`
/// / `Embeddings-GPT`），但没有一家把嵌入模型起成不含 embed 的样子——`bge-m3` 是例外，
/// 所以清单原样交给界面，用户可以自己填。**这里的判据宁可漏也不猜**：猜错一个
/// `gpt-4o-embeddings-fake` 之类的东西，代价是用户花 token 嵌一整库然后发现维度对不上。
pub fn 嵌入候选(清单: &[String]) -> Vec<String> {
    let mut 候: Vec<String> = 清单
        .iter()
        .filter(|id| id.to_ascii_lowercase().contains("embed"))
        .cloned()
        .collect();
    候.sort();
    候.dedup();
    候
}

/// 打一次 `<base>/models`。**零请求体、零笔记内容**——它问的是"你有什么"，不是"我有什么"。
/// 在 `spawn_blocking` 里调，且不持任何连接锁。
pub fn 列模型(cfg: &AiConfig) -> Result<发现> {
    let base = 端点(cfg.base_url.as_deref().unwrap_or("")).map_err(Error::Invalid)?;
    let url = format!("{base}/models");
    let 客 = 客户端().map_err(|e| Error::Invalid(format!("建不出 HTTP 客户端：{e}")))?;
    let 起 = std::time::Instant::now();
    let 请 = 客.get(&url);
    let 请 = match 钥() {
        Some(k) => 请.header("authorization", format!("Bearer {k}")),
        None => 请,
    };
    let 答 = 请
        .send()
        .map_err(|e| Error::Invalid(format!("{url} 连不上：{e}")))?;
    let 状 = 答.status();
    let 文 = 答
        .text()
        .map_err(|e| Error::Invalid(format!("读不回包：{e}")))?;
    if !状.is_success() {
        return Err(Error::Invalid(format!(
            "列模型 HTTP {}：{}{}",
            状.as_u16(),
            原文截(&文),
            if 建议补_v1(状.as_u16(), &base) {
                "｜这个地址末尾可能要加 /v1"
            } else {
                ""
            }
        )));
    }
    let 全部 = 解析模型清单(&文)?;
    let 候 = 嵌入候选(&全部);
    Ok(发现 {
        ms: 起.elapsed().as_millis() as u64,
        embed_candidates: 候,
        all: 全部,
    })
}

/// 超时口径：连接 5 秒、总 20 秒。嵌一整批也在 20 秒里——超了就报错，不悄悄加大超时，
/// 因为"卡住不动"比"失败并说清"更难查。
fn 客户端() -> std::result::Result<reqwest::blocking::Client, reqwest::Error> {
    reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(20))
        .build()
}

fn 钥() -> Option<String> {
    条目于(CRED_SERVICE, CRED_USER)
        .ok()
        .and_then(|条| 条.get_password().ok())
}

/// 打一次 `<base>/embeddings`。**回包按 `data[i].index` 排回去**：顺序错了就是把 A 段的
/// 向量安到 B 段头上，而它在检索里只表现为"结果有点不对"，几乎不可能被归因到这一步。
/// 缺条、重号、维度不齐一律报错——**半批落库比这批不嵌更坏**。
pub fn embed(cfg: &AiConfig, 文本: &[String]) -> Result<Vec<Vec<f32>>> {
    if 文本.is_empty() {
        return Ok(Vec::new());
    }
    let base = 端点(cfg.base_url.as_deref().unwrap_or("")).map_err(Error::Invalid)?;
    let 模型 = cfg
        .embedding_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::Invalid("没填嵌入模型名，没法嵌".into()))?;
    let url = format!("{base}/embeddings");
    let 客 = 客户端().map_err(|e| Error::Invalid(format!("建不出 HTTP 客户端：{e}")))?;
    let 请 = 客
        .post(&url)
        .json(&serde_json::json!({ "model": 模型, "input": 文本 }));
    let 请 = match 钥() {
        Some(k) => 请.header("authorization", format!("Bearer {k}")),
        None => 请,
    };
    let 答 = 请
        .send()
        .map_err(|e| Error::Invalid(format!("{url} 连不上：{e}")))?;
    let 状 = 答.status();
    let 文 = 答.text().unwrap_or_default();
    if !状.is_success() {
        return Err(Error::Invalid(format!(
            "嵌入请求 HTTP {}：{}{}",
            状.as_u16(),
            原文截(&文),
            if 建议补_v1(状.as_u16(), &base) {
                "｜这个地址末尾可能要加 /v1"
            } else {
                ""
            }
        )));
    }
    let 解: serde_json::Value = serde_json::from_str(&文)
        .map_err(|e| Error::Invalid(format!("嵌入回包不是 JSON（{e}）：{}", 原文截(&文))))?;
    let 项 = 解
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| Error::Invalid(format!("嵌入回包里没有 data 数组：{}", 原文截(&文))))?;
    let mut 槽: Vec<Option<Vec<f32>>> = vec![None; 文本.len()];
    for (顺, 条) in 项.iter().enumerate() {
        let 序 = 条
            .get("index")
            .and_then(|x| x.as_u64())
            .unwrap_or(顺 as u64) as usize;
        let Some(序) = (序 < 槽.len()).then_some(序) else {
            return Err(Error::Invalid(format!(
                "嵌入回包给了 index={序}，这批只有 {} 段文本——顺序不可信，整批不落库",
                文本.len()
            )));
        };
        let Some(v) = 条.get("embedding").and_then(|e| e.as_array()).map(|a| {
            a.iter()
                .filter_map(|x| x.as_f64().map(|f| f as f32))
                .collect::<Vec<f32>>()
        }) else {
            return Err(Error::Invalid(format!(
                "嵌入回包第 {序} 条没有 embedding 数组：{}",
                原文截(&文)
            )));
        };
        if v.is_empty() {
            return Err(Error::Invalid(format!("嵌入回包第 {序} 条是空向量")));
        }
        if 槽[序].is_some() {
            return Err(Error::Invalid(format!(
                "嵌入回包里 index={序} 出现了两次，整批不落库"
            )));
        }
        槽[序] = Some(v);
    }
    let 出: Vec<Vec<f32>> = 槽.into_iter().collect::<Option<Vec<_>>>().ok_or_else(|| {
        Error::Invalid(format!(
            "嵌入回包缺条数：要 {} 条，只给了 {} 条",
            文本.len(),
            项.len()
        ))
    })?;
    let 维 = 出[0].len();
    if 出.iter().any(|v| v.len() != 维) {
        return Err(Error::Invalid(
            "同一批里向量维度不一致，这张表装不下".into(),
        ));
    }
    Ok(出)
}

/// 一次 API 调用收发的大致量。`usage` 没回时记 0——**记 0 比猜一个数诚实**。
#[derive(Debug, Clone, Copy, Default)]
pub struct 用量 {
    pub in_tokens: usize,
    pub out_tokens: usize,
}

/// 打一次 `<base>/chat/completions`。**只发系统提示 + 组装好的上下文**，
/// 上下文里装的是检索出来的片段摘录（不是整篇笔记），所以送出去的量是可控的。
pub fn chat(cfg: &AiConfig, 系统: &str, 内容: &str) -> Result<(String, 用量)> {
    let base = 端点(cfg.base_url.as_deref().unwrap_or("")).map_err(Error::Invalid)?;
    let 模型 = cfg
        .chat_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::Invalid("没填对话模型名".into()))?;
    let url = format!("{base}/chat/completions");
    let 客 = 客户端().map_err(|e| Error::Invalid(format!("建不出 HTTP 客户端：{e}")))?;
    let 请 = 客.post(&url).json(&serde_json::json!({
        "model": 模型,
        "messages": [
            { "role": "system", "content": 系统 },
            { "role": "user", "content": 内容 },
        ],
    }));
    let 请 = match 钥() {
        Some(k) => 请.header("authorization", format!("Bearer {k}")),
        None => 请,
    };
    let 答 = 请
        .send()
        .map_err(|e| Error::Invalid(format!("{url} 连不上：{e}")))?;
    let 状 = 答.status();
    let 文 = 答.text().unwrap_or_default();
    if !状.is_success() {
        return Err(Error::Invalid(format!(
            "问答请求 HTTP {}：{}{}",
            状.as_u16(),
            原文截(&文),
            if 建议补_v1(状.as_u16(), &base) {
                "｜这个地址末尾可能要加 /v1"
            } else {
                ""
            }
        )));
    }
    let 解: serde_json::Value = serde_json::from_str(&文)
        .map_err(|e| Error::Invalid(format!("问答回包不是 JSON（{e}）：{}", 原文截(&文))))?;
    let 文本 = 解
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(str::trim)
        .ok_or_else(|| {
            Error::Invalid(format!(
                "问答回包里没有 choices[0].message.content：{}",
                原文截(&文)
            ))
        })?;
    let 量 = 解.get("usage");
    Ok((
        文本.to_string(),
        用量 {
            in_tokens: 量
                .and_then(|u| u.get("prompt_tokens"))
                .and_then(|x| x.as_u64())
                .unwrap_or(0) as usize,
            out_tokens: 量
                .and_then(|u| u.get("completion_tokens"))
                .and_then(|x| x.as_u64())
                .unwrap_or(0) as usize,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 没填齐就不发请求() {
        let 报 = probe(&AiConfig::default());
        assert!(!报.ok);
        assert_eq!(报.steps.len(), 1, "缺项时不该打网络: {:?}", 报.steps);
        assert_eq!(报.steps[0].stage, "config");
        for 项 in ["base_url", "chat_model"] {
            assert!(报.steps[0].detail.contains(项), "{} 要报出来", 项);
        }
        assert!(
            !报.steps[0].detail.contains("embedding_model"),
            "嵌入模型不再是必填，缺项里不许出现它: {}",
            报.steps[0].detail
        );
    }

    #[test]
    fn 缺项只盯地址与对话模型_嵌入留空是正常配置() {
        let 齐 = AiConfig {
            base_url: Some("http://x/v1".into()),
            chat_model: Some("a".into()),
            embedding_model: Some("b".into()),
            ..Default::default()
        };
        assert!(缺项(&齐).is_empty());
        // 档 A 的那条决定：嵌入模型没填**不算缺**——DeepSeek / Anthropic 就没有这个端点，
        // 把它算成"没配好"等于逼用户去填一个他家不存在的东西
        assert!(
            缺项(&AiConfig {
                embedding_model: None,
                ..齐.clone()
            })
            .is_empty(),
            "没填嵌入模型不该报缺项"
        );
        assert!(
            缺项(&AiConfig {
                embedding_model: Some("   ".into()),
                ..齐.clone()
            })
            .is_empty(),
            "只有空格的嵌入模型也不算填上"
        );
        assert_eq!(
            缺项(&AiConfig {
                base_url: None,
                chat_model: None,
                ..齐
            }),
            ["base_url", "chat_model"]
        );
    }

    #[test]
    fn 未启用那一步的指引与按钮同名() {
        // 真机照出来的：指引写着「看看这家有哪些嵌入模型」，而按钮叫「看看这家有哪些模型」，
        // 用户按着这句话找不到东西。**跨语言的等值由 `src/ui/ai.test.ts` 那条用例钉**
        // （它同时读 App.tsx 与这里的 `发现按钮名`），这里只钉"这一步确实指了那枚按钮"
        let 报 = probe(&AiConfig {
            base_url: Some("http://127.0.0.1:9/v1".into()),
            chat_model: Some("m".into()),
            embedding_model: None,
            ..Default::default()
        });
        let 步 = 报
            .steps
            .iter()
            .find(|s| s.stage == "embeddings-off")
            .expect("嵌入留空时必须有这一步");
        assert!(步.ok, "没发请求的一步不该红");
        assert!(
            步.detail.contains(发现按钮名),
            "指引要点名真实的按钮: {}",
            步.detail
        );
    }

    #[test]
    fn 模型清单两种形状都认_读不懂就报错不返回空() {
        let 开 = r#"{"data":[{"id":"gpt-4o"},{"id":"text-embedding-3-small"},{"id":"bge-m3"}]}"#;
        let 全 = 解析模型清单(开).unwrap();
        assert_eq!(
            全,
            [
                "bge-m3".to_string(),
                "gpt-4o".to_string(),
                "text-embedding-3-small".to_string()
            ],
            "按字典序给回，界面才有稳定顺序"
        );
        // Ollama 等网关把清单放在 models 下，条目里甚至只写 name——只认 id 会把它读成
        // "这家一个模型都没有"，那是把"没读懂"说成"没有"
        let 另 = r#"{"models":[{"name":"x"},{"id":"nomic-embed-text"}]}"#;
        assert_eq!(
            解析模型清单(另).unwrap(),
            ["nomic-embed-text".to_string(), "x".to_string()]
        );
        // 重号去掉（同一家挂两个别名会让清单看着像很多模型）
        let 重 = r#"{"data":[{"id":"a"},{"id":"a"}]}"#;
        assert_eq!(解析模型清单(重).unwrap(), ["a".to_string()]);
        // "200 但形状不对" 与 "这家一个模型都没有" 必须分开：前者报错，后者是空清单
        let 错 = 解析模型清单(r#"{"object":"list"}"#)
            .unwrap_err()
            .to_string();
        assert!(错.contains("没有 data[]"), "{错}");
        let 空 = 解析模型清单(r#"{"data":[]}"#).unwrap();
        assert!(空.is_empty(), "对方明确说没有模型时给空清单，不编");
        assert!(
            解析模型清单("<html>登录</html>").is_err(),
            "登录页不是 JSON"
        );
    }

    #[test]
    fn 嵌入候选只认含_embed_的_宁可漏也不猜() {
        let 全 = [
            "bge-m3".to_string(),
            "gpt-4o".to_string(),
            "text-embedding-3-large".to_string(),
            "text-embedding-3-small".to_string(),
            "EMBEDDINGS-V2".to_string(),
        ];
        assert_eq!(
            嵌入候选(&全),
            [
                "EMBEDDINGS-V2".to_string(),
                "text-embedding-3-large".to_string(),
                "text-embedding-3-small".to_string()
            ],
            "大小写不敏感；`bge-m3` 这种不含 embed 的不猜（清单原样交给界面，用户自己填）"
        );
        assert!(嵌入候选(&["gpt-4o".to_string()]).is_empty());
        assert!(嵌入候选(&[]).is_empty());
    }

    #[test]
    fn 地址校验不猜也不悄悄补() {
        assert_eq!(
            端点("https://api.openai.com/v1/").unwrap(),
            "https://api.openai.com/v1",
            "只去尾斜杠"
        );
        assert_eq!(
            端点("  http://localhost:11434/v1  ").unwrap(),
            "http://localhost:11434/v1"
        );
        // 补 /v1 是猜，猜错时报错就更难懂：只校验，不改写
        assert!(端点("api.openai.com/v1").unwrap_err().contains("http://"));
        assert!(端点("ftp://x/v1").unwrap_err().contains("只认"));
        assert!(端点("https://a b/v1").unwrap_err().contains("空格"));
        assert!(端点("https://a/v1?k=1").unwrap_err().contains("查询串"));
        assert!(端点("").unwrap_err().contains("空"));
    }

    #[test]
    fn 只有_404_且末尾不是_v1_才提那一手() {
        assert!(建议补_v1(404, "https://api.deepseek.com"));
        assert!(
            !建议补_v1(404, "https://api.openai.com/v1"),
            "已经带 v1 就别再让人加一遍"
        );
        assert!(
            !建议补_v1(401, "https://api.deepseek.com"),
            "401 是鉴权问题，与路径无关"
        );
    }

    #[test]
    fn 对方原文压成一行且截断() {
        assert_eq!(原文截("  {\"error\":\"bad\"}\n"), "{\"error\":\"bad\"}");
        let 长 = "字".repeat(500);
        let 短 = 原文截(&长);
        assert_eq!(
            短.chars().count(),
            241,
            "240 字 + 一个省略号: {}",
            短.chars().count()
        );
        assert!(短.ends_with('…'));
    }

    #[test]
    fn 配置存进_ai_段且_key_不在里面() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        save(
            &v,
            &AiConfig {
                base_url: Some("https://api.example.com/v1///".into()),
                chat_model: Some(" 某模型 ".into()),
                embedding_model: None,
                ..Default::default()
            },
        )
        .unwrap();
        let 文本 = std::fs::read_to_string(v.meta_dir().join("config.toml")).unwrap();
        assert!(文本.contains("[ai]"), "{文本}");
        assert!(
            文本.contains("https://api.example.com/v1"),
            "尾斜杠该被收掉: {文本}"
        );
        assert!(文本.contains("某模型"), "{文本}");
        assert!(
            !文本.contains("embedding_model"),
            "没填的项不写出去: {文本}"
        );
        assert!(
            !文本.to_lowercase().contains("key"),
            "这个文件里永远不该出现 Key: {文本}"
        );
        let 回 = load(&v).unwrap();
        assert_eq!(回.chat_model.as_deref(), Some("某模型"));
    }

    #[test]
    fn 空串当删掉而不是一把空钥匙() {
        // 界面上清空那一格的意思就是"不要 Key 了"
        assert!(crate::ai::归一("   ").is_none());
    }

    /// **这一条钉的是 `keyring` 的 feature 开关。**
    ///
    /// `keyring` 3.x 没有默认 feature：不显式开 `windows-native`，它编译进的是**进程内的
    /// mock 存储**——`set_password` 照样返回 Ok，应用照样报"Key 已存进 Windows 凭据管理器"，
    /// 而 `cmdkey /list` 里什么都没有，重启即丢。真机跑第一次就照出来了（存完的视图里
    /// `keySet` 是 false），所以这条用例的判据不是"能读回自己写的值"（mock 也满足），
    /// 而是**换一个 Entry 实例还要能读回**——mock 按实例存，真凭据管理器按目标名存。
    #[test]
    fn 存进的是真凭据管理器而不是进程内的假存储() {
        let (服务, 用户) = ("dev.note.service.test", "ai-用例");
        // 用另一对名字：用例绝不能覆盖用户真在用的那一条 Key
        let _ = 删把于(服务, 用户);
        assert_eq!(尾注于(服务, 用户), None, "开局该是干净的");

        条目于(服务, 用户)
            .unwrap()
            .set_password("sk-用例-8888")
            .unwrap();
        let 另起一个 = 条目于(服务, 用户).unwrap();
        assert_eq!(
            另起一个.get_password().ok().as_deref(),
            Some("sk-用例-8888"),
            "换一个 Entry 读不回来 = 没真存进操作系统（多半是 keyring 少了 windows-native feature）"
        );
        assert_eq!(尾注于(服务, 用户).as_deref(), Some("…8888（10 位）"));

        删把于(服务, 用户).unwrap();
        assert_eq!(尾注于(服务, 用户), None, "删了就该读不到");
        assert!(删把于(服务, 用户).is_ok(), "再删一次（本来就没有）不算失败");
    }
}
