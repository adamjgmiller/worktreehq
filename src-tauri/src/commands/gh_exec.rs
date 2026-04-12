use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

#[derive(Serialize)]
pub struct GhExecResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

// 30s timeout. API calls shouldn't take as long as git fetches. Generous
// enough for paginated responses on repos with hundreds of open PRs.
const GH_EXEC_TIMEOUT: Duration = Duration::from_secs(30);

/// Run the `gh` CLI binary with the given positional args. Args are passed
/// directly to `Command` — no shell interpolation, same safe pattern as
/// `git_exec`. Returns structured stdout/stderr/code.
#[tauri::command]
pub async fn gh_exec(args: Vec<String>) -> AppResult<GhExecResult> {
    tauri::async_runtime::spawn_blocking(move || gh_exec_blocking(args))
        .await
        .map_err(|e| AppError::Msg(format!("gh_exec join error: {e}")))?
}

fn gh_exec_blocking(args: Vec<String>) -> AppResult<GhExecResult> {
    // Safety: args are passed positionally via Command, not through a shell.
    // No shell interpolation occurs — this is the equivalent of execvp().
    let mut cmd = Command::new("gh");
    cmd.args(&args);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    // GH_PROMPT_DISABLED=1 prevents gh from ever trying to prompt for auth
    // interactively — same rationale as GIT_TERMINAL_PROMPT=0 in git_exec.
    // NO_COLOR=1 strips ANSI codes from output so JSON parsing is clean.
    cmd.env("GH_PROMPT_DISABLED", "1");
    cmd.env("NO_COLOR", "1");

    // Remove GITHUB_TOKEN / GH_TOKEN so `gh` uses its own credential store
    // (gh auth login) rather than silently picking up whatever token the
    // user's shell exports. Same rationale as the env scrubbing in git_exec —
    // without this, the auth method the user configured is bypassed.
    cmd.env_remove("GITHUB_TOKEN");
    cmd.env_remove("GH_TOKEN");

    let mut child = cmd.spawn().map_err(|e| {
        // Distinguish "gh not installed" from other spawn failures so the
        // frontend can fall through to the PAT path gracefully.
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::Msg("gh CLI not found".into())
        } else {
            AppError::Io(e)
        }
    })?;

    // Drain stdout/stderr on background threads. Same pattern as git_exec.
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = stdout_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let stderr_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = stderr_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });

    let child_id = child.id();
    let (tx, rx) = mpsc::channel::<std::io::Result<std::process::ExitStatus>>();
    let wait_handle = thread::spawn(move || {
        let result = child.wait();
        let _ = tx.send(result);
    });

    let status = match rx.recv_timeout(GH_EXEC_TIMEOUT) {
        Ok(s) => s,
        Err(_) => {
            #[cfg(unix)]
            unsafe {
                libc::kill(child_id as libc::pid_t, libc::SIGKILL);
            }
            #[cfg(not(unix))]
            let _ = child_id;
            let _ = wait_handle.join();
            let _ = stdout_handle.join();
            let _ = stderr_handle.join();
            return Err(AppError::Msg(format!(
                "gh {} timed out after {}s",
                args.join(" "),
                GH_EXEC_TIMEOUT.as_secs()
            )));
        }
    };
    let _ = wait_handle.join();
    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();
    let code = match status {
        Ok(s) => s.code().unwrap_or(-1),
        Err(e) => return Err(AppError::Io(e)),
    };

    Ok(GhExecResult {
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        code,
    })
}
