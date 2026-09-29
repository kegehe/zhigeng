//! 侧栏目录树的**用户自定义顺序**。
//!
//! 落在 `<Vault>/.note/tree.toml`，属 [02] §`.note/` 两分层里的**不可丢层**：
//! 它不是索引（`index.db` 删了要能长回来，而顺序长不回来），也不是笔记内容
//! （Markdown 是唯一真相源，往正文里塞自动生成的 rank 串会污染 diff 与快照）。
//! 一条判据走到底：**删掉会不会让用户丢东西**——会，所以它跟着 Vault 整体复制走。
//!
//! 存的是"某个父目录下，子条目从上到下的名字序列"，而不是每篇一个数字。
//! 理由有两条：一是同级的序本来就是一次拖拽整体算出来的，写全序列比维护
//! 稀疏 rank 少一类"两个条目抢同一个数"的边角；二是这份文件人能读、能手改
//! （[00] 的口径：盘上格式即最终规格）。

use std::collections::BTreeSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::vault::Vault;
use crate::{Error, Result};

/// 一个父目录的自定义顺序。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeOrder {
    /// 父目录，库根相对、正斜杠。库根本身是空串（顶层那一条）。
    pub parent: String,
    /// 从上到下排列的子条目名：目录用本名，笔记带 `.md`。
    pub names: Vec<String>,
}

fn tree_file(vault: &Vault) -> PathBuf {
    vault.meta_dir().join("tree.toml")
}

/// 存坏档副本用的批次名。必须每次都不重复：连着坏两次，第二次不该覆盖第一次的遗言。
fn 批次() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 归一父路径：反斜杠换正斜杠、去首尾斜杠。
/// 前端从 `rel` 切出来的路径在 Windows 上可能是反斜杠形式，两边统一一次，
/// 否则同一个目录会存成两条互不相认的序。
fn norm_parent(p: &str) -> String {
    p.replace('\\', "/").trim_matches('/').to_string()
}

/// 只挡会让这份文件失去意义的形状：子条目名里不能带路径分隔符（那是完整路径，
/// 不是同级名），父路径不能越出库根（它虽然从不参与落盘解析，但存进来就是脏数据）。
fn check(order: &TreeOrder) -> Result<()> {
    let parent = norm_parent(&order.parent);
    if parent.split('/').any(|seg| seg == "..") {
        return Err(Error::Invalid(format!("父路径越出库根: {}", order.parent)));
    }
    if parent.chars().any(|c| c.is_control()) {
        return Err(Error::Invalid("父路径不能带控制字符".into()));
    }
    for n in &order.names {
        if n.trim().is_empty() || n.contains('/') || n.contains('\\') {
            return Err(Error::Invalid(format!("同级条目名不能带路径分隔符: {n}")));
        }
        // 控制字符写进 TOML 基础字符串就是**整份文件非法**：`quoted` 只转义 `" \ \n \t`，
        // `\r`、ESC、NUL 是原样推出去的，下次读回来直接是"坏档"，所有层的顺序一起没。
        // 这些字符在 Windows 的文件名里本就不允许，从界面走不进来——但 `parent`/`names`
        // 是前端传上来的字符串，这道关口不该假设调用方诚实。
        if n.chars().any(|c| c.is_control()) {
            return Err(Error::Invalid(format!("同级条目名不能带控制字符: {n}")));
        }
    }
    Ok(())
}

/// 读全部同级顺序。三种"读不出内容"要分开对待：
/// - 没有这个文件 = 用户还没拖过 → 空表（空库、老库、手工建的库都该正常起）
/// - 有文件但不是合法 TOML = 坏档 → 空表（按没排过序处理，绝不能让侧栏起不来）
/// - 文件在但读不出来（占用 / 权限）→ 照报错误。**静默当空表是危险的**：
///   调用方下一步可能就是保存，那会把一份只是暂时读不动的好档覆盖掉。
pub fn load(vault: &Vault) -> Result<Vec<TreeOrder>> {
    use serde::de::IntoDeserializer;
    let doc = match 读(&tree_file(vault))? {
        读回::是表(t) => t,
        // 没有这个文件 / 坏档：都按"没排过序"处理，侧栏不能起不来
        _ => toml::Table::new(),
    };
    let mut out = Vec::new();
    if let Some(toml::Value::Array(rows)) = doc.get("order") {
        for row in rows {
            // 单条读不回来不影响别的条目：坏的那条按"没排过序"处理
            if let Ok(mut o) = TreeOrder::deserialize(row.clone().into_deserializer()) {
                // 归一在这里做完：前端拿 `parent` 做**相等比较**（`App.tsx` 的 `存过`、
                // `tree.ts` 的 `合并层`），而排序那条路是归一过的。手改出一个 `notes/` 或
                // `notes\工作`，不归一就会出现"屏幕上算同一层、写回时算两层"——拖走一篇时
                // 源层不被清理，同一层越攒越多条。
                o.parent = norm_parent(&o.parent);
                out.push(o);
            }
        }
    }
    Ok(out)
}

