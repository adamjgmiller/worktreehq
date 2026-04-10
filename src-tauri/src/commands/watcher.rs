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
            if let Err(e) = watcher.watch(&path, RecursiveMode::Recursive) {
                eprintln!("[watcher] failed to watch {}: {}", p, e);
            }
        }
    }

    // Drop the old watcher BEFORE installing the new one. If we assigned
    // `*slot = Some(new)` while the old watcher was still inside the slot,
    // both watchers would emit `worktree-changed` events into the same
    // AppHandle for the duration of the drop, doubling every refresh event.
    let mut slot = state.0.lock().unwrap_or_else(|p| p.into_inner());
    slot.take();
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
