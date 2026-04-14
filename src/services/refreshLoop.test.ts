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
  simulateMerge: vi.fn().mockResolvedValue({ hasConflicts: false, output: '', conflictedFiles: [], infoByFile: new Map() }),
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
  it('keeps empty status for branches with a clean worktree', async () => {
    asMock(git.listWorktrees).mockResolvedValueOnce([
      { path: '/tmp/repo/wt-feat', branch: 'feat', status: 'clean',
        untrackedCount: 0, modifiedCount: 0, stagedCount: 0, isBare: false },
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
    asMock(squash.detectSquashMerges).mockImplementationOnce(async ({ branches: bs }) => ({
      updatedBranches: bs,
      mappings: [],
    }));

    await refreshOnce();

    const branches = useRepoStore.getState().branches;
    const feat = branches.find((b) => b.name === 'feat')!;
    const orphan = branches.find((b) => b.name === 'orphan')!;

    // feat has a clean worktree → stays empty (no work in progress)
    expect(feat.mergeStatus).toBe('empty');
    expect(feat.worktreePath).toBe('/tmp/repo/wt-feat');
    // orphan has no worktree → also stays empty
    expect(orphan.mergeStatus).toBe('empty');
    expect(orphan.worktreePath).toBeUndefined();
  });

  it('demotes empty branches to unmerged when worktree is dirty', async () => {
    asMock(git.listWorktrees).mockResolvedValueOnce([
      { path: '/tmp/repo/wt-feat', branch: 'feat', status: 'dirty',
        untrackedCount: 1, modifiedCount: 0, stagedCount: 0, isBare: false },
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
    ]);
    asMock(squash.detectSquashMerges).mockImplementationOnce(async ({ branches: bs }) => ({
      updatedBranches: bs,
      mappings: [],
    }));

    await refreshOnce();

    const branches = useRepoStore.getState().branches;
    const feat = branches.find((b) => b.name === 'feat')!;

    // feat has a dirty worktree → demoted to unmerged
    expect(feat.mergeStatus).toBe('unmerged');
    expect(feat.worktreePath).toBe('/tmp/repo/wt-feat');
  });

  it('demotes empty branches to unmerged when worktree has conflicts', async () => {
    asMock(git.listWorktrees).mockResolvedValueOnce([
      { path: '/tmp/repo/wt-feat', branch: 'feat', status: 'conflict',
        untrackedCount: 0, modifiedCount: 0, stagedCount: 0, hasConflicts: true, isBare: false },
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
    ]);
    asMock(squash.detectSquashMerges).mockImplementationOnce(async ({ branches: bs }) => ({
      updatedBranches: bs,
      mappings: [],
    }));

    await refreshOnce();

    const feat = useRepoStore.getState().branches.find((b) => b.name === 'feat')!;
    // Conflicts count as dirty even though untracked/modified/staged are 0
    expect(feat.mergeStatus).toBe('unmerged');
    expect(feat.worktreePath).toBe('/tmp/repo/wt-feat');
  });

  it('demotes empty branches to unmerged when worktree has an in-progress op', async () => {
    asMock(git.listWorktrees).mockResolvedValueOnce([
      { path: '/tmp/repo/wt-feat', branch: 'feat', status: 'clean',
        untrackedCount: 0, modifiedCount: 0, stagedCount: 0, hasConflicts: false,
        inProgress: 'rebase', isBare: false },
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
    ]);
    asMock(squash.detectSquashMerges).mockImplementationOnce(async ({ branches: bs }) => ({
      updatedBranches: bs,
      mappings: [],
    }));

    await refreshOnce();

    const feat = useRepoStore.getState().branches.find((b) => b.name === 'feat')!;
    // Mid-rebase with no file changes still counts as active
    expect(feat.mergeStatus).toBe('unmerged');
    expect(feat.worktreePath).toBe('/tmp/repo/wt-feat');
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
    // Open-PR list cache IS invalidated so PR state changes that don't move
    // refs (closed-without-merge, draft toggle) still surface on the click.
    expect(asMock(github.invalidateOpenPrListCache)).toHaveBeenCalledWith('o', 'r');
    // Per-PR detail cache is NOT invalidated when refs didn't move — the
    // optimistic pass populated it ~2s ago, and the 5-min TTL makes serving
    // those entries to the post-fetch pass safe. This is the #113 fix: avoid
    // making a duplicate GraphQL round-trip for PR data that can't have
    // changed without a ref move (merge_commit_sha, state → merged, etc.).
    expect(asMock(github.invalidatePrCacheForRepo)).not.toHaveBeenCalled();
  });

  it('user-initiated fetch + refs moved → both invalidations fire', async () => {
    // Confirms the gate flips back to the full invalidation when refs
    // actually moved — a freshly-merged PR upstream may have changed its
    // state from 'open' to 'merged' and the cached 'open' entry would
    // mis-classify squash-merged branches on the post-fetch pass.
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
    });
    asMock(git.snapshotRemoteRefs)
      .mockResolvedValueOnce('before\n')
      .mockResolvedValueOnce('after\n');

    await runFetchOnce({ userInitiated: true });

    expect(asMock(github.invalidateOpenPrListCache)).toHaveBeenCalledWith('o', 'r');
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

  it('two rapid user clicks in one fetch window keep the spinner pinned (refcount)', async () => {
    // Regression test for #73: before the refcount, click 1's finally
    // would flip userRefreshing OFF as soon as its fetch resolved, even
    // while click 2's post-fetch refresh was still running — flickering
    // the grid's grey-out mid-click. With the hold/release refcount,
    // click 1's release is balanced against click 2's active claim, so
    // the flag stays pinned until the last caller lets go.
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
    });
    // Hold fetchAllPrune so click 1 stays in the fetch window when
    // click 2 fires — this is what pushes click 2 into the
    // `fetchInFlight` join branch of runFetchOnce.
    let releaseFetch: () => void = () => {};
    asMock(git.fetchAllPrune).mockImplementation(
      () => new Promise<void>((r) => { releaseFetch = () => r(); }),
    );
    // Hold the inner refreshOnce pipelines open so the spinner state is
    // observable in each phase.
    const releases: Array<(v: unknown) => void> = [];
    asMock(git.listWorktrees).mockImplementation(
      () => new Promise((r) => { releases.push(r); }),
    );

    const tick = () => new Promise<void>((r) => setTimeout(r, 0));

    const click1 = runFetchOnce({ userInitiated: true });
    for (let i = 0; i < 5; i++) await tick();
    expect(useRepoStore.getState().userRefreshing).toBe(true);

    // Click 2 lands while click 1's fetch is still in flight. This is
    // the exact scenario #73 reproduces — both clicks want ownership of
    // the spinner flag. Before the refcount, they fought and flickered.
    const click2 = runFetchOnce({ userInitiated: true });
    for (let i = 0; i < 5; i++) await tick();
    expect(useRepoStore.getState().userRefreshing).toBe(true);

    // Release the fetch. Click 1's body finally releases ITS spinner
    // claim, but click 2 is still holding its own claim (plus any
    // inner refreshOnce claims). The pre-refcount code released the
    // flag here; the refcount version must not.
    releaseFetch();
    for (let i = 0; i < 10; i++) await tick();
    expect(useRepoStore.getState().userRefreshing).toBe(true);

    // Drain whatever queued listWorktrees calls remain from the inner
    // optimistic + post-fetch refreshOnce pipelines from both clicks.
    // The exact count depends on dedupe collapse ordering; just drain
    // until both click promises resolve.
    for (let i = 0; i < 20 && releases.length > 0; i++) {
      releases.shift()!([]);
      for (let j = 0; j < 3; j++) await tick();
    }
    await click1;
    await click2;

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

  it('preserves direct-merged status when detection transiently regresses to unmerged', async () => {
    const directBranch = makeBranch('feat/direct', 'direct-merged');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [directBranch],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([directBranch]);
    await refreshOnce();
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('direct-merged');

    // Tick 2: same SHA, but reflog check fails → status regresses to unmerged.
    const regressed = makeBranch('feat/direct', 'unmerged');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [regressed],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([regressed]);
    await refreshOnce();

    // Ratchet should preserve direct-merged.
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('direct-merged');
  });

  it('keeps empty when a clean worktree is attached', async () => {
    // Tick 1: branch has no worktree, status is empty.
    const emptyBranch = makeBranch('feat', 'empty');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [emptyBranch],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([emptyBranch]);
    await refreshOnce();
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('empty');

    // Tick 2: user created a clean worktree for this branch (same SHA).
    // The worktree has no uncommitted changes, so the branch should stay
    // empty — there is genuinely no work in progress.
    asMock(git.listWorktrees).mockResolvedValueOnce([
      { path: '/tmp/repo/wt-feat', branch: 'feat', status: 'clean',
        untrackedCount: 0, modifiedCount: 0, stagedCount: 0, isBare: false },
    ]);
    const stillEmpty = makeBranch('feat', 'empty');
    asMock(git.listBranches).mockResolvedValueOnce([stillEmpty]);
    asMock(squash.detectSquashMerges).mockImplementationOnce(async ({ branches: bs }) => ({
      updatedBranches: bs,
      mappings: [],
    }));
    await refreshOnce();

    const feat = useRepoStore.getState().branches.find((b) => b.name === 'feat')!;
    expect(feat.mergeStatus).toBe('empty');
    expect(feat.worktreePath).toBe('/tmp/repo/wt-feat');
  });

  it('demotes empty→unmerged when a dirty worktree is attached', async () => {
    // Tick 1: branch has no worktree, status is empty.
    const emptyBranch = makeBranch('feat', 'empty');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [emptyBranch],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([emptyBranch]);
    await refreshOnce();
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('empty');

    // Tick 2: user created a worktree and started editing (dirty state).
    // The post-ratchet demotion fires because the worktree has changes.
    asMock(git.listWorktrees).mockResolvedValueOnce([
      { path: '/tmp/repo/wt-feat', branch: 'feat', status: 'dirty',
        untrackedCount: 2, modifiedCount: 0, stagedCount: 0, isBare: false },
    ]);
    const stillEmpty = makeBranch('feat', 'empty');
    asMock(git.listBranches).mockResolvedValueOnce([stillEmpty]);
    asMock(squash.detectSquashMerges).mockImplementationOnce(async ({ branches: bs }) => ({
      updatedBranches: bs,
      mappings: [],
    }));
    await refreshOnce();

    const feat = useRepoStore.getState().branches.find((b) => b.name === 'feat')!;
    expect(feat.mergeStatus).toBe('unmerged');
    expect(feat.worktreePath).toBe('/tmp/repo/wt-feat');
  });

  it('ratchets empty→unmerged regression from transient subprocess failure', async () => {
    // empty depends on a successful git rev-list subprocess (abMatch must
    // be truthy). When the subprocess transiently fails, abMatch is null
    // and the status falls through to unmerged. The ratchet preserves
    // empty so the "Safe to delete" filter doesn't bounce — regardless of
    // whether the branch has a worktree or not.
    const emptyBranch = makeBranch('feat/empty', 'empty');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [emptyBranch],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([emptyBranch]);
    await refreshOnce();
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('empty');

    // Tick 2: subprocess failure → detection returns unmerged.
    const regressed = makeBranch('feat/empty', 'unmerged');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [regressed],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([regressed]);
    await refreshOnce();
    // Ratchet preserves empty — same SHA, transient failure.
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('empty');
  });

  it('ratchets empty→unmerged regression even with a clean worktree attached', async () => {
    // Same scenario as above but with a worktree. Previously the ratchet
    // had a carve-out that allowed the regression when a worktree was
    // attached. Now the ratchet always protects empty, and the
    // dirty-worktree demotion is a separate post-ratchet step.
    const emptyBranch = makeBranch('feat/wt', 'empty');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [emptyBranch],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([emptyBranch]);
    asMock(git.listWorktrees).mockResolvedValueOnce([
      { path: '/tmp/repo/wt-feat', branch: 'feat/wt', status: 'clean',
        untrackedCount: 0, modifiedCount: 0, stagedCount: 0, isBare: false },
    ]);
    await refreshOnce();
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('empty');

    // Tick 2: subprocess failure → detection returns unmerged, worktree
    // still clean.
    const regressed = makeBranch('feat/wt', 'unmerged');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [regressed],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([regressed]);
    asMock(git.listWorktrees).mockResolvedValueOnce([
      { path: '/tmp/repo/wt-feat', branch: 'feat/wt', status: 'clean',
        untrackedCount: 0, modifiedCount: 0, stagedCount: 0, isBare: false },
    ]);
    await refreshOnce();
    // Ratchet preserves empty — clean worktree, same SHA.
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('empty');
  });

  it('does not ratchet stale status', async () => {
    // stale is derived from unmerged + commit-date arithmetic — no
    // subprocess can fail. Transitions are always legitimate.
    const staleBranch = makeBranch('feat/old', 'stale');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [staleBranch],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([staleBranch]);
    await refreshOnce();
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('stale');

    const regressed = makeBranch('feat/old', 'unmerged');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [regressed],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([regressed]);
    await refreshOnce();
    // stale is not ratcheted — fresh detection is trusted.
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('unmerged');
  });

  it('allows stale→empty transition when main fast-forwards past the branch', async () => {
    const staleBranch = makeBranch('feat/old', 'stale');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [staleBranch],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([staleBranch]);
    await refreshOnce();
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('stale');

    // Main advanced to include this branch's commits — same branch SHA,
    // but aheadOfMain drops to 0 so detection returns empty.
    const nowEmpty = makeBranch('feat/old', 'empty');
    asMock(squash.detectSquashMerges).mockResolvedValueOnce({
      updatedBranches: [nowEmpty],
      mappings: [],
    });
    asMock(git.listBranches).mockResolvedValueOnce([nowEmpty]);
    await refreshOnce();
    // stale is not ratcheted — the transition to empty is allowed.
    expect(useRepoStore.getState().branches[0].mergeStatus).toBe('empty');
  });
});
