//! 属性面板：读 front-matter 的 `tags` / `props` / `ai.*`，写回去。
//!
//! 写的原则只有一条：**只动用户改过的那几行**。没有变化的标签 / 属性 / 开关
//! 一个字节都不碰；未知顶层键、注释、键的顺序、CRLF 行尾都照抄。整段重拼 YAML
//! 会把用户手写的注释和格式一起吃掉，而 front-matter 是用户资产。
//!
//! 唯一的例外是行内写法（`props: {a: 1}` / `ai: {private: true}`）：要改其中一项
//! 就先把整段展开成块写法，数据保留、格式变成常见的块状。行内写法里没有注释可丢。

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

use crate::meta::is_date;
use crate::{Error, Result};

/// 面板里的一行属性。`kind` 决定写回时要不要引号：`text` 按需要引，
/// `num` / `date` / `bool` 只在值确实长得像该类型时才不加引号。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaProp {
    pub key: String,
    pub value: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaView {
    pub hash: String,
    pub tags: Vec<String>,
    pub props: Vec<MetaProp>,
    pub private: bool,
    pub no_ai: bool,
    pub has_front_matter: bool,
    /// front-matter 不是合法 YAML 时为 false：面板只读，不拿一份解析不出来的
    /// 结构去猜用户想改哪一行。索引侧同样按空处理（docs/02 D18）。
    pub yaml_ok: bool,
}

/// 一项属性的改法。`value: None` = 删掉这一项（复杂值也能删）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropEdit {
    pub key: String,
    pub kind: String,
    pub value: Option<String>,
}

/// 面板一次提交的完整意图。`None` = 这一栏没动。
///
/// `props` 是**逐项意图**而不是整张表：没出现在里面的属性（尤其是列表 / 映射
/// 这类面板只读的值）原样留在文件里，不会被"重建属性表"擦掉。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaPatch {
    pub tags: Option<Vec<String>>,
    pub props: Option<Vec<PropEdit>>,
    pub private: Option<bool>,
    pub no_ai: Option<bool>,
}

/// 读。`hash` 由调用方给（服务层那份盘上字节的 hash），面板保存时原样带回。
pub fn view(content: &str, hash: &str) -> MetaView {
    let Some(fm) = md_kernel::parse(content).front_matter else {
        return MetaView {
            hash: hash.to_string(),
            tags: Vec::new(),
            props: Vec::new(),
            private: false,
            no_ai: false,
            has_front_matter: false,
            yaml_ok: true,
        };
    };
    let yaml = &fm.yaml;
    let root = serde_yaml::from_str::<Value>(yaml);
    let yaml_ok = root.is_ok();
    let tags = crate::meta::parse(yaml).tags;
    let mut props = Vec::new();
    if let Ok(root) = &root {
        if let Some(map) = root.as_mapping() {
            if let Some(Value::Mapping(pm)) = map.get("props") {
                for (k, v) in pm {
                    let Some(key) = k.as_str() else { continue };
                    let (value, kind) = prop_row(v);
                    props.push(MetaProp {
                        key: key.to_string(),
                        value,
                        kind,
                    });
                }
            }
        }
    }
    MetaView {
        hash: hash.to_string(),
        tags,
        props,
        private: ai_flag(yaml, "private"),
        no_ai: ai_flag(yaml, "no_ai"),
        has_front_matter: true,
        yaml_ok,
    }
}

fn prop_row(v: &Value) -> (String, String) {
    match v {
        Value::Null => (String::new(), "text".into()),
        Value::Bool(b) => (b.to_string(), "bool".into()),
        Value::Number(n) => (n.to_string(), "num".into()),
        Value::String(s) if is_date(s) => (s.clone(), "date".into()),
        Value::String(s) => (s.clone(), "text".into()),
        other => (
            serde_json::to_string(other).unwrap_or_default(),
            "json".into(),
        ),
    }
}

/// 与 `index.rs` 的隐私位同一条判据：只认 `ai:` 段下面缩进子行的
/// true / yes / 1。面板显示什么，检索就按什么挡。
fn ai_flag(yaml: &str, key: &str) -> bool {
    let mut in_ai = false;
    for l in yaml.lines() {
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
            return v == "true" || v == "yes" || v == "1";
        }
    }
    false
}

