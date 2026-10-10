use std::path::{Path, PathBuf};
use std::sync::Mutex;

use note_core::assets;
use note_core::capture::Captured;
use note_core::import::{Entry as ImportEntry, Report as ImportReport};
use note_core::index::Index;
use note_core::service::{
    apply_external, reindex_captured, reindex_moved, reindex_note, snapshot_vault, unindex,
    AppInfo, EditDoc, HitRow, Hub, LinkPanel, NoteDetail, NoteList, NoteSource, SnapshotRow,
    TrashRow,
};
use note_core::vault::Vault;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// 速记窗标签，前端按它路由到 Capture 组件。
const CAPTURE_LABEL: &str = "capture";

/// 默认热键。刻意避开 Ctrl+N（新建惯例）与 Win+N（系统通知中心）。
const CAPTURE_SHORTCUT: &str = "Alt+Shift+N";

/// 壳只持有状态与命令注册。业务判断一律在 `note-core`——
/// 因为 CLI / MCP 必须走到完全相同的代码（docs/03 §后端 = 本地服务层）。
/// 第二个槽是文件监听器：**换库时必须换掉它**，否则旧库的事件会写进新库的索引。
/// drop 即停止监听，所以"赋新值丢旧值"就是收尾。
///
/// 第三个槽记着"上一次放进 asset 协议 scope 的是哪个目录"。换库时不撤旧的，
/// 旧库的图片就还能被 `<img>` 读出来——那是另一件事：本产品的边界是"当前这个库"。
struct Shared(
    Mutex<Option<Hub>>,
    Mutex<Option<note_core::watch::WatcherHandle>>,
    Mutex<Option<PathBuf>>,
);

/// "上一次打开的 Vault 在哪"这个指针必须存在 Vault 之外（否则先有 Vault 还是先有指针）。
/// 这是元数据而非用户内容，所以不违反 docs/03 §路径归属。
fn last_vault_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("last-vault.txt"))
}

fn read_last_vault(app: &tauri::AppHandle) -> Option<PathBuf> {
    let f = last_vault_file(app)?;
    let s = std::fs::read_to_string(f).ok()?;
    let p = PathBuf::from(s.trim());
    p.is_dir().then_some(p)
}

fn write_last_vault(app: &tauri::AppHandle, path: &std::path::Path) {
    if let Some(f) = last_vault_file(app) {
        if let Some(dir) = f.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(f, path.display().to_string());
    }
}

fn with_hub<T: serde::Serialize>(
    state: &State<'_, Shared>,
    f: impl FnOnce(&Hub) -> note_core::Result<T>,
) -> Result<T, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let hub = guard.as_ref().ok_or_else(|| "尚未选择 Vault".to_string())?;
    f(hub).map_err(|e| e.to_string())
}

/// 写命令的错误负载。`kind` 是前端要分支的**类型**，不是文案——
/// 自动保存必须区分"这篇在别处被改过"（要让用户选择保留哪份）和普通的写失败
/// （只需报错），靠 `to_string()` 匹配字符串迟早碎掉。
#[derive(serde::Serialize)]
struct WriteErr {
    kind: &'static str,
    message: String,
}

fn werr(e: note_core::Error) -> WriteErr {
    WriteErr {
        kind: if matches!(e, note_core::Error::Conflict(_)) {
            "conflict"
        } else {
            "error"
        },
        message: e.to_string(),
    }
}

/// 写操作要 `&mut Hub`：SQLite 单写者，M1 之前就用这把锁串行化（docs/03）。
fn with_hub_mut<T: serde::Serialize>(
    state: &State<'_, Shared>,
    f: impl FnOnce(&mut Hub) -> note_core::Result<T>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let hub = guard.as_mut().ok_or_else(|| "尚未选择 Vault".to_string())?;
    f(hub).map_err(|e| e.to_string())
}

/// 同上，但错误带类型。写命令一律用它——前端要按 `kind` 分支。
fn with_hub_write<T: serde::Serialize>(
    state: &State<'_, Shared>,
    f: impl FnOnce(&mut Hub) -> note_core::Result<T>,
) -> Result<T, WriteErr> {
    let mut guard = state.0.lock().map_err(werr_io)?;
    let hub = guard.as_mut().ok_or_else(|| WriteErr {
        kind: "error",
        message: "尚未选择 Vault".into(),
    })?;
    f(hub).map_err(werr)
}

