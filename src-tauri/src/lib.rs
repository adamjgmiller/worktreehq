mod commands;
mod error;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            commands::watcher::init(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::git_exec::git_exec,
            commands::repo::resolve_repo,
            commands::config::read_config,
            commands::config::write_config,
            commands::notepads::read_notepad,
            commands::notepads::write_notepad,
            commands::notepads::is_notepad_touched,
            commands::notepads::list_notepads,
            commands::notepads::delete_notepad,
            commands::watcher::start_watching,
            commands::watcher::stop_watching,
            commands::claude_state::read_claude_state,
            commands::claude_first_prompt::read_claude_first_prompt,
            commands::claude_first_prompt::read_claude_session_first_prompt,
            commands::fs_probe::path_exists,
            commands::shell_open::shell_open,
            commands::claude_session::open_claude_session,
            commands::pr_cache::read_pr_cache,
            commands::pr_cache::write_pr_cache,
            commands::worktree_order::read_worktree_order,
            commands::worktree_order::write_worktree_order,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
