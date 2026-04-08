use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct AppConfig {
    #[serde(default)]
    pub github_token: String,
    #[serde(default = "default_interval")]
    pub refresh_interval_ms: u64,
    #[serde(default = "default_fetch_interval")]
    pub fetch_interval_ms: u64,
    #[serde(default)]
    pub last_repo_path: Option<String>,
}

// 15s default. The filesystem watcher (scoped to .git/) covers the immediacy
// case for actual git changes, so the poll loop is just a safety net for
// things `notify` misses (mostly remote PR state). 5s was wasteful — every
// tick re-ran the full read pipeline.
fn default_interval() -> u64 {
    15_000
}

// 0 disables the auto-fetch loop. Default 60s keeps remote state reasonably fresh
// without hammering origin on every refresh tick.
fn default_fetch_interval() -> u64 {
    60_000
}

fn config_path() -> AppResult<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::Msg("no config dir".into()))?
        .join("worktreehq");
    std::fs::create_dir_all(&base).map_err(AppError::Io)?;
    Ok(base.join("config.toml"))
}

#[tauri::command]
pub fn read_config() -> AppResult<AppConfig> {
    let p = config_path()?;
    if !p.exists() {
        let env_token = std::env::var("GITHUB_TOKEN").unwrap_or_default();
        return Ok(AppConfig {
            github_token: env_token,
            refresh_interval_ms: default_interval(),
            fetch_interval_ms: default_fetch_interval(),
            last_repo_path: None,
        });
    }
    let text = std::fs::read_to_string(&p).map_err(AppError::Io)?;
    let mut cfg: AppConfig = toml::from_str(&text)?;
    if cfg.github_token.is_empty() {
        if let Ok(t) = std::env::var("GITHUB_TOKEN") {
            cfg.github_token = t;
        }
    }
    if cfg.refresh_interval_ms == 0 {
        cfg.refresh_interval_ms = default_interval();
    }
    // Note: fetch_interval_ms == 0 is a valid "disabled" signal and is preserved as-is.
    Ok(cfg)
}

#[tauri::command]
pub fn write_config(cfg: AppConfig) -> AppResult<()> {
    let p = config_path()?;
    let text = toml::to_string_pretty(&cfg)?;
    std::fs::write(&p, text).map_err(AppError::Io)?;
    Ok(())
}
