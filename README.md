# WorktreeHQ

**A squash-merge-aware git worktree dashboard for developers running parallel AI coding sessions.**

> v0.x — early, actively developed. Currently builds from source; pre-built binaries are not yet provided.

<!-- TODO: drop a hero screenshot here once one exists -->

## Why this exists

Two problems most git GUIs don't solve:

**1. Squash merges break branch hygiene.** After GitHub squash-merges a PR, the source branch's commits never appear on `main`, so `git branch --merged` returns nothing. Tools like GitKraken, Fork, and Tower treat the commit graph as the source of truth — but squash merging deliberately breaks that graph. The result: dead branches pile up forever and there's no safe way to bulk-clean them.

**2. Parallel AI coding sessions across worktrees have no unified view.** If you run 2–8 [Claude Code](https://claude.com/claude-code), Codex, or other agent sessions in parallel `git worktree`s, you have no single place to see what's committed, what's dirty, what's ahead/behind main, which sessions are alive, or which branches are stale.

WorktreeHQ is a desktop dashboard for both. It detects squash-merged branches via the GitHub API plus a `git cherry` patch-id fallback, surfaces live worktree state across all your parallel sessions, and lets you safely bulk-delete the dead branches that other tools think are still alive.

## What it does

### Worktrees tab

- Live cards per `git worktree`: branch, path, dirty/clean state (untracked, modified, staged, stashed), ahead/behind, last commit, conflict markers
- In-progress operation detection (rebase, merge, cherry-pick, revert, bisect)
- Composite "branch disposition" pill summarizing how each worktree's branch relates to `main`, with a one-click "pull main" affordance when behind
- Per-worktree notepad for capturing session context and TODOs
- **Claude session awareness** — detects whether the worktree currently has a live, idle, recent, or dormant `claude` process bound to it, and warns when multiple Claude sessions are writing to the same worktree at once (macOS + Linux; Windows degrades gracefully — see [Limitations](#status--limitations))
- Create new worktrees and safely remove existing ones, with typed-confirmation safety on dirty removals and orphaned-worktree detection

### Branches tab

- All local + remote branches in one sortable, filterable list
- **Squash-merge detection** — parses `(#N)` PR refs in main commit subjects, queries GitHub via Octokit, and marks the source branch as `merged (squash)` even though `git branch --merged` doesn't think so
- **Patch-equivalent fallback** — `git cherry main <branch>` catches squash-merged branches that lack a PR-tagged commit
- Filter presets: *safe to delete*, *stale*, *active*, *orphaned*
- Bulk delete (local, remote, or both) with a confirmation dialog that lists the exact refs to be removed and a typed `delete` gate for selections of more than 5 branches

### Squash Archaeology tab

- For any squash commit on `main`: see the PR number, source branch, and the original commit history of the now-deleted branch (via `archive/<branch>` tags if you've adopted that convention)
- Solves the "I squash-merged this two months ago and want to see what was actually in it" problem

### Graph tab

- SVG-rendered first-parent timeline of `main` with fork markers colored by branch merge status

## Screenshots

<!-- TODO: drop screenshots into docs/screenshots/ and reference them here -->

*Screenshots coming soon.*

## Install

WorktreeHQ is a [Tauri v2](https://tauri.app) desktop app. Pre-built binaries are not yet provided — for now, you build from source.

### Prerequisites

- **Node.js** 20+ and npm
- **Rust** toolchain ([rustup](https://rustup.rs/), latest stable)
- Tauri's per-platform dependencies:
  - **macOS** — Xcode Command Line Tools (`xcode-select --install`)
  - **Linux** — `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`
  - **Windows** — WebView2 Runtime (preinstalled on Windows 11) and Microsoft C++ Build Tools

See [Tauri's prerequisites page](https://v2.tauri.app/start/prerequisites/) for the canonical, up-to-date list.

### Build & run

```bash
git clone https://github.com/adamjgmiller/worktreehq.git
cd worktreehq
npm install
npm run tauri dev      # development build with hot reload
npm run tauri build    # produces a platform installer in src-tauri/target/release/bundle/
```

### First run

1. Launch the app inside any git repository, or click the folder icon in the top bar to pick one. Recently-used repos are remembered in a dropdown.
2. (Optional but recommended) Add a GitHub Personal Access Token in **Settings** to enable squash-merge detection and PR enrichment.
   - **Scopes needed**: `public_repo` for open-source repos, or `repo` for private repositories
   - The token is stored locally in `~/.config/worktreehq/config.toml` and is only sent to `api.github.com`
   - You can also set `GITHUB_TOKEN` as an environment variable; the app will use it as a fallback if no token is configured in Settings

## Architecture

WorktreeHQ is intentionally thin on the Rust side: a single Tauri command shells out to the system `git` binary, and every git operation in the app is a TypeScript function built on top of it. The Rust side handles only what shell-git can't: filesystem watching (`notify`), config and notepad persistence, Claude IDE state polling, and the on-disk PR cache.

Frontend stack: React 18 + TypeScript + Tailwind + Vite + Zustand + Octokit. Backend: Tauri v2 (Rust). A polling refresh loop is the source of truth for worktree state, with a `notify`-based file watcher as an early-refresh signal between ticks.

For full architecture details, the squash-detection algorithm, persistence locations, and conventions for adding new git operations, see [`CLAUDE.md`](./CLAUDE.md).

## Status & limitations

This project is **v0.x** — actively developed, breaking changes possible. Known limitations:

- **Build from source only.** No pre-built installers yet. macOS Gatekeeper will require you to right-click → Open the first launch of any locally-built binary (the bundles are unsigned).
- **One repo at a time.** Multi-repo support is not in scope; the recent-repos dropdown lets you switch between recently-used repos quickly instead.
- **Read-only except for branch deletion and worktree create/remove.** No commit, push, pull (other than the explicit "pull main" action), diff viewer, or merge-conflict tooling. WorktreeHQ is designed to *complement* your existing git workflow, not replace it.
- **Claude session detection is macOS + Linux only.** On Windows, the "idle vs. closed" distinction degrades gracefully — the rest of the Claude awareness features still work. PRs to add a Windows scanner welcome.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the dev loop, conventions, and how to file issues. Contributors should also read [`CLAUDE.md`](./CLAUDE.md) for the load-bearing architecture decisions before adding new features.

Security issues: please use the private reporting process in [`SECURITY.md`](./SECURITY.md), not the public issue tracker.

## License

[MIT](./LICENSE) © 2026 Adam Miller
