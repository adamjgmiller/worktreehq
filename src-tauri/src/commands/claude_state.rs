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
use std::process::Command;
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
    // Absolute cwd paths of every running `claude` process. Lets the TS side
    // distinguish "session is closed" from "session is alive but idle waiting
    // for input" — JSONL mtime alone can't tell those apart. Always re-read
    // regardless of fingerprint match (same as ide_locks): process state
    // changes faster than file mtimes, and the fingerprint only covers the
    // projects/ tree.
    pub live_worktree_cwds: Vec<String>,
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

// ─── Live `claude` process scan ──────────────────────────────────────────
//
// Goal: distinguish "session JSONL is stale because the user closed claude"
// from "session JSONL is stale because the user is idle in front of a still-
// running prompt". Both look identical from the projects/ dir alone — the
// JSONL mtime only updates on assistant output, so an idle-but-alive session
// can sit at the same mtime for hours. The only reliable signal is whether
// a `claude` process actually exists.
//
// We don't try to map process → session_id (the session id isn't in argv).
// Instead we collect cwds: every running `claude` process has a cwd pointing
// at the worktree it was launched from. The TS side intersects this with the
// per-worktree session list and attributes the live process to the most-
// recent JSONL in that worktree (which is the one a single-claude user is
// almost always on, since `claude` rotates session ids per launch).
//
// macOS path: one `lsof -nP -c claude -d cwd -Fpn` subprocess. lsof's `-F`
// emits one record per line, prefixed with a single field-id char (`p` for
// pid, `n` for filename). Parsed in `parse_lsof_pn_output` (a pure function
// for testability).
//
// Linux path: walk /proc/*/comm, find entries equal to "claude", read
// /proc/<pid>/cwd as a symlink. Multiple syscalls but no subprocess.
//
// Windows: returns empty Vec. The Claude Code user base is overwhelmingly
// macOS/Linux and we'd need a different IPC mechanism (e.g. `tasklist` +
// `wmic`) to do better. The "Claude idle vs closed" feature degrades
// gracefully on Windows: sessions just stay marked as closed.

