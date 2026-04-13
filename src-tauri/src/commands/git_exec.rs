use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;

/// Auth state for git subprocess credential injection. Updated from the
/// frontend via `set_git_auth_method` whenever auth method changes (bootstrap
/// + Settings save). When `method` is `"gh-cli"`, `git_exec` injects
/// `credential.helper=!gh auth git-credential`. When `"pat"`, it injects a
/// shell helper that echoes the stored token via an env var (so it never
/// appears in `ps` output).
struct GitAuthState {
    method: String,
    token: Option<String>,
}

static AUTH_STATE: Mutex<GitAuthState> = Mutex::new(GitAuthState {
    method: String::new(),
    token: None,
});

#[tauri::command]
pub fn set_git_auth_method(method: String, token: Option<String>) {
    let mut state = AUTH_STATE.lock().unwrap_or_else(|p| p.into_inner());
    state.method = method;
    state.token = token;
}

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
pub async fn git_exec(repo_path: String, args: Vec<String>) -> AppResult<GitExecResult> {
    // Off-load the entire subprocess dance to Tauri's blocking threadpool.
    //
    // Why this is load-bearing: Tauri v2's `#[tauri::command]` on a plain
    // `fn` generates `body_blocking` (see tauri-macros/src/command/wrapper.rs),
    // which calls the function synchronously inside the IPC dispatch — which
    // runs on the main thread. Every sync command we invoke from JS
    // therefore blocks the UI thread for the entire duration of the
    // subprocess. A single refresh tick fires ~30 git subprocesses
    // (worktrees list + branches list + per-branch ahead/behind + merge-base +
    // merge-tree + fetch), so the main thread was spending hundreds of ms
    // (often 1-2 seconds) inside git_exec per click, completely blocking
    // scroll, clicks, and even the refresh button's own spin animation.
    //
    // Marking the wrapper `async fn` flips the macro to the async body,
    // which dispatches to Tauri's async runtime. That alone unblocks the
    // main thread, but calling `child.wait()` from the async context would
    // still block a tokio worker. Wrapping the whole body in
    // `spawn_blocking` puts the subprocess on a thread dedicated to
    // blocking I/O, so parallel `Promise.all` git calls from JS actually
    // run in parallel instead of serializing through one blocked worker.
    let (method, token) = {
        let state = AUTH_STATE.lock().unwrap_or_else(|p| p.into_inner());
        (state.method.clone(), state.token.clone())
    };
    tauri::async_runtime::spawn_blocking(move || {
        git_exec_blocking(repo_path, args, method, token)
    })
    .await
    .map_err(|e| AppError::Msg(format!("git_exec join error: {e}")))?
}

fn git_exec_blocking(
    repo_path: String,
    args: Vec<String>,
    auth_method: String,
    auth_token: Option<String>,
) -> AppResult<GitExecResult> {
    if repo_path.is_empty() {
        return Err(AppError::Msg("git_exec: repo_path is empty".into()));
    }

    // Args are passed positionally as a Vec<String> to git via Command; there
    // is no shell interpolation, so this is the safe equivalent of running a
    // named binary with an args array.
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&repo_path);

    // Only inject credential helpers for git subcommands that contact a
    // remote. Local commands (status, log, branch, etc.) never need
    // credentials, and restricting injection keeps the PAT env var out
    // of repository-controlled hooks that fire during non-network
    // operations. For network commands that DO trigger hooks (push
    // triggers pre-push, pull triggers post-merge), the env var is
    // still visible — see the credential-helper-binary tracking issue
    // for the long-term fix.
    let needs_credentials = args.first().map_or(false, |sub| {
        matches!(
            sub.as_str(),
            "fetch" | "push" | "pull" | "ls-remote" | "clone"
        )
    });

    if needs_credentials {
        // When the user chose gh-cli auth, inject `credential.helper` so
        // git fetch/push authenticate via `gh auth git-credential` instead
        // of triggering the macOS `git-credential-osxkeychain` keychain
        // prompt. An empty `credential.helper=` first resets the
        // multi-valued helper list so system-level helpers (osxkeychain,
        // etc.) are removed; then the gh helper is the only one git will
        // consult.
        if auth_method == "gh-cli" {
            cmd.arg("-c").arg("credential.helper=");
            cmd.arg("-c")
                .arg("credential.helper=!gh auth git-credential");

            // On macOS, GUI-launched apps inherit a minimal PATH that
            // doesn't include Homebrew dirs. Git spawns a shell to run
            // `!`-prefixed credential helpers, so `gh` must be findable
            // on PATH. Same extension as gh_exec.rs.
            #[cfg(target_os = "macos")]
            {
                let path = std::env::var("PATH").unwrap_or_default();
                if !path.contains("/opt/homebrew/bin") || !path.contains("/usr/local/bin") {
                    cmd.env("PATH", format!("{path}:/opt/homebrew/bin:/usr/local/bin"));
                }
            }
        } else if auth_method == "pat" {
            if let Some(ref token) = auth_token {
                if !token.is_empty() {
                    // Pass the PAT via a private env var so it never shows
                    // in `ps` output. The shell credential helper receives
                    // "get" as $1 (argv) and echoes the token back to git.
                    // Scoped to github.com so the token is never
                    // accidentally sent to a non-GitHub remote. Reset the
                    // global helper list first so system-level helpers
                    // (osxkeychain, etc.) can't trigger prompts if the
                    // scoped helper fails.
                    cmd.arg("-c").arg("credential.helper=");
                    cmd.env("__WORKTREEHQ_PAT", token);
                    cmd.arg("-c").arg(concat!(
                        "credential.https://github.com.helper=",
                        r#"!f() { test "$1" = get && printf 'username=x-access-token\npassword=%s\n' "$__WORKTREEHQ_PAT"; }; f"#,
                    ));
                }
            }
        }
    }

    cmd.args(&args);
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
    //                          instead of the OS default (~75s). We append
    //                          to any user-provided GIT_SSH_COMMAND so the
    //                          custom SSH binary is preserved and, because
    //                          SSH uses first-wins for -o options, any user
    //                          overrides (e.g. ConnectTimeout=60) take
    //                          precedence over our defaults.
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
