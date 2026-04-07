# WorktreeHQ — Implementation Plan

## Context
Solo dev working across 2–8 git worktrees on `gov-portal` needs a real-time dashboard for worktree state and branch hygiene. Existing GUIs don't understand squash-merges, so merged branches look "unmerged" and pile up. Goal: a lightweight Tauri v2 desktop app that (1) shows live worktree cards, (2) audits all branches with squash-merge awareness, (3) lets the user safely bulk-delete dead branches, and (4) traces squash commits on `main` back to their original PRs/branches. Repo lives at `/home/user/canopy` (currently empty besides README); MVP will be built in one shot on branch `claude/plan-workflow-management-tHdbu`, then validated against `~/gov-portal`.

## Approach
Single-shot build: scaffold Tauri v2 + React/TS/Tailwind, implement all MVP features end-to-end, write a `PLAN.md` at the project root mirroring this plan, then run `npm run tauri build`-style checks and report back only when complete. No mid-build check-ins (per user instruction overriding the original "wait for PLAN.md approval" line).

## Architecture

**Backend (Rust / Tauri commands)** — thin layer; most git work happens in TS via `simple-git` for prototype speed. Rust provides:
- `get_repo_path()` — resolves CLI arg or cwd, validates `.git`.
- `read_config()` / `write_config()` — `~/.config/worktreehq/config.toml` (GitHub token).
- `open_path(path)` — OS reveal helper.
- File watcher command (`notify` crate) emitting `worktree-changed` events to the webview as a fallback/complement to polling.

**Frontend (React + TS + Tailwind + Vite)** uses `simple-git` and `@octokit/rest` directly from the renderer (Tauri allows Node-style deps via the sidecar shell-less approach: we run `simple-git` against the local FS through Tauri's `fs` + `shell` allowlist; if `simple-git` can't run in the webview, fall back to a tiny Rust `run_git(args)` command that shells out to `git` and returns stdout — implement this from the start to avoid rework).

**Decision:** ship a single Rust command `git_exec(repo_path, args[])` returning `{stdout, stderr, code}`. All TS git logic builds on it. This is simpler than wiring `simple-git` through Tauri and keeps the door open for native Rust `git2` later.

**Data flow:**
1. App launch → Rust resolves repo path → emits `repo-ready`.
2. TS `GitService` issues `git_exec` calls to enumerate worktrees, branches, commits.
3. TS `GitHubService` (Octokit) fetches PR data for branches with remotes.
4. `SquashDetector` joins (1)+(3) to compute merge status.
5. Zustand store holds normalized state; React components subscribe.
6. Polling loop (5s default) + Rust file-watcher events trigger refresh.

## Data Model (TypeScript)

```ts
type MergeStatus = 'merged-normally' | 'squash-merged' | 'unmerged' | 'stale';

interface Worktree {
  path: string;
  branch: string;
  isPrimary: boolean;
  head: string;            // commit sha
  uncommittedCount: number;
  stagedCount: number;
  ahead: number;
  behind: number;
  hasConflicts: boolean;
  lastCommit: { sha: string; message: string; date: string; author: string };
  status: 'clean' | 'dirty' | 'conflict' | 'diverged';
}

interface Branch {
  name: string;
  hasLocal: boolean;
  hasRemote: boolean;
  lastCommitDate: string;
  lastCommitSha: string;
  aheadOfMain: number;
  behindMain: number;
  mergeStatus: MergeStatus;
  pr?: PRInfo;
  worktreePath?: string;
  upstreamGone?: boolean;  // remote deleted
}

interface PRInfo {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  mergedAt?: string;
  mergeCommitSha?: string;
  headRef: string;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
  url: string;
}

interface SquashMapping {
  squashCommitSha: string;       // commit on main
  prNumber: number;
  sourceBranch: string;
  archiveTag?: string;            // archive/<branch> if exists
  originalCommits?: string[];     // if branch/tag still resolvable
}

interface SessionStatus { worktreePath: string; active: boolean; lastSeen?: string } // stub for future
```

