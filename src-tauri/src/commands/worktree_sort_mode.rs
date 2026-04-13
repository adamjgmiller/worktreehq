use crate::error::AppResult;
use super::persistent_json::JsonMapStore;

// Kept in a separate file from worktree_order so a parse failure on one
// can't corrupt the other, and so upgrades don't have to migrate the
// existing worktree_order.json schema.
static STORE: JsonMapStore<String> =
    JsonMapStore::new("worktree_sort_mode.json", "worktree_sort_mode");

#[tauri::command]
pub fn read_worktree_sort_mode(repo_path: String) -> AppResult<Option<String>> {
    STORE.read(&repo_path)
}

#[tauri::command]
pub fn write_worktree_sort_mode(repo_path: String, mode: String) -> AppResult<()> {
    STORE.write(repo_path, mode)
}
