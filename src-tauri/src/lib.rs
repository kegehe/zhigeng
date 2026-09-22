use std::path::PathBuf;
use std::sync::Mutex;

use note_core::service::{AppInfo, HitRow, Hub, NoteDetail, NoteList};
use tauri::{Manager, State};

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

#[tauri::command]
fn app_info(state: State<'_, Shared>) -> Result<AppInfo, String> {
    with_hub(&state, |h| h.app_info())
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
fn vault_open(
    app: tauri::AppHandle,
    state: State<'_, Shared>,
    path: String,
) -> Result<AppInfo, String> {
    let hub = Hub::open(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
    let info = hub.app_info().map_err(|e| e.to_string())?;
    *state.0.lock().map_err(|e| e.to_string())? = Some(hub);
    write_last_vault(&app, std::path::Path::new(&path));
    Ok(info)
}

#[tauri::command]
fn save_note(state: State<'_, Shared>, rel: String, content: String) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let hub = guard.as_mut().ok_or_else(|| "尚未选择 Vault".to_string())?;
    hub.save_note(&rel, &content).map_err(|e| e.to_string())
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

    builder
        .manage(Shared(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            app_info,
            list_notes,
            read_note,
            search_keyword,
            vault_open,
            save_note
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
