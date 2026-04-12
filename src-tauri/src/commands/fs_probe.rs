use crate::error::{AppError, AppResult};

// Plain filesystem existence probe. Not git work, so it belongs outside git_exec.
// Used by the frontend to detect in-progress operations (rebase-merge/, MERGE_HEAD, …)
// and to read/write the on-disk PR cache.
//
// Async + spawn_blocking is deliberate even though a single `Path::new().exists()`
// call is microseconds: the refresh pipeline fires ~5 marker probes per
// worktree (MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, rebase-apply/,
// rebase-merge/), so a repo with 50 worktrees does ~250 path_exists IPC
// calls per tick. A sync #[tauri::command] serializes every one of them on
// the main thread — see git_exec.rs for the full explanation of why that's
// what actually froze the UI on refresh click.
#[tauri::command]
pub async fn path_exists(path: String) -> AppResult<bool> {
    tauri::async_runtime::spawn_blocking(move || Ok(std::path::Path::new(&path).exists()))
        .await
        .map_err(|e| AppError::Msg(format!("path_exists join error: {e}")))?
}

// `mkdir -p` for the frontend. Used before `git worktree add <path>` so the
// parent directory (e.g. `<repo>/.claude/worktrees/`) exists on a fresh repo
// where Claude Code hasn't created it yet — git worktree add itself creates
// only the leaf, not intermediate parents.
//
// Async + spawn_blocking so a slow disk can't stall the Tauri main thread.
// No-op if the directory already exists (create_dir_all contract).
#[tauri::command]
pub async fn ensure_dir(path: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&path)
            .map_err(|e| AppError::Msg(format!("ensure_dir({path}) failed: {e}")))
    })
    .await
    .map_err(|e| AppError::Msg(format!("ensure_dir join error: {e}")))?
}