## Squash-Merge Detection Algorithm

1. `git log main --first-parent --format='%H%x09%s%x09%cI'` → list of main commits.
2. For each, regex `/\(#(\d+)\)\s*$/` on subject → candidate PR number.
3. Batch fetch via Octokit `GET /repos/{o}/{r}/pulls/{n}` (cached on disk in `~/.cache/worktreehq/prs.json`, keyed by sha).
4. If PR `merged === true` and `merge_commit_sha === sha`, record `SquashMapping{ squashSha, prNumber, sourceBranch: pr.head.ref }`.
5. Mark any local/remote branch matching `sourceBranch` as `squash-merged`.
6. Look for tag `archive/<sourceBranch>` → attach `archiveTag` and resolve `git log archive/<branch> ^main` for original commits.
7. **Fallback (no `(#N)` in subject):** `git cherry main <branch>` — all `-` lines means patch-equivalent → `squash-merged`. Run only for branches still `unmerged` after step 5 to keep it cheap.
8. **Stale rule:** `unmerged` AND `lastCommitDate < now-30d` AND no open PR → `stale`.

## Component Breakdown (React)

- `App.tsx` — root, repo bootstrap, routing between tabs.
- `RepoBar.tsx` — shows repo path, refresh button, settings gear, GitHub token status.
- `Tabs.tsx` — `Worktrees | Branches | Squash Archaeology | Graph`.
- `WorktreesView.tsx` — grid of `WorktreeCard`.
- `WorktreeCard.tsx` props: `Worktree` — colored border, branch (mono), path, counts, ahead/behind chips, last commit, status icon. Animate bg on change via Framer Motion.
- `BranchesView.tsx` — toolbar (filter presets, search, sort) + `BranchTable`.
- `BranchTable.tsx` props: `branches`, `onSelect`, `selection`. Virtualized if >200.
- `BranchRow.tsx` — name, badges (local/remote/worktree), PR pill, merge status pill, dates.
- `BulkActionBar.tsx` — appears when selection > 0; Delete Local / Delete Remote / Delete Both buttons.
- `ConfirmDeleteDialog.tsx` — lists exactly which refs will be removed; requires typed "delete" to confirm bulk >5.
- `SquashView.tsx` — list of main commits with `(#N)` markers; click → `SquashDetail`.
- `SquashDetail.tsx` — shows `squash sha → PR #N → branch X (deleted?) → N original commits` with Octokit data.
- `GraphView.tsx` — uses `@gitgraph/react` (or simple SVG) to render `main` linear with fork markers colored by branch status.
- `EmptyState.tsx`, `ErrorBanner.tsx`, `LoadingSpinner.tsx`, `Toast.tsx`.
- `SettingsModal.tsx` (token entry on first run only — no full settings UI per scope).

State: `useRepoStore` (Zustand) — `{ repo, worktrees, branches, squashMappings, prs, loading, error, lastRefresh }`.

## File Structure

```
worktreehq/
├── PLAN.md
├── README.md
├── package.json
├── vite.config.ts
├── tailwind.config.js
├── tsconfig.json
├── index.html
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── store/useRepoStore.ts
│   ├── services/
│   │   ├── gitService.ts          # wraps invoke('git_exec')
│   │   ├── githubService.ts       # Octokit + disk cache
│   │   ├── squashDetector.ts
│   │   └── refreshLoop.ts
│   ├── types/index.ts
│   ├── components/
│   │   ├── RepoBar.tsx
│   │   ├── Tabs.tsx
│   │   ├── worktrees/{WorktreesView,WorktreeCard}.tsx
│   │   ├── branches/{BranchesView,BranchTable,BranchRow,BulkActionBar,ConfirmDeleteDialog,FilterBar}.tsx
│   │   ├── squash/{SquashView,SquashDetail}.tsx
│   │   ├── graph/GraphView.tsx
│   │   └── common/{EmptyState,ErrorBanner,LoadingSpinner,Toast,SettingsModal}.tsx
│   ├── hooks/{useInterval.ts,useRepoBootstrap.ts}
│   ├── lib/{format.ts,filters.ts,colors.ts}
│   └── styles/globals.css
└── src-tauri/
    ├── tauri.conf.json
    ├── Cargo.toml
    └── src/
        ├── main.rs
        ├── commands/
        │   ├── mod.rs
        │   ├── git_exec.rs
        │   ├── repo.rs
        │   ├── config.rs
        │   └── watcher.rs
        └── error.rs
```

