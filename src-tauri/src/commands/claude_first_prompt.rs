// Extracts the first user-typed prompt from a worktree's Claude Code session
// transcripts. Used by the notepad autofill: when a worktree's notepad is
// empty AND has never been touched, the frontend calls this command to seed
// the notepad with the prompt the user opened the worktree for.
//
// Why this is its own file rather than living in claude_state.rs: that module
// runs on the 15s polling tick and has a fingerprint-based memo cache tuned
// to skip JSONL header reads on the unchanged path. This command runs once
// per worktree per app session (gated by the notepads `touched` flag), so it
// has very different access patterns and would only complicate the cache
// invariants if bolted on.
//
// Algorithm:
//   1. Find the project dir under ~/.claude/projects/ that maps to this
//      worktree. Authoritative match: any project dir whose first JSONL has
//      a `worktree-state` record with `worktreePath == worktree_path`.
//      Fallback: encoded-dirname match (path → s/[/.]/-/g).
//   2. Sort that project dir's JSONL files by mtime ascending (= "least
//      recently written" ≈ "oldest session for this worktree"). The user
//      asked for "earliest by mtime across all sessions" — see the
//      conversation in PR description for why mtime is the chosen
//      disambiguator.
//   3. For each session in mtime-ascending order, scan up to 200 lines
//      looking for the first record where:
//          type == "user"
//          message.role == "user"
//          message.content is a JSON string (NOT an array — array means
//              tool_result, not human-typed text)
//          content does not start with "<command-" (filters out slash-
//              command output that Claude Code wraps as user records)
//          content is non-empty after trimming
//      Return the first match, truncated to `max_chars` on a word boundary.
//   4. Fall through to the next session if the current one yields nothing
//      (e.g. a session that crashed before any prompt was sent). Bail with
//      None after all sessions are exhausted — the notepad just stays empty
//      and the touched flag is NOT set, so we'll retry next time.

use crate::error::{AppError, AppResult};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_LINES_SCANNED: usize = 200;

fn claude_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude"))
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

/// Mirrors the lossy `cwd → dirname` encoding Claude Code applies when
/// creating ~/.claude/projects/<dir>. Replacing both `/` and `.` with `-`
/// is irreversible (you can't decode `--` back to `/.` or `..`), so this
/// is only used as a fast-path lookup; the authoritative match comes from
/// reading the `worktree-state` record inside a JSONL.
fn encode_project_dir_name(path: &str) -> String {
    path.chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect()
}

/// Read up to ~10 lines of a JSONL looking for the `worktree-state` record's
/// `worktreePath`. Same shape as `claude_state::extract_worktree_path` but
/// duplicated here to keep this command self-contained — the caching layer
/// in claude_state is the wrong abstraction for a one-shot autofill scan.
fn read_worktree_path_header(jsonl: &Path) -> Option<String> {
    let file = fs::File::open(jsonl).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(10).flatten() {
        if !line.contains("worktree-state") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("worktree-state") {
            continue;
        }
        if let Some(p) = v
            .get("worktreeSession")
            .and_then(|ws| ws.get("worktreePath"))
            .and_then(|p| p.as_str())
        {
            return Some(p.to_string());
        }
    }
    None
}

/// Find the ~/.claude/projects/<dir>/ directory that corresponds to the
/// given worktree path. Tries authoritative match first (read each project
/// dir's newest JSONL header) and falls back to the encoded-dirname lookup.
fn find_project_dir(claude: &Path, worktree_path: &str) -> Option<PathBuf> {
    let projects = claude.join("projects");
    let entries: Vec<PathBuf> = match fs::read_dir(&projects) {
        Ok(it) => it.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect(),
        Err(_) => return None,
    };

    // Authoritative pass: read each project dir's newest JSONL header. We
    // walk newest-first per dir because the header record is identical
    // across all sessions in a project dir (they all share a cwd), so one
    // header read per dir is enough.
    for dir in &entries {
        let Some(newest) = newest_jsonl(dir) else { continue };
        if read_worktree_path_header(&newest).as_deref() == Some(worktree_path) {
            return Some(dir.clone());
        }
    }

    // Fallback: encoded dirname match. Only safe when the authoritative
    // pass found nothing — otherwise an encoded-name collision (rare but
    // possible) could attribute another worktree's sessions to this one.
    let encoded = encode_project_dir_name(worktree_path);
    for dir in entries {
        if dir.file_name().and_then(|n| n.to_str()) == Some(&encoded) {
            return Some(dir);
        }
    }
    None
}

