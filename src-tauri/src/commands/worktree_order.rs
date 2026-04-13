use crate::error::AppResult;
use super::persistent_json::JsonMapStore;

static STORE: JsonMapStore<Vec<String>> =
    JsonMapStore::new("worktree_order.json", "worktree_order");

#[tauri::command]
pub fn read_worktree_order(repo_path: String) -> AppResult<Vec<String>> {
    Ok(STORE.read(&repo_path)?.unwrap_or_default())
}

#[tauri::command]
pub fn write_worktree_order(repo_path: String, order: Vec<String>) -> AppResult<()> {
    STORE.write(repo_path, order)
}
