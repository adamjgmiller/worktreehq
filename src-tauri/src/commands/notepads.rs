use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

// Single-process lock so concurrent saves from rapid keystrokes can't
// interleave a read-modify-write on notepads.json.
static NOTEPADS_LOCK: Mutex<()> = Mutex::new(());

/// Persisted shape for one notepad entry.
///
/// `touched` exists so we can autofill an empty notepad from the worktree's
/// first Claude Code prompt without ever doing it twice. Once any write
/// happens against a path — whether the autofill itself, a manual edit, or
/// the user clearing the entry to empty — `touched` flips to true and the
/// autofill path is locked out forever for that worktree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotepadEntry {
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub touched: bool,
}

/// On-disk JSON value: either the legacy bare-string format (pre-autofill
/// release) or the modern struct. Untagged so serde tries the struct first
/// and falls back to the string. Legacy entries are migrated to V2 with
/// `touched = true` because the only way they exist on disk is that the
/// user already typed in them — i.e. they have non-empty content (the old
/// `write_notepad` deleted empty entries) — so the user has clearly
/// "touched" them and they should not be autofilled if cleared later.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawNotepadValue {
    Modern(NotepadEntry),
    Legacy(String),
}

impl From<RawNotepadValue> for NotepadEntry {
    fn from(raw: RawNotepadValue) -> Self {
        match raw {
            RawNotepadValue::Modern(e) => e,
            RawNotepadValue::Legacy(s) => NotepadEntry {
                content: s,
                touched: true,
            },
        }
    }
}

fn notepads_path() -> AppResult<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::Msg("no config dir".into()))?
        .join("worktreehq");
    std::fs::create_dir_all(&base).map_err(AppError::Io)?;
    Ok(base.join("notepads.json"))
}

fn load_all() -> AppResult<HashMap<String, NotepadEntry>> {
    let p = notepads_path()?;
    if !p.exists() {
        return Ok(HashMap::new());
    }
    let text = std::fs::read_to_string(&p).map_err(AppError::Io)?;
    if text.trim().is_empty() {
        return Ok(HashMap::new());
    }
    let raw: HashMap<String, RawNotepadValue> = serde_json::from_str(&text)
        .map_err(|e| AppError::Msg(format!("notepads parse: {}", e)))?;
    Ok(raw.into_iter().map(|(k, v)| (k, v.into())).collect())
}

fn save_all(map: &HashMap<String, NotepadEntry>) -> AppResult<()> {
    let p = notepads_path()?;
    let tmp = p.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(map)
        .map_err(|e| AppError::Msg(format!("notepads serialize: {}", e)))?;
    std::fs::write(&tmp, text).map_err(AppError::Io)?;
    std::fs::rename(&tmp, &p).map_err(AppError::Io)?;
    Ok(())
}

#[tauri::command]
pub fn read_notepad(worktree_path: String) -> AppResult<String> {
    let _g = NOTEPADS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let map = load_all()?;
    Ok(map
        .get(&worktree_path)
        .map(|e| e.content.clone())
        .unwrap_or_default())
}

#[tauri::command]
pub fn write_notepad(worktree_path: String, content: String) -> AppResult<()> {
    let _g = NOTEPADS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut map = load_all()?;
    // Always set touched=true on any write — including clearing to empty.
    // This is what locks out the autofill path: once the user has either
    // typed something OR explicitly emptied the notepad, we never want to
    // refill it from a Claude session prompt again.
    map.insert(
        worktree_path,
        NotepadEntry {
            content,
            touched: true,
        },
    );
    save_all(&map)
}

/// Has this notepad ever been written to (autofill, manual edit, or manual
/// clear)? The autofill load path uses this to skip worktrees the user has
/// already interacted with — even ones whose current content is empty.
#[tauri::command]
pub fn is_notepad_touched(worktree_path: String) -> AppResult<bool> {
    let _g = NOTEPADS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let map = load_all()?;
    Ok(map.get(&worktree_path).map(|e| e.touched).unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_string_entry_loads_as_touched() {
        // Pre-autofill notepads.json files stored bare strings. Loading
        // those today should normalize to {content, touched: true} so the
        // user's existing notes are preserved AND the autofill path is
        // immediately locked out for them (their notes are clearly
        // user-authored — they wouldn't exist otherwise).
        let raw = r#"{"/some/path": "hello"}"#;
        let parsed: HashMap<String, RawNotepadValue> = serde_json::from_str(raw).unwrap();
        let normalized: HashMap<String, NotepadEntry> =
            parsed.into_iter().map(|(k, v)| (k, v.into())).collect();
        let entry = normalized.get("/some/path").unwrap();
        assert_eq!(entry.content, "hello");
        assert!(entry.touched);
    }

    #[test]
    fn modern_struct_entry_round_trips() {
        // The modern shape must deserialize without falling through to the
        // legacy variant. Verifies the untagged enum's order-of-attempts
        // (Modern first, Legacy fallback) hasn't been silently inverted.
        let raw = r#"{"/some/path": {"content": "hi", "touched": false}}"#;
        let parsed: HashMap<String, RawNotepadValue> = serde_json::from_str(raw).unwrap();
        let normalized: HashMap<String, NotepadEntry> =
            parsed.into_iter().map(|(k, v)| (k, v.into())).collect();
        let entry = normalized.get("/some/path").unwrap();
        assert_eq!(entry.content, "hi");
        assert!(!entry.touched);
    }

    #[test]
    fn modern_entry_with_missing_fields_uses_defaults() {
        // Defensive: a manually-edited notepads.json with a partial entry
        // shouldn't crash the loader. Missing `content` → empty string,
        // missing `touched` → false (the same default a brand-new entry
        // would have if a future writer ever forgot to set it).
        let raw = r#"{"/some/path": {}}"#;
        let parsed: HashMap<String, RawNotepadValue> = serde_json::from_str(raw).unwrap();
        let normalized: HashMap<String, NotepadEntry> =
            parsed.into_iter().map(|(k, v)| (k, v.into())).collect();
        let entry = normalized.get("/some/path").unwrap();
        assert_eq!(entry.content, "");
        assert!(!entry.touched);
    }
}
