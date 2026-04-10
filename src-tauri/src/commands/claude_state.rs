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
use std::time::Duration;

/// Timeout for `ps` and `lsof` subprocesses. These should return near-instantly
/// but can hang when the system has an unresponsive NFS/FUSE mount. Without
/// this, a blocked `lsof` would wedge the Claude-awareness poll indefinitely.
const SUBPROCESS_TIMEOUT: Duration = Duration::from_secs(5);
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
// Two historical landmines shaped the current implementation:
//
//   1. The `claude` CLI execs a version-suffixed binary at
//      `~/.local/share/claude/versions/<version>`, so the kernel's COMM /
//      executable basename for a running session is e.g. `2.1.97`, NOT
//      `claude`. Anything that filters on COMM (`lsof -c claude`, Linux
//      `/proc/<pid>/comm`) matches zero processes. We have to look at
//      argv[0] (what the wrapper set) instead.
//
//   2. lsof's `-c` and `-d` filters are joined with OR, not AND, unless
//      you pass `-a`. `lsof -c claude -d cwd` means "files whose command
//      starts with claude OR whose fd is cwd" — which, combined with (1),
//      silently returned the cwd of every process on the system. We now
//      always pass `-a` and only ever use `-p <pids>` (never `-c`) as the
//      second filter.
//
// macOS path: one `ps -axo pid=,command=` to enumerate pids whose argv[0]
// basename is "claude", then one `lsof -nP -a -p <pid,...> -d cwd -Fn` to
// get their cwds.
//
// Linux path: walk /proc/<pid>/cmdline (null-separated argv), filter on
// argv[0] basename == "claude", read /proc/<pid>/cwd as a symlink.
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

/// Parse the output of `ps -axo pid=,command=` and return the pids whose
/// argv[0] basename is exactly "claude". The `=` suffix on the ps format
/// suppresses headers and trailing whitespace padding, so every non-empty
/// line is `<pid> <command-with-args>`.
///
/// We match on argv[0] (what the `claude` wrapper script sets) rather than
/// the executable basename, because the wrapper execs
/// `~/.local/share/claude/versions/<version>` — so the kernel-visible
/// process name is the version string, not "claude". See the module
/// comment for the full story.
pub(crate) fn parse_ps_claude_pids(text: &str) -> Vec<String> {
    let mut pids: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim_start();
        if line.is_empty() {
            continue;
        }
        // Split into `<pid>` and `<rest>`.
        let Some(space_idx) = line.find(char::is_whitespace) else {
            continue;
        };
        let (pid, rest) = line.split_at(space_idx);
        if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        // argv[0] is the first whitespace-delimited token of the command.
        // We don't try to handle quoted-with-spaces argv[0] — `claude` is
        // never invoked that way in practice, and `ps` doesn't quote for us.
        let argv0 = rest.trim_start().split_whitespace().next().unwrap_or("");
        if argv0.is_empty() {
            continue;
        }
        // Compare the basename — argv[0] may be an absolute path
        // (`/usr/local/bin/claude`), a tilde-expanded one, or bare `claude`.
        let basename = argv0.rsplit('/').next().unwrap_or(argv0);
        if basename == "claude" {
            pids.push(pid.to_string());
        }
    }
    pids
}

/// Run a subprocess with a timeout. Returns None on spawn failure, timeout, or
/// if the child can't be waited on. Mirrors the timeout pattern in git_exec.rs.
fn run_with_timeout(cmd: &mut Command) -> Option<std::process::Output> {
    let child = cmd.spawn().ok()?;
    let child_id = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(SUBPROCESS_TIMEOUT) {
        Ok(result) => result.ok(),
        Err(_) => {
            #[cfg(unix)]
            unsafe {
                libc::kill(child_id as libc::pid_t, libc::SIGKILL);
            }
            eprintln!(
                "[claude_state] subprocess timed out after {}s",
                SUBPROCESS_TIMEOUT.as_secs()
            );
            None
        }
    }
}

