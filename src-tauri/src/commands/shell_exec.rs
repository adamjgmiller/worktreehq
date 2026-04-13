use crate::error::{AppError, AppResult};
use super::subprocess::{wait_with_timeout, SubprocessResult};
use std::process::{Command, Stdio};
use std::time::Duration;

pub type ShellExecResult = SubprocessResult;

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

    let child = cmd.spawn().map_err(AppError::Io)?;
    let budget = Duration::from_secs(timeout_secs.unwrap_or(DEFAULT_TIMEOUT.as_secs()));
    wait_with_timeout(child, budget, "post-create commands")
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
