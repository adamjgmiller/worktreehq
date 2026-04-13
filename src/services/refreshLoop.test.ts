import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import {
  refreshOnce,
  runFetchOnce,
  startFetchLoop,
  stopFetchLoop,
  stopRefreshLoop,
  _resetRefreshLoopForTests,
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
  listTags: vi.fn(),
  fetchAllPrune: vi.fn(),
  snapshotRemoteRefs: vi.fn(),
  getChangedFiles: vi.fn().mockResolvedValue([]),
  getMergeBase: vi.fn().mockResolvedValue(''),
  simulateMerge: vi.fn().mockResolvedValue({ hasConflicts: false, output: '' }),
}));

vi.mock('./squashDetector', () => ({
  detectSquashMerges: vi.fn(),
}));

vi.mock('./githubService', () => ({
  listOpenPRsForBranches: vi.fn(),
  batchFetchPRs: vi.fn(),
  invalidateOpenPrListCache: vi.fn(),
  invalidatePrCacheForRepo: vi.fn(),
}));

vi.mock('./claudeAwarenessService', () => ({
  fetchClaudePresence: vi.fn(),
}));

vi.mock('./conflictDetector', () => ({
  detectCrossWorktreeConflicts: vi.fn(),
}));

import * as git from './gitService';
import * as github from './githubService';
import type { AuthMethod } from './githubService';
import * as squash from './squashDetector';
import * as claude from './claudeAwarenessService';
import * as conflicts from './conflictDetector';

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
    crossWorktreeConflicts: [],
    conflictSummaryByPath: new Map(),
    loading: false,
    userRefreshing: false,
    fetching: false,
    lastFetchError: null,
    error: null,
    lastRefresh: 0,
    githubAuthStatus: 'checking',
    authMethod: 'none' as AuthMethod,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  // Reset the module-level in-flight flags so a previous test that left
  // refreshInFlight or pendingUserRefresh stuck doesn't poison this run.
  _resetRefreshLoopForTests();

  asMock(git.listWorktrees).mockResolvedValue([]);
  asMock(git.listBranches).mockResolvedValue([]);
  asMock(git.listMainCommits).mockResolvedValue({ commits: [], total: 0 });
  asMock(git.listTags).mockResolvedValue([]);
  asMock(git.fetchAllPrune).mockResolvedValue(undefined);
  // Default: every snapshot call returns a different string so the runFetchOnce
  // diff check always sees a change and fires the chained refresh. Tests that
  // exercise the skip-when-unchanged branch override this per-test.
  let snapCounter = 0;
  asMock(git.snapshotRemoteRefs).mockImplementation(async () => `snap-${snapCounter++}\n`);
  asMock(github.listOpenPRsForBranches).mockResolvedValue(new Map());
  asMock(github.batchFetchPRs).mockResolvedValue(new Map());
  asMock(squash.detectSquashMerges).mockResolvedValue({
    updatedBranches: [],
    mappings: [],
  });
  asMock(claude.fetchClaudePresence).mockResolvedValue(new Map());
  asMock(conflicts.detectCrossWorktreeConflicts).mockResolvedValue({
    pairs: [],
    summaryByPath: new Map(),
  });
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
    asMock(git.listMainCommits).mockResolvedValueOnce({
      commits: [{ sha: 'a', subject: 'one', date: '', prNumber: undefined }],
      total: 1234,
    });

    await refreshOnce();

    expect(useRepoStore.getState().mainCommits).toHaveLength(1);
    expect(useRepoStore.getState().mainCommitsTotal).toBe(1234);
  });
});

