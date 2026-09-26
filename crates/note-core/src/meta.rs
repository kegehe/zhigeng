//! front-matter 里的标签与属性 → 派生表 `tags` / `props`。
//!
//! docs/02 §front-matter 定的形状只有两种，这里就只认这两种：
//!
//! ```yaml
//! tags: [ai-native, m4]
//! props:
//!   priority: high
//!   as_of: 2026-09-22
//! ```
//!
//! **顶层的自定义键不折叠进 props**。看着方便，实际是猜：`ai:` 段、各家编辑器留下的
//! 杂项都会被当成"用户属性"，而属性是看板/日历视图的数据源，猜错就是脏数据。
//! 要进视图的内容，写进 `props:` 下面。
//!
//! 坏 YAML 不报错、不中断：返回空并 warn。一个文件写坏不该让整库重建停下来——
//! 这个教训在悬空锚点那次已经付过学费了（docs/02 §偏差 D18）。

use serde_yaml::Value;

/// 一条属性值。落盘时按类型分列存（`props` 表有 text/num/date/json 四列），
/// 这样"按 due 排序""按 priority 分组"不需要在 SQL 里现解析字符串。
#[derive(Debug, Clone, PartialEq)]
pub enum PropValue {
    Text(String),
    Num(f64),
    Date(String),
    Json(String),
}

impl PropValue {
    /// 落进哪一列。四列互斥，全空表示这条没有可存的值。
    pub fn columns(&self) -> (Option<&str>, Option<f64>, Option<&str>, Option<&str>) {
        match self {
            Self::Text(s) => (Some(s.as_str()), None, None, None),
            Self::Num(n) => (None, Some(*n), None, None),
            Self::Date(s) => (None, None, Some(s.as_str()), None),
            Self::Json(s) => (None, None, None, Some(s.as_str())),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Meta {
    pub tags: Vec<String>,
    pub props: Vec<(String, PropValue)>,
}

impl Meta {
    pub fn empty() -> Self {
        Self {
            tags: Vec::new(),
            props: Vec::new(),
        }
    }
}

/// 解析 front-matter 的 YAML 文本。`yaml` 是两条 `---` 之间的部分（不含分隔线）。
pub fn parse(yaml: &str) -> Meta {
    if yaml.trim().is_empty() {
        return Meta::empty();
    }
    let root = match serde_yaml::from_str::<Value>(yaml) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("front-matter 不是合法 YAML，标签与属性按空处理：{e}");
            return Meta::empty();
        }
    };
    let Some(map) = root.as_mapping() else {
        return Meta::empty();
    };
    Meta {
        tags: map.get("tags").map_or_else(Vec::new, tag_list),
        props: map.get("props").map_or_else(Vec::new, prop_list),
    }
}

/// 标签：只收标量项。前导 `#` 去掉（Obsidian 里 `#tag` 是写法，存的是名字），
/// 空的丢掉，重复的只留第一次（表主键是 `(note_id, tag)`，重复会直接撞）。
fn tag_list(v: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |s: &str| {
        let t = s.trim().trim_start_matches('#').trim();
        if !t.is_empty() && !out.iter().any(|e| e == t) {
            out.push(t.to_string());
        }
    };
    match v {
        Value::Sequence(items) => {
            for it in items {
                if let Some(s) = scalar_to_string(it) {
                    add(&s);
                }
            }
        }
        // `tags: ai-native` 这种单值写法很常见，不是错误
        other => {
            if let Some(s) = scalar_to_string(other) {
                for part in s.split([',', ' ']) {
                    add(part);
                }
            }
        }
    }
    out
}

fn prop_list(v: &Value) -> Vec<(String, PropValue)> {
    let Some(map) = v.as_mapping() else {
        if v.is_null() {
            return Vec::new();
        }
        tracing::warn!("front-matter 的 props 不是键值映射，忽略");
        return Vec::new();
    };
    let mut out = Vec::new();
    for (k, val) in map {
        let Some(key) = k.as_str() else { continue };
        out.push((key.to_string(), prop_value(val)));
    }
    out
}

fn prop_value(v: &Value) -> PropValue {
    match v {
        Value::Number(n) => PropValue::Num(n.as_f64().unwrap_or(0.0)),
        Value::Bool(b) => PropValue::Text(b.to_string()),
        Value::Null => PropValue::Text(String::new()),
        Value::String(s) => {
            if is_date(s) {
                PropValue::Date(s.clone())
            } else {
                PropValue::Text(s.clone())
            }
        }
        // 列表与嵌套映射原样存成 JSON：视图现在不解析它们，但也不该丢
        other => PropValue::Json(serde_yaml_to_json(other)),
    }
}

/// `2026-09-22` 与 `2026-09-22T20:41:07+08:00`。判据宁窄不宽：
/// 把 "2026-计划" 认成日期，日历视图里就会多出一条假条目。
/// 只按字节比较——按字符位置切片会在多字节中文上 panic（`2026-计划` 就踩到了）。
fn is_date(s: &str) -> bool {
    let b = s.trim().as_bytes();
    if b.len() < 10 {
        return false;
    }
    let shape = b[0].is_ascii_digit()
        && b[1].is_ascii_digit()
        && b[2].is_ascii_digit()
        && b[3].is_ascii_digit()
        && b[4] == b'-'
        && b[5].is_ascii_digit()
        && b[6].is_ascii_digit()
        && b[7] == b'-'
        && b[8].is_ascii_digit()
        && b[9].is_ascii_digit();
    shape && (b.len() == 10 || matches!(b[10], b'T' | b' '))
}

fn serde_yaml_to_json(v: &Value) -> String {
    // serde_yaml::Value 本身是 Serialize，过一道 JSON 就是能落库的文本
    serde_json::to_string(&v).unwrap_or_default()
}

fn scalar_to_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // 测试名是给人读的中文短语

