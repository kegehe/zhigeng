//! `<Vault>/.note/config.toml` 的**段级**读写。
//!
//! 这个文件是全应用共享的配置面（docs/02 §`.note/` 两分层里它是"不可丢层"），
//! 多个模块各写自己那一段：`[backup]`、`[ai]`，将来还有快捷键与自动化档位。
//! 所以"读整篇 → 只换自己那一段 → 写回"这条纪律**只能有一份实现**——各写一份的
//! 结局是谁后写谁把别人的段抹掉，而用户看到的是"我配好的备份目录没了"。
//!
//! 两条从 `tree.toml` 那一档搬过来的规矩（同一条教训不许在第二个文件上重犯）：
//!
//! 1. **必须 `toml::from_str` 整篇文档**，`text.parse::<Value>()` 认的是单个值，
//!    带 `[表]` 头的正常配置会被判成坏档（[tree_order] 的注释记着这次）。
//! 2. **坏档先存一份进 `.note/conflicts/` 再按空表继续**：直接覆盖等于用户改出一个
//!    错字就永久丢掉整份配置。两次损坏不互相覆盖，所以名字带毫秒。

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::vault::{Vault, META_DIR};
use crate::{Error, Result};

const NAME: &str = "config.toml";

fn 相对路径() -> String {
    format!("{META_DIR}/{NAME}")
}

/// 读某一段。文件不存在或没有那一段 → `Ok(None)`（"没配过"与"配坏了"必须可区分，
/// 坏了是 `Err`：开库时读到一份语法错的配置，静默当没配过等于把用户的错字藏起来）。
pub fn read段<T: DeserializeOwned>(vault: &Vault, 段: &str) -> Result<Option<T>> {
    let path = vault.meta_dir().join(NAME);
    let Ok(原文) = std::fs::read_to_string(&path) else {
        return Ok(None);
    };
    let 文档 = 解析(&原文, &path)?;
    let Some(值) = 文档.get(段) else {
        return Ok(None);
    };
    let 转 = 值.clone().try_into::<T>().map_err(|e| Error::Io {
        path: path.display().to_string(),
        source: std::io::Error::other(format!("段 [{段}] 读不回来：{e}")),
    })?;
    Ok(Some(转))
}

/// 写某一段，**其余段原样保留**。原子写（这个文件属于不可丢层）。
pub fn write段<T: Serialize>(vault: &Vault, 段: &str, 值: &T) -> Result<()> {
    let path = vault.meta_dir().join(NAME);
    let 原文 = std::fs::read_to_string(&path).ok();
    let mut 文档 = match 原文.as_deref() {
        Some(t) if !t.trim().is_empty() => 解析坏档则存档(t, &path),
        _ => toml::Value::Table(Default::default()),
    };
    // 手工转表而不是 `Value::try_from(&整篇)`：段内 `Option::None` 的字段靠
    // `skip_serializing_if` 不写出去，TOML 没有 null 这个概念。
    let 新段 = toml::Value::try_from(值).map_err(|e| Error::Io {
        path: path.display().to_string(),
        source: std::io::Error::other(e.to_string()),
    })?;
    文档
        .as_table_mut()
        .ok_or_else(|| Error::Io {
            path: path.display().to_string(),
            source: std::io::Error::other("config.toml 的顶层不是表"),
        })?
        .insert(段.into(), 新段);
    let 文本 = toml::to_string(&文档).map_err(|e| Error::Io {
        path: path.display().to_string(),
        source: std::io::Error::other(e.to_string()),
    })?;
    vault.write_atomic(&相对路径(), 文本.as_bytes())?;
    Ok(())
}

fn 解析(原文: &str, path: &std::path::Path) -> Result<toml::Value> {
    toml::from_str::<toml::Value>(原文).map_err(|e| Error::Io {
        path: path.display().to_string(),
        source: std::io::Error::other(e.to_string()),
    })
}

