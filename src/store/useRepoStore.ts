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
  squashMappings: SquashMapping[];
  claudePresence: Map<string, ClaudePresence>;
  loading: boolean;
  fetching: boolean;
  error: string | null;
  lastRefresh: number;
  githubTokenSet: boolean;
  refreshIntervalMs: number;
  fetchIntervalMs: number;

  setRepo: (r: RepoState) => void;
  setWorktrees: (w: Worktree[]) => void;
  setBranches: (b: Branch[]) => void;
  setMainCommits: (c: MainCommit[]) => void;
  setSquashMappings: (s: SquashMapping[]) => void;
  setClaudePresence: (p: Map<string, ClaudePresence>) => void;
  setLoading: (v: boolean) => void;
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
  squashMappings: [],
  claudePresence: new Map(),
  loading: false,
  fetching: false,
  error: null,
  lastRefresh: 0,
  githubTokenSet: false,
  refreshIntervalMs: 5000,
  fetchIntervalMs: 60_000,

  setRepo: (repo) => set({ repo }),
  setWorktrees: (worktrees) => set({ worktrees }),
  setBranches: (branches) => set({ branches }),
  setMainCommits: (mainCommits) => set({ mainCommits }),
  setSquashMappings: (squashMappings) => set({ squashMappings }),
  setClaudePresence: (claudePresence) => set({ claudePresence }),
  setLoading: (loading) => set({ loading }),
  setFetching: (fetching) => set({ fetching }),
  setError: (error) => set({ error }),
  setTokenPresent: (githubTokenSet) => set({ githubTokenSet }),
  setRefreshInterval: (refreshIntervalMs) => set({ refreshIntervalMs }),
  setFetchInterval: (fetchIntervalMs) => set({ fetchIntervalMs }),
  markRefreshed: () => set({ lastRefresh: Date.now() }),
}));
