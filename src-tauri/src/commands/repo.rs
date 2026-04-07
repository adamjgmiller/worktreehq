use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct RepoInfo {
    pub path: String,
    pub is_git: bool,
}

fn find_git_root(start: &std::path::Path) -> Option<PathBuf> {
    let mut cur = Some(start.to_path_buf());
    while let Some(p) = cur {
        if p.join(".git").exists() {
            return Some(p);
        }
        cur = p.parent().map(|x| x.to_path_buf());
    }
    None
}

#[tauri::command]
pub fn resolve_repo(path: Option<String>) -> AppResult<RepoInfo> {
    let candidate = match path {
        Some(p) => PathBuf::from(p),
        None => std::env::current_dir().map_err(AppError::Io)?,
    };
    let abs = candidate
        .canonicalize()
        .unwrap_or_else(|_| candidate.clone());
    if let Some(root) = find_git_root(&abs) {
        Ok(RepoInfo {
            path: root.to_string_lossy().to_string(),
            is_git: true,
        })
    } else {
        Ok(RepoInfo {
            path: abs.to_string_lossy().to_string(),
            is_git: false,
        })
    }
}

#[tauri::command]
pub fn open_path(_path: String) -> AppResult<()> {
    Ok(())
}