fn werr_io(e: std::sync::PoisonError<std::sync::MutexGuard<'_, Option<Hub>>>) -> WriteErr {
    WriteErr {
        kind: "error",
        message: e.to_string(),
    }
}

/// 落盘同步返回、索引挪到后台线程，做完广播 `note://indexed`。
///
/// 这不是"为了快"而牺牲正确性：实测单篇索引要 8–10ms，留在同步路径上就把
/// G6 的 8ms 红线顶穿了（docs/03 §后端调用纪律 明确 8ms–300ms 一律异步 + 乐观 UI）。
/// 文件在同步那一步已经 fsync 落盘，所以返回即代表内容不会丢。
///
/// 后台这一半走 `Hub::indexer()` 那条**独立的连接**，并且只在取句柄的一瞬锁主锁。
/// 上一版它在主锁里跑完整篇：保存 2999 块后，下一个读命令等了 3.26 秒。
/// 后台补索引，做完广播"变了哪些路径"。前端拿这个决定：列表要刷，
/// 正在看的那一篇如果也在里面且没在编辑，就整个重装载（否则界面停在旧内容上）。
fn reindex_async<F>(app: AppHandle, rels: Vec<String>, job: F)
where
    F: FnOnce(&Vault, &Index) -> note_core::Result<()> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let handles = app
            .state::<Shared>()
            .0
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|h| (h.vault().clone(), h.indexer())));
        let done: Vec<String> = match handles {
            Some((vault, bg)) => match bg.lock() {
                Ok(index) if job(&vault, &index).is_ok() => rels,
                _ => Vec::new(),
            },
            None => Vec::new(),
        };
        // 前端靠它把"已存"变成"已可搜"；失败时下次 reindex 会兜底
        let _ = app.emit("note://indexed", done);
    });
}

/// 后台补 `attachments` 那一行——纯派生数据，失败只记日志。
///
/// **索引句柄必须在发起命令那一刻就取好**：等任务真跑起来再去取"当前 hub"，用户在这个
/// 窗口里换了库，A 库的 sha 与路径就登进 B 库的 `index.db` 了（`reindex_async` 之所以
/// 只在锁里拿句柄、不在锁里干活，是同一条理由）。
fn 登记附件(bg: std::sync::Arc<std::sync::Mutex<Index>>, 记录: assets::AssetOut) {
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(index) = bg.lock() else {
            log::warn!("附件登记跳过：索引那条连接被毒化（图片已在盘上，不影响显示）");
            return;
        };
        if let Err(e) = assets::register(index.conn(), &记录, None) {
            log::warn!("附件登记没补上（图片已在盘上，不影响显示）：{e}");
        }
    });
}

/// 把当前 Vault 的 `attachments/` 放进 asset 协议的运行期 scope，并撤掉上一个库的那条。
///
/// 配置文件里 scope 是空数组——Vault 位置由用户随时改，静态配置写不死，所以只能运行期给。
/// 这条 scope 只管**前端能不能读到某个路径**，与写盘无关：写文件走的是 `Vault::resolve`
/// 那道墙。撤旧的不是洁癖，是"切库之后旧库的图不该还能显示"这条产品边界。
fn 盯资产目录(app: &AppHandle, 记着: &Mutex<Option<PathBuf>>, vault: &Vault) {
    let 目录 = vault.root().join(note_core::vault::ATTACHMENTS_DIR);
    let scope = app.asset_protocol_scope();
    if let Ok(mut 守) = 记着.lock() {
        if let Some(旧) = 守.as_ref() {
            if *旧 != 目录 {
                let _ = scope.forbid_directory(旧, true);
            }
        }
        *守 = Some(目录.clone());
    }
    if let Err(e) = scope.allow_directory(&目录, true) {
        log::warn!("asset 协议没放行 attachments 目录，图片只显示文件名：{e}");
    }
}

