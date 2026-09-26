//! 文件监听：外部（Obsidian、VSCode、同步盘）改了库里的文件，界面要跟上。
//!
//! docs/05 验收 ⑤ 写的是"要么刷新要么报冲突，绝不覆盖"。冲突那一半早就有了
//! （保存时比 `expect_hash`），这一半是**刷新**：没有它，用户在 Obsidian 里改了
//! 一篇，回到本应用看到的还是旧内容——那才是真正会丢东西的方向。
//!
//! 自我写入不是问题：原子写是"临时文件 → rename"，监听器会报事件，但消费方拿磁盘
//! hash 与库里的 hash 一比就发现没变，于是 no-op（见 `service::apply_external`）。
//! 所以这里**不**维护"我们刚写了哪些路径"的黑名单——那张表重启就失效，比不维护更糟。

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError, Sender, TryRecvError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::vault::Vault;
use crate::{Error, Result};

/// 攒批的默认静默窗口：一次保存会连着报好几条事件（临时文件、rename、时间戳），
/// 逐条处理会让同一篇被反复重算。
pub const DEBOUNCE: Duration = Duration::from_millis(300);

/// 一次变化。`rel` 是相对库根的正斜杠路径。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Change {
    /// 新建或内容变了
    Touched(String),
    /// 删了或移走了
    Removed(String),
}

impl Change {
    fn rel(&self) -> &str {
        match self {
            Self::Touched(r) | Self::Removed(r) => r,
        }
    }
    fn removed(&self) -> bool {
        matches!(self, Self::Removed(_))
    }
}

/// 一个在跑的监听器。**drop 即停止监听**，所以持有方决定生命周期
/// （换库时把旧的丢掉，否则旧库的事件会写进新库的索引）。
pub struct WatcherHandle {
    stop: Sender<()>,
    _thread: JoinHandle<()>,
    // 声明在最后：先停线程再放监听器
    _watcher: RecommendedWatcher,
}

impl Drop for WatcherHandle {
    fn drop(&mut self) {
        // 只打招呼，不 join：接收线程最多 200ms 后就会看到它并退出。
        // 在这里 join 等于让"丢弃监听器"的那条线程（可能是 UI 线程）等一次调度。
        let _ = self.stop.send(());
    }
}

/// 该忽略的路径：库私有目录（`.note/`、`.git/`、点开头的一切）、原子写的临时文件、
/// 以及非 Markdown 的内容。
///
/// 临时文件必须挡掉——它半截时读到的 hash 与任何一篇都对不上，放过去就是白跑一次索引。
fn ignorable(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    rel.split('/').any(|s| s.starts_with('.'))
        || !(rel.ends_with(".md") || rel.ends_with(".markdown"))
        || name.ends_with(".tmp")
}

/// 起一个监听器：变化攒到安静 `debounce` 之后一次性交给 `sink`。
pub fn spawn(
    vault: &Vault,
    debounce: Duration,
    sink: impl Fn(Vec<Change>) + Send + 'static,
) -> Result<WatcherHandle> {
    let root = vault.root().to_path_buf();
    let (tx, rx) = mpsc::channel::<Change>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    let mut watcher = notify::recommended_watcher({
        let tx = tx.clone();
        let root = root.clone();
        move |res: std::result::Result<Event, notify::Error>| {
            let Ok(ev) = res else { return };
            // 改名在 notify 里只给一个路径。另一个方向不猜——消费方按"文件在不在"收敛，
            // 猜错会把一篇好端端的笔记从索引里删掉。
            let gone = matches!(
                ev.kind,
                EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
            );
            for path in ev.paths {
                let Ok(rel) = path.strip_prefix(&root) else {
                    continue;
                };
                let rel = rel.to_string_lossy().replace('\\', "/");
                if rel.is_empty() || ignorable(&rel) {
                    continue;
                }
                let _ = tx.send(if gone {
                    Change::Removed(rel)
                } else {
                    Change::Touched(rel)
                });
            }
        }
    })
    .map_err(|e| watch_err(&root, e))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| watch_err(&root, e))?;

    let thread = thread::spawn(move || {
        loop {
            // 1) 等第一个事件，同时盯着停止信号
            let mut batch: Vec<Change> = Vec::new();
            loop {
                match stop_rx.try_recv() {
                    Ok(()) | Err(TryRecvError::Disconnected) => return,
                    Err(TryRecvError::Empty) => {}
                }
                match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(c) => {
                        batch.push(c);
                        break;
                    }
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            // 2) 攒到安静下来再一次性交出去
            while let Ok(c) = rx.recv_timeout(debounce) {
                batch.push(c);
            }
            sink(merge(batch));
        }
    });

    Ok(WatcherHandle {
        stop: stop_tx,
        _thread: thread,
        _watcher: watcher,
    })
}