/// 应用一次面板提交。没有任何实际变化时返回**原串**（调用方据此不写盘）。
pub fn apply(content: &str, patch: &MetaPatch) -> Result<String> {
    // 校验放在两条分支之前：新建 front-matter 与已有 front-matter 共用同一份判据，
    // 否则"没有 front-matter"这条路上重复键会被原样写进文件，整篇从此读不出来。
    if let Some(edits) = &patch.props {
        校验属性编辑(edits)?;
    }
    let doc = md_kernel::parse(content);
    let Some(fm) = doc.front_matter else {
        return 新建并写(content, patch);
    };
    // front-matter 的第一行是 `---`，YAML 从它后面一行开始。不能用
    // `raw.find(yaml)` 定位：空 YAML 的 find("") 返回 0，会把新内容拼到开头去。
    let pos = fm.raw.find('\n').map(|i| i + 1).unwrap_or(fm.raw.len());
    if pos > fm.raw.len() {
        return Ok(content.to_string());
    }
    let 当前 = view(content, "");
    if !当前.yaml_ok {
        return Err(Error::Invalid(
            "front-matter 不是合法 YAML，属性面板改不了；先在外部编辑器里修好".into(),
        ));
    }
    let eol = 默认行尾(&fm.raw);
    let mut lines = 拆行(&fm.yaml);
    let 原始 = fm.yaml.clone();

    if let Some(want) = &patch.tags {
        let want = 清洗标签(want);
        if want != 当前.tags {
            设置标签(&mut lines, &want, eol);
        }
    }

    if let Some(edits) = &patch.props {
        let mut 删过 = HashSet::new();
        for e in edits.iter().filter(|e| e.value.is_none()) {
            if 当前.props.iter().any(|p| p.key == e.key) {
                删除属性(&mut lines, &e.key)?;
                删过.insert(e.key.clone());
            }
        }
        for (e, value) in edits
            .iter()
            .filter_map(|e| e.value.as_ref().map(|v| (e, v)))
        {
            if e.kind == "json" {
                continue; // 复杂值只读；前端不该发，发了也不猜
            }
            if !删过.contains(&e.key)
                && 当前
                    .props
                    .iter()
                    .any(|p| p.key == e.key && p.kind == "json")
            {
                return Err(Error::Invalid(format!(
                    "属性「{}」是列表 / 映射，属性面板不能改写；要换成普通值请先删掉它",
                    e.key
                )));
            }
            if !删过.contains(&e.key) {
                if let Some(old) = 当前.props.iter().find(|p| p.key == e.key) {
                    if old.value == *value && old.kind == e.kind {
                        continue;
                    }
                }
            }
            设置属性(&mut lines, &e.key, &e.kind, value, eol)?;
        }
    }

    if let Some(w) = patch.private {
        if w != 当前.private {
            设置ai标志(&mut lines, "private", w, eol)?;
        }
    }
    if let Some(w) = patch.no_ai {
        if w != 当前.no_ai {
            设置ai标志(&mut lines, "no_ai", w, eol)?;
        }
    }

    let 新 = 拼行(&lines);
    if 新 == 原始 {
        return Ok(content.to_string());
    }
    let new_raw = format!("{}{}{}", &fm.raw[..pos], 新, &fm.raw[pos + fm.yaml.len()..]);
    Ok(format!("{new_raw}{}", &content[fm.raw.len()..]))
}

/// 没有 front-matter 的笔记（导入路径不改用户文件，D24）也能从面板加元数据。
/// 只写用户确实填了的那几项，不替它补 `id` / `created`。
fn 新建并写(content: &str, patch: &MetaPatch) -> Result<String> {
    let eol = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut lines = Vec::new();
    let tags = 清洗标签(patch.tags.as_deref().unwrap_or_default());
    if !tags.is_empty() {
        lines.push(行 {
            text: flow标签(&tags),
            eol: eol.into(),
        });
    }
    let mut 写了属性 = false;
    for e in patch.props.as_deref().unwrap_or_default() {
        if let Some(v) = &e.value {
            if e.kind == "json" {
                continue;
            }
            if !写了属性 {
                lines.push(行 {
                    text: "props:".into(),
                    eol: eol.into(),
                });
                写了属性 = true;
            }
            写入值(&mut lines, 2, &e.key, &e.kind, v, eol);
        }
    }
    let private = patch.private == Some(true);
    let no_ai = patch.no_ai == Some(true);
    if private || no_ai {
        lines.push(行 {
            text: "ai:".into(),
            eol: eol.into(),
        });
        if private {
            lines.push(行 {
                text: "  private: true".into(),
                eol: eol.into(),
            });
        }
        if no_ai {
            lines.push(行 {
                text: "  no_ai: true".into(),
                eol: eol.into(),
            });
        }
    }
    if lines.is_empty() {
        return Ok(content.to_string());
    }
    Ok(format!("---{eol}{}---{eol}{eol}{content}", 拼行(&lines)))
}