/// 起文件监听。外部改了库里的文件时重算那几篇，然后广播 `note://indexed`
/// 让列表与正文自己刷新——docs/05 验收 ⑤ 的"要么刷新"那一半，之前只有"不覆盖"。
///
/// 起不来不是致命错误：记一条日志继续跑，用户至少还能手动刷新。
fn start_watcher(app: &AppHandle, hub: &Hub) -> Option<note_core::watch::WatcherHandle> {
    let vault = hub.vault().clone();
    let bg = hub.indexer();
    let handle = app.clone();
    match note_core::watch::spawn(hub.vault(), note_core::watch::DEBOUNCE, move |changes| {
        let Ok(index) = bg.lock() else { return };
        match apply_external(&vault, &index, &changes) {
            Ok(0) => {}
            Ok(count) => {
                log::info!("外部改了 {count} 篇，索引已跟上");
                let rels: Vec<String> = changes
                    .iter()
                    .map(|c| match c {
                        note_core::watch::Change::Touched(r)
                        | note_core::watch::Change::Removed(r) => r.clone(),
                    })
                    .collect();
                let _ = handle.emit("note://indexed", rels);
            }
            Err(e) => log::warn!("外部改动收敛失败：{e}"),
        }
    }) {
        Ok(w) => Some(w),
        Err(e) => {
            log::warn!("文件监听起不来（界面不会自动刷新，手动刷新仍可用）：{e}");
            None
        }
    }
}

/// 当日做一次快照。启动后跑，不挡启动、不排主锁——整库遍历在两万篇下是秒级的，
/// 握着锁做就等于把刚拆掉的"隐形预算"从后门请回来。
fn snapshot_daily(app: AppHandle) {
    let vault = match app
        .state::<Shared>()
        .0
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|h| h.vault().clone()))
    {
        Some(v) => v,
        None => return, // 还没选库，没什么可备份
    };
    tauri::async_runtime::spawn_blocking(move || match snapshot_vault(&vault, false) {
        Ok(Some(s)) => log::info!("每日快照完成 {}，收了 {} 个文件", s.id, s.copied_files),
        Ok(None) => log::debug!("今天已经快照过，或没配备份目录"),
        Err(e) => log::warn!("每日快照失败：{e}"),
    });
}

/// 取后台任务的句柄：`Vault` 克隆 + 索引那条独立连接。
/// **只在取句柄的一瞬锁主锁**——拿着主锁做长任务就是上一版"保存后读命令等 3.26 秒"的病。
fn bg_handles(
    state: &State<'_, Shared>,
) -> Option<(
    note_core::vault::Vault,
    std::sync::Arc<std::sync::Mutex<Index>>,
)> {
    let guard = state.0.lock().ok()?;
    let hub = guard.as_ref()?;
    Some((hub.vault().clone(), hub.indexer()))
}

/// 导入预览：只算计划不写盘。源目录由用户填（与选库同一套做法，不引原生对话框）。
#[tauri::command]
async fn import_preview(app: AppHandle, src: String) -> Result<Vec<ImportEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (vault, bg) = bg_handles(&app.state::<Shared>()).ok_or("尚未选择 Vault")?;
        let _index = bg.lock().map_err(|e| e.to_string())?;
        note_core::import::plan(&vault, Path::new(&src), note_core::import::DEFAULT_INTO)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 真正导入 + 逐篇索引，做完广播 `note://indexed` 让列表自己刷新。
#[tauri::command]
async fn import_apply(app: AppHandle, src: String) -> Result<ImportReport, String> {
    let handle = app.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        let (vault, bg) = bg_handles(&app.state::<Shared>()).ok_or("尚未选择 Vault")?;
        let index = bg.lock().map_err(|e| e.to_string())?;
        note_core::import::import_and_index(
            &vault,
            &index,
            Path::new(&src),
            note_core::import::DEFAULT_INTO,
            false,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let rels = report.notes.clone();
    let _ = handle.emit("note://indexed", rels);
    Ok(report)
}

/// 唤起速记窗。已存在就复用——不重复建窗口，也不打断用户已经输入的内容。
fn show_capture(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(CAPTURE_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, CAPTURE_LABEL, WebviewUrl::App("index.html".into()))
        .title("速记")
        .inner_size(620.0, 172.0)
        .decorations(false)
        // 无边框窗口只有保留系统边框区，Win11 才会画圆角与投影（与主窗口同档）
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .center()
        .build()?;
    Ok(())
}

/// 落盘同步返回（实测含 fsync 的 p95 是 5.93ms，在 8ms 预算内），
/// 索引挪到后台线程（实测 p95 9.86ms，同步做速记窗就会发涩）。
/// 命令返回即代表内容已落盘——关掉窗口不等于可能丢。
#[tauri::command]
fn capture_text(
    app: AppHandle,
    state: State<'_, Shared>,
    text: String,
    source_url: Option<String>,
) -> Result<Captured, String> {
    let cap = with_hub_mut(&state, |h| {
        h.capture_write(&text, source_url.as_deref(), true)
    })?;
    let rel = cap.rel.clone();
    let content = cap.content.clone();
    reindex_async(app, vec![rel.clone()], move |vault, index| {
        reindex_captured(vault, index, &rel, &content)
    });
    Ok(cap)
}

#[tauri::command]
fn hide_capture(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(CAPTURE_LABEL) {
        let _ = w.hide();
    }
    Ok(())
}

#[tauri::command]
fn app_info(state: State<'_, Shared>) -> Result<AppInfo, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    match guard.as_ref() {
        Some(hub) => hub.app_info().map_err(|e| e.to_string()),
        // 没选库不是错误：首启界面要拿到"没有库"这个状态，而不是去匹配错误文案
        None => Ok(AppInfo::no_vault()),
    }
}

