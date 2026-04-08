import { create } from 'zustand';
import type {
  Worktree,
  Branch,
  SquashMapping,
  MainCommit,
  RepoState,
  ClaudePresence,
} from '../types';

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
  markRefreshed: () => void;
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
  refreshIntervalMs: 5000,
  fetchIntervalMs: 60_000,

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
  markRefreshed: () => set({ lastRefresh: Date.now() }),
}));