fn 校验属性编辑(edits: &[PropEdit]) -> Result<()> {
    let mut seen = HashSet::new();
    for e in edits.iter().filter(|e| e.value.is_some()) {
        let key = e.key.trim();
        if key.is_empty() {
            return Err(Error::Invalid("属性键不能为空".into()));
        }
        if !seen.insert(key.to_string()) {
            return Err(Error::Invalid(format!("属性键「{key}」重复")));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 行模型
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct 行 {
    text: String,
    eol: String,
}

fn 拆行(s: &str) -> Vec<行> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, b) in s.bytes().enumerate() {
        if b == b'\n' {
            let chunk = &s[start..i];
            let cr = chunk.ends_with('\r');
            out.push(行 {
                text: if cr {
                    chunk[..chunk.len() - 1].to_string()
                } else {
                    chunk.to_string()
                },
                eol: if cr { "\r\n" } else { "\n" }.into(),
            });
            start = i + 1;
        }
    }
    if start < s.len() {
        out.push(行 {
            text: s[start..].to_string(),
            eol: String::new(),
        });
    }
    out
}

fn 拼行(lines: &[行]) -> String {
    let mut out = String::new();
    for l in lines {
        out.push_str(&l.text);
        out.push_str(&l.eol);
    }
    out
}

fn 默认行尾(raw: &str) -> &'static str {
    // 看第一行：混用行尾的文件里，新写入的行跟着开头的 `---` 走
    if raw.starts_with("---\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn 缩进(text: &str) -> usize {
    let mut n = 0;
    for c in text.chars() {
        match c {
            ' ' => n += 1,
            '\t' => n += 4,
            _ => break,
        }
    }
    n
}

/// `key: rest` → (key, rest)。只认顶格或缩进的普通键与双引号键；
/// 值的边界必须落在空白或行尾，避免把 `https://…` 认成键。
fn 解析键行(text: &str) -> Option<(String, String)> {
    let t = text.trim_start();
    if t.is_empty() || t.starts_with('#') || t.starts_with('-') {
        return None;
    }
    if let Some(rest) = t.strip_prefix('"') {
        let mut out = String::new();
        let mut esc = false;
        for (i, c) in rest.char_indices() {
            if esc {
                out.push(c);
                esc = false;
                continue;
            }
            match c {
                '\\' => esc = true,
                '"' => {
                    let after = rest[i + 1..].trim_start();
                    let v = after.strip_prefix(':')?;
                    if !(v.is_empty() || v.starts_with([' ', '\t'])) {
                        return None;
                    }
                    return Some((out, v.trim_start().to_string()));
                }
                _ => out.push(c),
            }
        }
        return None;
    }
    let idx = t.find(':')?;
    let key = &t[..idx];
    if key.is_empty() || key.chars().any(char::is_whitespace) {
        return None;
    }
    let after = &t[idx + 1..];
    if !(after.is_empty() || after.starts_with([' ', '\t'])) {
        return None;
    }
    Some((key.to_string(), after.trim_start().to_string()))
}

fn 顶层键(text: &str) -> Option<String> {
    if text.starts_with([' ', '\t']) {
        return None;
    }
    let t = text.trim_end();
    if t.is_empty() || t.starts_with('#') {
        return None;
    }
    解析键行(t).map(|(k, _)| k)
}

/// 一个顶层键占的行区间 `[start, end)`，末尾的空行与顶格注释不算在段里——
/// 它们属于文件排版，改这一段时不该跟着被重写。
fn 找段(lines: &[行], key: &str) -> Option<(usize, usize)> {
    let mut i = 0;
    while i < lines.len() {
        if 顶层键(&lines[i].text).as_deref() == Some(key) {
            let mut end = i + 1;
            while end < lines.len() && 顶层键(&lines[end].text).is_none() {
                end += 1;
            }
            while end > i + 1 {
                let raw = &lines[end - 1].text;
                if raw.trim().is_empty() || (raw.starts_with('#') && !raw.starts_with(' ')) {
                    end -= 1;
                } else {
                    break;
                }
            }
            return Some((i, end));
        }
        i += 1;
    }
    None
}

fn 子缩进(lines: &[行], s: usize, e: usize) -> Option<usize> {
    for l in &lines[s + 1..e] {
        if l.text.trim().is_empty() || l.text.trim_start().starts_with('#') {
            continue;
        }
        return Some(缩进(&l.text));
    }
    None
}

fn 追加段(lines: &mut Vec<行>, 新: Vec<行>, eol: &str) {
    if 新.is_empty() {
        return;
    }
    if let Some(last) = lines.last_mut() {
        if last.eol.is_empty() {
            last.eol = eol.into();
        }
    }
    lines.extend(新);
}

// ---------------------------------------------------------------------------
// 标签
// ---------------------------------------------------------------------------

fn 清洗标签(v: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in v {
        let t = s.trim().trim_start_matches('#').trim();
        if !t.is_empty() && !out.iter().any(|e| e == t) {
            out.push(t.to_string());
        }
    }
    out
}

fn flow标签(tags: &[String]) -> String {
    let 内 = tags
        .iter()
        .map(|t| yaml标量(t))
        .collect::<Vec<_>>()
        .join(", ");
    format!("tags: [{内}]")
}

fn 设置标签(lines: &mut Vec<行>, want: &[String], eol: &str) {
    let 段 = 找段(lines, "tags");
    if want.is_empty() {
        if let Some((s, e)) = 段 {
            lines.splice(s..e, []);
        }
        return;
    }
    let 行eol = 段
        .as_ref()
        .map(|(s, _)| lines[*s].eol.clone())
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| eol.to_string());
    let mut 新 = Vec::new();
    let 块式 = match 段 {
        Some((s, e)) => {
            let rest = 解析键行(&lines[s].text).map(|(_, r)| r).unwrap_or_default();
            // `tags: [a, b]` 与单值写法都按 flow 重写；`tags:` 空值跟子项
            // 是块写法（空值时也按块写，读起来更稳）
            if rest.starts_with('[') {
                false
            } else if rest.is_empty() {
                (s + 1..e).any(|i| lines[i].text.trim_start().starts_with('-')) || s + 1 == e
            } else {
                false
            }
        }
        None => false,
    };
    if 块式 {
        新.push(行 {
            text: "tags:".into(),
            eol: 行eol,
        });
        for t in want {
            新.push(行 {
                text: format!("  - {}", yaml标量(t)),
                eol: eol.into(),
            });
        }
    } else {
        新.push(行 {
            text: flow标签(want),
            eol: 行eol,
        });
    }
    match 段 {
        Some((s, e)) => {
            lines.splice(s..e, 新);
        }
        None => 追加段(lines, 新, eol),
    }
}

