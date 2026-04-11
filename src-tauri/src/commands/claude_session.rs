// Launch a fresh terminal that runs `claude --resume <session_id>` inside the
// given worktree directory. Wired to the "open" button on each past-session
// row in the worktree card so the user can resume a closed session in one
// click instead of copy-pasting a shell command.
//
// Why this isn't a variant of `shell_open`: that command's `terminal` action
// is a fire-and-forget "cd there in Terminal"; it has no way to also run a
// command in the opened terminal. Extending it with an optional command
// parameter would generalize it beyond its stated purpose and muddy the
// action enum. A narrow command named for its job is clearer.
//
// Security: `session_id` and `path` both arrive over IPC and both end up
// interpolated into a shell command string. We defend at two layers:
//   1. `session_id` is whitelisted to `[A-Za-z0-9_-]`. Real Claude session
//      ids are UUIDs, so this filter has no false-positive cost but blocks
//      any metacharacter injection if the IPC caller were hostile.
//   2. `path` is single-quoted for the shell (POSIX) or passed via
//      `current_dir` (Windows) so we never interpolate it into a `cmd /c`
//      command string.

use crate::error::{AppError, AppResult};
use std::process::Command;

#[tauri::command]
pub fn open_claude_session(path: String, session_id: String) -> AppResult<()> {
    if path.is_empty() {
        return Err(AppError::Msg("open_claude_session: path is empty".into()));
    }
    if !std::path::Path::new(&path).exists() {
        return Err(AppError::Msg(format!("path does not exist: {path}")));
    }
    if !is_safe_session_id(&session_id) {
        return Err(AppError::Msg(format!(
            "invalid claude session id: {session_id}"
        )));
    }
    platform_open(&path, &session_id)
}

fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

// POSIX shell single-quote, escaping embedded single quotes with the standard
// 'foo'\''bar' pattern. Mirrors the TS helper in claudeAwarenessService.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(target_os = "macos")]
fn platform_open(path: &str, session_id: &str) -> AppResult<()> {
    // AppleScript's `do script` opens a new Terminal window (or tab if the
    // app is already frontmost) and runs the given shell command. Wrapping
    // the `tell` block via repeated `-e` flags lets us avoid quoting an
    // entire multi-line script and keeps escaping to just the AppleScript
    // string literal layer.
    let shell_cmd = format!("cd {} && claude --resume {}", shell_quote(path), session_id);
    Command::new("osascript")
        .args([
            "-e",
            "tell application \"Terminal\"",
            "-e",
            "activate",
            "-e",
            &format!("do script \"{}\"", applescript_escape(&shell_cmd)),
            "-e",
            "end tell",
        ])
        .spawn()?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn applescript_escape(s: &str) -> String {
    // AppleScript string literals only need `\` and `"` escaped. Our shell
    // command can contain single quotes (from shell_quote) but those are
    // fine inside an AppleScript double-quoted string.
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "windows")]
fn platform_open(path: &str, session_id: &str) -> AppResult<()> {
    // Prefer Windows Terminal; fall back to a plain `cmd /k` in a new
    // console. In both cases the session id is interpolated only into the
    // command argument (already validated to be alphanumeric + -_), and the
    // working directory is passed structurally so `path` never enters a
    // shell command string.
    let resume = format!("claude --resume {}", session_id);
    if Command::new("wt.exe")
        .args(["-d", path, "cmd.exe", "/k", &resume])
        .spawn()
        .is_ok()
    {
        return Ok(());
    }
    Command::new("cmd")
        .args(["/c", "start", "", "cmd.exe", "/k", &resume])
        .current_dir(path)
        .spawn()?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn platform_open(path: &str, session_id: &str) -> AppResult<()> {
    // Each terminal emulator has its own flag for "start in this directory"
    // and its own convention for "after these args, run this command". Most
    // of the modern ones take `-- <argv>` after a working-directory flag;
    // konsole uses `-e` instead. We `exec $SHELL` after the command so the
    // terminal stays open if the user wants to read output — otherwise the
    // window would close the instant `claude` exits.
    let shell_cmd = format!(
        "claude --resume {}; exec \"${{SHELL:-bash}}\"",
        session_id
    );

    // gnome-terminal / x-terminal-emulator / xfce4 / alacritty all take
    // `--working-directory <path> -- bash -c <cmd>`.
    let dash_dash: &[(&str, &str)] = &[
        ("x-terminal-emulator", "--working-directory"),
        ("gnome-terminal", "--working-directory"),
        ("xfce4-terminal", "--working-directory"),
        ("alacritty", "--working-directory"),
    ];
    for (bin, flag) in dash_dash {
        match Command::new(bin)
            .arg(flag)
            .arg(path)
            .arg("--")
            .args(["bash", "-c", &shell_cmd])
            .spawn()
        {
            Ok(_) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(AppError::Io(e)),
        }
    }

    // konsole: `--workdir <path> -e bash -c <cmd>`
    match Command::new("konsole")
        .args(["--workdir", path, "-e", "bash", "-c", &shell_cmd])
        .spawn()
    {
        Ok(_) => return Ok(()),
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(AppError::Io(e)),
        Err(_) => {}
    }

    // kitty: `--directory <path> bash -c <cmd>` (no `--` separator)
    match Command::new("kitty")
        .args(["--directory", path, "bash", "-c", &shell_cmd])
        .spawn()
    {
        Ok(_) => return Ok(()),
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(AppError::Io(e)),
        Err(_) => {}
    }

    // xterm has no working-directory flag, so use the spawned process's cwd
    // and pass `-e bash -c <cmd>` for command execution. Avoids interpolating
    // `path` into any shell string.
    match Command::new("xterm")
        .current_dir(path)
        .args(["-e", "bash", "-c", &shell_cmd])
        .spawn()
    {
        Ok(_) => Ok(()),
        Err(_) => Err(AppError::Msg(
            "No terminal emulator found. Install one of: gnome-terminal, konsole, alacritty, kitty, xterm.".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_uuid_style_session_ids() {
        assert!(is_safe_session_id("0e9f8b3c-1234-5678-9abc-def012345678"));
        assert!(is_safe_session_id("abc_123"));
        assert!(is_safe_session_id("A"));
    }

    #[test]
    fn rejects_shell_metacharacters_in_session_id() {
        assert!(!is_safe_session_id(""));
        assert!(!is_safe_session_id("id; rm -rf ~"));
        assert!(!is_safe_session_id("id && echo pwn"));
        assert!(!is_safe_session_id("id`pwd`"));
        assert!(!is_safe_session_id("id$USER"));
        assert!(!is_safe_session_id("id with space"));
        assert!(!is_safe_session_id("id/../etc"));
    }

    #[test]
    fn shell_quote_handles_embedded_single_quotes() {
        assert_eq!(shell_quote("/a/b c"), "'/a/b c'");
        assert_eq!(shell_quote("/weird's dir"), "'/weird'\\''s dir'");
    }
}
