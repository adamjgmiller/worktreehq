// Reads Claude Code's on-disk state from ~/.claude/ so the frontend can surface
// which worktrees have live or historical Claude sessions.
//
// Two sources, both cheap filesystem reads:
//   1. ~/.claude/ide/<pid>.lock  — JSON per IDE-attached session with workspaceFolders
//   2. ~/.claude/projects/<encoded>/<sessionId>.jsonl — per-session transcripts. The
//      newest JSONL's mtime tells us if a session is currently live, and the first
//      few lines contain a `worktree-state` record whose `worktreePath` field is the
//      authoritative way to map a project dir back to a worktree (the dirname
//      encoding of cwd → `-` is lossy, so don't rely on reversing it).
//
// Defensive: if ~/.claude/ doesn't exist (user doesn't use Claude Code), returns
// empty vecs rather than erroring. Same for unreadable files — we skip them.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
pub struct IdeLock {
    pub pid: i64,
    pub ide_name: Option<String>,
    pub workspace_folders: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ProjectSession {
    pub session_id: String,
    pub mtime_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct ProjectDir {
    pub dir_name: String,
    pub worktree_path: Option<String>,
    pub sessions: Vec<ProjectSession>,
}

#[derive(Debug, Serialize)]
pub struct ClaudeState {
    pub ide_locks: Vec<IdeLock>,
    pub projects: Vec<ProjectDir>,
    // A cheap mtime-based fingerprint of the dirs we walk. The TS side
    // passes the previous fingerprint back on the next call; if it still
    // matches, we set `unchanged = true` and return empty vecs to signal
    // that the caller should reuse its cached joined-presence map. The
    // walk is unavoidable (we need stats either way) but the JSONL header
    // reads + lockfile JSON parses + pid checks are skipped on unchanged.
    pub fingerprint: String,
    pub unchanged: bool,
}

#[derive(Debug, Deserialize)]
struct RawIdeLock {
    pid: Option<i64>,
    #[serde(rename = "ideName")]
    ide_name: Option<String>,
    #[serde(rename = "workspaceFolders", default)]
    workspace_folders: Vec<String>,
}

fn claude_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude"))
}

// Check whether a process with the given PID is still running. Used to filter
// out stale IDE lockfiles left behind by crashed editors — without this, a
// crashed IDE reports `live-ide` status forever. On Unix we use `kill(pid, 0)`:
// returns 0 if we can signal the process (it exists and we have permission),
// or -1 with ESRCH if it doesn't exist. EPERM means the process exists but we
// can't signal it — still "alive" for our purposes. On Windows we currently
// trust the lockfile (Claude Code is predominantly used on macOS/Linux).
#[cfg(unix)]
fn pid_is_alive(pid: i64) -> bool {
    if pid <= 0 {
        return false;
    }
    let pid = pid as libc::pid_t;
    let ret = unsafe { libc::kill(pid, 0) };
    if ret == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn pid_is_alive(_pid: i64) -> bool {
    true
}

fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| {
            t.duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        })
        .unwrap_or(0)
}

fn read_ide_locks(claude: &Path) -> Vec<IdeLock> {
    let ide = claude.join("ide");
    let Ok(entries) = fs::read_dir(&ide) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("lock") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(raw) = serde_json::from_str::<RawIdeLock>(&text) else {
            continue;
        };
        let Some(pid) = raw.pid else { continue };
        // Skip stale lockfiles — a crashed IDE leaves these behind and the
        // frontend would otherwise report `live-ide` indefinitely.
        if !pid_is_alive(pid) {
            continue;
        }
        out.push(IdeLock {
            pid,
            ide_name: raw.ide_name,
            workspace_folders: raw.workspace_folders,
        });
    }
    out
}

// Read up to the first 10 lines of a JSONL looking for a `worktree-state` record.
// Returns the worktreePath if found. Bounded to keep polling cheap; the record is
// always near the top of the file (Claude writes it right after the permission mode).
fn extract_worktree_path(jsonl: &Path) -> Option<String> {
    let file = fs::File::open(jsonl).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(10).flatten() {
        if !line.contains("worktree-state") {
            continue;
        }
        // Skip this line on parse failure (e.g. a half-flushed append from a
        // live-writing session) rather than aborting the whole scan — the
        // next line in the 10-line window may still be a complete record.
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("worktree-state") {
            continue;
        }
        let path = v
            .get("worktreeSession")
            .and_then(|ws| ws.get("worktreePath"))
            .and_then(|p| p.as_str())
            .map(|s| s.to_string());
        if path.is_some() {
            return path;
        }
    }
    None
}

