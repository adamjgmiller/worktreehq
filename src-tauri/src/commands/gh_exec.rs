use crate::error::{AppError, AppResult};
use super::subprocess::{wait_with_timeout, SubprocessResult};
use std::process::{Command, Stdio};
use std::time::Duration;

pub type GhExecResult = SubprocessResult;

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

    // On macOS, GUI apps launched from Finder/Dock inherit a minimal PATH
    // (/usr/bin:/bin:/usr/sbin:/sbin). Homebrew tools like `gh` live in
    // /opt/homebrew/bin (Apple Silicon) or /usr/local/bin (Intel), neither
    // of which is on this default PATH. Extend it so `gh` is findable
    // regardless of how the app was launched. `git` doesn't need this
    // because Apple ships it at /usr/bin/git.
    #[cfg(target_os = "macos")]
    {
        let path = std::env::var("PATH").unwrap_or_default();
        if !path.contains("/opt/homebrew/bin") || !path.contains("/usr/local/bin") {
            cmd.env("PATH", format!("{path}:/opt/homebrew/bin:/usr/local/bin"));
        }
    }

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

    let child = cmd.spawn().map_err(|e| {
        // Distinguish "gh not installed" from other spawn failures so the
        // frontend can fall through to the PAT path gracefully.
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::Msg("gh CLI not found".into())
        } else {
            AppError::Io(e)
        }
    })?;
    let label = format!("gh {}", args.join(" "));
    wait_with_timeout(child, GH_EXEC_TIMEOUT, &label)
}
