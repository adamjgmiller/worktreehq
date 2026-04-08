import { create } from 'zustand';
import type {
  Worktree,
  Branch,
  SquashMapping,
  MainCommit,
  RepoState,
  ClaudePresence,
} from '../types';

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
  loading: boolean;
  // `loading` flips on every poll tick; `userRefreshing` only flips when the
  // user explicitly asked for a refresh (button click, post-mutation). The
  // RepoBar spinner binds to this so it doesn't animate on the heartbeat.
  userRefreshing: boolean;
  fetching: boolean;
  error: string | null;
  lastRefresh: number;
  githubTokenSet: boolean;
  refreshIntervalMs: number;
  fetchIntervalMs: number;
  zoomLevel: number;

  setRepo: (r: RepoState) => void;
  setWorktrees: (w: Worktree[]) => void;
  setBranches: (b: Branch[]) => void;
  setMainCommits: (c: MainCommit[], total?: number) => void;
  setSquashMappings: (s: SquashMapping[]) => void;
  setClaudePresence: (p: Map<string, ClaudePresence>) => void;
  setLoading: (v: boolean) => void;
  setUserRefreshing: (v: boolean) => void;
  setFetching: (v: boolean) => void;
  setError: (e: string | null) => void;
  setTokenPresent: (v: boolean) => void;
  setRefreshInterval: (ms: number) => void;
  setFetchInterval: (ms: number) => void;
  setZoomLevel: (z: number) => void;
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
  loading: false,
  userRefreshing: false,
  fetching: false,
  error: null,
  lastRefresh: 0,
  githubTokenSet: false,
  // 15s default. The watcher (scoped to .git/) covers the immediacy case
  // for actual git changes, so the poll loop just needs to be a safety net.
  // 5s was both wasteful (re-running the full pipeline 12×/min) and
  // pointless once the watcher fires for the things that actually matter.
  refreshIntervalMs: 15_000,
  fetchIntervalMs: 60_000,
  zoomLevel: ZOOM_DEFAULT,

  setRepo: (repo) => set({ repo }),
  setWorktrees: (worktrees) => set({ worktrees }),
  setBranches: (branches) => set({ branches }),
  setMainCommits: (mainCommits, total) =>
    set({ mainCommits, mainCommitsTotal: total ?? mainCommits.length }),
  setSquashMappings: (squashMappings) => set({ squashMappings }),
  setClaudePresence: (claudePresence) => set({ claudePresence }),
  setLoading: (loading) => set({ loading }),
  setUserRefreshing: (userRefreshing) => set({ userRefreshing }),
  setFetching: (fetching) => set({ fetching }),
  setError: (error) => set({ error }),
  setTokenPresent: (githubTokenSet) => set({ githubTokenSet }),
  setRefreshInterval: (refreshIntervalMs) => set({ refreshIntervalMs }),
  setFetchInterval: (fetchIntervalMs) => set({ fetchIntervalMs }),
  setZoomLevel: (z) => set({ zoomLevel: clampZoom(z) }),
  markRefreshed: () => set({ lastRefresh: Date.now() }),
}));
