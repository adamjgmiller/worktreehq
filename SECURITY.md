# Security policy

## Reporting a vulnerability

If you find a security vulnerability in WorktreeHQ, please **do not file a public GitHub issue**. Instead, open a private security advisory:

→ **[Report a vulnerability](https://github.com/adamjgmiller/worktreehq/security/advisories/new)**

This uses GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) feature, which keeps the report confidential until a fix is ready. I'll respond within a few days and work with you on a fix and a coordinated disclosure timeline.

## What "security-relevant" looks like for this app

WorktreeHQ runs locally on your machine and stores one piece of secret material: a GitHub Personal Access Token, kept in `~/.config/worktreehq/config.toml`. Things I'd consider security-relevant:

- Token leaking outside `~/.config/worktreehq/config.toml` — for example into logs, error messages, IPC payloads sent to the webview, or the window title
- Arbitrary command execution via crafted branch names, repo paths, PR titles, or notepad contents
- Path traversal that lets the app read or write outside the configured repo or the app's own config directory
- Anything that lets a malicious git remote (e.g. a hostile `origin`) cause behavior beyond what `git` itself would do
- Tauri IPC commands accepting unsanitized input that reaches the shell

Bug reports for non-security issues belong in the [public issue tracker](https://github.com/adamjgmiller/worktreehq/issues).

## Token handling — what the app does and doesn't do

- The token is read from `~/.config/worktreehq/config.toml` (or the `GITHUB_TOKEN` environment variable as a fallback) and used only as a Bearer token to `api.github.com` via [Octokit](https://github.com/octokit/octokit.js).
- The token is **never** written to any other file, sent to any other host, or surfaced in error messages reaching the UI.
- If you save an empty token via the Settings modal, the app sets an `explicitly_set` flag so the env-var fallback no longer overrides your explicit clear.
- The on-disk PR cache contains PR metadata fetched via this token, but never the token itself.

## Supported versions

WorktreeHQ is currently v0.x and only the `main` branch receives security fixes. Once a v1 ships, this section will be updated with a support matrix.