    use super::*;

    #[test]
    fn 标签与属性按形状解析() {
        let m = parse(
            "id: n-4h7kq2w9\ntitle: 主动层设计\ntags: [ai-native, m4]\ncreated: 2026-09-22\nprops:\n  priority: high\n  as_of: 2026-09-22\n  weight: 3\n  已确认: true\n  范围: [a, b]\n",
        );
        assert_eq!(m.tags, vec!["ai-native", "m4"]);
        assert_eq!(m.props.len(), 5, "{:?}", m.props);
        let get = |k: &str| m.props.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(get("priority"), Some(PropValue::Text("high".into())));
        assert_eq!(get("as_of"), Some(PropValue::Date("2026-09-22".into())));
        assert_eq!(get("weight"), Some(PropValue::Num(3.0)));
        assert_eq!(get("已确认"), Some(PropValue::Text("true".into())));
        assert!(matches!(get("范围"), Some(PropValue::Json(_))));
    }

    #[test]
    fn 单值标签与前导井号都归一() {
        let m = parse("tags: ai-native\n");
        assert_eq!(m.tags, vec!["ai-native"]);
        // 井号必须带引号：YAML 里 `[#a, b]` 的 `#` 起是注释，那不是解析器该猜的东西
        let m = parse("tags: [\"#a\", b, \"\", a, c]\n");
        assert_eq!(
            m.tags,
            vec!["a", "b", "c"],
            "去井号、去空、去重: {:?}",
            m.tags
        );
    }

    #[test]
    fn 顶层自定义键不冒充属性() {
        let m = parse("tags: [a]\npriority: high\nai:\n  private: true\n");
        assert_eq!(m.tags, vec!["a"]);
        assert!(m.props.is_empty(), "只有 props: 下面的才算: {:?}", m.props);
    }

    #[test]
    fn 坏YAML返回空而不是把重建带崩() {
        let m = parse("tags: [a, b\nprops: {坏掉\n  : :");
        assert_eq!(m, Meta::empty());
        assert_eq!(parse(""), Meta::empty());
        assert_eq!(parse("just a string"), Meta::empty());
    }

    #[test]
    fn 日期判据宁窄不宽() {
        assert!(is_date("2026-09-22"));
        assert!(is_date("2026-09-22T20:41:07+08:00"));
        // 这些都不是日期：认了就会在日历视图里长出假条目
        assert!(!is_date("2026-计划"));
        assert!(!is_date("2026-09-22-额外"));
        assert!(!is_date("20260922"));
        assert!(!is_date("9-22"));
    }
}
