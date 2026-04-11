import { create } from 'zustand';
import type {
  Worktree,
  Branch,
  SquashMapping,
  MainCommit,
  RepoState,
  ClaudePresence,
  WorktreePairOverlap,
  WorktreeConflictSummary,
  WorktreeSortMode,
} from '../types';
import { initialThemePreference, type ThemePreference } from '../hooks/useTheme';

// GitHub token auth state. Distinguishes "no token configured" from "token
// configured but rejected by GitHub" so the UI can surface an expired/revoked
// PAT as loudly as a missing one — previously both showed as green "auth" if
// the string was non-empty, and a stale token silently stopped enriching PR
// data with no visible explanation. 'checking' is the transient bootstrap
// state before validateToken() resolves; displayed as the 'missing' yellow
// pill color to avoid a fourth visible state.
export type GithubAuthStatus = 'missing' | 'checking' | 'valid' | 'invalid';

// Zoom is clamped to [ZOOM_MIN, ZOOM_MAX] in the setter. Range matches the
// Rust-side clamp in src-tauri/src/commands/config.rs and is intentionally
// wider than the keyboard step (0.10) so the user can land on common stops
// (75%, 100%, 125%, 150%) cleanly.
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.0;
export const ZOOM_STEP = 0.1;
export const ZOOM_DEFAULT = 1.0;

interface StoreState {
  repo: RepoState | null;
  worktrees: Worktree[];
  branches: Branch[];
  mainCommits: MainCommit[];
  mainCommitsTotal: number;
  squashMappings: SquashMapping[];
  claudePresence: Map<string, ClaudePresence>;
  crossWorktreeConflicts: WorktreePairOverlap[];
  conflictSummaryByPath: Map<string, WorktreeConflictSummary>;
  loading: boolean;
  // `loading` flips on every poll tick; `userRefreshing` only flips when the
  // user explicitly asked for a refresh (button click, post-mutation). The
  // RepoBar spinner binds to this so it doesn't animate on the heartbeat.
  userRefreshing: boolean;
  fetching: boolean;
  // Last background fetch error message. Null when fetches are healthy.
  // Unlike `error` (which is the full-width ErrorBanner for user-initiated
  // failures), this surfaces as a subtle inline indicator in RepoBar so
  // silent background failures (e.g. expired SSH key) don't go unnoticed.
  lastFetchError: string | null;
  error: string | null;
  lastRefresh: number;
  githubAuthStatus: GithubAuthStatus;
  // The repo path the current `worktrees`/`branches`/`mainCommits`/`squashMappings`
  // collections correspond to. Set inside `runRefreshOnce` only on success.
  // App.tsx gates the content region on `dataRepoPath === repo.path` so:
  //   - first launch: stays null until the first refresh lands → shimmer
  //   - repo switch:  cleared to null in loadRepoAtPath → shimmer until the
  //     new refresh lands → no flash of the previous repo's cards
  //   - failed first refresh: stays null → shimmer persists with the error
  //     banner above instead of lying about the repo's contents
  // Doubles as the gate for the "no GitHub token" banner: that warning only
  // shows once dataRepoPath matches repo.path, so it never pops above the
  // shimmer during the loading window.
  dataRepoPath: string | null;
  refreshIntervalMs: number;
  fetchIntervalMs: number;
  zoomLevel: number;
  // MRU list of repo paths the user has opened, most-recent first. Mirrors
  // the persisted `recent_repo_paths` field in config.toml. Lives in the
  // store (rather than being read from config on each dropdown open) so the
  // RecentReposMenu re-renders instantly after a switch — otherwise the
  // user would see a one-tick flash of stale ordering.
  recentRepoPaths: string[];
  worktreeOrder: string[];
  // How the Worktrees tab sorts its cards. 'recent' is the first-run default
  // (most recently touched first, primary pinned to top). Switches to 'manual'
  // automatically when the user drags a card, so the drag gesture "just works"
  // without requiring them to pre-select Manual mode. Persisted per-repo.
  worktreeSortMode: WorktreeSortMode;
  // User's theme choice. "dark" is the first-run default (the app's
  // established visual identity); "system" is an opt-in that follows
  // the OS `prefers-color-scheme`. See useTheme.ts for the resolution
  // and DOM-application logic. Persisted to config.toml via
  // persistThemePreference. FOUC is prevented by `bootstrapThemeSync()`
  // in main.tsx, which applies the last-seen theme class from
  // localStorage synchronously before React mounts; the bootstrap hook
  // later reconciles this store field against the persisted
  // config.toml value.
  themePreference: ThemePreference;