/// 文件读回来的三种样子。
enum 读回 {
    /// 还没有这个文件（用户没拖过）
    没有,
    /// 有文件，但整篇解析不出一个表：里面**可能还留着别的层**
    坏档(String),
    是表(toml::Table),
}

/// 读回顶层表。见 [`load`] 里那三分。
fn 读(path: &std::path::Path) -> Result<读回> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(读回::没有),
        Err(e) => {
            return Err(Error::Io {
                path: path.display().to_string(),
                source: e,
            })
        }
    };
    // 与 config.toml 同一条教训：必须 `from_str` 整篇文档，`parse::<Value>()` 认的是
    // 单个值，带 `[表]` / `[[数组]]` 头的正常文件会被判成坏档。
    match toml::from_str::<toml::Value>(&text) {
        Ok(toml::Value::Table(t)) => Ok(读回::是表(t)),
        // 坏档：把原文留着，写的那一侧决定怎么保住它
        _ => Ok(读回::坏档(text)),
    }
}

/// 写。按父目录**整条替换**，没点到的父目录原样留着；空序列等于"这一层恢复默认"，
/// 于是那条被删掉而不是留一个空数组占位。
pub fn save(vault: &Vault, orders: &[TreeOrder]) -> Result<()> {
    for o in orders {
        check(o)?;
    }
    // 先读回来再改：这份文件理论上只有自己一个写者，但"读—改—写"这条纪律与
    // config.toml 保持一致，别的模块往**顶层**塞的键不会被这次保存丢掉
    // （`[[order]]` 里多出来的键会没，见 `render` 的说明）。
    // 读不出来的 IO 错误在这里同样照报——覆盖一份只是暂时读不动的好档是不可接受的。
    let path = tree_file(vault);
    let mut doc = match 读(&path)? {
        读回::是表(t) => t,
        读回::没有 => toml::Table::new(),
        // 坏档：读不回来的那份里**可能还留着别的层**（人手改出一个错字，其余全是好的）。
        // 按空表直接写回去，就是把用户排好的顺序静默抹了——所以先把原文存进
        // `.note/conflicts/`，再继续。坏档不锁死拖拽（有测试钉这条），但不许白丢。
        读回::坏档(原文) => {
            vault.keep_conflict(&format!("tree.toml.{}", 批次()), 原文.as_bytes())?;
            toml::Table::new()
        }
    };

    let existing: Vec<toml::Value> = match doc.get("order").and_then(|v| v.as_array()) {
        Some(a) => a.clone(),
        None => Vec::new(),
    };
    let 改过的: BTreeSet<String> = orders.iter().map(|o| norm_parent(&o.parent)).collect();
    let mut rows: Vec<toml::Value> = Vec::new();
    let mut 已放: BTreeSet<String> = BTreeSet::new();
    // 已存的条目按原顺序保留，被本次点到的换成新值
    for row in existing {
        let parent = row
            .get("parent")
            .and_then(|v| v.as_str())
            .map(norm_parent)
            .unwrap_or_default();
        if !改过的.contains(&parent) {
            rows.push(row);
            continue;
        }
        if !已放.insert(parent.clone()) {
            continue; // 同一层存重了（手改出来的），合并成一条
        }
        if let Some(p) = orders.iter().find(|o| norm_parent(&o.parent) == parent) {
            if !p.names.is_empty() {
                rows.push(to_row(p));
            }
        }
    }
    for p in orders {
        let parent = norm_parent(&p.parent);
        if 已放.contains(&parent) || p.names.is_empty() {
            continue;
        }
        已放.insert(parent);
        rows.push(to_row(p));
    }

    if rows.is_empty() {
        doc.remove("order");
    } else {
        doc.insert("order".into(), toml::Value::Array(rows));
    }
    let text = render(&doc);
    // 走 Vault 的原子写：半截的 tree.toml 下次启动会被判成坏档，等于顺序全丢
    vault.write_atomic(".note/tree.toml", text.as_bytes())?;
    Ok(())
}

fn to_row(o: &TreeOrder) -> toml::Value {
    let mut t = toml::Table::new();
    t.insert("parent".into(), str_value(&norm_parent(&o.parent)));
    t.insert(
        "names".into(),
        toml::Value::Array(o.names.iter().map(|n| str_value(n)).collect()),
    );
    toml::Value::Table(t)
}