/// Parse the output of `lsof -F pn ...`. lsof emits records in groups: each
/// process is introduced by a `p<pid>` line and followed by one record per
/// open file descriptor — for our `-d cwd` filter that's exactly one `n<path>`
/// line per process. Records may include `f<fd>` lines and others between
/// `p` and `n`; we only care about the most-recent `p` value when an `n`
/// line arrives.
pub(crate) fn parse_lsof_pn_output(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in text.lines() {
        // We only care about `n` records (the cwd path). Skip `p`, `f`, etc.
        // — we don't actually need the pid for our purposes, just the cwd.
        let Some(rest) = line.strip_prefix('n') else {
            continue;
        };
        let trimmed = rest.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Dedupe — two `claude` processes launched from the same worktree
        // would otherwise produce two entries, and the TS side does set
        // membership anyway.
        if seen.insert(trimmed.to_string()) {
            out.push(trimmed.to_string());
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn scan_live_claude_cwds() -> Vec<String> {
    // `-n` skips DNS lookups (faster), `-P` skips port name resolution,
    // `-c claude` filters processes whose name starts with "claude", `-d cwd`
    // restricts file descriptors to the cwd entry, and `-Fpn` emits machine-
    // readable records with pid + path fields. The whole thing typically
    // returns in well under 50ms even with several claude processes running.
    let output = match Command::new("lsof")
        .args(["-nP", "-c", "claude", "-d", "cwd", "-Fpn"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    // lsof exits non-zero when no matching processes are found — that's not
    // an error for us, just an empty result. So we don't gate on `success()`,
    // we just parse whatever it printed (which will be empty stdout).
    let text = String::from_utf8_lossy(&output.stdout);
    parse_lsof_pn_output(&text)
}

#[cfg(target_os = "linux")]
fn scan_live_claude_cwds() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let Ok(entries) = fs::read_dir("/proc") else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // /proc/<pid>/comm contains the process name (without args). We only
        // want claude. Skip non-numeric dir names quickly.
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if !name.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let comm = match fs::read_to_string(path.join("comm")) {
            Ok(s) => s,
            Err(_) => continue,
        };
        if comm.trim() != "claude" {
            continue;
        }
        // /proc/<pid>/cwd is a symlink to the process's cwd. read_link
        // returns the resolved target as a PathBuf.
        let Ok(cwd) = fs::read_link(path.join("cwd")) else { continue };
        let Some(cwd_str) = cwd.to_str() else { continue };
        let owned = cwd_str.to_string();
        if seen.insert(owned.clone()) {
            out.push(owned);
        }
    }
    out
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn scan_live_claude_cwds() -> Vec<String> {
    // Windows / other: no idle-vs-closed detection. See module comment for
    // why this is acceptable.
    Vec::new()
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
            live_worktree_cwds: Vec::new(),
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

    // Always re-run the live-claude process scan for the same reason as
    // ide_locks: process state changes faster than file mtimes, and the
    // fingerprint only covers the projects/ tree.
    let live_worktree_cwds = scan_live_claude_cwds();

    let fingerprint = compute_projects_fingerprint(&claude);
    if let Some(expected) = expected_fingerprint {
        if !expected.is_empty() && expected == fingerprint {
            // Short-circuit only the projects path: skip the JSONL header
            // reads. The TS caller will combine these fresh ide_locks +
            // live_worktree_cwds with its cached projects data and re-join
            // against the current wall clock so live/recent/dormant
            // transitions still fire on time.
            return Ok(ClaudeState {
                ide_locks,
                projects: Vec::new(),
                live_worktree_cwds,
                fingerprint,
                unchanged: true,
            });
        }
    }

    Ok(ClaudeState {
        ide_locks,
        projects: read_projects(&claude),
        live_worktree_cwds,
        fingerprint,
        unchanged: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_lsof_pn_extracts_cwd_paths() {
        // lsof -Fpn output: each process is introduced by `p<pid>`, then one
        // record per file descriptor. With `-d cwd` there's exactly one `n`
        // line per process. Real-world output also includes `f<fd>` lines
        // we should ignore.
        let raw = "p29244\nfcwd\nn/Users/adam/Projects/canopy/.claude/worktrees/feat-a\np43688\nfcwd\nn/Users/adam/Projects/other\n";
        let out = parse_lsof_pn_output(raw);
        assert_eq!(
            out,
            vec![
                "/Users/adam/Projects/canopy/.claude/worktrees/feat-a".to_string(),
                "/Users/adam/Projects/other".to_string(),
            ]
        );
    }

    #[test]
    fn parse_lsof_pn_dedupes_repeated_cwds() {
        // Two claude processes launched from the same worktree → same cwd.
        // The output should contain it once. The TS side does set membership
        // anyway, but cleaning up at the parser keeps the contract honest.
        let raw = "p1\nn/a/b\np2\nn/a/b\np3\nn/c/d\n";
        let out = parse_lsof_pn_output(raw);
        assert_eq!(out, vec!["/a/b".to_string(), "/c/d".to_string()]);
    }

    #[test]
    fn parse_lsof_pn_handles_empty_input() {
        // lsof exits with no stdout when no matching processes exist —
        // not an error for us, just an empty result.
        assert_eq!(parse_lsof_pn_output(""), Vec::<String>::new());
    }

    #[test]
    fn parse_lsof_pn_skips_lines_without_n_prefix() {
        // Defensive: anything that isn't an `n`-prefixed record gets dropped.
        let raw = "garbage\np123\nfcwd\nnvalid\nmore garbage\n";
        let out = parse_lsof_pn_output(raw);
        assert_eq!(out, vec!["valid".to_string()]);
    }
}