/// 只在**写**的路上容错：读不回来的原文先存进 `.note/conflicts/`，再按空表继续写。
fn 解析坏档则存档(原文: &str, path: &std::path::Path) -> toml::Value {
    match toml::from_str::<toml::Value>(原文) {
        Ok(v) => v,
        Err(_) => {
            let 毫秒 = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let dst = path
                .parent()
                .map(|p| p.join("conflicts").join(format!("{NAME}.坏-{毫秒}")))
                .unwrap_or_else(|| path.with_extension("坏"));
            if let Some(父) = dst.parent() {
                let _ = std::fs::create_dir_all(父);
            }
            if let Err(e) = std::fs::write(&dst, 原文) {
                tracing::warn!("坏档的 {NAME} 没能存进 conflicts（{e}），仍按空表继续写");
            } else {
                tracing::warn!("config.toml 解析失败，原文已存到 {}", dst.display());
            }
            toml::Value::Table(Default::default())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
    struct 段A {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        on: bool,
    }

    #[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
    struct 段B {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    }

    #[test]
    fn 两段各写各的谁都不许把对方抹了() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        write段(
            &v,
            "a",
            &段A {
                name: Some("备份盘".into()),
                on: true,
            },
        )
        .unwrap();
        write段(
            &v,
            "b",
            &段B {
                url: Some("https://api.example.com/v1".into()),
            },
        )
        .unwrap();

        assert_eq!(
            read段::<段A>(&v, "a").unwrap().unwrap().name.as_deref(),
            Some("备份盘"),
            "后写乙不该把甲丢掉"
        );
        assert_eq!(
            read段::<段B>(&v, "b").unwrap().unwrap().url.as_deref(),
            Some("https://api.example.com/v1")
        );
    }

    #[test]
    fn 没写过的段是_没有_而不是坏档() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        assert!(read段::<段A>(&v, "a").unwrap().is_none(), "文件都不在");
        write段(&v, "a", &段A::default()).unwrap();
        assert!(read段::<段A>(&v, "a").unwrap().is_some(), "写过就是有了");
        assert!(read段::<段B>(&v, "b").unwrap().is_none(), "别的段没写过");
    }

    #[test]
    fn 默认值不写出去所以读回来还是默认() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        write段(&v, "a", &段A::default()).unwrap();
        let 文本 = std::fs::read_to_string(v.meta_dir().join("config.toml")).unwrap();
        assert!(!文本.contains("name"), "None 写进 TOML 就是坏文档：{文本}");
        assert!(!文本.contains("on"), "false 没必要占一行：{文本}");
    }

    #[test]
    fn 带表头的正常配置不许被当成坏档() {
        // `text.parse::<Value>()` 犯的正是这个错（tree.toml 那一档的教训）
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        std::fs::create_dir_all(v.meta_dir()).unwrap();
        std::fs::write(v.meta_dir().join("config.toml"), "[a]\nname = \"已有的\"\n").unwrap();
        write段(
            &v,
            "b",
            &段B {
                url: Some("x".into()),
            },
        )
        .unwrap();
        let 文本 = std::fs::read_to_string(v.meta_dir().join("config.toml")).unwrap();
        let 回 = read段::<段A>(&v, "a")
            .expect("读该成功")
            .expect("a 段必须还在");
        assert_eq!(
            回.name.as_deref(),
            Some("已有的"),
            "手写进去的段必须还在: {文本}"
        );
    }

    #[test]
    fn 段名必须是_ascii_因为非_ascii_裸键根本不是合法_toml() {
        // 本轮踩出来的：`[甲]` 被 toml 0.9 判成 "invalid unquoted key, expected letters,
        // numbers, `-`, `_`"。生产里的两个段名（backup / ai）都满足这条；写在这儿是为了
        // 下一个往这个文件里塞段的人——**字段名**倒是没事（序列化器会给它们加引号），
        // 有事的只有**段名**这种要出现在 `[...]` 头里的键。
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        std::fs::create_dir_all(v.meta_dir()).unwrap();
        std::fs::write(v.meta_dir().join("config.toml"), "[甲]\nname = \"x\"\n").unwrap();
        assert!(
            read段::<段A>(&v, "甲").is_err(),
            "中文段名读回来的是错误，不是值"
        );
        // 而 ASCII 段名 + 中文**值**是好的
        std::fs::write(v.meta_dir().join("config.toml"), "[a]\nname = \"已有的\"\n").unwrap();
        assert_eq!(
            read段::<段A>(&v, "a").unwrap().unwrap().name.as_deref(),
            Some("已有的")
        );
    }

    #[test]
    fn 坏档先存一份再按空表继续写() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        std::fs::create_dir_all(v.meta_dir()).unwrap();
        std::fs::write(v.meta_dir().join("config.toml"), "这不是 TOML ][\n").unwrap();
        write段(
            &v,
            "a",
            &段A {
                on: true,
                name: None,
            },
        )
        .unwrap();
        let 文本 = std::fs::read_to_string(v.meta_dir().join("config.toml")).unwrap();
        assert!(文本.contains("on = true"), "新写的段该在: {文本}");
        let 存 = std::fs::read_dir(v.meta_dir().join("conflicts"))
            .unwrap()
            .filter_map(|e| e.ok())
            .find(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("config.toml.坏-")
            });
        assert!(
            存.is_some(),
            "原文必须留在 conflicts 里，不能凭空丢掉用户写的东西"
        );
    }

    #[test]
    fn 读的时候坏档要报错而不是当没配() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path()).unwrap();
        std::fs::create_dir_all(v.meta_dir()).unwrap();
        std::fs::write(v.meta_dir().join("config.toml"), "[甲\n").unwrap();
        assert!(read段::<段A>(&v, "a").is_err(), "语法错要被说出来");
    }
}
