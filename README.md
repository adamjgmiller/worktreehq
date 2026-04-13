# WorktreeHQ

[![License: PolyForm Shield 1.0.0](https://img.shields.io/badge/License-PolyForm%20Shield%201.0.0-blue.svg)](https://polyformproject.org/licenses/shield/1.0.0/)
![macOS](https://img.shields.io/badge/macOS-supported-success)
![Linux](https://img.shields.io/badge/Linux-supported-success)
![Windows](https://img.shields.io/badge/Windows-experimental-yellow)

**A squash-merge-aware git worktree dashboard for developers running parallel AI coding sessions.**

> v0.x — early, actively developed. Currently builds from source; pre-built binaries are not yet provided.

<!-- 
  DEMO VIDEO — replace this placeholder after uploading your .mp4:
  1. Open any GitHub issue comment box on this repo
  2. Drag-and-drop your video file to upload it
  3. Copy the resulting https://github.com/user-attachments/assets/... URL
  4. Replace this entire comment block and the paragraph below with:
  
  <video src="YOUR_VIDEO_URL" width="100%" autoplay loop muted playsinline></video>

  For a non-GitHub fallback (npm, crates.io, etc.), wrap it in a link with a thumbnail:
  <a href="YOUR_VIDEO_URL">
    <img src="YOUR_THUMBNAIL_URL" alt="WorktreeHQ demo" width="100%">
  </a>
-->
<p align="center"><em>Demo video coming soon</em></p>

> **[See all screenshots &rarr;](./SCREENSHOTS.md)** — light and dark themes, tabs, bulk operations, and more.

## Why this exists

Two problems most git GUIs don't solve:

**1. Squash merges break branch hygiene.** After GitHub squash-merges a PR, the source branch's commits never appear on `main`, so `git branch --merged` returns nothing. Tools like GitKraken, Fork, and Tower treat the commit graph as the source of truth — but squash merging deliberately breaks that graph. The result: dead branches pile up forever and there's no safe way to bulk-clean them.

**2. Parallel AI coding sessions across worktrees have no unified view.** If you run multiple [Claude Code](https://claude.com/claude-code), Codex, or other agent sessions in parallel `git worktree`s, you have no single place to see what's committed, what's dirty, what's ahead/behind main, which sessions are alive, what each session is working on, or which branches are stale.

WorktreeHQ is a desktop dashboard for both. It detects squash-merged branches via the GitHub API plus a `git cherry` patch-id fallback, surfaces live worktree state across all your parallel sessions, gives you a per-worktree notepad to track what each session is doing, and lets you safely bulk-delete the dead branches that other tools think are still alive.

## What it does

### Worktrees tab

- Live cards per `git worktree`: branch, path, dirty/clean state (untracked, modified, staged, stashed), ahead/behind, last commit, conflict markers
- In-progress operation detection (rebase, merge, cherry-pick, revert, bisect)
- Composite "branch disposition" pill summarizing how each worktree's branch relates to `main`, with a one-click "pull main" affordance when behind
- **Per-worktree notepad** — a persistent scratchpad on every worktree card for capturing session context, TODOs, and decisions. Auto-saves as you type, survives app restarts, and auto-seeds with your Claude Code first prompt so you can see at a glance what each worktree was opened to do. Notes from deleted worktrees are preserved in the Archive tab so context is never lost.
- **Claude session awareness** — detects whether the worktree currently has a live, idle, recent, or dormant `claude` process bound to it, and warns when multiple Claude sessions are writing to the same worktree at once (macOS + Linux; Windows degrades gracefully — see [Limitations](#status--limitations))
- Create new worktrees and safely remove existing ones, with typed-confirmation safety on dirty removals and orphaned-worktree detection
- Manual fetch + refresh, and keyboard zoom (Cmd/Ctrl +/−/0) with persistent zoom level

### Branches tab

- All local + remote branches in one sortable, filterable list
- **Squash-merge detection** — parses `(#N)` PR refs in main commit subjects, queries GitHub via Octokit, and marks the source branch as `merged (squash)` even though `git branch --merged` doesn't think so
- **Patch-equivalent fallback** — `git cherry main <branch>` catches squash-merged branches that lack a PR-tagged commit
- Filter presets: *all*, *mine*, *safe to delete*, *stale*, *active*, *orphaned*
- Bulk delete (local, remote, or both) with a confirmation dialog that lists the exact refs to be removed and a typed `delete` gate for selections of more than 5 branches

### Squash Archaeology tab

- For any squash commit on `main`: see the PR number, source branch, and the original commit history of the now-deleted branch (via `archive/<branch>` tags if you've adopted that convention)
- Solves the "I squash-merged this two months ago and want to see what was actually in it" problem

### Archive tab

- Surfaces notepad entries from worktrees that have been removed — so notes, TODOs, and session context survive even after `git worktree remove`
- Copy or delete archived notes; keeps your notepad history tidy without losing anything by accident

### Graph tab

- SVG-rendered first-parent timeline of `main` with fork markers colored by branch merge status

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

> **macOS note:** The build output is unsigned. macOS Gatekeeper will block the first launch — right-click the app and choose **Open** to bypass it.

### First run

1. Launch the app inside any git repository, or click the folder icon in the top bar to pick one. Recently-used repos are remembered in a dropdown.
2. (Optional but recommended) Set up GitHub auth in **Settings** to enable squash-merge detection and PR enrichment. Two options:
   - **GitHub CLI** (recommended) — install [`gh`](https://cli.github.com/), run `gh auth login`, and the app auto-detects it. No token stored by this app.
   - **Personal access token** — fine-grained PAT with Pull requests (read) scope. Stored in your OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service), not on disk.

## Architecture

WorktreeHQ is intentionally thin on the Rust side: a single Tauri command shells out to the system `git` binary, and every git operation in the app is a TypeScript function built on top of it. The Rust side handles only what shell-git can't: filesystem watching (`notify`), config and notepad persistence, Claude IDE state polling, and the on-disk PR cache.

Frontend stack: React 18 + TypeScript + Tailwind + Vite + Zustand + Octokit. Backend: Tauri v2 (Rust). A polling refresh loop is the source of truth for worktree state, with a `notify`-based file watcher as an early-refresh signal between ticks.

For full architecture details, the squash-detection algorithm, persistence locations, and conventions for adding new git operations, see [`CLAUDE.md`](./CLAUDE.md).

## Status & limitations

This project is **v0.x** — actively developed, breaking changes possible. Known limitations:

- **Build from source only.** No pre-built installers yet.
- **One repo at a time.** Multi-repo support is not in scope; the recent-repos dropdown lets you switch between recently-used repos quickly instead.
- **Read-only except for branch deletion and worktree create/remove.** No commit, push, pull (other than the explicit "pull main" action), diff viewer, or merge-conflict tooling. WorktreeHQ is designed to *complement* your existing git workflow, not replace it.
- **Claude session detection is macOS + Linux only.** On Windows, the "idle vs. closed" distinction degrades gracefully — the rest of the Claude awareness features still work. PRs to add a Windows scanner welcome.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the dev loop, conventions, and how to file issues. Contributors should also read [`CLAUDE.md`](./CLAUDE.md) for the load-bearing architecture decisions before adding new features.

All contributions require signing a one-time [Contributor License Agreement](./CLA.md) — a bot will prompt you on your first pull request.

Security issues: please use the private reporting process in [`SECURITY.md`](./SECURITY.md), not the public issue tracker.

## License

This project is licensed under the [PolyForm Shield License 1.0.0](https://polyformproject.org/licenses/shield/1.0.0/).

**What this means in practice:**

- You can use this software for any purpose — personal, internal, commercial — as long as you're not competing with this project or products offered using it.
- You can modify the code and distribute your modifications.
- You can use it inside your company, in your product, for your clients.
- You cannot take this software (or a fork of it) and offer it as a competing product or service.

For the vast majority of users, this license works exactly like a permissive open source license. The only restriction is on direct competition.

If you have questions about whether your use case is permitted, [open an issue](https://github.com/adamjgmiller/worktreehq/issues) and ask.