## Critical Files / Reused Pieces
- All new code; no existing utilities to reuse (canopy repo is empty).
- External libs: `@tauri-apps/api`, `@octokit/rest`, `zustand`, `framer-motion`, `@gitgraph/react`, `date-fns`, `clsx`, `lucide-react`, `tailwindcss`. Rust: `tauri`, `serde`, `notify`, `toml`, `dirs`.

## MVP vs Future
**MVP (build now):** worktree cards w/ live polling + watcher, branch audit w/ squash detection + filters + bulk delete, squash archaeology view, simplified graph, dark theme, token config, error/empty/loading states.
**Future (do not build):** Claude session detection, multi-repo, commit/push/pull, diff viewer, settings UI, custom keybinds, archive-on-merge automation.

## Testing Plan

**Unit (Vitest):**
- `squashDetector.test.ts` — fixtures: PR-tagged subject, no-tag patch-id match, unmerged, stale.
- `filters.test.ts` — each preset against synthetic Branch[].
- `format.test.ts` — relative dates, ahead/behind formatting.

**Integration:** mock `git_exec` and Octokit; assert store transitions for refresh cycle.

**Manual QA against `~/gov-portal`:**
1. `cd ~/gov-portal && /path/to/worktreehq` → window opens, worktree cards render for all 3 worktrees.
2. `touch ~/gov-portal-wt2/foo.txt` → within 5s the matching card flips green→yellow with uncommittedCount=1.
3. `git -C ~/gov-portal-wt2 add foo.txt` → stagedCount increments.
4. Branches tab → confirm previously squash-merged branches show `merged (squash)` pill with PR number link.
5. Apply "safe to delete" filter → select all → delete local → confirm dialog lists exact refs → confirm → branches disappear, no errors.
6. Delete a remote branch via GitHub UI, refresh → local shows `upstreamGone` badge and appears in "orphaned" filter.
7. Squash tab → click a recent squash commit → detail shows PR #, original branch, original commits (if archive tag exists; otherwise "branch deleted, 0 commits resolvable").
8. Graph tab → main shows forks colored by status; squash-merged forks rendered distinct from active.
9. Remove `GITHUB_TOKEN` and config → relaunch → SettingsModal prompts; entering token persists to `~/.config/worktreehq/config.toml`.
10. Point at non-git dir → ErrorBanner: "Not a git repository".

**Build verification:** `npm run build` (Vite) and `cargo check` in `src-tauri` must both pass before reporting done. `npm run tauri dev` smoke test against canopy itself (will show 0 worktrees, 1 branch — validates no crashes on minimal repo).

## Execution Order (single shot, no mid-stream check-ins)
1. Scaffold Tauri v2 React/TS template into `worktreehq/` inside canopy repo.
2. Add deps, Tailwind config, dark theme base, types, store skeleton.
3. Implement `git_exec` Rust command + `gitService.ts`; render worktree cards (static-from-git first, then polling, then notify watcher).
4. Branches enumeration + ahead/behind via `git_exec`.
5. Octokit integration + PR cache + token config flow.
6. SquashDetector + merge status pills.
7. Filters, selection, bulk delete with confirm dialog.
8. SquashView + SquashDetail.
9. GraphView via `@gitgraph/react`.
10. Polish: empty/error/loading states, animations, accessible icons (lucide) alongside colors.
11. Vitest suite + cargo check + vite build.
12. Write `worktreehq/PLAN.md` mirroring this plan, commit on `claude/plan-workflow-management-tHdbu`, push.
13. Report back with manual QA checklist and the validation commands.