describe('refreshOnce userInitiated flag', () => {
  it('flips userRefreshing on and off when userInitiated is true', async () => {
    let release: (v: unknown) => void = () => {};
    asMock(git.listWorktrees).mockImplementation(
      () => new Promise((r) => { release = r; }),
    );

    const p = refreshOnce({ userInitiated: true });
    expect(useRepoStore.getState().userRefreshing).toBe(true);

    release([]);
    await p;
    expect(useRepoStore.getState().userRefreshing).toBe(false);
  });

  it('leaves userRefreshing false for background ticks', async () => {
    await refreshOnce();
    expect(useRepoStore.getState().userRefreshing).toBe(false);
  });

  it('joining an in-flight background refresh queues a follow-up and animates the spinner', async () => {
    // Hold the first refresh open with a release-on-demand listWorktrees mock.
    // Each refresh resolves the promise it captured, so the test can step through
    // (1) the in-flight bg refresh, then (2) the queued follow-up, in sequence.
    const releases: Array<(v: unknown) => void> = [];
    asMock(git.listWorktrees).mockImplementation(
      () => new Promise((r) => { releases.push(r); }),
    );

    // Kick off a background refresh (userRefreshing stays false).
    const bg = refreshOnce();
    expect(useRepoStore.getState().userRefreshing).toBe(false);

    // User clicks the button while bg is in flight. The dedupe must NOT
    // collapse this onto the bg promise — bg started against pre-mutation
    // state. Instead a follow-up is queued, and the user-initiated promise
    // resolves only after the follow-up completes.
    const user = refreshOnce({ userInitiated: true });
    expect(useRepoStore.getState().userRefreshing).toBe(true);

    // Release the first (background) refresh. The follow-up should kick off
    // automatically from the in-flight finally hook.
    releases[0]([]);
    await bg;
    // bg has resolved but the follow-up is now in flight; user is still pending.
    expect(useRepoStore.getState().userRefreshing).toBe(true);

    // Release the follow-up. user should now resolve and clear the spinner.
    // Yield once so the follow-up's listWorktrees promise has been pushed.
    await Promise.resolve();
    expect(releases.length).toBeGreaterThanOrEqual(2);
    releases[1]([]);
    await user;
    expect(useRepoStore.getState().userRefreshing).toBe(false);
    expect(asMock(git.listWorktrees)).toHaveBeenCalledTimes(2);
  });
});