fn newest_jsonl(dir: &Path) -> Option<PathBuf> {
    let files = fs::read_dir(dir).ok()?;
    files
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .max_by_key(|p| mtime_ms(p))
}

/// All JSONL session files in a project dir, sorted by mtime ascending
/// (oldest first). Used to walk sessions in the order the user asked for:
/// "earliest by mtime across all sessions".
fn sessions_oldest_first(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<(u64, PathBuf)> = match fs::read_dir(dir) {
        Ok(it) => it
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl"))
            .map(|p| (mtime_ms(&p), p))
            .collect(),
        Err(_) => return Vec::new(),
    };
    files.sort_by_key(|(m, _)| *m);
    files.into_iter().map(|(_, p)| p).collect()
}

/// Return the first human-typed prompt content from a single JSONL session
/// transcript, or None if the file has no qualifying record in the first
/// MAX_LINES_SCANNED lines.
///
/// The filter is shape-based, not graph-based: we look for `type:"user"`,
/// `message.role:"user"`, and then extract human-readable text from
/// `message.content`. Content comes in two shapes:
///
///   1. Plain string  → simple typed prompt, no attachments.
///   2. Array of blocks → either a `tool_result` envelope (which we skip)
///      or a typed prompt with attached image(s) and/or text. Claude Code
///      switches to array form whenever the user pasted or dropped an
///      image into their prompt. The text block in that array already
///      contains "[Image #N]" markers (Claude Code injects them when the
///      session is recorded), so we just need to pull the text out. If
///      the message is image-only with no accompanying text we fall back
///      to a literal "[Image]" placeholder so the notepad still gets a
///      seed instead of silently advancing to the next prompt.
///
/// Discriminator between the two array sub-shapes: `tool_result` records
/// always contain at least one block with `type:"tool_result"`. Human
/// messages with images contain only `type:"text"` and `type:"image"`
/// blocks. We also drop records whose extracted text starts with
/// `<command-` because Claude Code wraps slash-command stdout in fake
/// user records using that envelope.
pub(crate) fn extract_first_user_prompt(jsonl: &Path) -> Option<String> {
    let file = fs::File::open(jsonl).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(MAX_LINES_SCANNED).flatten() {
        // Cheap pre-filter: skip lines that obviously aren't user records.
        // Saves the JSON parse cost on the dozen-plus header/system lines
        // that precede the first user prompt in every session.
        if !line.contains("\"type\":\"user\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        let Some(msg) = v.get("message") else { continue };
        if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        let Some(content_value) = msg.get("content") else {
            continue;
        };
        let extracted: String = if let Some(s) = content_value.as_str() {
            s.to_string()
        } else if let Some(arr) = content_value.as_array() {
            // tool_result envelope → not human input, skip the whole record.
            let is_tool_result = arr.iter().any(|b| {
                b.get("type").and_then(|t| t.as_str()) == Some("tool_result")
            });
            if is_tool_result {
                continue;
            }
            // Walk text/image blocks. Text blocks already have "[Image #N]"
            // markers baked in by Claude Code, so for the common case
            // (text + image) we just join the text blocks and ignore the
            // image blocks entirely. The has_image fallback only fires for
            // image-only messages where there's no text to anchor to.
            let mut text_parts: Vec<String> = Vec::new();
            let mut has_image = false;
            for block in arr {
                match block.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                            text_parts.push(t.to_string());
                        }
                    }
                    Some("image") => {
                        has_image = true;
                    }
                    _ => {}
                }
            }
            if text_parts.is_empty() {
                if has_image {
                    "[Image]".to_string()
                } else {
                    continue;
                }
            } else {
                text_parts.join(" ")
            }
        } else {
            continue;
        };

        let trimmed = extracted.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Drop slash-command output envelopes. Claude Code wraps these as
        // user records with content like `<command-name>...<command-name>`
        // or `<local-command-stdout>...`. We don't want any of those as
        // notepad seeds.
        if trimmed.starts_with("<command-") || trimmed.starts_with("<local-command-") {
            continue;
        }
        return Some(trimmed.to_string());
    }
    None
}