#[tauri::command]
fn list_notes(state: State<'_, Shared>, limit: Option<usize>) -> Result<NoteList, String> {
    with_hub(&state, |h| {
        h.list_notes(limit.unwrap_or(200).clamp(1, 2000))
    })
}

/// 侧栏自定义顺序。读命令，但走的是文件而不是索引，所以库里没索引也照样返回空表。
#[tauri::command]
fn tree_order(state: State<'_, Shared>) -> Result<Vec<note_core::tree_order::TreeOrder>, String> {
    with_hub(&state, |h| h.tree_order())
}

/// 一次可以交下好几层（把一篇拖进别的目录，源层与目标层都变了）。
///
/// 走 `with_hub_write` 那把主锁**不是为了碰 SQLite**（它一个字节都不写库），是为了
/// 串行化"读—改—写"：命令跑在线程池上，两次快速连拖若并发，后写的会把前一次那层
/// 覆盖回它自己读到的旧状态。锁的持有时长就是一个小文件的 fsync（实测同类写 2–6ms），
/// 远在 G6 的 8ms 之内。
#[tauri::command]
fn tree_order_save(
    state: State<'_, Shared>,
    orders: Vec<note_core::tree_order::TreeOrder>,
) -> Result<(), String> {
    with_hub_write(&state, |h| h.save_tree_order(&orders)).map_err(|e| e.message)
}

#[tauri::command]
fn read_note(state: State<'_, Shared>, rel: String) -> Result<NoteDetail, String> {
    with_hub(&state, |h| h.read_note(&rel))
}

#[tauri::command]
fn read_raw(state: State<'_, Shared>, rel: String) -> Result<NoteSource, String> {
    with_hub(&state, |h| h.read_raw(&rel))
}

/// 行内编辑器要的整篇结构（每块含精确源切片，未改动的块原样回写）
#[tauri::command]
fn note_edit_doc(state: State<'_, Shared>, rel: String) -> Result<EditDoc, String> {
    with_hub(&state, |h| h.note_edit_doc(&rel))
}

#[tauri::command]
fn search_keyword(
    state: State<'_, Shared>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<HitRow>, String> {
    with_hub(&state, |h| {
        h.search_keyword(&query, limit.unwrap_or(20).clamp(1, 200))
    })
}

/// 反链面板：一篇的入链与出链（含悬空的，带原始写法）
#[tauri::command]
fn note_links(
    state: State<'_, Shared>,
    rel: String,
    limit: Option<usize>,
) -> Result<LinkPanel, String> {
    with_hub(&state, |h| {
        h.note_links(&rel, limit.unwrap_or(40).clamp(1, 500))
    })
}

#[tauri::command]
fn vault_default_path() -> String {
    note_core::vault::default_vault_path().display().to_string()
}

