use std::path::PathBuf;
use std::sync::Mutex;

use note_core::capture::Captured;
use note_core::service::{
    AppInfo, EditDoc, HitRow, Hub, NoteDetail, NoteList, NoteSource, TrashRow,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// 速记窗标签，前端按它路由到 Capture 组件。
const CAPTURE_LABEL: &str = "capture";

/// 默认热键。刻意避开 Ctrl+N（新建惯例）与 Win+N（系统通知中心）。
const CAPTURE_SHORTCUT: &str = "Alt+Shift+N";

/// 壳只持有状态与命令注册。业务判断一律在 `note-core`——
/// 因为 CLI / MCP 必须走到完全相同的代码（docs/03 §后端 = 本地服务层）。
struct Shared(Mutex<Option<Hub>>);

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
fn reindex_async<F>(app: AppHandle, job: F)
where
    F: FnOnce(&mut Hub) -> note_core::Result<()> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let ok = match app.state::<Shared>().0.lock() {
            Ok(mut guard) => match guard.as_mut() {
                Some(hub) => job(hub).is_ok(),
                None => false,
            },
            Err(_) => false,
        };
        // 前端靠它把"已存"变成"已可搜"；失败时下次 reindex 会兜底
        let _ = app.emit("note://indexed", ok);
    });
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
    reindex_async(app, move |h| h.index_captured(&rel, &content));
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
    *state.0.lock().map_err(|e| e.to_string())? = Some(hub);
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
    reindex_async(app, move |h| h.index_one(&rel));
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
    reindex_async(app, move |h| h.index_one(&rel));
    Ok(shown)
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
    reindex_async(app, move |h| h.index_moved(&rel, &new_rel));
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
    reindex_async(app, move |h| h.index_moved(&rel, &new_rel));
    Ok(())
}

#[tauri::command]
fn note_trash(app: AppHandle, state: State<'_, Shared>, rel: String) -> Result<(), WriteErr> {
    with_hub_write(&state, |h| h.note_trash_file(&rel))?;
    reindex_async(app, move |h| h.index_trashed(&rel));
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
    reindex_async(app, move |h| h.index_one(&rel));
    Ok(())
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
        .manage(Shared(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            app_info,
            capture_text,
            hide_capture,
            list_notes,
            read_note,
            read_raw,
            note_edit_doc,
            search_keyword,
            vault_default_path,
            vault_open,
            save_note,
            note_create,
            note_rename,
            note_move,
            note_trash,
            list_trash,
            note_restore
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<Shared>();

            if let Some(p) = read_last_vault(&handle) {
                match Hub::open(&p) {
                    Ok(hub) => {
                        *state.0.lock().unwrap() = Some(hub);
                        log::info!("已打开 Vault {}", p.display());
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
