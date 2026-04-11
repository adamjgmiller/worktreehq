use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

#[derive(Debug, Serialize)]
pub struct ShellExecResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

// Default wall-clock cap. `npm install` on a cold cache easily exceeds
// git_exec's 90s, so we start with a much larger budget. The caller can
// override via `timeout_secs`.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(600);

#[tauri::command]
pub fn run_shell_commands(
    cwd: String,
    script: String,
    timeout_secs: Option<u64>,
) -> AppResult<ShellExecResult> {
    if cwd.is_empty() {
        return Err(AppError::Msg("run_shell_commands: cwd is empty".into()));
    }
    if script.trim().is_empty() {
        return Ok(ShellExecResult {
            stdout: String::new(),
            stderr: String::new(),
            code: 0,
        });
    }

    // `sh -c <script>` feeds the whole multi-line script to a POSIX shell,
    // so `&&`, `||`, env-var expansion, `cd`, and subshells all work. We
    // intentionally use `sh` rather than `bash` for portability — if a user
    // needs bashisms they can prefix their commands with `bash -c '...'`.
    #[cfg(unix)]
    let mut cmd = {
        let mut c = Command::new("/bin/sh");
        c.arg("-c").arg(&script);
        c
    };
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&script);
        c
    };

    cmd.current_dir(&cwd);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    // Unlike git_exec we INHERIT the user's env — tools like npm, asdf,
    // nvm, and direnv rely on PATH and friends. But we still scrub
    // GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE so a `git` command inside the
    // user's script won't be silently misdirected to the launching shell's
    // repo (the exact failure mode git_exec.rs documents).
    cmd.env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE");

    let mut child = cmd.spawn().map_err(AppError::Io)?;

    // Drain stdout/stderr on background threads. Reading them on the main
    // thread before wait() can deadlock on scripts whose output fills the
    // OS pipe buffer — `npm install` trivially exceeds 64KB.
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

    // Wait for the child with a timeout. Same pattern as git_exec: move the
    // Child into a worker thread so the caller can recv() with a deadline,
    // and on timeout kill the still-running child via its PID (captured
    // before the move) so the readers can exit cleanly.
    let child_id = child.id();
    let (tx, rx) = mpsc::channel::<std::io::Result<std::process::ExitStatus>>();
    let wait_handle = thread::spawn(move || {
        let result = child.wait();
        let _ = tx.send(result);
    });

    let budget = Duration::from_secs(timeout_secs.unwrap_or(DEFAULT_TIMEOUT.as_secs()));
    let status = match rx.recv_timeout(budget) {
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
                "post-create commands timed out after {}s",
                budget.as_secs()
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

    Ok(ShellExecResult {
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        code,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn empty_script_is_a_noop_success() {
        let r = run_shell_commands("/tmp".into(), "   ".into(), None).unwrap();
        assert_eq!(r.code, 0);
        assert!(r.stdout.is_empty());
        assert!(r.stderr.is_empty());
    }

    #[test]
    fn success_captures_stdout() {
        let r = run_shell_commands("/tmp".into(), "echo hello".into(), None).unwrap();
        assert_eq!(r.code, 0);
        assert!(r.stdout.contains("hello"));
    }

    #[test]
    fn non_zero_exit_is_surfaced_not_errored() {
        let r = run_shell_commands("/tmp".into(), "false".into(), None).unwrap();
        assert_ne!(r.code, 0);
    }

    #[test]
    fn runs_in_the_given_cwd() {
        let r = run_shell_commands("/tmp".into(), "pwd".into(), None).unwrap();
        assert_eq!(r.code, 0);
        // macOS resolves /tmp → /private/tmp, so accept either form.
        let out = r.stdout.trim();
        assert!(out == "/tmp" || out == "/private/tmp", "got {out}");
    }

    #[test]
    fn timeout_kills_the_child() {
        let r = run_shell_commands("/tmp".into(), "sleep 5".into(), Some(1));
        assert!(r.is_err());
        let msg = r.unwrap_err().to_string();
        assert!(msg.contains("timed out"), "got {msg}");
    }

    #[test]
    fn empty_cwd_is_an_error() {
        let r = run_shell_commands("".into(), "echo hi".into(), None);
        assert!(r.is_err());
    }

    #[test]
    fn git_env_vars_are_scrubbed() {
        // Set GIT_DIR in the parent env; child should not see it.
        std::env::set_var("GIT_DIR", "/nowhere");
        let r = run_shell_commands(
            "/tmp".into(),
            "echo ${GIT_DIR:-unset}".into(),
            None,
        )
        .unwrap();
        std::env::remove_var("GIT_DIR");
        assert_eq!(r.code, 0);
        assert!(r.stdout.contains("unset"), "got {}", r.stdout);
    }
}