#[tauri::command]
fn vault_open(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
    path: String,
) -> Result<AppInfo, String> {
    let hub = Hub::open_or_create(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
    let info = hub.app_info().map_err(|e| e.to_string())?;
    let watcher = start_watcher(&app, &hub);
    盯资产目录(&app, &state.2, hub.vault());
    *state.0.lock().map_err(|e| e.to_string())? = Some(hub);
    *state.1.lock().map_err(|e| e.to_string())? = watcher;
    write_last_vault(&app, std::path::Path::new(&path));
    Ok(info)
}

/// 写命令一律"落盘同步 + 索引后台"。返回即代表内容已经在磁盘上，
/// 索引晚一点才追上——前端收到 `note://indexed` 再校正列表与正文。
#[tauri::command]
fn save_note(
    app: AppHandle,
    state: State<'_, Shared>,
    rel: String,
    content: String,
    expect_hash: Option<String>,
) -> Result<String, WriteErr> {
    let hash = with_hub_write(&state, |h| {
        h.save_note_write(&rel, &content, expect_hash.as_deref())
    })?;
    reindex_async(app, vec![rel.clone()], move |vault, index| {
        reindex_note(vault, index, &rel)
    });
    Ok(hash)
}

#[tauri::command]
fn note_create(
    app: AppHandle,
    state: State<'_, Shared>,
    title: String,
) -> Result<String, WriteErr> {
    let rel = with_hub_write(&state, |h| h.note_create_file(&title))?;
    let shown = rel.clone();
    reindex_async(app, vec![rel.clone()], move |vault, index| {
        reindex_note(vault, index, &rel)
    });
    Ok(shown)
}

/// 把剪贴板来的图片字节存进 `attachments/`，返回内容寻址路径给前端拼成 `![[…]]`。
///
/// **只有落盘那一步是同步的**：返回即代表字节已经在盘上，正文里那行引用不会指着空气。
/// `attachments` 表那一行在后台补（可丢的派生数据，docs/02 §`.note/` 两分层），
/// 所以粘一张 2MB 的截图不会被 DB 写排队拖住——它也不该报错：图已经存好了。
///
/// 字节走 IPC 的 **raw body**（`invoke("attachment_save", uint8)`）。用 JSON 传一张
/// 2MB 的图要么 base64 膨胀到 2.7MB，要么十进制数组膨胀到 8MB 以上，而这条命令就在
/// 打字路径上；格式则由**字节本身**判（`assets::sniff`），不信文件名——剪贴板给的名字
/// 永远是 `image.png`，用户改了什么名我们根本不知道。
#[tauri::command]
async fn attachment_save(
    state: State<'_, Shared>,
    request: tauri::ipc::Request<'_>,
) -> Result<assets::AssetOut, WriteErr> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b,
        // 前端忘了走 raw（传了对象/数组）时给一句能看懂的话，而不是把 JSON 当图片存下来
        _ => {
            return Err(WriteErr {
                kind: "error",
                message: "attachment_save 要走 raw body：前端请传 Uint8Array".into(),
            })
        }
    };
    // 锁里只做"确认选了哪个库 + 拿一份句柄"，sha256、写文件与 fsync 全在锁外。
    //
    // 这条命令的开销**随图片大小走**（手机原图 5–8MB，本机实测光 sha256 就要 40–60ms），
    // 压在 Hub 主锁上就是"粘一张图，期间列表与打开笔记全排队"——docs/03 记过一次
    // 3.26 秒的同款形状。`Vault` 内部只是一个路径，克隆一份出来用，
    // 拿法与 `reindex_async` 一致（只在锁里取句柄，不在锁里干活）。
    let (vault, bg) = {
        let guard = state.0.lock().map_err(werr_io)?;
        let hub = guard.as_ref().ok_or_else(|| WriteErr {
            kind: "error",
            message: "尚未选择 Vault".into(),
        })?;
        (hub.vault().clone(), hub.indexer())
    };
    let 记录 = assets::save_bytes(&vault, bytes).map_err(werr)?;
    登记附件(bg, 记录.clone());
    Ok(记录)
}

#[tauri::command]
fn note_rename(
    app: AppHandle,
    state: State<'_, Shared>,
    rel: String,
    new_stem: String,
) -> Result<String, WriteErr> {
    let new_rel = with_hub_write(&state, |h| h.note_rename_file(&rel, &new_stem))?;
    let shown = new_rel.clone();
    reindex_async(
        app,
        vec![rel.clone(), new_rel.clone()],
        move |vault, index| reindex_moved(vault, index, &rel, &new_rel),
    );
    Ok(shown)
}

#[tauri::command]
fn note_move(
    app: AppHandle,
    state: State<'_, Shared>,
    rel: String,
    new_rel: String,
) -> Result<(), WriteErr> {
    with_hub_write(&state, |h| h.note_move_file(&rel, &new_rel))?;
    reindex_async(
        app,
        vec![rel.clone(), new_rel.clone()],
        move |vault, index| reindex_moved(vault, index, &rel, &new_rel),
    );
    Ok(())
}

