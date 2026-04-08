# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WorktreeHQ — a Tauri v2 desktop dashboard for live git worktree state and branch hygiene, with first-class understanding of **squash-merged** PRs. The product reason this exists: most git GUIs treat squash-merged branches as "unmerged" so they pile up forever. This app detects squash merges via the GitHub API plus a `git cherry` patch-id fallback so dead branches can be safely bulk-deleted.

See `README.md` for the user-facing feature list and `PLAN.md` for the original implementation plan, data model, and squash-detection algorithm in detail.

## Commands

```bash
npm install
npm run dev          # Vite only (frontend dev server on :1420)
npm run tauri dev    # Full Tauri app (spawns vite + native window)
npm test             # vitest run (one-shot)
npm run test:watch   # vitest watch
npm run build        # tsc --noEmit && vite build
```

Run a single test file: `npx vitest run src/services/squashDetector.test.ts`
Run a single test by name: `npx vitest run -t 'extracts PR number'`

Rust-side check (faster than a full `tauri build`): `cd src-tauri && cargo check`

`npm run tauri dev` requires the OS-level WebView deps (on Linux: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`).

## Architecture — the load-bearing decisions

### One Rust command, all git logic in TypeScript

The Rust backend is intentionally thin. There is **one** generic command, `git_exec(repo_path, args[])` (`src-tauri/src/commands/git_exec.rs`), that invokes the system `git` binary as a subprocess via `std::process::Command` and returns `{stdout, stderr, code}`. Every git operation in the app — listing worktrees, computing ahead/behind, cherry-checks, branch deletes — is a TypeScript function in `src/services/gitService.ts` that builds on `git_exec`.

**Implication for new work:** when adding a new git operation, add a TS function in `gitService.ts`. Do **not** add a new `#[tauri::command]` for it. The only Rust commands that exist are for things git can't do: filesystem watching (`watcher.rs`), config persistence (`config.rs`), repo root resolution (`repo.rs`), notepads (`notepads.rs`), Claude IDE state polling (`claude_state.rs`), the on-disk PR cache (`pr_cache.rs`), and a tiny `path_exists` probe (`fs_probe.rs`).

`git_exec` deliberately scrubs the subprocess environment before invoking git: `GIT_TERMINAL_PROMPT=0` (so a fetch against an unreachable HTTPS remote can't hang waiting for credentials — there's no TTY), `GIT_PAGER=cat`, `LC_ALL=C` (parsers in `gitService.ts` implicitly assume English output), `GIT_OPTIONAL_LOCKS=0`, and removes inherited `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`. Don't reach around this if you're shelling out from elsewhere — and if you ever add a second Rust subprocess command, mirror these or you'll reintroduce the credential-prompt-hang failure mode.

### Frontend data flow

```
useRepoBootstrap (hook)
  → invoke('read_config')           # token + last_repo_path + refresh interval
  → invoke('resolve_repo')          # finds .git root walking up from cwd
  → getDefaultBranch (gitService)
  → setRepo() in zustand store
  → startRefreshLoop()              # polling tick, default 15s

refreshLoop.refreshOnce()  (src/services/refreshLoop.ts)
  ├── listWorktrees()       ─┐
  ├── listBranches()         │ all in parallel via Promise.all
  ├── listMainCommits()      │
  └── listTags()            ─┘
  → listOpenPRsForBranches() (Octokit)
  → detectSquashMerges()    # the squash-detection algorithm
  → store setters → React re-renders
```

State lives in a single Zustand store (`src/store/useRepoStore.ts`). React components subscribe via selectors. There is no router; tabs are local component state in `App.tsx`.

Runtime repo switching (e.g. the "Pick a repository…" affordance and the
folder-icon button in `RepoBar`) goes through `src/services/repoSelect.ts`,
which wraps the directory picker, `resolve_repo`, the gitService bootstrap
calls, and config persistence. Use `pickAndLoadRepo()` for new entry points
rather than reproducing the dance.

### Squash-merge detection (the core domain logic)

`src/services/squashDetector.ts` is the brain of the app. The algorithm has two passes:

1. **PR-tag pass**: walk first-parent commits on `main`, regex `/(#\d+)$/` on each subject to extract a PR number, fetch the PR via Octokit (cached 5 min in-memory in `githubService.ts`), and if `pr.merge_commit_sha === commit.sha` mark `pr.head.ref` as `squash-merged`. Also creates a `SquashMapping` so the Squash Archaeology view can render `squash sha → PR # → source branch → original commits` (the original commits come from optional `archive/<branch>` tags).
2. **Cherry fallback pass**: for branches still `unmerged` after pass 1, run `git cherry main <branch>` — if every line starts with `-`, every commit on the branch is patch-equivalent to something on main, so it's effectively squash-merged. Only runs on remaining unmerged branches to keep it cheap.
3. **Stale rule**: any `unmerged` branch with `lastCommitDate < now-30d` becomes `stale`.

When changing merge-status logic, both passes need to stay consistent or branches will flicker between statuses across refreshes.

### Tauri bridge with browser fallback

`src/services/tauriBridge.ts` wraps `@tauri-apps/api/core`'s `invoke` so that when the frontend runs outside a Tauri window (dev preview, vitest), calls just throw `"Tauri runtime unavailable"` instead of crashing on a missing global. This is what lets unit tests in `src/services/*.test.ts` and `src/lib/*.test.ts` run without spinning up the backend — they just don't exercise the invoke path. If you see that error in dev, you're running plain `npm run dev` instead of `npm run tauri dev`.

### Persistence locations

- App config: `~/.config/worktreehq/config.toml` (TOML; fields: `github_token`, `github_token_explicitly_set`, `refresh_interval_ms`, `fetch_interval_ms`, `last_repo_path`). `GITHUB_TOKEN` env var is used as a fallback when `github_token` is empty AND `github_token_explicitly_set` is false. The flag flips to true the first time the user saves via `SettingsModal`, so an explicit clear is respected even when the env var is exported in the user's shell — without it the env would silently re-populate the token on every launch.
- Per-worktree notepads: `~/.config/worktreehq/notepads.json` (JSON map keyed by worktree path). Writes go through a single-process `Mutex` plus atomic rename via `.tmp` file in `src-tauri/src/commands/notepads.rs` because rapid keystroke saves can otherwise interleave a read-modify-write.

### Polling + filesystem watcher

The 15s polling loop is the source of truth for refreshes. The Rust `notify`-based watcher (`src-tauri/src/commands/watcher.rs`) is a complement — it emits a `worktree-changed` event the frontend can listen for to trigger an early refresh between ticks. Don't rely on the watcher alone; on macOS in particular `notify` events can be flaky for git's internal `.git/index` churn.

## Project layout (the parts that matter)

- `src/services/` — all the logic lives here. Start with `gitService.ts`, `squashDetector.ts`, `refreshLoop.ts`.
- `src/store/useRepoStore.ts` — single Zustand store; everything else subscribes.
- `src/types/index.ts` — the canonical TS types for `Worktree`, `Branch`, `PRInfo`, `SquashMapping`. Match these when adding fields.
- `src/components/{worktrees,branches,squash,graph}/` — view per tab. `App.tsx` switches between them.
- `src-tauri/src/commands/` — Rust command handlers, one file per concern. `lib.rs` registers them in `invoke_handler!`.
- `PLAN.md` — original design doc; still useful as the reference for the data model and the squash algorithm. Treat it as historical: anything that disagrees with the current code is out of date.

## Conventions worth knowing

- New git operations go in `gitService.ts`, not in new Rust commands.
- Use `tryRun()` (returns empty string on failure) vs `run()` (throws on **any** non-zero exit code, with stderr/stdout/exit code in the message) deliberately: most read paths use `tryRun` so a single failing repo command doesn't blank the whole UI; destructive ops (`deleteLocalBranch`, etc.) use `run` so failures surface.
- `listBranches` only considers `origin/*` remote refs. The rest of the app hard-codes `origin` for delete/push paths, so a non-origin remote ref isn't actionable; matching it as a branch would also collide on the stripped name across remotes. If you ever add multi-remote support, this filter is the place to start.
- The refresh loop does **not** clear `store.error` at the start of each tick — only after a successful pipeline. Errors set by user actions (`createWorktree`, `removeWorktree`, prune, etc.) need to survive across the next 15s poll. If you need to reset the error from a non-refresh code path, call `setError(null)` explicitly.
- When adding a Rust command, register it in **both** `src-tauri/src/commands/mod.rs` and the `invoke_handler![]` macro in `src-tauri/src/lib.rs`, and add a TS wrapper in `tauriBridge.ts` or the relevant service. Don't leave dead stub commands in `invoke_handler!` — they're load-bearing surface in the IPC schema and silently confuse callers.
- Lock guards on shared `Mutex` state (notepads, watcher) use `.unwrap_or_else(|p| p.into_inner())` so a poisoned mutex doesn't crash the app.
- The frontend tests mock at the service layer, not at `invoke`. Look at `src/services/squashDetector.test.ts` for the pattern.
- Tailwind theme uses custom tokens prefixed `wt-` (`wt-bg`, `wt-dirty`, etc.) defined in `tailwind.config.js`. Use those instead of raw color classes so the dark theme stays consistent.
- Destructive UI dialogs (`ConfirmDeleteDialog`, `RemoveWorktreeDialog`) follow a shared shape: Escape closes, backdrop click closes, focus lands on Cancel, anything irreversible (remote-touching delete, force-removing a dirty worktree) requires typed confirmation. New destructive flows should match.
