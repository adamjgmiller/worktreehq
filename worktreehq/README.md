# WorktreeHQ

A lightweight Tauri v2 desktop dashboard for real-time git worktree and branch hygiene — with first-class understanding of **squash-merged** PRs.

## Features (MVP)

- **Worktree cards** — live-refreshing cards per `git worktree` showing branch, path, uncommitted/staged counts, ahead/behind, last commit. Color-coded: green (clean), yellow (dirty), red (conflict), blue (diverged).
- **Branch audit** — all local + remote branches in one sortable/filterable list. Filter presets: _safe to delete_, _stale_, _active_, _orphaned_. Bulk delete with a confirmation dialog listing exactly which refs will be removed (requires typing `delete` for bulk >5).
- **Squash-merge detection** — parses `(#N)` PR references on `main`, queries GitHub API, marks matching branches as `squash-merged` (not `unmerged`). Falls back to `git cherry` patch-id matching for PRs without references.
- **Squash archaeology** — click any commit on `main` to see `squash sha → PR #N → source branch → original commits` (via `archive/<branch>` tags if present).
- **Simplified graph** — SVG-rendered first-parent timeline of `main` with colored fork markers by merge status.
- Dark theme, large readable cards, monospace for refs/paths, accessible icons alongside colors.

## Architecture

- **Frontend**: React 18 + TypeScript + Tailwind + Vite + Zustand + Framer Motion + Octokit.
- **Backend**: Tauri v2 (Rust). A single generic `git_exec(repo_path, args[])` command shells out to `git`; all git logic is in TypeScript on top of it. `notify` crate watches worktree paths for live change events. Config in `~/.config/worktreehq/config.toml`.

See [`PLAN.md`](./PLAN.md) for full architecture, data model, component breakdown, and squash detection algorithm.

## Dev

```bash
npm install
npm run dev          # vite only
npm run tauri dev    # full Tauri app (requires Linux: libwebkit2gtk-4.1-dev, libgtk-3-dev, libayatana-appindicator3-dev, librsvg2-dev)
npm test             # vitest
npm run build        # tsc + vite build
```

### First run

1. Launch inside a git repo (`cd ~/your-repo && /path/to/worktreehq`) or pass `--` args.
2. If no `GITHUB_TOKEN` env var or `~/.config/worktreehq/config.toml` is found, the settings modal will prompt for a GitHub token (needed for PR lookup).

## Validation / manual QA

See the **Testing Plan** section of [`PLAN.md`](./PLAN.md) for the full checklist. Summary:

1. `cd ~/gov-portal && npm run tauri dev` from the worktreehq dir — window opens, 3 worktree cards render.
2. `touch ~/gov-portal-wt2/foo.txt` → within 5s card flips green → yellow, `uncommitted=1`.
3. `git -C ~/gov-portal-wt2 add foo.txt` → `staged=1`.
4. Branches tab → previously squash-merged branches show `merged (squash)` pill with PR link.
5. Filter "safe to delete" → select all → `Delete local` → confirmation lists exact refs → confirm → they disappear.
6. Squash tab → click a recent squash commit → detail shows PR #, source branch, archive status.
7. Graph tab → colored fork markers per merge status.

## Not in v1

No commit/push/pull, no diff viewer, no Claude session management, no multi-repo, no full settings UI.