#[cfg(target_os = "macos")]
fn scan_live_claude_cwds() -> Vec<String> {
    // Step 1: enumerate claude processes via ps. We use `-axo pid=,command=`
    // because `command=` shows the full argv (including argv[0] as the
    // wrapper set it) rather than the kernel's COMM field, which would be
    // the version string (e.g. "2.1.97") and match nothing.
    let ps_output = match run_with_timeout(
        Command::new("ps").args(["-axo", "pid=,command="]),
    ) {
        Some(o) => o,
        None => return Vec::new(),
    };
    let ps_text = String::from_utf8_lossy(&ps_output.stdout);
    let pids = parse_ps_claude_pids(&ps_text);
    if pids.is_empty() {
        return Vec::new();
    }

    // Step 2: ask lsof for the cwds of exactly those pids. CRITICAL details:
    //   * `-a` ANDs the filters together. Without it, lsof ORs `-p` and
    //     `-d cwd`, effectively returning "these pids' files OR every
    //     process's cwd" — i.e. the entire system's cwd table.
    //   * `-p <comma-separated>` restricts to our claude pids.
    //   * `-Fn` machine-readable output with filename (`n`) records. pid
    //     (`p`) and fd (`f`) records are also emitted as part of the record
    //     grouping; parse_lsof_pn_output already ignores those.
    let pid_list = pids.join(",");
    let output = match run_with_timeout(
        Command::new("lsof").args(["-nP", "-a", "-p", &pid_list, "-d", "cwd", "-Fn"]),
    ) {
        Some(o) => o,
        None => return Vec::new(),
    };
    // lsof exits non-zero when there's nothing to report — that's not an
    // error for us, just an empty result.
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
        // /proc/<pid> — skip non-numeric dir names quickly.
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if !name.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        // /proc/<pid>/cmdline holds the full argv as NUL-separated records.
        // We deliberately do NOT use /proc/<pid>/comm: comm is the kernel's
        // COMM field, which is the executable basename and would be the
        // version string (`2.1.97`) because the `claude` wrapper execs a
        // version-suffixed binary. argv[0] is what the wrapper set and is
        // the only place "claude" actually appears.
        let cmdline = match fs::read(path.join("cmdline")) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if cmdline.is_empty() {
            continue;
        }
        // argv[0] is everything up to the first NUL byte.
        let argv0_end = cmdline.iter().position(|&b| b == 0).unwrap_or(cmdline.len());
        let argv0 = match std::str::from_utf8(&cmdline[..argv0_end]) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let basename = argv0.rsplit('/').next().unwrap_or(argv0);
        if basename != "claude" {
            continue;
        }
        // /proc/<pid>/cwd is a symlink to the process's cwd.
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

    #[test]
    fn parse_ps_claude_pids_matches_bare_argv0() {
        // The most common shape: `ps -axo pid=,command=` with a bare
        // `claude` argv[0] set by the wrapper script.
        let raw = "\
76093 claude --dangerously-skip-permissions --worktree claude-status-fix
40734 /opt/homebrew/bin/python3 -m http.server
12345 bash
";
        assert_eq!(parse_ps_claude_pids(raw), vec!["76093".to_string()]);
    }

    #[test]
    fn parse_ps_claude_pids_matches_absolute_path_argv0() {
        // Some shells rewrite argv[0] to the absolute executable path —
        // the basename is still "claude" and that's what we key on.
        let raw = "4242 /usr/local/bin/claude --foo\n999 /bin/bash\n";
        assert_eq!(parse_ps_claude_pids(raw), vec!["4242".to_string()]);
    }

    #[test]
    fn parse_ps_claude_pids_does_not_match_version_binary() {
        // Regression test for the original bug: if someone ever starts the
        // versioned binary directly (bypassing the wrapper), argv[0] is the
        // version string, NOT "claude". We do NOT want to match that — it
        // could be anything, and we'd rather silently miss than false-
        // positive. Better mitigation is still: always launch via the
        // wrapper so argv[0] == "claude".
        let raw = "76093 /Users/adam/.local/share/claude/versions/2.1.97 --foo\n";
        assert_eq!(parse_ps_claude_pids(raw), Vec::<String>::new());
    }

    #[test]
    fn parse_ps_claude_pids_does_not_match_substring() {
        // `claude-code` or `claudewrap` should NOT be treated as claude.
        // Matching substrings would re-introduce the over-match bug that
        // motivated this whole change.
        let raw = "1 claude-code --foo\n2 claudewrap\n3 /bin/claude-extras\n";
        assert_eq!(parse_ps_claude_pids(raw), Vec::<String>::new());
    }

    #[test]
    fn parse_ps_claude_pids_skips_header_and_blank_lines() {
        // ps with `=` headers shouldn't print a header, but defensive
        // parsing against garbage lines costs nothing.
        let raw = "\n   PID COMMAND\n\n76093 claude\n";
        assert_eq!(parse_ps_claude_pids(raw), vec!["76093".to_string()]);
    }

    #[test]
    fn parse_ps_claude_pids_handles_empty_input() {
        assert_eq!(parse_ps_claude_pids(""), Vec::<String>::new());
    }

    #[test]
    fn parse_ps_claude_pids_collects_multiple() {
        let raw = "1 claude\n2 /usr/bin/python\n3 /opt/bin/claude --foo\n";
        assert_eq!(
            parse_ps_claude_pids(raw),
            vec!["1".to_string(), "3".to_string()]
        );
    }
}
