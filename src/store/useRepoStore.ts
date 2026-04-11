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
} from '../types';
import type { ThemePreference } from '../hooks/useTheme';

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
  githubTokenSet: boolean;
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
  // User's theme choice. "system" follows the OS `prefers-color-scheme`
  // and is the first-run default — see useTheme.ts for the resolution
  // and DOM-application logic. Persisted to config.toml via
  // persistThemePreference; the initial value is hydrated in the
  // bootstrap hook before any UI mounts so there's no FOUC.
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
  setTokenPresent: (v: boolean) => void;
  setDataRepoPath: (p: string | null) => void;
  setRefreshInterval: (ms: number) => void;
  setFetchInterval: (ms: number) => void;
  setZoomLevel: (z: number) => void;
  setRecentRepoPaths: (paths: string[]) => void;
  setWorktreeOrder: (order: string[]) => void;
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
  githubTokenSet: false,
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
  themePreference: 'system',

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
  setTokenPresent: (githubTokenSet) => set({ githubTokenSet }),
  setDataRepoPath: (dataRepoPath) => set({ dataRepoPath }),
  setRefreshInterval: (refreshIntervalMs) => set({ refreshIntervalMs }),
  setFetchInterval: (fetchIntervalMs) => set({ fetchIntervalMs }),
  setZoomLevel: (z) => set({ zoomLevel: clampZoom(z) }),
  setRecentRepoPaths: (recentRepoPaths) => set({ recentRepoPaths }),
  setWorktreeOrder: (worktreeOrder) => set({ worktreeOrder }),
  setThemePreference: (themePreference) => set({ themePreference }),
  markRefreshed: () => set({ lastRefresh: Date.now() }),
}));