describe('refreshOnce worktree-attached empty branch demotion', () => {
  it('demotes empty branches to unmerged when they have a worktree', async () => {
    asMock(git.listWorktrees).mockResolvedValueOnce([
      { path: '/tmp/repo/wt-feat', branch: 'feat', status: 'clean', isBare: false },
    ]);
    asMock(git.listBranches).mockResolvedValueOnce([
      {
        name: 'feat',
        hasLocal: true,
        hasRemote: true,
        lastCommitDate: new Date().toISOString(),
        lastCommitSha: 'aaa',
        aheadOfMain: 0,
        behindMain: 0,
        mergeStatus: 'empty',
      },
      {
        name: 'orphan',
        hasLocal: true,
        hasRemote: false,
        lastCommitDate: new Date().toISOString(),
        lastCommitSha: 'bbb',
        aheadOfMain: 0,
        behindMain: 0,
        mergeStatus: 'empty',
      },
    ]);
    // detectSquashMerges passes branches through unchanged by default —
    // mirror that so the enrichment-stage demotion is visible in the store.
    asMock(squash.detectSquashMerges).mockImplementationOnce(async ({ branches: bs }) => ({
      updatedBranches: bs,
      mappings: [],
    }));

    await refreshOnce();

    const branches = useRepoStore.getState().branches;
    const feat = branches.find((b) => b.name === 'feat')!;
    const orphan = branches.find((b) => b.name === 'orphan')!;

    // feat has a worktree → demoted to unmerged
    expect(feat.mergeStatus).toBe('unmerged');
    expect(feat.worktreePath).toBe('/tmp/repo/wt-feat');
    // orphan has no worktree → stays empty
    expect(orphan.mergeStatus).toBe('empty');
    expect(orphan.worktreePath).toBeUndefined();
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
    // Construct the held promise eagerly so `release` is captured the moment
    // the promise exists — not lazily inside the mock implementation, where
    // ordering depends on exactly when `fetchAllPrune` gets awaited inside
    // `runFetchOnce`. The previous form was brittle: any new await added
    // before `fetchAllPrune` (e.g. the snapshotRemoteRefs call) would race
    // the test's `release()` and wedge the timeout.
    let release: () => void = () => {};
    const heldPromise = new Promise<void>((r) => { release = r; });
    asMock(git.fetchAllPrune).mockReturnValue(heldPromise);

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

  it('sets lastFetchError on background fetch failure', async () => {
    asMock(git.fetchAllPrune).mockRejectedValueOnce(new Error('network'));

    await runFetchOnce();
    expect(useRepoStore.getState().lastFetchError).toBe('network');
  });

  it('does not set lastFetchError on user-initiated fetch failure', async () => {
    asMock(git.fetchAllPrune).mockRejectedValueOnce(new Error('auth'));

    await runFetchOnce({ userInitiated: true });

    // User-initiated failures go through setError → ErrorBanner, then
    // chain a refreshOnce (which clears error on success). The key
    // invariant: lastFetchError stays null so the inline indicator
    // doesn't double up with the ErrorBanner.
    expect(useRepoStore.getState().lastFetchError).toBeNull();
  });

  it('clears lastFetchError on a successful fetch', async () => {
    useRepoStore.setState({ lastFetchError: 'prior failure' });
    asMock(git.snapshotRemoteRefs)
      .mockResolvedValueOnce('before\n')
      .mockResolvedValueOnce('after\n');

    await runFetchOnce({ userInitiated: true });

    expect(useRepoStore.getState().lastFetchError).toBeNull();
  });

  it('prepends an actionable hint to recognized fetch errors (SSH publickey)', async () => {
    asMock(git.fetchAllPrune).mockRejectedValueOnce(
      new Error('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'),
    );

    await runFetchOnce();
    const msg = useRepoStore.getState().lastFetchError ?? '';
    // Hint line from fetchErrorClassifier — asserts the wiring, not the
    // exact copy, so a future hint rewording doesn't break this test.
    expect(msg).toMatch(/SSH key/i);
    // Raw git stderr is preserved for debugging.
    expect(msg).toContain('Permission denied (publickey)');
  });
});

describe('runFetchOnce skip-when-unchanged', () => {
  it('background tick skips the chained refresh when the remote ref snapshot is unchanged', async () => {
    asMock(git.snapshotRemoteRefs).mockResolvedValue('same\n');

    await runFetchOnce();

    expect(asMock(git.fetchAllPrune)).toHaveBeenCalledTimes(1);
    // Chained refresh should NOT have run, so listWorktrees was not called
    // (the only refreshOnce-side mock that's tied to it).
    expect(asMock(git.listWorktrees)).not.toHaveBeenCalled();
    // lastRefresh must NOT advance on a no-op fetch — bumping it would
    // dishonestly tell the user a refresh happened when nothing did. The
    // polling tick is the source of truth for the "updated X ago" indicator.
    expect(useRepoStore.getState().lastRefresh).toBe(0);
    // PR list cache must NOT be invalidated when nothing moved — otherwise
    // we'd negate half the value of the open-PR list cache.
    expect(asMock(github.invalidateOpenPrListCache)).not.toHaveBeenCalled();
  });

  it('user-initiated fetch always chains a refresh, even on unchanged refs', async () => {
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
    });
    asMock(git.snapshotRemoteRefs).mockResolvedValue('same\n');

    await runFetchOnce({ userInitiated: true });

    // User-initiated fetches run refreshOnce TWICE: once optimistically
    // (immediate local re-derive, fires before fetchAllPrune) and once
    // post-fetch (fresh-remote re-derive). Each pipeline calls
    // listWorktrees as the first element of its Promise.all, so the mock
    // records two invocations. The skip path for unchanged refs is also
    // bypassed for user-initiated because the user may be surfacing
    // PR-state-only changes that don't move refs.
    expect(asMock(git.listWorktrees)).toHaveBeenCalledTimes(2);
    expect(asMock(github.invalidateOpenPrListCache)).toHaveBeenCalledWith('o', 'r');
    // The per-PR detail cache must ALSO be invalidated on user-initiated
    // fetches. Without this, squashDetector pass 1 reads the still-cached
    // open-state PR via batchFetchPRs and won't detect a fresh merge until
    // the 5min TTL expires — exactly the freshness bug the refresh button
    // is supposed to fix.
    expect(asMock(github.invalidatePrCacheForRepo)).toHaveBeenCalledWith('o', 'r');
  });

  it('background tick does NOT invalidate the per-PR cache', async () => {
    // The per-PR cache is expensive to refill (one GraphQL call per chunk
    // on the next refresh) and the 5min TTL is fine for unattended
    // background ticks. Only the user-clicked path should drop it.
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
    });
    // Default mock alternates strings → refs change → chained refresh runs.
    await runFetchOnce();

    expect(asMock(github.invalidateOpenPrListCache)).toHaveBeenCalledWith('o', 'r');
    expect(asMock(github.invalidatePrCacheForRepo)).not.toHaveBeenCalled();
  });

  it('user-initiated fetch flips userRefreshing during the chained refresh', async () => {
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
    });
    // Optimistic refresh means a user click fires refreshOnce twice: once
    // immediately against local state (the optimistic phase) and once
    // post-fetch against fresh remote refs. Each pipeline calls
    // listWorktrees as the first subprocess in its Promise.all, so we
    // queue release handles and resolve them in sequence — the post-fetch
    // refreshOnce dedupes into the optimistic via pendingUserRefresh, so
    // the follow-up only launches after the optimistic drains.
    const releases: Array<(v: unknown) => void> = [];
    asMock(git.listWorktrees).mockImplementation(
      () => new Promise((r) => { releases.push(r); }),
    );

    const p = runFetchOnce({ userInitiated: true });
    // Drain microtasks AND macrotasks until both the optimistic refreshOnce
    // AND the fetch body's snapshot/fetchAllPrune steps have landed. A
    // plain `await Promise.resolve()` only drains microtasks; we rely on
    // setTimeout(0) advances to settle the whole chain including the
    // fetch-body IIFE and the dedupe bookkeeping.
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));
    for (let i = 0; i < 5; i++) await tick();
    expect(useRepoStore.getState().userRefreshing).toBe(true);
    expect(releases.length).toBe(1);

    // Release the optimistic's listWorktrees. Its pipeline drains, then
    // the finally block launches the queued follow-up which calls
    // listWorktrees again, pushing a second release handle.
    releases[0]([]);
    for (let i = 0; i < 10; i++) await tick();
    expect(releases.length).toBe(2);

    // Release the follow-up and let the whole chain resolve.
    releases[1]([]);
    await p;
    expect(useRepoStore.getState().userRefreshing).toBe(false);
  });

  it('invalidates the open-PR list cache when refs do change', async () => {
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
    });
    // Default mock alternates strings, so before != after.

    await runFetchOnce();

    expect(asMock(github.invalidateOpenPrListCache)).toHaveBeenCalledWith('o', 'r');
    expect(asMock(git.listWorktrees)).toHaveBeenCalledTimes(1);
  });

  it('still triggers a refresh on snapshot failure (empty string fallback)', async () => {
    asMock(git.snapshotRemoteRefs).mockResolvedValue('');

    await runFetchOnce();

    // Empty strings on both sides — the skip path requires both to be
    // truthy to engage, so we err on the side of refreshing.
    expect(asMock(git.listWorktrees)).toHaveBeenCalledTimes(1);
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

describe('merge-status ratchet', () => {
  function makeBranch(name: string, mergeStatus: string, sha = 'abc123') {
    return {
      name,
      hasLocal: true,
      hasRemote: true,
      lastCommitDate: '2025-01-01T00:00:00+00:00',
      lastCommitSha: sha,
      aheadOfMain: mergeStatus === 'empty' ? 0 : 1,
      behindMain: 0,
      mergeStatus,
    };
  }

  it('preserves squash-merged status when detection transiently regresses to unmerged', async () => {
    // Tick 1: branch detected as squash-merged.
    const squashBranch = makeBranch('feat/foo', 'squash-merged');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [squashBranch],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([squashBranch]);
    await refreshOnce();
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('squash-merged');

    // Tick 2: same branch SHA, but detection fails to re-detect → unmerged.
    const regressed = makeBranch('feat/foo', 'unmerged');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [regressed],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([regressed]);
    await refreshOnce();

    // Ratchet should preserve squash-merged.
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('squash-merged');
  });

  it('allows status upgrade from unmerged to squash-merged', async () => {
    const unmerged = makeBranch('feat/bar', 'unmerged');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [unmerged],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([unmerged]);
    await refreshOnce();
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('unmerged');

    const upgraded = makeBranch('feat/bar', 'squash-merged');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [upgraded],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([upgraded]);
    await refreshOnce();
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('squash-merged');
  });

  it('trusts fresh detection when the branch SHA changes', async () => {
    const squashBranch = makeBranch('feat/baz', 'squash-merged', 'sha-old');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [squashBranch],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([squashBranch]);
    await refreshOnce();
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('squash-merged');

    // Branch SHA moved — user pushed new work. Detection says unmerged; trust it.
    const newWork = makeBranch('feat/baz', 'unmerged', 'sha-new');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [newWork],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([newWork]);
    await refreshOnce();
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('unmerged');
  });

  it('preserves empty status when detection transiently regresses to unmerged', async () => {
    const emptyBranch = makeBranch('feat/empty', 'empty');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [emptyBranch],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([emptyBranch]);
    await refreshOnce();
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('empty');

    const regressed = makeBranch('feat/empty', 'unmerged');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [regressed],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([regressed]);
    await refreshOnce();
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('empty');
  });
});