// ---------------------------------------------------------------------------
// 属性
// ---------------------------------------------------------------------------

fn 写入值(out: &mut Vec<行>, indent: usize, key: &str, kind: &str, value: &str, eol: &str) {
    let pad = " ".repeat(indent);
    let k = yaml键(key);
    let v = value.trim();
    let text = match kind {
        "num" if v.parse::<f64>().is_ok() => format!("{pad}{k}: {v}"),
        "date" if is_date(v) => format!("{pad}{k}: {v}"),
        "bool" => {
            let low = v.to_ascii_lowercase();
            if matches!(low.as_str(), "true" | "yes" | "1") {
                format!("{pad}{k}: true")
            } else if matches!(low.as_str(), "false" | "no" | "0" | "") {
                format!("{pad}{k}: false")
            } else {
                format!("{pad}{k}: {}", yaml标量(v))
            }
        }
        _ => format!("{pad}{k}: {}", yaml标量(v)),
    };
    out.push(行 {
        text,
        eol: eol.into(),
    });
}

fn 写嵌套值(out: &mut Vec<行>, indent: usize, key: &str, v: &Value, eol: &str) {
    let pad = " ".repeat(indent);
    let k = yaml键(key);
    let s = serde_yaml::to_string(v)
        .unwrap_or_default()
        .trim_end_matches(['\n', '\r'])
        .to_string();
    if (!v.is_sequence() && !v.is_mapping()) || s == "[]" || s == "{}" {
        out.push(行 {
            text: format!("{pad}{k}: {s}"),
            eol: eol.into(),
        });
    } else {
        out.push(行 {
            text: format!("{pad}{k}:"),
            eol: eol.into(),
        });
        for l in s.lines() {
            out.push(行 {
                text: format!("{pad}  {l}"),
                eol: eol.into(),
            });
        }
    }
}