fn str_value(s: &str) -> toml::Value {
    toml::Value::String(s.to_string())
}

/// TOML 基础字符串。名字里出现反斜杠在 `check` 就被拒了，这里仍按规矩转义，
/// 免得将来放开限制时静默写出读不回来的文档。
fn quoted(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// 手写 `[[order]]` 那一段而不是整体 `toml::to_string`：默认输出会把数组套表写成
/// `order = [{ parent = "…" }]` 的内联形式，人读不动，也不好手改。
/// 别的键（不是我们写的）交给 `toml::to_string` 原样搬出去，且必须放在最前面——
/// TOML 里裸键不能出现在表头之后。
///
/// 说得准一点：保住的是**顶层**的别的键。`[[order]]` 里多出来的键、以及文件里的注释，
/// 在这次重写里会没（`toml::Value` 不携带它们）。要紧的东西别往这两个字段里塞。
fn render(table: &toml::Table) -> String {
    let mut out = String::from(
        "# 侧栏目录树的自定义顺序。每个 [[order]] 是一个父目录，names 从上到下。\n\
         # 没列进来的条目按默认规则排在列进来的之后；删掉某一段 = 这一层恢复默认。\n\
         # 这一份是应用写的，也可以人写。\n",
    );
    let mut 其余 = table.clone();
    其余.remove("order");
    if !其余.is_empty() {
        if let Ok(text) = toml::to_string(&其余) {
            out.push_str(&text);
            out.push('\n');
        }
    }
    let Some(rows) = table.get("order").and_then(|v| v.as_array()) else {
        return out;
    };
    for row in rows {
        let parent = row.get("parent").and_then(|x| x.as_str()).unwrap_or("");
        let names = row
            .get("names")
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default();
        out.push_str("\n[[order]]\n");
        out.push_str(&format!("parent = {}\n", quoted(parent)));
        let 项: Vec<String> = names
            .iter()
            .map(|n| quoted(n.as_str().unwrap_or("")))
            .collect();
        out.push_str(&format!("names = [{}]\n", 项.join(", ")));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn 载入(v: &Vault) -> Vec<TreeOrder> {
        load(v).expect("读顺序不该失败")
    }

    fn 一层(parent: &str, names: &[&str]) -> TreeOrder {
        TreeOrder {
            parent: parent.into(),
            names: names.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn 没拖过就没有这个文件() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        assert!(载入(&vault).is_empty());
        assert!(!tree_file(&vault).exists());
    }

    #[test]
    fn 写进去再读回来一模一样() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        let 序 = vec![
            一层("", &["notes", "项目", "inbox"]),
            一层("notes", &["甲.md", "乙.md"]),
        ];
        save(&vault, &序).unwrap();
        assert_eq!(载入(&vault), 序);
    }

    #[test]
    fn 只替换点到的那一层别的层原样留着() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        save(&vault, &[一层("notes", &["甲.md"])]).unwrap();
        save(&vault, &[一层("inbox", &["新.md"])]).unwrap();
        let 全 = 载入(&vault);
        assert_eq!(全.len(), 2);
        assert_eq!(全[0].parent, "notes");
        assert_eq!(全[1].parent, "inbox");
    }

    #[test]
    fn 空序列等于恢复默认所以整段删掉() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        save(&vault, &[一层("notes", &["甲.md"])]).unwrap();
        save(&vault, &[一层("notes", &[])]).unwrap();
        assert!(载入(&vault).is_empty());
    }

    #[test]
    fn 反斜杠路径与正斜杠算同一层() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        save(&vault, &[一层(r"notes\工作", &["甲.md"])]).unwrap();
        save(&vault, &[一层("notes/工作", &["乙.md"])]).unwrap();
        let 全 = 载入(&vault);
        assert_eq!(全.len(), 1, "同一层不该存成两条");
        assert_eq!(全[0].parent, "notes/工作");
        assert_eq!(全[0].names, vec!["乙.md".to_string()]);
    }

    #[test]
    fn 坏文件按没排过序处理而不是起不来() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        std::fs::create_dir_all(vault.meta_dir()).unwrap();
        std::fs::write(tree_file(&vault), "这不是 toml [[[ ").unwrap();
        assert!(载入(&vault).is_empty());
        // 而且还能写回去：坏档不该把拖拽功能一起锁死
        save(&vault, &[一层("notes", &["甲.md"])]).unwrap();
        assert_eq!(载入(&vault).len(), 1);
    }

    #[test]
    fn 子条目名带路径分隔符就拒掉() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        assert!(save(&vault, &[一层("notes", &["../秘密.md"])]).is_err());
        assert!(!tree_file(&vault).exists(), "拒掉就不能留下文件");
        assert!(save(&vault, &[一层("../notes", &["甲.md"])]).is_err());
    }

    #[test]
    fn 写出去的文件人能读懂() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        save(&vault, &[一层("notes", &["甲.md", "乙.md"])]).unwrap();
        let 文本 = std::fs::read_to_string(tree_file(&vault)).unwrap();
        assert!(文本.contains("[[order]]"), "{文本}");
        assert!(文本.contains("names = [\"甲.md\", \"乙.md\"]"), "{文本}");
        // 内联数组那种写法人读不动，这条钉住手写序列化的理由
        assert!(!文本.contains("order = ["), "{文本}");
    }

    #[test]
    fn 别人写的键不会被这次保存抹掉() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        std::fs::create_dir_all(vault.meta_dir()).unwrap();
        std::fs::write(
            tree_file(&vault),
            "owner = \"将来的别的模块\"\n\n[[order]]\nparent = \"inbox\"\nnames = [\"旧.md\"]\n",
        )
        .unwrap();
        save(&vault, &[一层("notes", &["甲.md"])]).unwrap();
        let 文本 = std::fs::read_to_string(tree_file(&vault)).unwrap();
        assert!(文本.contains("owner = \"将来的别的模块\""), "{文本}");
        let 全 = 载入(&vault);
        assert_eq!(全.len(), 2, "原有那层该保留，新那层追加在后面");
        assert_eq!(全[0].parent, "inbox");
        assert_eq!(全[1].parent, "notes");
    }

    #[test]
    fn 读不出来的文件不许被覆盖() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        // 拿一个同名目录顶掉文件：读它是 IO 错误而不是"没有顺序"
        std::fs::create_dir_all(vault.meta_dir().join("tree.toml")).unwrap();
        assert!(load(&vault).is_err());
        assert!(save(&vault, &[一层("notes", &["甲.md"])]).is_err());
    }

    #[test]
    fn 名字里带引号也能原样读回() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        save(&vault, &[一层("notes", &["他说\"好\".md"])]).unwrap();
        assert_eq!(载入(&vault)[0].names[0], "他说\"好\".md");
    }

    #[test]
    fn 控制字符不许写出去() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        // `quoted` 只转义 `" \ \n \t`，`\r` 会原样推进基础字符串里 = 整份文件非法 TOML，
        // 下次读回来是坏档，所有层的顺序一起没
        assert!(save(&vault, &[一层("notes", &["甲\r.md"])]).is_err());
        assert!(save(&vault, &[一层("no\u{0000}tes", &["甲.md"])]).is_err());
        assert!(!tree_file(&vault).exists(), "拒掉就不能留下文件");
    }

    #[test]
    fn 坏档里剩下的层会被存进冲突目录再重写() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        std::fs::create_dir_all(vault.meta_dir()).unwrap();
        // 第一层是好的，第二层写崩了：TOML 整篇读不回来，于是"按空表写回去"会把好的那层抹了
        let 遗言 = "[[order]]\nparent = \"notes\"\nnames = [\"甲.md\"]\n\n[[order]]\nparent = \"inbox\"\nnames = [\n";
        std::fs::write(tree_file(&vault), 遗言).unwrap();
        assert!(载入(&vault).is_empty(), "坏档按没排过序处理");
        save(&vault, &[一层("项目", &["乙.md"])]).unwrap();
        let 全 = 载入(&vault);
        assert_eq!(全.len(), 1);
        assert_eq!(全[0].parent, "项目");
        let 存住的: Vec<String> = std::fs::read_dir(vault.meta_dir().join("conflicts"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|名| 名.starts_with("tree.toml"))
            .collect();
        assert_eq!(存住的.len(), 1, "坏档原文得留一份可查的副本：{存住的:?}");
        let 文本 = std::fs::read(vault.meta_dir().join("conflicts").join(&存住的[0])).unwrap();
        assert_eq!(文本, 遗言.as_bytes(), "副本必须逐字节等于当时那份");
    }

    #[test]
    fn 读回来的父路径是归一过的() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        std::fs::create_dir_all(vault.meta_dir()).unwrap();
        // 人写文件时容易多一个尾斜杠、或者用反斜杠；前端拿这些字符串做相等比较，不归一
        // 就会出现"屏幕上算同一层、写回时算两层"
        std::fs::write(
            tree_file(&vault),
            "[[order]]\nparent = \"notes/\"\nnames = [\"甲.md\"]\n",
        )
        .unwrap();
        assert_eq!(载入(&vault)[0].parent, "notes");
    }
}
