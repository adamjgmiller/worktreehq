use crate::error::{AppError, AppResult};
use std::path::PathBuf;
use std::sync::Mutex;

// Single-process lock so we don't interleave reads/writes across parallel invocations.
static PR_CACHE_LOCK: Mutex<()> = Mutex::new(());

fn pr_cache_path() -> AppResult<PathBuf> {
    let base = dirs::cache_dir()
        .ok_or_else(|| AppError::Msg("no cache dir".into()))?
        .join("worktreehq");
    std::fs::create_dir_all(&base).map_err(AppError::Io)?;
    Ok(base.join("prs.json"))
}

#[tauri::command]
pub fn read_pr_cache() -> AppResult<String> {
    let _g = PR_CACHE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let p = pr_cache_path()?;
    if !p.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&p).map_err(AppError::Io)
}

#[tauri::command]
pub fn write_pr_cache(content: String) -> AppResult<()> {
    let _g = PR_CACHE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let p = pr_cache_path()?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(AppError::Io)?;
    std::fs::rename(&tmp, &p).map_err(AppError::Io)?;
    Ok(())
}