/// 行内 `props: {…}` 展开成块写法。属性面板要改一项时必须先有可替换的行；
/// 展开保留所有键值与嵌套结构，只是不再是一行。
fn 展开属性段(lines: &mut Vec<行>, eol: &str) -> Result<()> {
    let Some((s, e)) = 找段(lines, "props") else {
        return Ok(());
    };
    let rest = 解析键行(&lines[s].text).map(|(_, r)| r).unwrap_or_default();
    if rest.is_empty() {
        return Ok(());
    }
    let parsed = serde_yaml::from_str::<Value>(&rest)
        .map_err(|_| Error::Invalid("props 段不是合法的 YAML 映射".into()))?;
    let m = match parsed {
        Value::Mapping(m) => m,
        Value::Null => Mapping::new(),
        _ => {
            return Err(Error::Invalid(
                "props 段不是键值映射，属性面板改不了".into(),
            ))
        }
    };
    let 行eol = if lines[s].eol.is_empty() {
        eol.to_string()
    } else {
        lines[s].eol.clone()
    };
    let mut 新 = vec![行 {
        text: "props:".into(),
        eol: 行eol,
    }];
    for (k, v) in &m {
        if let Some(k) = k.as_str() {
            写嵌套值(&mut 新, 2, k, v, eol);
        }
    }
    lines.splice(s..e, 新);
    Ok(())
}

fn 找属性项(
    lines: &[行],
    start: usize,
    end: usize,
    indent: usize,
    key: &str,
) -> Option<(usize, usize)> {
    let mut i = start;
    while i < end {
        if 缩进(&lines[i].text) == indent {
            if let Some((k, _)) = 解析键行(&lines[i].text) {
                if k == key {
                    let mut j = i + 1;
                    while j < end {
                        let t = &lines[j].text;
                        if !t.trim().is_empty() && 缩进(t) <= indent {
                            break;
                        }
                        j += 1;
                    }
                    return Some((i, j));
                }
            }
        }
        i += 1;
    }
    None
}

fn 设置属性(lines: &mut Vec<行>, key: &str, kind: &str, value: &str, eol: &str) -> Result<()> {
    展开属性段(lines, eol)?;
    let Some((s, e)) = 找段(lines, "props") else {
        let mut 新 = vec![行 {
            text: "props:".into(),
            eol: eol.into(),
        }];
        写入值(&mut 新, 2, key, kind, value, eol);
        追加段(lines, 新, eol);
        return Ok(());
    };
    let indent = 子缩进(lines, s, e).unwrap_or(2);
    if let Some((a, b)) = 找属性项(lines, s + 1, e, indent, key) {
        let 行eol = if lines[a].eol.is_empty() {
            eol.to_string()
        } else {
            lines[a].eol.clone()
        };
        let mut 新 = Vec::new();
        写入值(&mut 新, indent, key, kind, value, &行eol);
        lines.splice(a..b, 新);
    } else {
        let mut 新 = Vec::new();
        写入值(&mut 新, indent, key, kind, value, eol);
        lines.splice(e..e, 新);
    }
    Ok(())
}