/// Truncate `text` to at most `max_chars` characters. If the cut falls inside
/// a word, walk back to the last whitespace so we don't display half a word
/// followed by an ellipsis. Falls through to a hard char-count truncation if
/// no whitespace exists in the prefix (very long URLs, etc.).
///
/// `max_chars` counts Rust `char`s, not bytes — multibyte content (emoji,
/// CJK) is bounded by visual character count, not byte count.
pub(crate) fn truncate_on_word_boundary(text: &str, max_chars: usize) -> String {
    // Collapse runs of whitespace (including newlines) into single spaces so
    // a multi-line first prompt renders as a single readable line in the
    // notepad textarea. The autofill is meant to be a hint of what the user
    // was working on, not a faithful transcript.
    let collapsed: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max_chars {
        return collapsed;
    }
    // Walk forward up to max_chars, remembering the last whitespace index.
    let mut last_space: Option<usize> = None;
    let mut taken = 0usize;
    let mut byte_end = 0usize;
    for (i, ch) in collapsed.char_indices() {
        if taken == max_chars {
            byte_end = i;
            break;
        }
        if ch.is_whitespace() {
            last_space = Some(i);
        }
        taken += 1;
        byte_end = i + ch.len_utf8();
    }
    let cut = last_space.unwrap_or(byte_end);
    // Trim the trailing space we cut on, then add an ellipsis. The ellipsis
    // makes it obvious the user is looking at a truncated seed, not the
    // full prompt.
    let head = collapsed[..cut].trim_end();
    format!("{}…", head)
}

#[tauri::command]
pub fn read_claude_first_prompt(
    worktree_path: String,
    max_chars: usize,
) -> AppResult<Option<String>> {
    let Some(claude) = claude_dir() else {
        return Err(AppError::Msg("no home dir".into()));
    };
    if !claude.exists() {
        // User doesn't use Claude Code at all — gracefully return None so
        // the notepad just stays empty.
        return Ok(None);
    }
    let Some(project_dir) = find_project_dir(&claude, &worktree_path) else {
        return Ok(None);
    };
    // Walk sessions oldest-mtime first; bail at the first one that yields a
    // qualifying prompt. The fall-through handles sessions that crashed
    // before any prompt was sent (rare but real — a power loss during
    // Claude startup leaves a JSONL with only header records).
    for jsonl in sessions_oldest_first(&project_dir) {
        if let Some(content) = extract_first_user_prompt(&jsonl) {
            return Ok(Some(truncate_on_word_boundary(&content, max_chars)));
        }
    }
    Ok(None)
}

