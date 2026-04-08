use crate::error::AppResult;

// Plain filesystem existence probe. Not git work, so it belongs outside git_exec.
// Used by the frontend to detect in-progress operations (rebase-merge/, MERGE_HEAD, …)
// and to read/write the on-disk PR cache.
#[tauri::command]
pub fn path_exists(path: String) -> AppResult<bool> {
    Ok(std::path::Path::new(&path).exists())
}
