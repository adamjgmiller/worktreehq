use crate::error::{AppError, AppResult};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

static ORDER_LOCK: Mutex<()> = Mutex::new(());

fn order_path() -> AppResult<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::Msg("no config dir".into()))?
        .join("worktreehq");
    std::fs::create_dir_all(&base).map_err(AppError::Io)?;
    Ok(base.join("worktree_order.json"))
}

fn load_all() -> AppResult<HashMap<String, Vec<String>>> {
    let p = order_path()?;
    if !p.exists() {
        return Ok(HashMap::new());
    }
    let text = std::fs::read_to_string(&p).map_err(AppError::Io)?;
    if text.trim().is_empty() {
        return Ok(HashMap::new());
    }
    match serde_json::from_str(&text) {
        Ok(v) => Ok(v),
        Err(e) => {
            let bad = p.with_extension("json.bad");
            eprintln!(
                "[worktree_order] parse error ({}); moving corrupt file to {}",
                e,
                bad.display()
            );
            let _ = std::fs::rename(&p, &bad);
            Ok(HashMap::new())
        }
    }
}

fn save_all(map: &HashMap<String, Vec<String>>) -> AppResult<()> {
    let p = order_path()?;
    let tmp = p.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(map)
        .map_err(|e| AppError::Msg(format!("worktree_order serialize: {}", e)))?;
    std::fs::write(&tmp, text).map_err(AppError::Io)?;
    std::fs::rename(&tmp, &p).map_err(AppError::Io)?;
    Ok(())
}

#[tauri::command]
pub fn read_worktree_order(repo_path: String) -> AppResult<Vec<String>> {
    let _g = ORDER_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let map = load_all()?;
    Ok(map.get(&repo_path).cloned().unwrap_or_default())
}

#[tauri::command]
pub fn write_worktree_order(repo_path: String, order: Vec<String>) -> AppResult<()> {
    let _g = ORDER_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut map = load_all()?;
    map.insert(repo_path, order);
    save_all(&map)
}
