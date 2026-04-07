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
    let output = Command::new("git")
        .arg("-C")
        .arg(&repo_path)
        .args(&args)
        .output()
        .map_err(AppError::Io)?;
    Ok(GitExecResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        code: output.status.code().unwrap_or(-1),
    })
}
