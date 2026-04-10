use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

#[derive(Serialize)]
pub struct GitExecResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

// Wall-clock cap on a single git subprocess. The env scrub below prevents the
// most common hangs (HTTPS credential prompts via GIT_TERMINAL_PROMPT=0, SSH
// passphrase prompts via BatchMode=yes, slow TCP via ConnectTimeout=10) but
// not every pathological case — `git status` against a sleeping NFS mount or a
// fetch stuck mid-transfer could still pin a Tauri worker thread. 90s is
// generous enough for legitimately slow fetches against a large remote while
// still cutting off truly hung processes.
const GIT_EXEC_TIMEOUT: Duration = Duration::from_secs(90);

#[tauri::command]
pub fn git_exec(repo_path: String, args: Vec<String>) -> AppResult<GitExecResult> {
    if repo_path.is_empty() {
        return Err(AppError::Msg("git_exec: repo_path is empty".into()));
    }

    // Note: args are passed positionally as a Vec<String> to git via Command;
    // there is no shell interpolation, so this is the safe equivalent of
    // execFile (not shell exec).
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&repo_path).args(&args);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    // Sanitize the environment so subprocesses behave deterministically and
    // never block on interactive prompts. Without these:
    //   GIT_TERMINAL_PROMPT=0  fetch against an unreachable HTTPS remote
    //                          would hang forever waiting for credentials
    //                          (no TTY to type into), wedging the refresh loop.
    //   GIT_SSH_COMMAND         the SSH equivalent of GIT_TERMINAL_PROMPT=0.
    //                          GIT_TERMINAL_PROMPT only covers git's own
    //                          HTTPS credential helpers — SSH passphrase
    //                          prompts are handled by the ssh binary itself.
    //                          BatchMode=yes tells SSH to fail immediately
    //                          instead of prompting when the agent has no key
    //                          loaded (after a reboot, sleep/wake, or keychain
    //                          timeout). ConnectTimeout=10 caps the TCP
    //                          handshake so a dead remote fails in seconds
    //                          instead of the OS default (~75s). We prepend
    //                          to any user-provided GIT_SSH_COMMAND so custom
    //                          SSH binaries or flags are preserved.
    //   GIT_PAGER=cat          prevents pager-related blocking on commands
    //                          that paginate output in unusual configs.
    //   LC_ALL=C               parsers in gitService.ts implicitly assume
    //                          English git output; translated errors would
    //                          silently break detection.
    //   GIT_OPTIONAL_LOCKS=0   read-only commands won't contend with
    //                          concurrent user git operations on the repo.
    //   GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE removed — if the app was
    //   launched from inside a git repo with these set, subprocesses would
    //   misdirect to the launching shell's repo instead of repo_path.
    let ssh_base = std::env::var("GIT_SSH_COMMAND").unwrap_or_else(|_| "ssh".into());
    let ssh_cmd = format!("{ssh_base} -o BatchMode=yes -o ConnectTimeout=10");
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", &ssh_cmd)
        .env("GIT_PAGER", "cat")
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE");

    let mut child = cmd.spawn().map_err(AppError::Io)?;

    // Drain stdout/stderr on background threads. Reading them on the main
    // thread before wait() can deadlock on commands whose output fills the
    // OS pipe buffer.
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

    // Wait for the child with a timeout. We move the Child into a worker
    // thread so the calling Tauri thread can recv() with a deadline; on
    // timeout we kill the child via its PID (we still have it before the
    // move) so the readers can exit cleanly.
    let child_id = child.id();
    let (tx, rx) = mpsc::channel::<std::io::Result<std::process::ExitStatus>>();
    let wait_handle = thread::spawn(move || {
        let result = child.wait();
        let _ = tx.send(result);
    });

    let status = match rx.recv_timeout(GIT_EXEC_TIMEOUT) {
        Ok(s) => s,
        Err(_) => {
            // Timed out — terminate the still-running child via its PID. The
            // wait_handle will then observe the death and complete; the
            // readers exit when the pipes close.
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
                "git {} timed out after {}s",
                args.join(" "),
                GIT_EXEC_TIMEOUT.as_secs()
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

    Ok(GitExecResult {
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        code,
    })
}