fn read_projects(claude: &Path) -> Vec<ProjectDir> {
    let projects = claude.join("projects");
    let Ok(entries) = fs::read_dir(&projects) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // Gather all JSONL sessions in this project dir.
        let mut sessions: Vec<ProjectSession> = Vec::new();
        let Ok(files) = fs::read_dir(&path) else {
            continue;
        };
        for f in files.flatten() {
            let fpath = f.path();
            if fpath.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let session_id = match fpath.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            sessions.push(ProjectSession {
                session_id,
                mtime_ms: mtime_ms(&fpath),
            });
        }
        if sessions.is_empty() {
            continue;
        }
        // Newest first.
        sessions.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));

        // Read worktreePath from the newest JSONL (all sessions in a project dir
        // share the same cwd, so one read covers the whole directory).
        let newest_path = path.join(format!("{}.jsonl", sessions[0].session_id));
        let worktree_path = extract_worktree_path(&newest_path);

        out.push(ProjectDir {
            dir_name,
            worktree_path,
            sessions,
        });
    }
    out
}

// Cheap fingerprint of the projects/ dir we'd otherwise read JSONL headers
// from. Walks the project directories but only collects `(dirname, newest
// session mtime)` pairs — no JSONL header reads. The result is sorted +
// concatenated so any change in the project dir set or any session mtime
// produces a different string.
//
// IDE locks are deliberately NOT included here. They have their own staleness
// problem: a crashed editor leaves a lockfile behind whose mtime never
// changes, so a fingerprint based on mtime alone would never detect the
// crash. Instead, `read_claude_state` always re-runs `read_ide_locks` (which
// runs `pid_is_alive` per lock — cheap) regardless of fingerprint match, and
// only the JSONL header reads in `read_projects` are short-circuited.
fn compute_projects_fingerprint(claude: &Path) -> String {
    let mut entries: Vec<String> = Vec::new();
    let projects = claude.join("projects");
    let Ok(dir_entries) = fs::read_dir(&projects) else {
        return String::new();
    };
    for entry in dir_entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let Ok(files) = fs::read_dir(&path) else { continue };
        let mut newest: u64 = 0;
        for f in files.flatten() {
            let fpath = f.path();
            if fpath.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let m = mtime_ms(&fpath);
            if m > newest {
                newest = m;
            }
        }
        if newest > 0 {
            entries.push(format!("proj:{}:{}", dir_name, newest));
        }
    }
    entries.sort();
    entries.join("|")
}

#[tauri::command]
pub fn read_claude_state(expected_fingerprint: Option<String>) -> AppResult<ClaudeState> {
    let Some(claude) = claude_dir() else {
        return Err(AppError::Msg("no home dir".into()));
    };
    if !claude.exists() {
        return Ok(ClaudeState {
            ide_locks: Vec::new(),
            projects: Vec::new(),
            fingerprint: String::new(),
            unchanged: false,
        });
    }
    // Touch _ so unix metadata warnings don't fire on non-unix.
    let _ = SystemTime::now();

    // Always re-run the IDE lock scan. It's cheap (typically 1-2 lockfiles)
    // and the only path that runs `pid_is_alive` to filter out crashed
    // editors. Skipping it on the unchanged path was a partial regression of
    // the stale-live-ide fix from earlier in the project's history.
    let ide_locks = read_ide_locks(claude.as_path());

    let fingerprint = compute_projects_fingerprint(&claude);
    if let Some(expected) = expected_fingerprint {
        if !expected.is_empty() && expected == fingerprint {
            // Short-circuit only the projects path: skip the JSONL header
            // reads. The TS caller will combine these fresh ide_locks with
            // its cached projects data and re-join against the current wall
            // clock so live/recent/dormant transitions still fire on time.
            return Ok(ClaudeState {
                ide_locks,
                projects: Vec::new(),
                fingerprint,
                unchanged: true,
            });
        }
    }

    Ok(ClaudeState {
        ide_locks,
        projects: read_projects(&claude),
        fingerprint,
        unchanged: false,
    })
}
