//! Shared subprocess execution: pipe draining, timeout, and SIGKILL.
//!
//! Used by `git_exec`, `gh_exec`, and `shell_exec` to avoid triplicating the
//! identical thread-spawn + mpsc-timeout dance.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::io::Read;
use std::process::Child;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// Shared result type for all subprocess commands. Serializes to
/// `{stdout, stderr, code}` — the same shape all three exec commands used.
#[derive(Debug, Serialize)]
pub struct SubprocessResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// Drain stdout/stderr, wait for exit with a timeout, SIGKILL on timeout.
///
/// `child` must have been spawned with `Stdio::piped()` for both stdout and
/// stderr.  `timeout_label` is a human-readable description included in the
/// timeout error message (e.g. `"git fetch origin"`, `"gh api ..."`,
/// `"post-create commands"`).
pub fn wait_with_timeout(
    mut child: Child,
    timeout: Duration,
    timeout_label: &str,
) -> AppResult<SubprocessResult> {
    // Drain stdout/stderr on background threads. Reading them on the calling
    // thread before wait() can deadlock when output fills the OS pipe buffer.
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

    // Move the Child into a worker thread so we can recv() with a deadline.
    // On timeout we kill via PID (captured before the move).
    let child_id = child.id();
    let (tx, rx) = mpsc::channel::<std::io::Result<std::process::ExitStatus>>();
    let wait_handle = thread::spawn(move || {
        let result = child.wait();
        let _ = tx.send(result);
    });

    let status = match rx.recv_timeout(timeout) {
        Ok(s) => s,
        Err(_) => {
            // Timed out — terminate the still-running child. The wait_handle
            // will then observe the death; the readers exit when pipes close.
            #[cfg(unix)]
            unsafe {
                libc::kill(child_id as libc::pid_t, libc::SIGKILL);
            }
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/PID", &child_id.to_string()])
                    .output();
            }
            #[cfg(not(any(unix, windows)))]
            let _ = child_id;
            let _ = wait_handle.join();
            let _ = stdout_handle.join();
            let _ = stderr_handle.join();
            return Err(AppError::Msg(format!(
                "{timeout_label} timed out after {}s",
                timeout.as_secs()
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

    Ok(SubprocessResult {
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        code,
    })
}
