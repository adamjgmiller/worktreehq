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

**Implication for new work:** when adding a new git operation, add a TS function in `gitService.ts`. Do **not** add a new `#[tauri::command]` for it. The only Rust commands that exist are for things git can't do: filesystem watching (`watcher.rs`), config persistence (`config.rs`), repo root resolution (`repo.rs`), and notepads (`notepads.rs`).

### Frontend data flow

```
useRepoBootstrap (hook)
  → invoke('read_config')           # token + last_repo_path + refresh interval
  → invoke('resolve_repo')          # finds .git root walking up from cwd
  → getDefaultBranch (gitService)
  → setRepo() in zustand store
  → startRefreshLoop()              # polling tick, default 5s

refreshLoop.refreshOnce()  (src/services/refreshLoop.ts)
  ├── listWorktrees()       ─┐
  ├── listBranches()         │ all in parallel via Promise.all
  ├── listMainCommits()      │
  ├── listTags()             │
  └── getRemoteUrl()        ─┘
  → listOpenPRsForBranches() (Octokit)
  → detectSquashMerges()    # the squash-detection algorithm
  → store setters → React re-renders
```

State lives in a single Zustand store (`src/store/useRepoStore.ts`). React components subscribe via selectors. There is no router; tabs are local component state in `App.tsx`.

### Squash-merge detection (the core domain logic)

`src/services/squashDetector.ts` is the brain of the app. The algorithm has two passes:

1. **PR-tag pass**: walk first-parent commits on `main`, regex `/(#\d+)$/` on each subject to extract a PR number, fetch the PR via Octokit (cached 5 min in-memory in `githubService.ts`), and if `pr.merge_commit_sha === commit.sha` mark `pr.head.ref` as `squash-merged`. Also creates a `SquashMapping` so the Squash Archaeology view can render `squash sha → PR # → source branch → original commits` (the original commits come from optional `archive/<branch>` tags).
2. **Cherry fallback pass**: for branches still `unmerged` after pass 1, run `git cherry main <branch>` — if every line starts with `-`, every commit on the branch is patch-equivalent to something on main, so it's effectively squash-merged. Only runs on remaining unmerged branches to keep it cheap.
3. **Stale rule**: any `unmerged` branch with `lastCommitDate < now-30d` becomes `stale`.

When changing merge-status logic, both passes need to stay consistent or branches will flicker between statuses across refreshes.

### Tauri bridge with browser fallback

`src/services/tauriBridge.ts` wraps `@tauri-apps/api/core`'s `invoke` so that when the frontend runs outside a Tauri window (dev preview, vitest), calls just throw `"Tauri runtime unavailable"` instead of crashing on a missing global. This is what lets unit tests in `src/services/*.test.ts` and `src/lib/*.test.ts` run without spinning up the backend — they just don't exercise the invoke path. If you see that error in dev, you're running plain `npm run dev` instead of `npm run tauri dev`.

### Persistence locations

- App config: `~/.config/worktreehq/config.toml` (TOML; fields: `github_token`, `refresh_interval_ms`, `last_repo_path`). `GITHUB_TOKEN` env var is used as fallback when the file is empty.
- Per-worktree notepads: `~/.config/worktreehq/notepads.json` (JSON map keyed by worktree path). Writes go through a single-process `Mutex` plus atomic rename via `.tmp` file in `src-tauri/src/commands/notepads.rs` because rapid keystroke saves can otherwise interleave a read-modify-write.

### Polling + filesystem watcher

The 5s polling loop is the source of truth for refreshes. The Rust `notify`-based watcher (`src-tauri/src/commands/watcher.rs`) is a complement — it emits a `worktree-changed` event the frontend can listen for to trigger an early refresh between ticks. Don't rely on the watcher alone; on macOS in particular `notify` events can be flaky for git's internal `.git/index` churn.

## Project layout (the parts that matter)

- `src/services/` — all the logic lives here. Start with `gitService.ts`, `squashDetector.ts`, `refreshLoop.ts`.
- `src/store/useRepoStore.ts` — single Zustand store; everything else subscribes.
- `src/types/index.ts` — the canonical TS types for `Worktree`, `Branch`, `PRInfo`, `SquashMapping`. Match these when adding fields.
- `src/components/{worktrees,branches,squash,graph}/` — view per tab. `App.tsx` switches between them.
- `src-tauri/src/commands/` — Rust command handlers, one file per concern. `lib.rs` registers them in `invoke_handler!`.
- `PLAN.md` — original design doc; still useful as the reference for the data model and the squash algorithm. Treat it as historical: anything that disagrees with the current code is out of date.

## Conventions worth knowing

- New git operations go in `gitService.ts`, not in new Rust commands.
- Use `tryRun()` (returns empty string on failure) vs `run()` (throws) deliberately: most read paths use `tryRun` so a single failing repo command doesn't blank the whole UI; destructive ops (`deleteLocalBranch`, etc.) use `run` so failures surface.
- When adding a Rust command, register it in **both** `src-tauri/src/commands/mod.rs` and the `invoke_handler![]` macro in `src-tauri/src/lib.rs`, and add a TS wrapper in `tauriBridge.ts` or the relevant service.
- The frontend tests mock at the service layer, not at `invoke`. Look at `src/services/squashDetector.test.ts` for the pattern.
- Tailwind theme uses custom tokens prefixed `wt-` (`wt-bg`, `wt-dirty`, etc.) defined in `tailwind.config.js`. Use those instead of raw color classes so the dark theme stays consistent.
