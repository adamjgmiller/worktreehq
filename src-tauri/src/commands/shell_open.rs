use crate::error::{AppError, AppResult};
use std::process::Command;

// Launch an OS-native app to open a directory. Unlike git_exec, these are
// fire-and-forget subprocess spawns that inherit the user's environment —
// app launchers need PATH, DISPLAY, and the user's Terminal preferences.
// We spawn() instead of output() because `open -a Terminal` only exits when
// Terminal.app itself quits, which would block the Tauri worker forever.
#[tauri::command]
pub fn shell_open(path: String, action: String) -> AppResult<()> {
    if path.is_empty() {
        return Err(AppError::Msg("shell_open: path is empty".into()));
    }
    if !std::path::Path::new(&path).exists() {
        return Err(AppError::Msg(format!("path does not exist: {path}")));
    }
    match action.as_str() {
        "file_manager" => open_file_manager(&path),
        "terminal" => open_terminal(&path),
        other => Err(AppError::Msg(format!("unknown shell_open action: {other}"))),
    }
}

#[cfg(target_os = "macos")]
fn open_file_manager(path: &str) -> AppResult<()> {
    Command::new("open").arg(path).spawn()?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_terminal(path: &str) -> AppResult<()> {
    // Launches Terminal.app at the given directory. Users on iTerm2/Warp/etc.
    // can be accommodated later via config. Note: if WorktreeHQ ever ships
    // sandboxed via the Mac App Store, this will require an entitlement.
    Command::new("open").args(["-a", "Terminal", path]).spawn()?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_file_manager(path: &str) -> AppResult<()> {
    // `start "" "<path>"` — the empty title arg is required so a quoted path
    // isn't interpreted as the window title by cmd's `start` builtin.
    Command::new("cmd").args(["/c", "start", "", path]).spawn()?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_terminal(path: &str) -> AppResult<()> {
    // Prefer Windows Terminal; fall back to cmd.exe if wt.exe fails for any
    // reason (not on PATH, permission denied, broken install, etc.). The
    // fallback uses `current_dir` so we never interpolate the path into a
    // cmd command string — avoids metacharacter handling entirely.
    if Command::new("wt.exe").args(["-d", path]).spawn().is_ok() {
        return Ok(());
    }
    Command::new("cmd")
        .args(["/c", "start", "", "cmd.exe"])
        .current_dir(path)
        .spawn()?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn open_file_manager(path: &str) -> AppResult<()> {
    Command::new("xdg-open").arg(path).spawn()?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn open_terminal(path: &str) -> AppResult<()> {
    // No universal Linux terminal launcher — probe a reasonable chain. Each
    // candidate uses a slightly different "start in dir" flag; all of these
    // accept a separate-arg form for the path.
    let attempts: &[(&str, &str)] = &[
        ("x-terminal-emulator", "--working-directory"),
        ("gnome-terminal", "--working-directory"),
        ("konsole", "--workdir"),
        ("xfce4-terminal", "--working-directory"),
        ("alacritty", "--working-directory"),
        ("kitty", "--directory"),
    ];
    for (bin, flag) in attempts {
        match Command::new(bin).arg(flag).arg(path).spawn() {
            Ok(_) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(AppError::Io(e)),
        }
    }
    // Last resort: xterm has no working-directory flag, so use current_dir
    // on the spawned process — xterm's default is to start the user's login
    // shell, which inherits the cwd. Avoids shell string interpolation and
    // any metacharacter injection concern for paths containing quotes.
    match Command::new("xterm").current_dir(path).spawn() {
        Ok(_) => Ok(()),
        Err(_) => Err(AppError::Msg(
            "No terminal emulator found. Install one of: gnome-terminal, konsole, alacritty, kitty, xterm.".into(),
        )),
    }
}
