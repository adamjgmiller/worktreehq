import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import {
  refreshOnce,
  runFetchOnce,
  startFetchLoop,
  stopFetchLoop,
  stopRefreshLoop,
} from './refreshLoop';
import { useRepoStore } from '../store/useRepoStore';

// Tests mock at the service layer — same pattern as squashDetector.test.ts.
// The module-level in-flight flags (refreshInFlight, fetchInFlight, running,
// fetchRunning) persist across tests within the file, so afterEach has to
// stop both loops and we await every promise to let .finally() clean up.

vi.mock('./gitService', () => ({
  listWorktrees: vi.fn(),
  listBranches: vi.fn(),
  listMainCommits: vi.fn(),
  countMainCommits: vi.fn(),
  listTags: vi.fn(),
  getRemoteUrl: vi.fn(),
  fetchAllPrune: vi.fn(),
}));

vi.mock('./squashDetector', () => ({
  detectSquashMerges: vi.fn(),
}));

vi.mock('./githubService', () => ({
  listOpenPRsForBranches: vi.fn(),
  batchFetchPRs: vi.fn(),
}));

vi.mock('./claudeAwarenessService', () => ({
  fetchClaudePresence: vi.fn(),
}));

import * as git from './gitService';
import * as github from './githubService';
import * as squash from './squashDetector';
import * as claude from './claudeAwarenessService';

const asMock = <T extends (...args: any[]) => any>(fn: T) => fn as unknown as Mock;

function resetStore() {
  useRepoStore.setState({
    repo: { path: '/tmp/repo', defaultBranch: 'main' },
    worktrees: [],
    branches: [],
    mainCommits: [],
    mainCommitsTotal: 0,
    squashMappings: [],
    claudePresence: new Map(),
    loading: false,
    fetching: false,
    error: null,
    lastRefresh: 0,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();

  asMock(git.listWorktrees).mockResolvedValue([]);
  asMock(git.listBranches).mockResolvedValue([]);
  asMock(git.listMainCommits).mockResolvedValue([]);
  asMock(git.countMainCommits).mockResolvedValue(0);
  asMock(git.listTags).mockResolvedValue([]);
  asMock(git.getRemoteUrl).mockResolvedValue({ owner: null, name: null });
  asMock(git.fetchAllPrune).mockResolvedValue(undefined);
  asMock(github.listOpenPRsForBranches).mockResolvedValue(new Map());
  asMock(github.batchFetchPRs).mockResolvedValue(new Map());
  asMock(squash.detectSquashMerges).mockResolvedValue({
    updatedBranches: [],
    mappings: [],
  });
  asMock(claude.fetchClaudePresence).mockResolvedValue(new Map());
});

afterEach(() => {
  stopRefreshLoop();
  stopFetchLoop();
});

describe('refreshOnce re-entrancy guard', () => {
  it('dedupes concurrent callers into a single in-flight promise', async () => {
    // Hold listWorktrees open so the first refresh is still suspended when the
    // second/third callers land. The guard should return the same promise
    // without launching another underlying run.
    let release: (v: unknown) => void = () => {};
    asMock(git.listWorktrees).mockImplementation(
      () => new Promise((r) => { release = r; }),
    );

    const p1 = refreshOnce();
    const p2 = refreshOnce();
    const p3 = refreshOnce();

    // All three callers hold the same promise object (strict equality).
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);

    // Only one underlying fetch kicked off.
    expect(asMock(git.listWorktrees)).toHaveBeenCalledTimes(1);

    release([]);
    await Promise.all([p1, p2, p3]);
  });

  it('allows a new refresh after the previous one completes', async () => {
    await refreshOnce();
    expect(asMock(git.listWorktrees)).toHaveBeenCalledTimes(1);

    await refreshOnce();
    expect(asMock(git.listWorktrees)).toHaveBeenCalledTimes(2);
  });

  it('routes errors to setError and still releases the in-flight slot', async () => {
    asMock(git.listWorktrees).mockRejectedValueOnce(new Error('boom'));

    await refreshOnce();

    expect(useRepoStore.getState().error).toBe('boom');
    expect(useRepoStore.getState().loading).toBe(false);

    // Next refresh should start fresh — failing refresh must not wedge the guard.
    asMock(git.listWorktrees).mockResolvedValueOnce([]);
    await refreshOnce();
    expect(asMock(git.listWorktrees)).toHaveBeenCalledTimes(2);
  });

  it('propagates mainCommitsTotal to the store for the truncation indicator', async () => {
    asMock(git.listMainCommits).mockResolvedValueOnce([
      { sha: 'a', subject: 'one', date: '', prNumber: undefined },
    ]);
    asMock(git.countMainCommits).mockResolvedValueOnce(1234);

    await refreshOnce();

    expect(useRepoStore.getState().mainCommits).toHaveLength(1);
    expect(useRepoStore.getState().mainCommitsTotal).toBe(1234);
  });
});

describe('runFetchOnce', () => {
  it('runs fetchAllPrune and then triggers a downstream refresh', async () => {
    await runFetchOnce();

    expect(asMock(git.fetchAllPrune)).toHaveBeenCalledTimes(1);
    expect(asMock(git.listWorktrees)).toHaveBeenCalledTimes(1);
  });

  it('flips the store fetching flag on then off', async () => {
    const seen: boolean[] = [];
    const unsub = useRepoStore.subscribe((s) => {
      seen.push(s.fetching);
    });

    await runFetchOnce();
    unsub();

    expect(seen).toContain(true);
    expect(useRepoStore.getState().fetching).toBe(false);
  });

  it('dedupes concurrent fetches via the in-flight flag', async () => {
    let release: () => void = () => {};
    asMock(git.fetchAllPrune).mockImplementation(
      () => new Promise<void>((r) => { release = r; }),
    );

    const p1 = runFetchOnce();
    const p2 = runFetchOnce(); // should short-circuit on fetchInFlight

    release();
    await Promise.all([p1, p2]);

    expect(asMock(git.fetchAllPrune)).toHaveBeenCalledTimes(1);
  });

  it('swallows fetchAllPrune failures and still clears the fetching flag', async () => {
    asMock(git.fetchAllPrune).mockRejectedValueOnce(new Error('network'));

    await expect(runFetchOnce()).resolves.toBeUndefined();
    expect(useRepoStore.getState().fetching).toBe(false);
  });
});

describe('fetch loop interval 0 (disabled)', () => {
  it('skips fetchAllPrune when fetchIntervalMs is 0 but keeps ticking', async () => {
    useRepoStore.setState({ fetchIntervalMs: 0 });

    startFetchLoop();
    // Flush microtasks so the initial async tick body completes.
    await Promise.resolve();
    await Promise.resolve();

    expect(asMock(git.fetchAllPrune)).not.toHaveBeenCalled();

    stopFetchLoop();
  });
});