  setRepo: (r: RepoState) => void;
  setWorktrees: (w: Worktree[]) => void;
  setBranches: (b: Branch[]) => void;
  setMainCommits: (c: MainCommit[], total?: number) => void;
  setSquashMappings: (s: SquashMapping[]) => void;
  setClaudePresence: (p: Map<string, ClaudePresence>) => void;
  setCrossWorktreeConflicts: (pairs: WorktreePairOverlap[], summary: Map<string, WorktreeConflictSummary>) => void;
  setLoading: (v: boolean) => void;
  setUserRefreshing: (v: boolean) => void;
  setFetching: (v: boolean) => void;
  setLastFetchError: (e: string | null) => void;
  setError: (e: string | null) => void;
  setGithubAuthStatus: (s: GithubAuthStatus) => void;
  setDataRepoPath: (p: string | null) => void;
  setRefreshInterval: (ms: number) => void;
  setFetchInterval: (ms: number) => void;
  setZoomLevel: (z: number) => void;
  setRecentRepoPaths: (paths: string[]) => void;
  setWorktreeOrder: (order: string[]) => void;
  setWorktreeSortMode: (mode: WorktreeSortMode) => void;
  setThemePreference: (pref: ThemePreference) => void;
  markRefreshed: () => void;
}

// Round to 2 decimals so floating-point drift from repeated +0.1 doesn't
// produce zoom values like 1.0000000000000002 in the persisted config.
function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return ZOOM_DEFAULT;
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  return Math.round(clamped * 100) / 100;
}

export const useRepoStore = create<StoreState>((set) => ({
  repo: null,
  worktrees: [],
  branches: [],
  mainCommits: [],
  mainCommitsTotal: 0,
  squashMappings: [],
  claudePresence: new Map(),
  crossWorktreeConflicts: [],
  conflictSummaryByPath: new Map(),
  loading: false,
  userRefreshing: false,
  fetching: false,
  lastFetchError: null,
  error: null,
  lastRefresh: 0,
  // Start in 'checking' so the bootstrap → validateToken transition doesn't
  // flash yellow "no token" before resolving to the real state. If bootstrap
  // never runs (non-Tauri test env, early error), the pill is hidden behind
  // the error banner anyway, so the initial value is irrelevant in that path.
  githubAuthStatus: 'checking',
  dataRepoPath: null,
  // 15s default. The watcher (scoped to .git/) covers the immediacy case
  // for actual git changes, so the poll loop just needs to be a safety net.
  // 5s was both wasteful (re-running the full pipeline 12×/min) and
  // pointless once the watcher fires for the things that actually matter.
  refreshIntervalMs: 15_000,
  fetchIntervalMs: 60_000,
  zoomLevel: ZOOM_DEFAULT,
  recentRepoPaths: [],
  worktreeOrder: [],
  worktreeSortMode: 'recent',
  // Seed from localStorage (same source bootstrapThemeSync reads) so
  // useTheme's first-render effect is a no-op that agrees with the
  // DOM class already set in main.tsx. A naked `'dark'` default here
  // would clobber a persisted light preference on every page load.
  themePreference: initialThemePreference(),

  setRepo: (repo) => set({ repo }),
  setWorktrees: (worktrees) => set({ worktrees }),
  setBranches: (branches) => set({ branches }),
  setMainCommits: (mainCommits, total) =>
    set({ mainCommits, mainCommitsTotal: total ?? mainCommits.length }),
  setSquashMappings: (squashMappings) => set({ squashMappings }),
  setClaudePresence: (claudePresence) => set({ claudePresence }),
  setCrossWorktreeConflicts: (crossWorktreeConflicts, conflictSummaryByPath) =>
    set({ crossWorktreeConflicts, conflictSummaryByPath }),
  setLoading: (loading) => set({ loading }),
  setUserRefreshing: (userRefreshing) => set({ userRefreshing }),
  setFetching: (fetching) => set({ fetching }),
  setLastFetchError: (lastFetchError) => set({ lastFetchError }),
  setError: (error) => set({ error }),
  setGithubAuthStatus: (githubAuthStatus) => set({ githubAuthStatus }),
  setDataRepoPath: (dataRepoPath) => set({ dataRepoPath }),
  setRefreshInterval: (refreshIntervalMs) => set({ refreshIntervalMs }),
  setFetchInterval: (fetchIntervalMs) => set({ fetchIntervalMs }),
  setZoomLevel: (z) => set({ zoomLevel: clampZoom(z) }),
  setRecentRepoPaths: (recentRepoPaths) => set({ recentRepoPaths }),
  setWorktreeOrder: (worktreeOrder) => set({ worktreeOrder }),
  setWorktreeSortMode: (worktreeSortMode) => set({ worktreeSortMode }),
  setThemePreference: (themePreference) => set({ themePreference }),
  markRefreshed: () => set({ lastRefresh: Date.now() }),
}));
