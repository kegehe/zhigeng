//! note-core —— 本地后端服务层。
//!
//! 只有本 crate 可以碰磁盘与 SQLite（docs/03 §后端 = 本地服务层）。
//! 依赖方向：`src-tauri` / `note-cli` / `note-mcp` → `note-core` → `md-kernel`。

pub mod ai;
pub mod assets;
pub mod capture;
pub mod config;
pub mod hash;
pub mod import;
pub mod index;
pub mod meta;
pub mod schema;
pub mod service;
pub mod snapshot;
pub mod tree_order;
pub mod vault;
pub mod watch;

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
}

pub type Result<T> = std::result::Result<T, Error>;