fn 删除属性(lines: &mut Vec<行>, key: &str) -> Result<()> {
    let Some((s, e)) = 找段(lines, "props") else {
        return Ok(());
    };
    let rest = 解析键行(&lines[s].text).map(|(_, r)| r).unwrap_or_default();
    if !rest.is_empty() {
        let parsed = serde_yaml::from_str::<Value>(&rest)
            .map_err(|_| Error::Invalid("props 段不是合法的 YAML 映射".into()))?;
        let m = match parsed {
            Value::Mapping(m) => m,
            Value::Null => Mapping::new(),
            _ => {
                return Err(Error::Invalid(
                    "props 段不是键值映射，属性面板改不了".into(),
                ))
            }
        };
        let 剩余: Mapping = m
            .into_iter()
            .filter(|(k, _)| k.as_str() != Some(key))
            .collect();
        if 剩余.is_empty() {
            lines.splice(s..e, []);
        } else {
            let 行eol = if lines[s].eol.is_empty() {
                "\n".to_string()
            } else {
                lines[s].eol.clone()
            };
            let eol = 行eol.clone();
            let mut 新 = vec![行 {
                text: "props:".into(),
                eol: 行eol,
            }];
            for (k, v) in &剩余 {
                if let Some(k) = k.as_str() {
                    写嵌套值(&mut 新, 2, k, v, &eol);
                }
            }
            lines.splice(s..e, 新);
        }
        return Ok(());
    }
    let Some(indent) = 子缩进(lines, s, e) else {
        return Ok(());
    };
    if let Some((a, b)) = 找属性项(lines, s + 1, e, indent, key) {
        lines.splice(a..b, []);
    }
    // 删空了就把 `props:` 段整个摘掉，别留一个空壳
    if let Some((s, e)) = 找段(lines, "props") {
        let 还有 = (s + 1..e)
            .any(|i| 缩进(&lines[i].text) == indent && 解析键行(&lines[i].text).is_some());
        if !还有 {
            lines.splice(s..e, []);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// ai.private / ai.no_ai
// ---------------------------------------------------------------------------

fn 设置ai标志(lines: &mut Vec<行>, key: &str, want: bool, eol: &str) -> Result<()> {
    let Some((s, e)) = 找段(lines, "ai") else {
        if !want {
            return Ok(());
        }
        追加段(
            lines,
            vec![
                行 {
                    text: "ai:".into(),
                    eol: eol.into(),
                },
                行 {
                    text: format!("  {key}: true"),
                    eol: eol.into(),
                },
            ],
            eol,
        );
        return Ok(());
    };
    let rest = 解析键行(&lines[s].text).map(|(_, r)| r).unwrap_or_default();
    if !rest.is_empty() {
        // 行内写法（或异常的单值）：整段展开成块，保住其余 ai 键
        let parsed = serde_yaml::from_str::<Value>(&rest).unwrap_or(Value::Null);
        let m = match parsed {
            Value::Mapping(m) => m,
            _ => Mapping::new(),
        };
        let 行eol = if lines[s].eol.is_empty() {
            eol.to_string()
        } else {
            lines[s].eol.clone()
        };
        let mut 新 = vec![行 {
            text: "ai:".into(),
            eol: 行eol,
        }];
        let mut 写到了 = false;
        for (k, v) in &m {
            let Some(k) = k.as_str() else { continue };
            if k == key {
                写嵌套值(&mut 新, 2, k, &Value::Bool(want), eol);
                写到了 = true;
            } else {
                写嵌套值(&mut 新, 2, k, v, eol);
            }
        }
        if !写到了 && want {
            写嵌套值(&mut 新, 2, key, &Value::Bool(true), eol);
        }
        lines.splice(s..e, 新);
        return Ok(());
    }
    let indent = 子缩进(lines, s, e).unwrap_or(2);
    if let Some((a, b)) = 找属性项(lines, s + 1, e, indent, key) {
        let 行eol = if lines[a].eol.is_empty() {
            eol.to_string()
        } else {
            lines[a].eol.clone()
        };
        lines.splice(
            a..b,
            [行 {
                text: format!("{}{}: {}", " ".repeat(indent), key, want),
                eol: 行eol,
            }],
        );
    } else if want {
        lines.splice(
            e..e,
            [行 {
                text: format!("{}{key}: true", " ".repeat(indent)),
                eol: eol.into(),
            }],
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// YAML 标量
// ---------------------------------------------------------------------------

fn yaml键(s: &str) -> String {
    yaml标量(s.trim())
}

fn yaml标量(s: &str) -> String {
    if 需引号(s) {
        let 内 = s
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
            .replace('\t', "\\t");
        format!("\"{内}\"")
    } else {
        s.to_string()
    }
}

/// 保守判据：拿不准就加引号。加多一对引号只是不好看，少加一对会让值换类型。
fn 需引号(s: &str) -> bool {
    if s.is_empty() || s.trim() != s {
        return true;
    }
    let low = s.to_ascii_lowercase();
    if matches!(
        low.as_str(),
        "true" | "false" | "null" | "~" | "yes" | "no" | "on" | "off" | ".nan" | ".inf" | "-.inf"
    ) {
        return true;
    }
    if s.parse::<f64>().is_ok() {
        return true;
    }
    if s.starts_with([
        '-', '?', ':', '#', '&', '*', '!', '|', '>', '\'', '"', '%', '@', '`', '[', ']', '{', '}',
        ',',
    ]) {
        return true;
    }
    s.chars().any(|c| {
        matches!(
            c,
            ':' | '#'
                | ','
                | '['
                | ']'
                | '{'
                | '}'
                | '&'
                | '*'
                | '!'
                | '|'
                | '>'
                | '\''
                | '"'
                | '%'
                | '@'
                | '`'
                | '\n'
                | '\r'
                | '\t'
        )
    })
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    const 样例: &str = "---\nid: n-4h7kq2w9\ntitle: 主动层设计\ntags: [ai-native, m4]\ncreated: 2026-09-22T20:41:07+08:00\nprops:\n  priority: high\n  as_of: 2026-09-22\nai:\n  private: false\n---\n\n核心问题\"什么时候打断用户\"。\n";

    fn 改(content: &str, patch: MetaPatch) -> String {
        apply(content, &patch).unwrap()
    }

    #[test]
    fn 没有改动就一个字节都不动() {
        let patch = MetaPatch {
            tags: Some(vec!["ai-native".into(), "m4".into()]),
            props: Some(vec![PropEdit {
                key: "priority".into(),
                kind: "text".into(),
                value: Some("high".into()),
            }]),
            private: Some(false),
            no_ai: Some(false),
        };
        assert_eq!(改(样例, patch), 样例);
    }

    #[test]
    fn 改标签只动那一行() {
        let out = 改(
            样例,
            MetaPatch {
                tags: Some(vec!["ai-native".into(), "m5".into()]),
                ..Default::default()
            },
        );
        assert!(out.contains("tags: [ai-native, m5]\n"), "{out}");
        assert!(out.contains("id: n-4h7kq2w9"), "{out}");
        assert!(out.contains("  priority: high\n"), "{out}");
        assert!(out.contains("核心问题"), "{out}");
    }

    #[test]
    fn 清空标签把整段摘掉() {
        let out = 改(
            样例,
            MetaPatch {
                tags: Some(vec![]),
                ..Default::default()
            },
        );
        assert!(!out.contains("tags:"), "{out}");
        assert!(out.contains("title: 主动层设计"), "{out}");
    }

    #[test]
    fn 块写法的标签保持块写法() {
        let src = "---\ntags:\n  - a\n  - b\n---\n\n正文\n";
        let out = 改(
            src,
            MetaPatch {
                tags: Some(vec!["a".into(), "c".into()]),
                ..Default::default()
            },
        );
        assert!(out.contains("tags:\n  - a\n  - c\n"), "{out}");
    }

    #[test]
    fn 改一项属性不动邻居与注释() {
        let src = "---\nprops:\n  # 优先级\n  priority: high\n  as_of: 2026-09-22\n# 顶层注释\ntitle: x\n---\n\n正文\n";
        let out = 改(
            src,
            MetaPatch {
                props: Some(vec![PropEdit {
                    key: "priority".into(),
                    kind: "text".into(),
                    value: Some("low".into()),
                }]),
                ..Default::default()
            },
        );
        assert!(
            out.contains("  # 优先级\n  priority: low\n  as_of: 2026-09-22\n"),
            "{out}"
        );
        assert!(out.contains("# 顶层注释\ntitle: x"), "{out}");
    }

    #[test]
    fn 加属性写在段尾_删空属性段整个摘掉() {
        let src = "---\ntitle: x\n---\n\n正文\n";
        let 加 = 改(
            src,
            MetaPatch {
                props: Some(vec![PropEdit {
                    key: "due".into(),
                    kind: "date".into(),
                    value: Some("2026-11-05".into()),
                }]),
                ..Default::default()
            },
        );
        assert!(加.contains("props:\n  due: 2026-11-05\n"), "{加}");
        let 删 = 改(
            &加,
            MetaPatch {
                props: Some(vec![PropEdit {
                    key: "due".into(),
                    kind: "date".into(),
                    value: None,
                }]),
                ..Default::default()
            },
        );
        assert_eq!(删, src);
    }

    #[test]
    fn 行内写法展开后数据不丢() {
        let src = "---\nprops: {priority: high, 范围: [a, b]}\n---\n\n正文\n";
        let out = 改(
            src,
            MetaPatch {
                props: Some(vec![PropEdit {
                    key: "priority".into(),
                    kind: "text".into(),
                    value: Some("low".into()),
                }]),
                ..Default::default()
            },
        );
        assert!(
            out.contains("props:\n  priority: low\n  范围:\n    - a\n    - b\n"),
            "{out}"
        );
    }

    #[test]
    fn 复杂值不传就不碰() {
        let src = "---\nprops:\n  范围:\n    - a\n    - b\n  priority: high\n---\n\n正文\n";
        let out = 改(
            src,
            MetaPatch {
                props: Some(vec![PropEdit {
                    key: "priority".into(),
                    kind: "text".into(),
                    value: Some("low".into()),
                }]),
                ..Default::default()
            },
        );
        assert!(out.contains("  范围:\n    - a\n    - b\n"), "{out}");
        assert!(out.contains("priority: low"), "{out}");
    }

    #[test]
    fn ai_开关只写嵌套行_其余键保留() {
        let src = "---\nai:\n  private: false\n  other: x\n---\n\n正文\n";
        let out = 改(
            src,
            MetaPatch {
                private: Some(true),
                ..Default::default()
            },
        );
        assert!(out.contains("ai:\n  private: true\n  other: x\n"), "{out}");
    }

    #[test]
    fn 没有_ai_段时只写请求为真的那项() {
        let out = 改(
            样例,
            MetaPatch {
                no_ai: Some(true),
                ..Default::default()
            },
        );
        assert!(
            out.contains("ai:\n  private: false\n  no_ai: true\n"),
            "{out}"
        );
        // 两项都为假且段已存在时不新增键
        let out = 改(
            "---\ntitle: x\n---\n\n正文\n",
            MetaPatch {
                private: Some(false),
                no_ai: Some(false),
                ..Default::default()
            },
        );
        assert_eq!(out, "---\ntitle: x\n---\n\n正文\n");
    }

    #[test]
    fn crlf_整篇保持_crlf() {
        let src = "---\r\ntags: [a]\r\nprops:\r\n  priority: high\r\n---\r\n\r\n正文\r\n";
        let out = 改(
            src,
            MetaPatch {
                tags: Some(vec!["a".into(), "b".into()]),
                props: Some(vec![PropEdit {
                    key: "due".into(),
                    kind: "date".into(),
                    value: Some("2026-11-05".into()),
                }]),
                private: Some(true),
                ..Default::default()
            },
        );
        assert!(!out.replace("\r\n", "").contains('\n'), "{out:?}");
        assert!(out.contains("tags: [a, b]\r\n"), "{out:?}");
        assert!(
            out.contains("  priority: high\r\n  due: 2026-11-05\r\n"),
            "{out:?}"
        );
        assert!(out.contains("ai:\r\n  private: true\r\n"), "{out:?}");
    }

    #[test]
    fn 没有_front_matter_时新建一块() {
        let out = 改(
            "# 标题\n\n正文\n",
            MetaPatch {
                tags: Some(vec!["导入".into()]),
                props: Some(vec![PropEdit {
                    key: "as_of".into(),
                    kind: "date".into(),
                    value: Some("2026-11-05".into()),
                }]),
                private: Some(true),
                ..Default::default()
            },
        );
        assert_eq!(
            out,
            "---\ntags: [导入]\nprops:\n  as_of: 2026-11-05\nai:\n  private: true\n---\n\n# 标题\n\n正文\n"
        );
    }

    #[test]
    fn 坏_yaml_拒绝编辑() {
        let src = "---\ntags: [未闭合\n---\n\n正文\n";
        let e = apply(
            src,
            &MetaPatch {
                tags: Some(vec!["a".into()]),
                ..Default::default()
            },
        );
        assert!(e.is_err());
    }

    #[test]
    fn 视图按类型分行() {
        let v = view(样例, "h");
        assert_eq!(v.tags, vec!["ai-native", "m4"]);
        assert!(!v.private);
        let get = |k: &str| v.props.iter().find(|p| p.key == k).unwrap();
        assert_eq!(get("priority").kind, "text");
        assert_eq!(get("as_of").kind, "date");
        assert!(v.yaml_ok && v.has_front_matter);
    }

    #[test]
    fn 标签去井号去重() {
        assert_eq!(
            清洗标签(&["#a".into(), " a ".into(), "b".into(), "#b".into()]),
            vec!["a", "b"]
        );
    }

    #[test]
    fn 新建_front_matter_也校验属性键() {
        let e = apply(
            "正文\n",
            &MetaPatch {
                props: Some(vec![
                    PropEdit {
                        key: "a".into(),
                        kind: "text".into(),
                        value: Some("1".into()),
                    },
                    PropEdit {
                        key: "a".into(),
                        kind: "text".into(),
                        value: Some("2".into()),
                    },
                ]),
                ..Default::default()
            },
        );
        assert!(matches!(e, Err(Error::Invalid(_))), "{e:?}");
    }

    #[test]
    fn 不能把普通属性改名成复杂属性的键_删了再写可以() {
        let src = "---\nprops:\n  范围:\n    - a\n  x: 1\n---\n\n正文\n";
        let 改名 = apply(
            src,
            &MetaPatch {
                props: Some(vec![
                    PropEdit {
                        key: "x".into(),
                        kind: "text".into(),
                        value: None,
                    },
                    PropEdit {
                        key: "范围".into(),
                        kind: "text".into(),
                        value: Some("y".into()),
                    },
                ]),
                ..Default::default()
            },
        );
        assert!(matches!(改名, Err(Error::Invalid(_))), "{改名:?}");
        // 删除 + 同名新值是同一次提交里的组合意图，不该被上面那条挡住
        let 重写 = 改(
            src,
            MetaPatch {
                props: Some(vec![
                    PropEdit {
                        key: "范围".into(),
                        kind: "json".into(),
                        value: None,
                    },
                    PropEdit {
                        key: "范围".into(),
                        kind: "text".into(),
                        value: Some("y".into()),
                    },
                ]),
                ..Default::default()
            },
        );
        assert!(重写.contains("  范围: y\n"), "{重写}");
        assert!(!重写.contains("- a"), "{重写}");
    }
}
