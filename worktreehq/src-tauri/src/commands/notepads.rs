use crate::error::{AppError, AppResult};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

// Single-process lock so concurrent saves from rapid keystrokes can't
// interleave a read-modify-write on notepads.json.
static NOTEPADS_LOCK: Mutex<()> = Mutex::new(());

fn notepads_path() -> AppResult<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::Msg("no config dir".into()))?
        .join("worktreehq");
    std::fs::create_dir_all(&base).map_err(AppError::Io)?;
    Ok(base.join("notepads.json"))
}

fn load_all() -> AppResult<HashMap<String, String>> {
    let p = notepads_path()?;
    if !p.exists() {
        return Ok(HashMap::new());
    }
    let text = std::fs::read_to_string(&p).map_err(AppError::Io)?;
    if text.trim().is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_str(&text).map_err(|e| AppError::Msg(format!("notepads parse: {}", e)))
}

fn save_all(map: &HashMap<String, String>) -> AppResult<()> {
    let p = notepads_path()?;
    let tmp = p.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(map)
        .map_err(|e| AppError::Msg(format!("notepads serialize: {}", e)))?;
    std::fs::write(&tmp, text).map_err(AppError::Io)?;
    std::fs::rename(&tmp, &p).map_err(AppError::Io)?;
    Ok(())
}

#[tauri::command]
pub fn read_notepad(worktree_path: String) -> AppResult<String> {
    let _g = NOTEPADS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let map = load_all()?;
    Ok(map.get(&worktree_path).cloned().unwrap_or_default())
}

#[tauri::command]
pub fn write_notepad(worktree_path: String, content: String) -> AppResult<()> {
    let _g = NOTEPADS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut map = load_all()?;
    if content.is_empty() {
        map.remove(&worktree_path);
    } else {
        map.insert(worktree_path, content);
    }
    save_all(&map)
}