#[tauri::command]
fn note_trash(app: AppHandle, state: State<'_, Shared>, rel: String) -> Result<(), WriteErr> {
    with_hub_write(&state, |h| h.note_trash_file(&rel))?;
    reindex_async(app, vec![rel.clone()], move |_vault, index| {
        unindex(index, &rel)
    });
    Ok(())
}

#[tauri::command]
fn list_trash(state: State<'_, Shared>) -> Result<Vec<TrashRow>, String> {
    with_hub(&state, |h| h.list_trash())
}

#[tauri::command]
fn note_restore(
    app: AppHandle,
    state: State<'_, Shared>,
    batch: String,
    rel: String,
) -> Result<(), WriteErr> {
    with_hub_write(&state, |h| h.note_restore_file(&batch, &rel))?;
    reindex_async(app, vec![rel.clone()], move |vault, index| {
        reindex_note(vault, index, &rel)
    });
    Ok(())
}

// ---- 备份与快照（docs/03 §备份：唯一副本 = 没有副本）----

/// 设备份目录，或显式关掉（`path: null, disabled: true`）。
/// 非法路径直接报错且不落配置；返回新的 app_info，界面一次往返就能把三态画对。
#[tauri::command]
fn backup_set(
    state: State<'_, Shared>,
    path: Option<String>,
    disabled: bool,
) -> Result<AppInfo, String> {
    with_hub_write(&state, |h| {
        h.set_backup(path.as_deref(), disabled)?;
        h.app_info()
    })
    .map_err(|e| e.message)
}

/// "立即备份"。整库遍历在库里跑，所以只在取 `Vault` 克隆的那一瞬锁主锁。
#[tauri::command]
fn backup_run(state: State<'_, Shared>) -> Result<Option<SnapshotRow>, String> {
    let vault = {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        guard
            .as_ref()
            .ok_or_else(|| "尚未选择 Vault".to_string())?
            .vault()
            .clone()
    };
    snapshot_vault(&vault, true).map_err(|e| e.to_string())
}

#[tauri::command]
fn backup_recent(
    state: State<'_, Shared>,
    limit: Option<usize>,
) -> Result<Vec<SnapshotRow>, String> {
    with_hub(&state, |h| h.snapshots_recent(limit.unwrap_or(10)))
}

#[tauri::command]
fn backup_history(state: State<'_, Shared>, rel: String) -> Result<Vec<SnapshotRow>, String> {
    with_hub(&state, |h| h.snapshots_of(&rel))
}

/// 从某份快照取回一篇。落盘同步返回，索引照旧走后台——与保存同一条纪律。
#[tauri::command]
fn backup_restore(
    app: AppHandle,
    state: State<'_, Shared>,
    rel: String,
    id: String,
) -> Result<String, WriteErr> {
    let hash = with_hub_write(&state, |h| h.snapshot_restore(&rel, &id))?;
    reindex_async(app, vec![rel.clone()], move |vault, index| {
        reindex_note(vault, index, &rel)
    });
    Ok(hash)
}

/// AI 档 0 的三条命令。共同点：**锁里只拿 `Vault` 句柄**，读文件、问凭据管理器、
/// 打网络全在锁外做。`ai_test` 那一趟是几百毫秒到 20 秒的网络往返，
/// 握着主锁做它等于把整个应用冻在那儿——与 docs/03 §后端调用纪律 里那个 3.26 秒同一种形状。
fn vault_of(state: &State<'_, Shared>) -> Result<Vault, WriteErr> {
    let guard = state.0.lock().map_err(werr_io)?;
    let hub = guard.as_ref().ok_or_else(|| WriteErr {
        kind: "error",
        message: "尚未选择 Vault".into(),
    })?;
    Ok(hub.vault().clone())
}

fn 中断(e: impl std::fmt::Display) -> WriteErr {
    WriteErr {
        kind: "error",
        message: format!("后台任务被中断：{e}"),
    }
}

#[tauri::command]
async fn ai_view(state: State<'_, Shared>) -> Result<note_core::ai::AiView, WriteErr> {
    let vault = vault_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || note_core::ai::view(&vault).map_err(werr))
        .await
        .map_err(中断)?
}

