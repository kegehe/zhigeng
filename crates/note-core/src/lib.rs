//! note-core —— 本地后端服务层。
//!
//! 只有本 crate 可以碰磁盘与 SQLite（docs/03 §后端 = 本地服务层）。
//! 依赖方向：`src-tauri` / `note-cli` / `note-mcp` → `note-core` → `md-kernel`。

pub mod ai;
pub mod answer;
pub mod assets;
pub mod capture;
pub mod config;
pub mod embed;
pub mod hash;
pub mod import;
pub mod index;
pub mod meta;
pub mod rerank;
pub mod retrieve;
pub mod rewrite;
pub mod schema;
pub mod service;
pub mod snapshot;
pub mod tree_order;
pub mod vault;
pub mod versions;
pub mod watch;

/// 假端点。**只在测试里编译**：它跑一个本地 HTTP 服务、把收到的请求体记下来，
/// 用来证明"送出去的那份里没有私密那篇的字节"——这件事没法用"查出来没有"来证。
#[cfg(test)]
pub mod fake_endpoint;

/// 重新导出，避免上层直接依赖 md-kernel 的版本细节。
pub use md_kernel as mk;

/// 全局错误类型。存储层的失败必须可区分，因为"写失败"与"写成功但索引失败"
/// 的恢复动作完全不同（docs/03 §核心机制）。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("IO 失败 {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("SQLite 失败: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("路径越出 Vault 范围: {0}")]
    OutsideVault(String),
    #[error("外部修改冲突: {0}")]
    Conflict(String),
    #[error("输入不合法: {0}")]
    Invalid(String),
    #[error("笔记不存在: {0}")]
    NotFound(String),
    /// **模型端点不可用**（连不上、被拒、超时）。它单独一个变体而不是塞进 `Invalid`：
    /// 界面要能把"网络那头没反应"与"配置写错了"分开说——前者是"生成侧暂时不可用，
    /// 本地那两路照常"，后者是"得改设置"。两种都说成"出错了"就是一句废话。
    #[error("{0}")]
    Unavailable(String),
}

pub type Result<T> = std::result::Result<T, Error>;
