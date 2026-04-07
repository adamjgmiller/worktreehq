# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

The canopy repo root is mostly empty — all code lives in `worktreehq/`. **Run every npm/cargo command from `worktreehq/`, not the repo root.** The root `README.md` is a placeholder; the real one is `worktreehq/README.md` and the canonical design doc is `worktreehq/PLAN.md`.

## Common commands

All from `worktreehq/`:

```bash
npm install
npm run dev          # Vite only (browser stub for Tauri — most features won't work)
npm run tauri dev    # Full Tauri desktop app (the real dev loop)
npm test             # vitest run (one-shot)
npm run test:watch   # vitest watch
npm run build        # tsc --noEmit + vite build (type-check gate before bundling)

# Single test file or pattern
npx vitest run src/services/squashDetector.test.ts
npx vitest run -t "parsePrNumberFromSubject"

# Rust side
cd src-tauri && cargo check
cd src-tauri && cargo build
```

`npm run tauri dev` on Linux requires `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`.

The app expects to be launched **inside the git repo it should manage** (e.g. `cd ~/your-repo && /path/to/worktreehq`). The Rust `resolve_repo` command walks up from `cwd` looking for `.git`. Right now WorktreeHQ is most often run against canopy itself (real worktrees under `.claude/worktrees/`, real `origin` at `github.com/adamjgmiller/canopy`), so changes to `worktreehq/` are observable in the running app's own UI within one refresh tick — but it's designed to be pointed at any repo, so don't bake canopy-specific assumptions into parsing or filter logic.

## Architecture

WorktreeHQ is a Tauri v2 desktop dashboard for live git worktree state and branch hygiene, with first-class **squash-merge** detection. The big-picture shape:

### One Rust command, all git logic in TypeScript

The Rust backend (`src-tauri/src/`) is intentionally thin. The architectural keystone is **a single generic command** `git_exec(repo_path, args[]) -> {stdout, stderr, code}` in `src-tauri/src/commands/git_exec.rs`. All git operations — worktree enumeration, branch listing, ahead/behind, `cherry`, deletes — are composed in TypeScript on top of it via `src/services/gitService.ts`.

**Convention: do not add new Rust commands for git operations.** Add a function to `gitService.ts` that calls `gitExec(...)` instead. The Rust side only owns: `git_exec`, `resolve_repo`, `open_path`, `read_config`/`write_config`, and `start_watching`/`stop_watching` (notify-based file watcher that emits `worktree-changed` events to the webview).

The TS-to-Tauri boundary goes through `src/services/tauriBridge.ts`, which has a stub fallback so unit tests and `npm run dev` (browser-only) do not crash on missing Tauri internals.

### Refresh loop and state

`useRepoBootstrap` (`src/hooks/useRepoBootstrap.ts`) is the entry point: reads config, resolves repo path, seeds the Zustand store, starts the refresh loop. `src/services/refreshLoop.ts` does a parallel fan-out (`listWorktrees`, `listBranches`, `listMainCommits`, `listTags`, `getRemoteUrl`) every 5s (configurable), then runs `detectSquashMerges` over the result and writes the normalized state into `useRepoStore`. The notify file watcher is a complement, not a replacement — polling is still the primary refresh mechanism.

All UI state lives in **one Zustand store** (`src/store/useRepoStore.ts`). Components subscribe with selectors; nothing fetches directly.

### Squash-merge detection (the differentiating feature)

`src/services/squashDetector.ts` is the load-bearing logic. The algorithm — also documented in `PLAN.md` — has two stages:

1. **PR-tag lookup**: Walk first-parent commits on the default branch, regex `/\(#(\d+)\)\s*$/` on the subject, fetch each PR via Octokit (`githubService.ts`, in-memory TTL cache), and if `pr.merged && pr.merge_commit_sha === commit.sha` mark the matching local/remote branch as `squash-merged`. Also record a `SquashMapping { squashSha, prNumber, sourceBranch, archiveTag? }` for the Squash Archaeology view.
2. **Patch-id fallback**: For branches still `unmerged` after stage 1, run `git cherry <default> <branchRef>` — all `-` lines means patch-equivalent → `squash-merged`. Cheap because it only runs on the residual.

After both stages, the **stale rule** (`isStale`) downgrades any still-`unmerged` branch with no commits in 30+ days to `mergeStatus: 'stale'`.

When changing this file, the unit tests in `squashDetector.test.ts` and `filters.test.ts` are the regression net.

### Filter presets

`src/lib/filters.ts` defines the five branch filter presets shown in the Branches tab. The semantics are tighter than they look — e.g. `safe-to-delete` requires merged status **and** no active worktree path; `orphaned` requires `hasLocal && (upstreamGone || !hasRemote)`. Tests in `filters.test.ts` pin these.

### Frontend structure

- **Tabs**: `Worktrees | Branches | Squash Archaeology | Graph` — switched in `App.tsx`, components live under `src/components/{worktrees,branches,squash,graph,common}/`.
- **Styling**: Tailwind with a custom `wt.*` color palette in `tailwind.config.js` (`wt-clean`, `wt-dirty`, `wt-conflict`, `wt-info`, `wt-squash`). Status colors are centralized in `src/lib/colors.ts` — do not hard-code Tailwind color classes for status; use `worktreeStatusClass` / `mergeStatusClass`.
- **Bulk delete safety**: `ConfirmDeleteDialog` lists every ref by name and requires typing `delete` for selections of >5. Preserve this affordance — the whole point of the tool is *safe* cleanup.

### Config and auth

`~/.config/worktreehq/config.toml` (managed by `src-tauri/src/commands/config.rs`) stores `github_token`, `refresh_interval_ms`, and `last_repo_path`. The token also falls back to the `GITHUB_TOKEN` env var. Without a token, PR-based squash detection is disabled but the `git cherry` fallback still works — the app surfaces this with a banner in `App.tsx`.

## Out of scope (do not build unless asked)

`PLAN.md` and `README.md` explicitly exclude these from v1: commit/push/pull operations, diff viewer, Claude session management, multi-repo support, full settings UI, custom keybinds, archive-on-merge automation. If a request implies one of these, surface that it is out of scope before implementing.
