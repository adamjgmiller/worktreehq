use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct AppConfig {
    // Legacy field — new installs store tokens in the OS keychain via the
    // `keychain_store` command. Kept for backward compat and migration: the
    // frontend reads this on first launch of the new version, migrates the
    // value to keychain, and clears it. On steady-state this is always empty.
    #[serde(default)]
    pub github_token: String,
    // When true, the user has explicitly set (or cleared) github_token via
    // Settings, so read_config must NOT fall back to the GITHUB_TOKEN env var
    // — even when github_token is empty.
    #[serde(default)]
    pub github_token_explicitly_set: bool,
    // Persisted auth method preference: "gh-cli", "pat", or "none". When
    // absent (upgrade from older version), the frontend auto-detects by
    // trying gh CLI first, then keychain PAT, then falling through to none.
    #[serde(default)]
    pub auth_method: String,
    #[serde(default = "default_interval")]
    pub refresh_interval_ms: u64,
    #[serde(default = "default_fetch_interval")]
    pub fetch_interval_ms: u64,
    #[serde(default)]
    pub last_repo_path: Option<String>,
    // MRU list of repos the user has opened in this app, most-recent first.
    // Maintained from the frontend (`repoSelect.ts`) which dedupes and caps
    // the length. `last_repo_path` is kept in sync as `recent_repo_paths[0]`
    // so an older binary that doesn't know about this field still resolves
    // to the same repo on launch.
    #[serde(default)]
    pub recent_repo_paths: Vec<String>,
    // UI zoom level. Multiplied against the root font-size on the frontend so
    // every rem-based Tailwind class scales together. Persisted so the user's
    // preferred zoom survives restarts. Range clamped to [0.5, 2.0] in the
    // setter; out-of-range values from manual edits are clamped on read.
    #[serde(default = "default_zoom_level")]
    pub zoom_level: f64,
    // UI theme. One of "light", "dark", "system". Default is "dark" —
    // the app's established visual identity — so a first-launch user
    // sees dark regardless of OS `prefers-color-scheme`. "system" is
    // still available as an opt-in preference if the user wants their
    // OS appearance to drive the app. Any unrecognized value is
    // coerced back to "dark" on read.
    #[serde(default = "default_theme")]
    pub theme: String,
    // Shell script run in each newly-created worktree's directory right after
    // `git worktree add` succeeds. Multi-line, fed verbatim to `sh -c` so
    // `&&`, env-var expansion, and `cd` all work. Empty string means "no
    // post-create step" and is the default. Editable per-invocation in the
    // Create Worktree dialog; this field is the saved default.
    #[serde(default)]
    pub post_create_commands: String,
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

fn default_zoom_level() -> f64 {
    1.0
}

fn default_theme() -> String {
    "dark".to_string()
}

const ZOOM_MIN: f64 = 0.5;
const ZOOM_MAX: f64 = 2.0;

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
        // No config yet → fall back to GITHUB_TOKEN if present. The user
        // hasn't made an explicit choice yet so the legacy env behavior is
        // the right default for first-run UX.
        let env_token = std::env::var("GITHUB_TOKEN").unwrap_or_default();
        return Ok(AppConfig {
            github_token: env_token,
            github_token_explicitly_set: false,
            auth_method: String::new(),
            refresh_interval_ms: default_interval(),
            fetch_interval_ms: default_fetch_interval(),
            last_repo_path: None,
            recent_repo_paths: Vec::new(),
            zoom_level: default_zoom_level(),
            theme: default_theme(),
            post_create_commands: String::new(),
        });
    }
    let text = std::fs::read_to_string(&p).map_err(AppError::Io)?;
    let mut cfg: AppConfig = toml::from_str(&text)?;
    // Env fallback only fires when the user has NOT explicitly set the token
    // via Settings. This lets a user clear their token from the UI even when
    // GITHUB_TOKEN is exported in their shell.
    if cfg.github_token.is_empty() && !cfg.github_token_explicitly_set {
        if let Ok(t) = std::env::var("GITHUB_TOKEN") {
            cfg.github_token = t;
        }
    }
    if cfg.refresh_interval_ms == 0 {
        cfg.refresh_interval_ms = default_interval();
    }
    // Migrate from the single-path schema: if a user upgrades from a build
    // that only knew about `last_repo_path`, seed the MRU list from it so the
    // dropdown isn't empty on first launch of the new build. Subsequent
    // writes from the frontend keep both fields in sync.
    if cfg.recent_repo_paths.is_empty() {
        if let Some(p) = cfg.last_repo_path.as_ref() {
            if !p.is_empty() {
                cfg.recent_repo_paths.push(p.clone());
            }
        }
    }
    // Note: fetch_interval_ms == 0 is a valid "disabled" signal and is preserved as-is.
    // Clamp zoom on read so a hand-edited config can't crash the UI with a wild value.
    if !cfg.zoom_level.is_finite() || cfg.zoom_level < ZOOM_MIN || cfg.zoom_level > ZOOM_MAX {
        cfg.zoom_level = default_zoom_level();
    }
    // Coerce unrecognized theme values back to the default ("dark") so
    // a typo in a hand-edited config can't leave the UI in a wedged state.
    if !matches!(cfg.theme.as_str(), "light" | "dark" | "system") {
        cfg.theme = default_theme();
    }
    Ok(cfg)
}

#[tauri::command]
pub fn write_config(cfg: AppConfig) -> AppResult<()> {
    let p = config_path()?;
    let text = toml::to_string_pretty(&cfg)?;
    // Atomic write: serialize to a sibling .tmp then rename. A crash mid-write
    // would otherwise leave config.toml truncated, taking down the user's
    // token, recents, and zoom level all at once. Mirrors the same pattern
    // used by notepads.rs and pr_cache.rs.
    let tmp = p.with_extension("toml.tmp");
    std::fs::write(&tmp, text).map_err(AppError::Io)?;
    std::fs::rename(&tmp, &p).map_err(AppError::Io)?;
    Ok(())
}