/// 存配置。**空串就是"清空这一项"**（前端不需要另一条删除命令——两条命令管同一件事，
/// 早晚一条改了另一条没改）。地址的校验在 `ai::端点`，这里不重复判。
#[tauri::command]
async fn ai_save_config(
    state: State<'_, Shared>,
    base_url: String,
    chat_model: String,
    embedding_model: String,
) -> Result<note_core::ai::AiView, WriteErr> {
    let vault = vault_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        note_core::ai::save(
            &vault,
            &note_core::ai::AiConfig {
                base_url: Some(base_url),
                chat_model: Some(chat_model),
                embedding_model: Some(embedding_model),
            },
        )
        .map_err(werr)?;
        note_core::ai::view(&vault).map_err(werr)
    })
    .await
    .map_err(中断)?
}

/// 存 / 清 Key（空串 = 删）。**返回的是视图，不是 Key 本身**——把明文带回 WebView
/// 等于把 docs/03 §后端调用纪律 里"API Key 不进 WebView"那条从后门拆掉。
#[tauri::command]
async fn ai_save_key(
    state: State<'_, Shared>,
    key: String,
) -> Result<note_core::ai::AiView, WriteErr> {
    let vault = vault_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        note_core::ai::set_key(&key).map_err(werr)?;
        note_core::ai::view(&vault).map_err(werr)
    })
    .await
    .map_err(中断)?
}

/// 连通测试：两个最小探针请求（chat + embeddings）。**探针文本是固定的 `ping`，
/// 不含任何笔记内容**——这句话要出现在界面上，本地优先的产品里用户真会问。
#[tauri::command]
async fn ai_test(state: State<'_, Shared>) -> Result<note_core::ai::Report, WriteErr> {
    let vault = vault_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = note_core::ai::load(&vault).map_err(werr)?;
        Ok(note_core::ai::probe(&cfg))
    })
    .await
    .map_err(中断)?
}