/// Read the first human-typed prompt from one specific session JSONL,
/// identified by `worktree_path` + `session_id`. Used by the past-sessions
/// list in the worktree card to label each row with what the user originally
/// asked Claude. Returns None when the session can't be located, the JSONL
/// has no qualifying user record in its first MAX_LINES_SCANNED lines, or
/// `~/.claude/` doesn't exist (user doesn't use Claude Code).
///
/// Safety: `session_id` arrives over IPC. We reject any value containing a
/// path separator or `..` segment so a hostile caller can't traverse out of
/// the resolved project dir. Real session ids are UUIDs and never contain
/// either, so this filter has no false-positive cost.
#[tauri::command]
pub fn read_claude_session_first_prompt(
    worktree_path: String,
    session_id: String,
    max_chars: usize,
) -> AppResult<Option<String>> {
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return Ok(None);
    }
    let Some(claude) = claude_dir() else {
        return Err(AppError::Msg("no home dir".into()));
    };
    if !claude.exists() {
        return Ok(None);
    }
    let Some(project_dir) = find_project_dir(&claude, &worktree_path) else {
        return Ok(None);
    };
    let jsonl = project_dir.join(format!("{}.jsonl", session_id));
    if !jsonl.exists() {
        return Ok(None);
    }
    match extract_first_user_prompt(&jsonl) {
        Some(content) => Ok(Some(truncate_on_word_boundary(&content, max_chars))),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    fn write_jsonl(dir: &Path, name: &str, lines: &[&str]) -> PathBuf {
        let path = dir.join(name);
        let mut f = fs::File::create(&path).unwrap();
        for line in lines {
            writeln!(f, "{}", line).unwrap();
        }
        path
    }

    #[test]
    fn extracts_first_string_user_record() {
        let tmp = tempdir();
        // Real shape: header records, then a user record with string content.
        // Verifies we walk past permission-mode/system/etc and land on the
        // first qualifying record.
        let jsonl = write_jsonl(
            tmp.path(),
            "s.jsonl",
            &[
                r#"{"type":"permission-mode","permissionMode":"bypassPermissions"}"#,
                r#"{"type":"worktree-state","worktreeSession":{"worktreePath":"/x"}}"#,
                r#"{"type":"system","subtype":"bridge_status"}"#,
                r#"{"type":"user","message":{"role":"user","content":"hello world this is the first prompt"},"uuid":"1"}"#,
            ],
        );
        assert_eq!(
            extract_first_user_prompt(&jsonl),
            Some("hello world this is the first prompt".to_string())
        );
    }

    #[test]
    fn skips_tool_result_envelope_records() {
        // Tool-result records also have type=user but message.content is
        // an array containing at least one block with type="tool_result".
        // We must NOT pick those — they're not human input. The next
        // record (a real string-content prompt) is the one we want.
        let tmp = tempdir();
        let jsonl = write_jsonl(
            tmp.path(),
            "s.jsonl",
            &[
                r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"abc","type":"tool_result","content":"file contents"}]}}"#,
                r#"{"type":"user","message":{"role":"user","content":"the actual prompt"}}"#,
            ],
        );
        assert_eq!(
            extract_first_user_prompt(&jsonl),
            Some("the actual prompt".to_string())
        );
    }

    #[test]
    fn extracts_text_from_user_record_with_attached_image() {
        // The bug this guards against: when a user pastes/drops an image
        // alongside their text, Claude Code switches `message.content` to
        // an array of blocks. The previous string-only filter skipped
        // these records and the autofill landed on the next plain prompt
        // (e.g. "yep commit and push and pr") instead of the real first
        // one. The text block already has "[Image #N]" markers baked in,
        // so just extracting the text gives the user-visible prompt.
        let tmp = tempdir();
        let jsonl = write_jsonl(
            tmp.path(),
            "s.jsonl",
            &[
                r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Image #1] please make this the new logo"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KG"}}]}}"#,
            ],
        );
        assert_eq!(
            extract_first_user_prompt(&jsonl),
            Some("[Image #1] please make this the new logo".to_string())
        );
    }

    #[test]
    fn extracts_image_placeholder_for_image_only_user_record() {
        // Edge case: user pasted an image with no accompanying text.
        // We can't extract text but we still want SOMETHING in the
        // notepad rather than silently skipping to the next prompt.
        let tmp = tempdir();
        let jsonl = write_jsonl(
            tmp.path(),
            "s.jsonl",
            &[
                r#"{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KG"}}]}}"#,
            ],
        );
        assert_eq!(
            extract_first_user_prompt(&jsonl),
            Some("[Image]".to_string())
        );
    }

    #[test]
    fn joins_multiple_text_blocks_in_array_content() {
        // Defensive: if a user message somehow ends up with multiple
        // text blocks (image-text-image-text interleaving), join them
        // with spaces so the notepad seed reads naturally.
        let tmp = tempdir();
        let jsonl = write_jsonl(
            tmp.path(),
            "s.jsonl",
            &[
                r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"first part"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"x"}},{"type":"text","text":"second part"}]}}"#,
            ],
        );
        assert_eq!(
            extract_first_user_prompt(&jsonl),
            Some("first part second part".to_string())
        );
    }

    #[test]
    fn skips_slash_command_envelope_records() {
        // `<command-name>` and `<local-command-stdout>` wrappers are how
        // Claude Code injects slash-command output as user records. They
        // pass the type+role+string filter but aren't human-typed text.
        let tmp = tempdir();
        let jsonl = write_jsonl(
            tmp.path(),
            "s.jsonl",
            &[
                r#"{"type":"user","message":{"role":"user","content":"<command-name>clear</command-name>"}}"#,
                r#"{"type":"user","message":{"role":"user","content":"<local-command-stdout>cleared</local-command-stdout>"}}"#,
                r#"{"type":"user","message":{"role":"user","content":"the real first prompt"}}"#,
            ],
        );
        assert_eq!(
            extract_first_user_prompt(&jsonl),
            Some("the real first prompt".to_string())
        );
    }

    #[test]
    fn returns_none_when_no_user_record_present() {
        // A session that crashed before the user typed anything. The
        // command falls through to the next session in the project dir;
        // this test just confirms the per-file extractor returns None.
        let tmp = tempdir();
        let jsonl = write_jsonl(
            tmp.path(),
            "s.jsonl",
            &[
                r#"{"type":"permission-mode","permissionMode":"default"}"#,
                r#"{"type":"system","subtype":"startup"}"#,
            ],
        );
        assert_eq!(extract_first_user_prompt(&jsonl), None);
    }

    #[test]
    fn returns_none_on_empty_string_content() {
        // Defensive: a `content: ""` record shouldn't seed the notepad
        // with whitespace. Walk past and look for the next real prompt.
        let tmp = tempdir();
        let jsonl = write_jsonl(
            tmp.path(),
            "s.jsonl",
            &[
                r#"{"type":"user","message":{"role":"user","content":"   "}}"#,
                r#"{"type":"user","message":{"role":"user","content":"non-empty"}}"#,
            ],
        );
        assert_eq!(
            extract_first_user_prompt(&jsonl),
            Some("non-empty".to_string())
        );
    }

    #[test]
    fn truncate_returns_full_text_when_short() {
        assert_eq!(truncate_on_word_boundary("hello world", 80), "hello world");
    }

    #[test]
    fn truncate_collapses_whitespace_into_single_spaces() {
        // Multi-line prompts should render as one line in the notepad
        // preview — the autofill is a hint, not a transcript.
        assert_eq!(
            truncate_on_word_boundary("line one\n\n\tline two", 80),
            "line one line two"
        );
    }

    #[test]
    fn truncate_walks_back_to_word_boundary() {
        // Cut at exactly char 11 ("hello world").
        let text = "hello world this is too long";
        let out = truncate_on_word_boundary(text, 11);
        // The 11-char window lands inside "world" or right after it. The
        // walk-back-to-last-space rule should yield "hello…" — never half
        // a word followed by an ellipsis.
        assert!(out.ends_with("…"), "expected ellipsis, got {:?}", out);
        assert!(!out.contains("worl…"), "should not split mid-word: {:?}", out);
    }

    #[test]
    fn truncate_falls_back_to_hard_cut_when_no_whitespace() {
        // Pathological input: a single 200-char URL with no spaces. We
        // can't word-break, so cut at exactly max_chars and append "…".
        let text = "a".repeat(200);
        let out = truncate_on_word_boundary(&text, 10);
        assert_eq!(out.chars().count(), 11); // 10 chars + ellipsis
        assert!(out.ends_with("…"));
    }

    #[test]
    fn truncate_handles_multibyte_characters() {
        // 5 emoji = 5 visual chars but ~20 bytes. max_chars must count
        // chars, not bytes, or we'd cut multibyte sequences in half.
        let text = "🌟🌟🌟🌟🌟 trailing text";
        let out = truncate_on_word_boundary(text, 5);
        // Should be the 5 emoji, no ellipsis (the original is exactly 5
        // chars before the trailing space).
        assert!(out.starts_with("🌟🌟🌟🌟🌟"));
    }

    #[test]
    fn session_first_prompt_rejects_path_traversal_session_id() {
        // The IPC boundary means session_id is attacker-controllable. Any
        // value with `/`, `\`, or `..` should bounce out as None without
        // touching the filesystem. Real session ids are UUIDs and would
        // never trip this guard.
        assert!(matches!(
            read_claude_session_first_prompt("/x".into(), "../etc/passwd".into(), 80),
            Ok(None)
        ));
        assert!(matches!(
            read_claude_session_first_prompt("/x".into(), "a/b".into(), 80),
            Ok(None)
        ));
        assert!(matches!(
            read_claude_session_first_prompt("/x".into(), "".into(), 80),
            Ok(None)
        ));
    }

    #[test]
    fn encode_project_dir_name_matches_claude_format() {
        // The encoding Claude Code uses for ~/.claude/projects/<dir>:
        // both `/` and `.` become `-`. This is the lossy fallback when
        // the authoritative worktree-state header isn't found.
        assert_eq!(
            encode_project_dir_name("/Users/adam/Projects/foo"),
            "-Users-adam-Projects-foo"
        );
        assert_eq!(
            encode_project_dir_name("/a/.b/c"),
            "-a--b-c"
        );
    }

    // ─── Minimal tempdir helper ────────────────────────────────────────
    // We don't pull in the `tempfile` crate just for these tests — a
    // hand-rolled tempdir keeps the dependency surface unchanged.
    struct TempDir {
        path: PathBuf,
    }
    impl TempDir {
        fn path(&self) -> &Path {
            &self.path
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
    fn tempdir() -> TempDir {
        // Counter so concurrent test threads don't collide on the same dir.
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        let path = std::env::temp_dir().join(format!("worktreehq-test-{}-{}", pid, n));
        fs::create_dir_all(&path).unwrap();
        TempDir { path }
    }
}
