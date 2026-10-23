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

/// 把生成侧的失败翻成一句"生成侧暂时不可用"。**只有这一份口径**——
/// 问答与改写两条路各写一句的话，早晚一句说"暂时不可用"另一句说"出错了"，
/// 而用户分不出这两者的区别正是这一档要消掉的（docs/05 M2 ③）。
///
/// 三段：结论（生成侧暂时不可用）→ 原因（连不上 / 对方 5xx / 超时）→ 还能做什么。
/// 第三段不是安慰，是真的：检索两路是本地的，改写那一档正文一个字没动——
/// 各条路说各自的，但第一段是同一句。
///
/// **只有 `Unavailable` 会被翻**：配置错误（模型名没填、地址格式不对）仍然是 `Invalid`，
/// 那句话说的是"去改设置"，混成"暂时不可用"会让人干等。
pub fn 翻不可用(e: Error, 还能做什么: &str) -> Error {
    match e {
        Error::Unavailable(原因) => {
            Error::Unavailable(format!("生成侧暂时不可用：{原因}。{还能做什么}"))
        }
        其他 => 其他,
    }
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

/// 流式专用的客户端。**总超时比非流式那条放宽到 180 秒**：`timeout` 管的是"整个响应
/// 多久之内要读完"，而思考型模型光想就要几十秒——拿 20 秒去流它必然读到一半断掉
/// （真机照出来的第一条：报"一个字都没有"，实际是它还在想）。
/// 为什么不用 `read_timeout`：`reqwest::blocking` 的 builder 没有这个方法（只有 async 侧有），
/// 实测编译不过。宁可给一个宽松的总闸，也别没有闸——没有闸的话一次挂死的流会永久占住
/// 那条 `spawn_blocking` 线程。
fn 流式客户端() -> std::result::Result<reqwest::blocking::Client, reqwest::Error> {
    reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(180))
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
        .map_err(|e| Error::Unavailable(format!("{url} 连不上：{e}")))?;
    let 状 = 答.status();
    let 文 = 答.text().unwrap_or_default();
    if !状.is_success() {
        let 码 = 状.as_u16();
        if 是暂时不可用(码) {
            return Err(Error::Unavailable(format!(
                "对方回了 HTTP {码}：{}",
                原文截(&文)
            )));
        }
        return Err(Error::Invalid(format!(
            "嵌入请求 HTTP {码}：{}{}",
            原文截(&文),
            if 建议补_v1(码, &base) {
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
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct 用量 {
    pub in_tokens: usize,
    pub out_tokens: usize,
}

/// 打一次 `<base>/chat/completions`。**只发系统提示 + 组装好的上下文**，
/// 上下文里装的是检索出来的片段摘录（不是整篇笔记），所以送出去的量是可控的。
pub fn chat(cfg: &AiConfig, 系统: &str, 内容: &str) -> Result<(String, 用量)> {
    let mut 体 = 请求体(cfg, 系统, 内容);
    体["stream"] = serde_json::Value::Bool(false);
    let 基 = 基址(cfg)?;
    let 答 = 认状态(发一次(cfg, &体, false)?, &基)?;
    解chat回包(&答.text().unwrap_or_default())
}

/// 流式版：`stream: true`，一边收一边把**新增的那截文本**交给 `每块`。
///
/// 两条不显然的：
/// 1. **不是所有网关都认 `stream`**。回包的 `content-type` 不是 event-stream 就当普通回包
///    解析，`每块` 收到一次完整文本——界面因此不需要知道对方流不流，它只是"可能一次到齐"。
/// 2. **token 数不能猜**：OpenAI 的流式默认**不回 usage**，要显式 `stream_options.include_usage`。
///    给了就拿，没给就记 0（与"提供方没回 usage 时记 0 而不是猜"同一条规矩）。
pub fn chat流(
    cfg: &AiConfig,
    系统: &str,
    内容: &str,
    每块: &mut dyn FnMut(流),
) -> Result<(String, 用量)> {
    let 基 = 基址(cfg)?;
    let 答 = 认状态(发一次(cfg, &流式请求体(cfg, 系统, 内容), true)?, &基)?;
    let 流 = 答
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("text/event-stream") || v.contains("stream"))
        .unwrap_or(false);
    if !流 {
        // 对方不流：整包解析，`每块` 一次给完。这不是降级失败，是一种正常回法
        let 文 = 答.text().unwrap_or_default();
        let (全文, 量) = 解chat回包(&文)?;
        每块(流::答案(全文.clone()));
        return Ok((全文, 量));
    }
    let mut 读 = std::io::BufReader::new(答);
    let (全文, 量, 想了, 见到结束) = 收流(&mut 读, 每块)?;
    if 全文.trim().is_empty() && 想了 == 0 {
        // **一个字都没收到 = 对方多半根本不支持 stream**（真机照出来的：这家网关会在流中途
        // 直接 reset 连接）。这时用非流式再问一次——用户要的是答案，不是我们的实现偏好。
        // 代价说清楚：首字时间没了。日志必须留一条，别让它变成"悄悄退回另一条路"
        tracing::warn!("流式一个字节都没收到，退回非流式再问一次（首字时间会没有）");
        let (全文, 量) = chat(cfg, 系统, 内容)?;
        每块(流::答案(全文.clone()));
        return Ok((全文, 量));
    }
    if 全文.trim().is_empty() {
        // 只回了思考过程 = 被截断或对方把答案吞了。这种**不**自动重试：
        // 它已经想了那么久，再打一趟是双倍的钱与双倍的等待，交回用户决定
        return Err(Error::Invalid(format!(
            "对方只回了思考过程（{想了} 字），没有答案——多半是被超时截断了。试着把问题问短一点，或在设置里换一家更快的模型"
        )));
    }
    if let Some(错) = 缺收尾(&全文, 想了, 见到结束) {
        return Err(Error::Invalid(错));
    }
    Ok((全文, 量))
}

/// 把一条 SSE 流读到 EOF 或 `[DONE]`。**EOF 不在这里判完整**：正常收尾与半路断开
/// 在 `read_line` 眼里都是 0，区别只在 `见到结束`——交给 `缺收尾` 判。
fn 收流(
    读: &mut impl std::io::BufRead,
    每块: &mut dyn FnMut(流),
) -> Result<(String, 用量, usize, bool)> {
    let mut 全文 = String::new();
    let mut 想了 = 0usize;
    let mut 量 = 用量::default();
    let mut 见到结束 = false;
    let mut 行 = String::new();
    loop {
        行.clear();
        let 读了 = 读
            .read_line(&mut 行)
            .map_err(|e| Error::Invalid(format!("流读断了：{e}")))?;
        if 读了 == 0 {
            break;
        }
        match 解流行(&行) {
            流块::文本(t) => {
                全文.push_str(&t);
                每块(流::答案(t));
            }
            流块::思考(t) => {
                想了 += t.chars().count();
                每块(流::思考(t));
            }
            流块::用量(u) => 量 = u,
            流块::结束 => {
                见到结束 = true;
                break;
            }
            流块::忽略 => {}
        }
    }
    Ok((全文, 量, 想了, 见到结束))
}

/// 有字但没收到 `[DONE]`：这是半路断开的流，不是完整答案。
/// 已收到的字可能正少在引用之前，不能交给幻觉门——门只查编号，查不出半句话被截断。
fn 缺收尾(全文: &str, 想了: usize, 见到结束: bool) -> Option<String> {
    if 见到结束 || 全文.trim().is_empty() {
        return None;
    }
    Some(format!(
        "流式回包没收到 [DONE] 就断了（已收到 {} 字{}）——这条答案不完整，没有采信。",
        全文.chars().count(),
        if 想了 > 0 {
            format!("，另有 {想了} 字思考")
        } else {
            String::new()
        }
    ))
}

/// 一行 SSE。`data: {...}` / `data: [DONE]` / 注释行 / 心跳空行。
#[derive(Debug, Clone, PartialEq)]
pub enum 流块 {
    /// 答案的字
    文本(String),
    /// **思考过程**的字（DeepSeek-R1 一类会先吐 `reasoning_content`，`content` 一直空着）。
    /// 它不是答案：不进 `答复.text`、不进引用判定，只能当进度显示
    思考(String),
    用量(用量),
    结束,
    忽略,
}

/// `chat流` 交给调用方的东西。分成两种字是为了**让界面能显示"它在想"而不把思考当答案**。
#[derive(Debug, Clone, PartialEq)]
pub enum 流 {
    答案(String),
    思考(String),
}

/// **纯函数**：喂一行，回这一行装的东西。流式的坑几乎都在切行与 `[DONE]` 上，
/// 这一段不打网络也能逐条钉住。
pub fn 解流行(行: &str) -> 流块 {
    let 行 = 行.trim_end_matches(['\r', '\n']);
    let 一些 = match 行.strip_prefix("data:") {
        Some(余) => 余.trim(),
        // `:` 开头是 SSE 注释/心跳，其它行（event:、id:）我们不用
        None => return 流块::忽略,
    };
    if 一些 == "[DONE]" {
        return 流块::结束;
    }
    let Ok(解) = serde_json::from_str::<serde_json::Value>(一些) else {
        return 流块::忽略;
    };
    let 取 = |键: &str| {
        解.get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("delta"))
            .and_then(|d| d.get(键))
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string()
    };
    let 增量 = 取("content");
    let 思 = 取("reasoning_content");
    let 量 = 解.get("usage").map(|u| 用量 {
        in_tokens: u.get("prompt_tokens").and_then(|x| x.as_u64()).unwrap_or(0) as usize,
        out_tokens: u
            .get("completion_tokens")
            .and_then(|x| x.as_u64())
            .unwrap_or(0) as usize,
    });
    if let Some(u) = 量 {
        return 流块::用量(u);
    }
    if !思.is_empty() {
        return 流块::思考(思);
    }
    if 增量.is_empty() {
        return 流块::忽略;
    }
    流块::文本(增量)
}

fn 基址(cfg: &AiConfig) -> Result<String> {
    端点(cfg.base_url.as_deref().unwrap_or("")).map_err(Error::Invalid)
}

fn 地址(cfg: &AiConfig) -> Result<String> {
    Ok(format!("{}/chat/completions", 基址(cfg)?))
}

fn 请求体(cfg: &AiConfig, 系统: &str, 内容: &str) -> serde_json::Value {
    serde_json::json!({
        "model": cfg.chat_model.as_deref().unwrap_or("").trim(),
        "messages": [
            { "role": "system", "content": 系统 },
            { "role": "user", "content": 内容 },
        ],
    })
}

fn 流式请求体(cfg: &AiConfig, 系统: &str, 内容: &str) -> serde_json::Value {
    let mut 体 = 请求体(cfg, 系统, 内容);
    体["stream"] = serde_json::Value::Bool(true);
    // 不显式要就没有 usage——而审计里的 token 不能靠猜
    体["stream_options"] = serde_json::json!({ "include_usage": true });
    体
}

/// 建请求、带上 Key、发出去。**chat 与 chat流 共用这一份**——两条路各写一遍请求头，
/// 早晚一条改了另一条没改（Key 那条尤其：漏了就是"配了却 401"）。
///
/// `流式` 只决定超时口径：180 秒那条只给真正的 SSE；非流式的问答与重排必须回到 20 秒，
/// 否则一次挂住的重排能让搜索干等三分钟（docs/03 §后端调用纪律）。
fn 发一次(
    cfg: &AiConfig,
    体: &serde_json::Value,
    流式: bool,
) -> Result<reqwest::blocking::Response> {
    // 没填模型名就别发：这条原先在 `chat` 里，挪到这里是因为 `chat流` 也得有同样的拦截
    cfg.chat_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::Invalid("没填对话模型名".into()))?;
    let url = 地址(cfg)?;
    let 客 = if 流式 {
        流式客户端()
    } else {
        客户端()
    }
    .map_err(|e| Error::Invalid(format!("建不出 HTTP 客户端：{e}")))?;
    let 请 = 客.post(&url).json(体);
    let 请 = match 钥() {
        Some(k) => 请.header("authorization", format!("Bearer {k}")),
        None => 请,
    };
    请.send()
        .map_err(|e| Error::Unavailable(format!("{url} 连不上：{e}")))
}

/// 非 2xx 翻成一句人话；2xx 把响应**原样还回来**给调用方读。
/// （`text()` 会吃掉 Response，所以这里不能是 `&mut`——一版写成 &mut 就编不过，
///  而"出错时读掉、成功时留着"这件事只能靠移动所有权表达）
fn 认状态(答: reqwest::blocking::Response, 基: &str) -> Result<reqwest::blocking::Response> {
    let 状 = 答.status();
    if 状.is_success() {
        return Ok(答);
    }
    let 文 = 答.text().unwrap_or_default();
    let 码 = 状.as_u16();
    if 是暂时不可用(码) {
        // 对方那头挂了或正在限流：**这是"暂时不可用"，不是"设置写错了"**——
        // 前者要说的是"本地那两路照常"，后者要说的是"去改设置"。两种都说成"出错了"，
        // 用户就只能干等（docs/05 M2 ③）
        return Err(Error::Unavailable(format!(
            "对方回了 HTTP {码}：{}",
            原文截(&文)
        )));
    }
    Err(Error::Invalid(format!(
        "问答请求 HTTP {码}：{}{}",
        原文截(&文),
        if 建议补_v1(码, 基) {
            "｜这个地址末尾可能要加 /v1"
        } else {
            ""
        }
    )))
}

/// 哪些状态码算"对方那头暂时不可用"。**5xx 与 429 算**：前者是对方挂了或网关在重启，
/// 后者是对方在限流——两者都是"过一会儿可能就好"。4xx 不算：Key 不对、地址不对、
/// 请求体不对，那些是"改了设置才会有用"，说成暂时不可用会让人干等。
fn 是暂时不可用(码: u16) -> bool {
    码 >= 500 || 码 == 429
}

/// 普通（非流式）回包的解析。**chat 与 chat流 的兜底分支共用这一份**。
fn 解chat回包(文: &str) -> Result<(String, 用量)> {
    let 解: serde_json::Value = serde_json::from_str(文)
        .map_err(|e| Error::Invalid(format!("问答回包不是 JSON（{e}）：{}", 原文截(文))))?;
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
                原文截(文)
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

    /// SSE 切行的坑全在这：`[DONE]`、心跳、注释、没有 content 的首块、带 usage 的尾块。
    #[test]
    fn 流的每一行都认得() {
        use 流块 as 块;
        assert_eq!(
            match 解流行("data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n") {
                块::文本(t) => t,
                _ => "".into(),
            },
            "你好"
        );
        // CRLF 与没有尾随空行都要能吃
        assert!(matches!(
            解流行("data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}"),
            块::文本(_)
        ));
        assert!(matches!(解流行("data: [DONE]"), 块::结束));
        assert!(matches!(解流行("\n"), 块::忽略), "心跳空行");
        assert!(matches!(解流行(": keep-alive\n"), 块::忽略), "注释行");
        assert!(
            matches!(解流行("event: message\n"), 块::忽略),
            "我们不用的字段"
        );
        // 首块常常只有 role 没有 content；尾块常常只有 usage
        assert!(matches!(
            解流行("data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}"),
            块::忽略
        ));
        match 解流行(
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":7}}",
        ) {
            块::用量(u) => assert_eq!((u.in_tokens, u.out_tokens), (12, 7)),
            其他 => panic!("该认出用量，来了 {其他:?}"),
        }
        // 坏 JSON 不许 panic，也不许当成内容
        assert!(matches!(解流行("data: {不是 json"), 块::忽略));
    }

    /// EOF 与 `[DONE]` 在 `read_line` 眼里都是 0，区别只能靠这个布尔。半路断掉的流
    /// 可能正少在引用之前，不能当完整答案——幻觉门只查编号，查不出半句话被截断。
    #[test]
    fn 读到done才算流收完() {
        let 收 = |文: &str| {
            let mut 出 = Vec::new();
            let (全, _, 想, 见) = 收流(&mut std::io::Cursor::new(文), &mut |b| 出.push(b)).unwrap();
            (全, 想, 见, 出)
        };
        let (全, _, 见, 出) = 收(
            "data: {\"choices\":[{\"delta\":{\"content\":\"甲\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n",
        );
        assert_eq!(全, "甲");
        assert!(见, "收到 [DONE] 才算收尾");
        assert_eq!(出, vec![流::答案("甲".into())]);

        let (全, _, 见, _) = 收("data: {\"choices\":[{\"delta\":{\"content\":\"甲\"}}]}\r\n\r\n");
        assert_eq!(全, "甲", "断之前收到的字照样要播出去");
        assert!(!见, "读到 EOF 不等于收到 [DONE]");
    }

    #[test]
    fn 没收到done的流不算完整答案() {
        let 错 = 缺收尾("半句", 0, false).expect("没收到 [DONE] 必须报");
        assert!(错.contains("[DONE]"), "{错}");
        assert!(错.contains("没有采信"), "要把结论说清：{错}");
        assert!(缺收尾("半句", 0, true).is_none(), "正常收尾不该报");
        assert!(缺收尾("", 0, false).is_none(), "零字归上一条分支");
        assert!(缺收尾("", 12, false).is_none(), "只有思考也归上一条分支");
    }

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