/// 问端点「你家有哪些模型」。**不碰 SQLite，也就不碰任何锁**——它只要 `Vault` 里那份
/// `[ai]` 配置（地址）与凭据管理器里的 Key。零请求体，笔记字节一个都不发。
#[tauri::command]
async fn ai_discover(state: State<'_, Shared>) -> Result<note_core::ai::发现, String> {
    let vault = {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        guard
            .as_ref()
            .ok_or_else(|| "尚未选择 Vault".to_string())?
            .vault()
            .clone()
    };
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = note_core::ai::load(&vault).map_err(|e| e.to_string())?;
        note_core::ai::列模型(&cfg).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 混合检索。**必然含一次网络往返**（把查询本身嵌成向量），所以它是 async 命令而不是
/// 同步那一批——界面那条关键词搜索仍然走 8ms 的同步通路，这一路晚一点到就晚一点到。
#[tauri::command]
async fn search_hybrid(
    state: State<'_, Shared>,
    query: String,
) -> Result<note_core::retrieve::检索结果, String> {
    let vault = {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        guard
            .as_ref()
            .ok_or_else(|| "尚未选择 Vault".to_string())?
            .vault()
            .clone()
    };
    let 派生 = {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        guard
            .as_ref()
            .ok_or_else(|| "尚未选择 Vault".to_string())?
            .indexer()
    };
    tauri::async_runtime::spawn_blocking(move || {
        // **分叉一条专用连接再干活**：这一趟里有一次网络往返，握着主锁或后台那条锁
        // 打它，就是 docs/03 §后端调用纪律 里"保存后读命令等 3.26 秒"的同一种病。
        // 开一条 SQLite 连接是毫秒级，摊在往返旁边不算成本。
        let 专 = {
            let 写锁 = 派生.lock().map_err(|e| e.to_string())?;
            写锁.fork().map_err(|e| e.to_string())?
        };
        note_core::retrieve::混合或退回(&vault, 专.conn(), &query).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 带引用的问答。**可能两次网络往返**（引用违规会重生成一次），所以同样在锁外、
/// 用一条分叉出来的连接干活；答案落 `ai_runs` 由 note-core 那一侧负责。
#[tauri::command]
async fn ai_ask(
    state: State<'_, Shared>,
    query: String,
) -> Result<note_core::answer::答复, WriteErr> {
    let (vault, 派生) = {
        let guard = state.0.lock().map_err(werr_io)?;
        let hub = guard.as_ref().ok_or_else(|| WriteErr {
            kind: "error",
            message: "尚未选择 Vault".into(),
        })?;
        (hub.vault().clone(), hub.indexer())
    };
    tauri::async_runtime::spawn_blocking(move || {
        let 专 = {
            let 写锁 = 派生.lock().map_err(|_| WriteErr {
                kind: "error",
                message: "索引那条连接被毒化，问不了".into(),
            })?;
            写锁.fork().map_err(werr)?
        };
        note_core::answer::ask(&vault, 专.conn(), &query).map_err(werr)
    })
    .await
    .map_err(|e| WriteErr {
        kind: "error",
        message: e.to_string(),
    })?
}

/// 审计页：最近的生成记录（含未采纳的那几次）。
#[tauri::command]
fn ai_runs(
    state: State<'_, Shared>,
    limit: Option<i64>,
) -> Result<Vec<note_core::answer::运行>, String> {
    with_hub(&state, |h| h.ai_runs(limit.unwrap_or(20)))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // 单实例：二次启动唤起已有窗口，而不是开第二个库（SQLite 写锁只有一个 owner）
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }));

    builder = builder.plugin(
        tauri_plugin_log::Builder::new()
            .level(log::LevelFilter::Info)
            .build(),
    );

    // 全局热键：主窗口开着或最小化都能唤起速记。注册失败（被别的程序占了）
    // 只降级不致命——窗口里的按钮照样能记。
    builder = builder.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    if let Err(e) = show_capture(app) {
                        log::error!("打开速记窗失败：{e}");
                    }
                }
            })
            .build(),
    );

    builder
        .manage(Shared(Mutex::new(None), Mutex::new(None), Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            app_info,
            capture_text,
            hide_capture,
            list_notes,
            tree_order,
            tree_order_save,
            read_note,
            read_raw,
            note_edit_doc,
            search_keyword,
            note_links,
            vault_default_path,
            vault_open,
            save_note,
            note_create,
            attachment_save,
            note_rename,
            note_move,
            note_trash,
            list_trash,
            note_restore,
            backup_set,
            backup_run,
            backup_recent,
            backup_history,
            backup_restore,
            import_preview,
            import_apply,
            ai_view,
            ai_save_config,
            ai_save_key,
            ai_test,
            ai_discover,
            search_hybrid,
            ai_ask,
            ai_runs
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<Shared>();

            if let Some(p) = read_last_vault(&handle) {
                match Hub::open(&p) {
                    Ok(hub) => {
                        let watcher = start_watcher(&handle, &hub);
                        盯资产目录(&handle, &state.2, hub.vault());
                        *state.0.lock().unwrap() = Some(hub);
                        *state.1.lock().unwrap() = watcher;
                        log::info!("已打开 Vault {}", p.display());
                        // 当日还没快照过就补一次（docs/03 §备份）。放在这里而不是
                        // 定时器：规格要的是"当日首次启动后"，不是固定钟点。
                        snapshot_daily(handle.clone());
                    }
                    Err(e) => log::warn!("打开上次 Vault 失败 {p:?}: {e}"),
                }
            }

            // Windows 材质。失败（旧系统 / 集显受限）就安静降级成实色底，
            // 绝不能因为拿不到 Mica 而起不来。
            #[cfg(windows)]
            if let Some(w) = app.get_webview_window("main") {
                if window_vibrancy::apply_mica(&w, None).is_err() {
                    log::info!("Mica 不可用，使用实色底");
                }
            }

            // 字符串可直接注册（GlobalShortcut 对 &str 有实现），解析失败会返回 Err
            if let Err(e) = app.global_shortcut().register(CAPTURE_SHORTCUT) {
                log::warn!("注册全局热键 {CAPTURE_SHORTCUT} 失败：{e}");
            }

            if let Some(icon) = app.default_window_icon() {
                let w = app.get_webview_window("main");
                let _ = tauri::tray::TrayIconBuilder::with_id("main")
                    .icon(icon.clone())
                    .tooltip("note")
                    .on_tray_icon_event(move |_tray, ev| {
                        if let tauri::tray::TrayIconEvent::Click { .. } = ev {
                            if let Some(ref w) = w {
                                let _ = w.unminimize();
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    })
                    .build(app);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("note 启动失败");
}
