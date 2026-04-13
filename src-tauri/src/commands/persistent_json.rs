//! Shared helpers for mutex-protected JSON file stores.
//!
//! Used by `worktree_order`, `worktree_sort_mode`, `notepads`, and `pr_cache`
//! to avoid duplicating the same path-resolution, atomic-write, and
//! corrupt-file-quarantine logic.

use crate::error::{AppError, AppResult};
use serde::{de::DeserializeOwned, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Resolve a file path under the app's config directory.
pub fn config_file_path(filename: &str) -> AppResult<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::Msg("no config dir".into()))?
        .join("worktreehq");
    std::fs::create_dir_all(&base).map_err(AppError::Io)?;
    Ok(base.join(filename))
}

/// Resolve a file path under the app's cache directory.
pub fn cache_file_path(filename: &str) -> AppResult<PathBuf> {
    let base = dirs::cache_dir()
        .ok_or_else(|| AppError::Msg("no cache dir".into()))?
        .join("worktreehq");
    std::fs::create_dir_all(&base).map_err(AppError::Io)?;
    Ok(base.join(filename))
}

/// Write `content` atomically: write to `.tmp`, then rename over the target.
pub fn atomic_write(path: &Path, content: &str) -> AppResult<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(AppError::Io)?;
    std::fs::rename(&tmp, path).map_err(AppError::Io)?;
    Ok(())
}

// ── JsonMapStore: full pattern for HashMap<String, V> JSON files ─────

/// A mutex-protected, atomically-written JSON file storing `HashMap<String, V>`.
///
/// Extracts the repeated pattern from `worktree_order.rs` and
/// `worktree_sort_mode.rs`: lock, load (with corrupt-file quarantine),
/// modify, save (atomic rename).
pub struct JsonMapStore<V> {
    lock: Mutex<()>,
    filename: &'static str,
    label: &'static str,
    _phantom: std::marker::PhantomData<V>,
}

impl<V> JsonMapStore<V>
where
    V: Serialize + DeserializeOwned,
{
    pub const fn new(filename: &'static str, label: &'static str) -> Self {
        Self {
            lock: Mutex::new(()),
            filename,
            label,
            _phantom: std::marker::PhantomData,
        }
    }

    /// Acquire the lock (poison-recovery) and return a guard.
    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Read a single key from the map.
    pub fn read(&self, key: &str) -> AppResult<Option<V>> {
        let _g = self.lock();
        let map = self.load_inner()?;
        Ok(map.into_iter().find(|(k, _)| k == key).map(|(_, v)| v))
    }

    /// Insert a key-value pair and persist.
    pub fn write(&self, key: String, value: V) -> AppResult<()> {
        let _g = self.lock();
        let mut map = self.load_inner()?;
        map.insert(key, value);
        self.save_inner(&map)
    }

    // ── internals (caller must hold lock) ────────────────────────────

    fn load_inner(&self) -> AppResult<HashMap<String, V>> {
        let p = config_file_path(self.filename)?;
        if !p.exists() {
            return Ok(HashMap::new());
        }
        let text = std::fs::read_to_string(&p).map_err(AppError::Io)?;
        if text.trim().is_empty() {
            return Ok(HashMap::new());
        }
        match serde_json::from_str(&text) {
            Ok(v) => Ok(v),
            Err(e) => {
                let bad = p.with_extension("json.bad");
                eprintln!(
                    "[{}] parse error ({}); moving corrupt file to {}",
                    self.label,
                    e,
                    bad.display()
                );
                let _ = std::fs::rename(&p, &bad);
                Ok(HashMap::new())
            }
        }
    }

    fn save_inner(&self, map: &HashMap<String, V>) -> AppResult<()> {
        let p = config_file_path(self.filename)?;
        let text = serde_json::to_string_pretty(map)
            .map_err(|e| AppError::Msg(format!("{} serialize: {}", self.label, e)))?;
        atomic_write(&p, &text)
    }
}