/// 同一路径在一批里只留最后一条判断（先 Touched 后 Removed 就是真删了，反之亦然）。
/// 输出顺序：先变化的、再删除的——消费方按这个顺序处理，不会出现"先删后建"被收敛成删。
fn merge(batch: Vec<Change>) -> Vec<Change> {
    let mut last: BTreeMap<String, bool> = BTreeMap::new();
    for c in &batch {
        last.insert(c.rel().to_string(), c.removed());
    }
    let mut out: Vec<Change> = Vec::new();
    for (rel, gone) in &last {
        if !*gone {
            out.push(Change::Touched(rel.clone()));
        }
    }
    for (rel, gone) in &last {
        if *gone {
            out.push(Change::Removed(rel.clone()));
        }
    }
    out
}

fn watch_err(path: &Path, e: notify::Error) -> Error {
    Error::Io {
        path: path.display().to_string(),
        source: std::io::Error::other(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // 测试名是给人读的中文短语

    use super::*;

    #[test]
    fn 该忽略的路径挡得干净() {
        assert!(ignorable(".note/index.db"));
        assert!(ignorable(".note/trash/notes/甲.md"));
        assert!(ignorable("notes/.甲.md.tmp"), "原子写的临时文件");
        assert!(ignorable("notes/附件.png"), "非 Markdown 不重索引");
        assert!(ignorable("notes/甲.txt"));
        assert!(!ignorable("notes/甲.md"));
        assert!(!ignorable("inbox/一条.markdown"));
        assert!(ignorable("notes"), "目录本身");
    }

    #[test]
    fn 同一路径在一批里只留最后一次判断() {
        let merged = merge(vec![
            Change::Touched("notes/甲.md".into()),
            Change::Removed("notes/甲.md".into()),
            Change::Touched("notes/乙.md".into()),
        ]);
        assert_eq!(
            merged,
            vec![
                Change::Touched("notes/乙.md".into()),
                Change::Removed("notes/甲.md".into()),
            ]
        );
    }

    /// 真起一个监听器：写盘要能收到，`.note/` 里的动静不能收到。
    /// 文件系统事件天生有延迟，所以这里给到 4 秒的轮询窗口而不是 sleep 一次就断言。
    #[test]
    fn 外部写入会被报上来而库私有目录不会() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        let (tx, rx) = mpsc::channel::<Vec<Change>>();
        let handle = spawn(&vault, Duration::from_millis(150), move |v| {
            let _ = tx.send(v);
        })
        .unwrap();

        std::fs::create_dir_all(vault.root().join("notes")).unwrap();
        std::fs::write(vault.root().join("notes/外部改的.md"), "外部写的内容\n").unwrap();

        let mut 收到的 = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        while std::time::Instant::now() < deadline {
            if let Ok(batch) = rx.recv_timeout(Duration::from_millis(300)) {
                收到的.extend(batch);
                if 收到的.iter().any(|c| c.rel() == "notes/外部改的.md") {
                    break;
                }
            }
        }
        assert!(
            收到的
                .iter()
                .any(|c| c.rel() == "notes/外部改的.md" && !c.removed()),
            "没收到外部写入：{收到的:?}"
        );
        assert!(
            收到的.iter().all(|c| !c.rel().starts_with(".note")),
            "库私有目录不该报上来: {收到的:?}"
        );
        drop(handle);
    }
}
