use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct GitExecResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

#[tauri::command]
pub fn git_exec(repo_path: String, args: Vec<String>) -> AppResult<GitExecResult> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&repo_path).args(&args);

    // Sanitize the environment so subprocesses behave deterministically and
    // never block on interactive prompts. Without these:
    //   GIT_TERMINAL_PROMPT=0  fetch against an unreachable HTTPS remote
    //                          would hang forever waiting for credentials
    //                          (no TTY to type into), wedging the refresh loop.
    //   GIT_PAGER=cat          prevents pager-related blocking on commands
    //                          that paginate output in unusual configs.
    //   LC_ALL=C               parsers in gitService.ts implicitly assume
    //                          English git output; translated errors would
    //                          silently break detection.
    //   GIT_OPTIONAL_LOCKS=0   read-only commands won't contend with
    //                          concurrent user git operations on the repo.
    //   GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE removed — if the app was
    //   launched from inside a git repo with these set, subprocesses would
    //   misdirect to the launching shell's repo instead of repo_path.
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE");

    let output = cmd.output().map_err(AppError::Io)?;
    Ok(GitExecResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        code: output.status.code().unwrap_or(-1),
    })
}
