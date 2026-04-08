use crate::error::{AppError, AppResult};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

pub struct WatcherState(pub Mutex<Option<RecommendedWatcher>>);

#[tauri::command]
pub fn start_watching(
    app: tauri::AppHandle,
    paths: Vec<String>,
    state: State<'_, WatcherState>,
) -> AppResult<()> {
    let app_handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            let path_str = ev
                .paths
                .first()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let _ = app_handle.emit("worktree-changed", path_str);
        }
    })
    .map_err(AppError::Notify)?;

    for p in paths {
        let path = std::path::PathBuf::from(&p);
        if path.exists() {
            let _ = watcher.watch(&path, RecursiveMode::Recursive);
        }
    }

    let mut slot = state.0.lock().unwrap_or_else(|p| p.into_inner());
    *slot = Some(watcher);
    let _ = app;
    Ok(())
}

#[tauri::command]
pub fn stop_watching(state: State<'_, WatcherState>) -> AppResult<()> {
    let mut slot = state.0.lock().unwrap_or_else(|p| p.into_inner());
    *slot = None;
    Ok(())
}

pub fn init(app: &mut tauri::App) {
    app.manage(WatcherState(Mutex::new(None)));
}
