use crate::error::AppResult;
use super::persistent_json::{cache_file_path, atomic_write};
use std::sync::Mutex;

// Single-process lock so we don't interleave reads/writes across parallel invocations.
static PR_CACHE_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
pub fn read_pr_cache() -> AppResult<String> {
    let _g = PR_CACHE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let p = cache_file_path("prs.json")?;
    if !p.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&p).map_err(crate::error::AppError::Io)
}

#[tauri::command]
pub fn write_pr_cache(content: String) -> AppResult<()> {
    let _g = PR_CACHE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let p = cache_file_path("prs.json")?;
    atomic_write(&p, &content)
}
