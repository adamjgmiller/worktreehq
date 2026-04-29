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
  expirePrEntriesByNumbers: vi.fn(),
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
import type { Branch } from '../types';

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

  it('user-initiated fetch + refs unchanged → narrow PR-only post-fetch pass', async () => {
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
    });
    asMock(git.snapshotRemoteRefs).mockResolvedValue('same\n');

    await runFetchOnce({ userInitiated: true });

    // Optimistic pass runs the full pipeline once. The narrow PR-only pass
    // does NOT re-run listWorktrees / listBranches / listMainCommits /
    // listTags / detectSquashMerges / detectCrossWorktreeConflicts — those
    // all have bit-identical inputs when refs didn't move, so re-running
    // them is provably redundant work. This is the core #113 fix.
    expect(asMock(git.listWorktrees)).toHaveBeenCalledTimes(1);
    expect(asMock(git.listBranches)).toHaveBeenCalledTimes(1);
    expect(asMock(git.listMainCommits)).toHaveBeenCalledTimes(1);
    expect(asMock(git.listTags)).toHaveBeenCalledTimes(1);
    expect(asMock(squash.detectSquashMerges)).toHaveBeenCalledTimes(1);
    expect(asMock(conflicts.detectCrossWorktreeConflicts)).toHaveBeenCalledTimes(1);
    // listOpenPRsForBranches IS called twice — once by the optimistic
    // (via runRefreshOnce) and once by the narrow pass — because PR
    // state can change without refs moving (closed-without-merge, draft
    // toggle, checks).
    expect(asMock(github.listOpenPRsForBranches)).toHaveBeenCalledTimes(2);
    // Both caches are invalidated on user-initiated fetches regardless of
    // refsChanged. batchFetchPRs returns cached entries blindly — it can't
    // tell "fresh enough" from "stale," so the narrow pass needs a cold
    // cache to actually surface the PR-metadata changes the click is for.
    expect(asMock(github.invalidateOpenPrListCache)).toHaveBeenCalledWith('o', 'r');
    expect(asMock(github.invalidatePrCacheForRepo)).toHaveBeenCalledWith('o', 'r');
  });

  it('user-initiated fetch + refs moved → full post-fetch pipeline', async () => {
    // Confirms the full pipeline still runs when refs actually moved —
    // new remote commits could have changed squash classifications,
    // added branches, or fast-forwarded main, and we need a fresh
    // listBranches / listMainCommits / detectSquashMerges pass to
    // surface those. Both cache invalidations fire so squashDetector
    // pass 1 doesn't serve a stale 'open' state for a PR that just
    // merged upstream.
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
    });
    asMock(git.snapshotRemoteRefs)
      .mockResolvedValueOnce('before\n')
      .mockResolvedValueOnce('after\n');

    await runFetchOnce({ userInitiated: true });

    expect(asMock(git.listWorktrees)).toHaveBeenCalledTimes(2);
    expect(asMock(github.invalidateOpenPrListCache)).toHaveBeenCalledWith('o', 'r');
    expect(asMock(github.invalidatePrCacheForRepo)).toHaveBeenCalledWith('o', 'r');
  });

  it('narrow pass clears .pr when the open PR disappeared from the list', async () => {
    // Simulates a PR being closed without merge between the optimistic
    // commit and the narrow pass. The open-PR list no longer returns
    // it, so the narrow pass drops the stale attachment.
    const branchWithOpenPR = {
      name: 'feat/x',
      hasLocal: true,
      hasRemote: true,
      lastCommitDate: '2025-01-01T00:00:00Z',
      lastCommitSha: 'abc',
      aheadOfMain: 1,
      behindMain: 0,
      mergeStatus: 'unmerged' as const,
      pr: {
        number: 42,
        title: 'Test PR',
        state: 'open' as const,
        headRef: 'feat/x',
        url: 'https://github.com/o/r/pull/42',
      },
    };
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
    });
    asMock(git.snapshotRemoteRefs).mockResolvedValue('same\n');
    // Seed the optimistic pipeline so it commits a branch carrying
    // an open PR attachment.
    asMock(git.listBranches).mockResolvedValue([branchWithOpenPR]);
    asMock(squash.detectSquashMerges).mockResolvedValue({
      updatedBranches: [branchWithOpenPR],
      mappings: [],
    });
    // Optimistic listOpenPRs sees the PR as open; narrow pass sees empty
    // (PR was closed between the two calls).
    asMock(github.listOpenPRsForBranches)
      .mockResolvedValueOnce(new Map([['feat/x', branchWithOpenPR.pr]]))
      .mockResolvedValueOnce(new Map());

    await runFetchOnce({ userInitiated: true });

    const branch = useRepoStore.getState().branches.find((b) => b.name === 'feat/x');
    expect(branch?.pr).toBeUndefined();
  });

  it('narrow pass preserves a squash-merged PR attached to a branch', async () => {
    // squashDetector attaches merged PRs (state: 'merged') that are NOT
    // in the open-PR list by design. The narrow pass must not clobber
    // those — only stale OPEN-state attachments are dropped.
    const branchWithMergedPR = {
      name: 'feat/y',
      hasLocal: true,
      hasRemote: true,
      lastCommitDate: '2025-01-01T00:00:00Z',
      lastCommitSha: 'def',
      aheadOfMain: 0,
      behindMain: 3,
      mergeStatus: 'squash-merged' as const,
      pr: {
        number: 7,
        title: 'Merged earlier',
        state: 'merged' as const,
        headRef: 'feat/y',
        url: 'https://github.com/o/r/pull/7',
        mergeCommitSha: 'deadbeef',
      },
    };
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
    });
    asMock(git.snapshotRemoteRefs).mockResolvedValue('same\n');
    asMock(git.listBranches).mockResolvedValue([branchWithMergedPR]);
    asMock(squash.detectSquashMerges).mockResolvedValue({
      updatedBranches: [branchWithMergedPR],
      mappings: [],
    });
    // Open-PR list is empty in BOTH optimistic and narrow passes — a
    // merged PR is never in the open list.
    asMock(github.listOpenPRsForBranches).mockResolvedValue(new Map());

    await runFetchOnce({ userInitiated: true });

    const branch = useRepoStore.getState().branches.find((b) => b.name === 'feat/y');
    expect(branch?.pr).toBeDefined();
    expect(branch?.pr?.state).toBe('merged');
    expect(branch?.pr?.number).toBe(7);
  });

  it('narrow pass still runs when the optimistic pipeline errors internally', async () => {
    // runRefreshOnce swallows pipeline errors (sets store error banner and
    // returns). The narrow pass still runs on whatever branches existed
    // before the click — a PR-only refresh is still useful output after a
    // transient listBranches failure, and the error banner communicates
    // the underlying problem to the user.
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
    });
    asMock(git.snapshotRemoteRefs).mockResolvedValue('same\n');
    asMock(git.listBranches).mockRejectedValueOnce(new Error('transient failure'));

    await runFetchOnce({ userInitiated: true });

    // The narrow pass's listOpenPRs runs even though the optimistic failed.
    // The optimistic also called listOpenPRs once (before listBranches
    // threw — they're in a Promise.all, but listOpenPRs sits AFTER the
    // listBranches await in runRefreshOnce, so the rejection short-circuits
    // before the optimistic's listOpenPRs would fire). Net: 1 call, from
    // the narrow pass.
    expect(asMock(github.listOpenPRsForBranches)).toHaveBeenCalledTimes(1);
    expect(useRepoStore.getState().error).toMatch(/transient failure/);
  });

  it('narrow pass surfaces failures via setError instead of silently swallowing', async () => {
    // GitHub API hiccup after a successful git fetch (rate limit, 500,
    // revoked token, etc.) shouldn't make the refresh button look like
    // it worked. The narrow pass mirrors runRefreshOnce's setError policy
    // so the user knows PR pills may be stale.
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
    });
    asMock(git.snapshotRemoteRefs).mockResolvedValue('same\n');
    // Optimistic's listOpenPRs succeeds; narrow pass's fails.
    asMock(github.listOpenPRsForBranches)
      .mockResolvedValueOnce(new Map())
      .mockRejectedValueOnce(new Error('GitHub API hiccup'));

    await runFetchOnce({ userInitiated: true });

    expect(useRepoStore.getState().error).toMatch(/GitHub API hiccup/);
  });

  it('narrow pass bumps lastRefresh after committing so the label resets on user click', async () => {
    // Users expect clicking refresh to reset the "updated X ago" indicator
    // to "just now" when the full round-trip completes. The optimistic
    // pass bumps lastRefresh ~0.5s after the click via commitRefreshResult;
    // the narrow pass bumps it again on its own success ~1-2s later so the
    // label reflects the actual completion of the PR-refresh phase, not
    // an intermediate sub-phase.
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
      lastRefresh: 0,
    });
    asMock(git.snapshotRemoteRefs).mockResolvedValue('same\n');
    const beforeClick = Date.now();

    await runFetchOnce({ userInitiated: true });

    expect(useRepoStore.getState().lastRefresh).toBeGreaterThanOrEqual(beforeClick);
  });

  it('narrow pass does NOT bump lastRefresh on failure', async () => {
    // The lastRefresh bump belongs inside the success path so a failed
    // narrow pass doesn't lie to the user about when PR data was last
    // successfully refreshed.
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
      lastRefresh: 0,
    });
    asMock(git.snapshotRemoteRefs).mockResolvedValue('same\n');
    asMock(github.listOpenPRsForBranches)
      .mockResolvedValueOnce(new Map()) // optimistic succeeds
      .mockRejectedValueOnce(new Error('narrow pass fail'));

    const tsBeforeFail = Date.now();
    await runFetchOnce({ userInitiated: true });

    // Optimistic still committed via commitRefreshResult, which bumps
    // lastRefresh. That's the only bump — the narrow pass's failure path
    // must not bump.
    const lastRefresh = useRepoStore.getState().lastRefresh;
    expect(lastRefresh).toBeGreaterThan(0);
    // Ensure the value we see is from the optimistic commit, which fires
    // before the narrow pass runs. Checking this exactly is timing-
    // dependent; the weaker invariant that survives jitter is: the error
    // was recorded and lastRefresh was not bumped AFTER that error.
    expect(useRepoStore.getState().error).toMatch(/narrow pass fail/);
    expect(lastRefresh).toBeLessThanOrEqual(tsBeforeFail + 50);
  });

  it('user click joining an in-flight background fetch invalidates both caches', async () => {
    // Regression test for the pre-existing join-branch cache-staleness gap
    // (super-code-review footnote #11). Without invalidation at the top
    // of the join branch, the user's joined refreshes serve per-PR data
    // from the 5-minute cache — defeating the refresh button's PR-state-
    // surfacing purpose for ~3% of clicks that land on an in-flight
    // background fetch.
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
    });
    // Hold fetchAllPrune so click 2 lands on the in-flight fetch.
    let releaseFetch: () => void = () => {};
    asMock(git.fetchAllPrune).mockImplementation(
      () => new Promise<void>((r) => { releaseFetch = () => r(); }),
    );

    const tick = () => new Promise<void>((r) => setTimeout(r, 0));

    // Background fetch starts first (no userInitiated).
    const bgFetch = runFetchOnce();
    for (let i = 0; i < 3; i++) await tick();

    // User click lands on the in-flight bg fetch → join branch.
    const userClick = runFetchOnce({ userInitiated: true });
    for (let i = 0; i < 3; i++) await tick();

    // Both caches must be invalidated synchronously at the top of the
    // join branch so the joined refreshes serve fresh data.
    expect(asMock(github.invalidateOpenPrListCache)).toHaveBeenCalledWith('o', 'r');
    expect(asMock(github.invalidatePrCacheForRepo)).toHaveBeenCalledWith('o', 'r');

    // Release and drain.
    releaseFetch();
    await bgFetch;
    await userClick;
  });

  it('repo switch while a background fetch is in-flight fires a real fetch for the new repo', async () => {
    // Regression test for super-code-review item #7. Before this fix,
    // `loadRepoAtPath` firing `runFetchOnce({ userInitiated: true })` while
    // a background fetch for the OLD repo was still in-flight would silently
    // join that fetch — waiting out its drain but never actually running
    // `fetchAllPrune` for the NEW repo. A squash that landed on the new
    // repo's remote wouldn't appear in `mainCommits` until the next 60s
    // background tick. The join branch now detects the repo mismatch after
    // the drain and recurses so the new repo gets a real fetch.
    useRepoStore.setState({
      repo: { path: '/tmp/repoA', defaultBranch: 'main', owner: 'o', name: 'a' },
    });
    // Repo A's fetch hangs until we release it, so the user-initiated call
    // lands on the in-flight branch. Repo B's fetch resolves immediately.
    let releaseA: () => void = () => {};
    asMock(git.fetchAllPrune).mockImplementation((path: string) => {
      if (path === '/tmp/repoA') {
        return new Promise<void>((r) => { releaseA = () => r(); });
      }
      return Promise.resolve();
    });

    const tick = () => new Promise<void>((r) => setTimeout(r, 0));

    // Background tick fires for repo A.
    const bgFetch = runFetchOnce();
    for (let i = 0; i < 3; i++) await tick();
    expect(asMock(git.fetchAllPrune)).toHaveBeenCalledWith('/tmp/repoA');

    // Simulate loadRepoAtPath: flip the store to repo B, then fire the
    // user-initiated fetch that lands on the in-flight branch.
    useRepoStore.setState({
      repo: { path: '/tmp/repoB', defaultBranch: 'main', owner: 'o', name: 'b' },
    });
    const userFetch = runFetchOnce({ userInitiated: true });
    for (let i = 0; i < 3; i++) await tick();

    // Release repo A's fetch. The join branch's post-drain mismatch check
    // should now recurse into runFetchOnce for repo B — fetchAllPrune must
    // be called for BOTH paths, not just A.
    releaseA();
    await bgFetch;
    await userFetch;

    const calls = asMock(git.fetchAllPrune).mock.calls.map((c) => c[0]);
    expect(calls).toContain('/tmp/repoA');
    expect(calls).toContain('/tmp/repoB');
  });

  it('same-repo click joining an in-flight fetch does NOT trigger a redundant recursive fetch', async () => {
    // Guard for the mismatch-detection fix above: when the user clicks
    // refresh while a background fetch for the SAME repo is in-flight, the
    // join branch's post-drain repo-path check should be a no-op — we must
    // not fire a second fetchAllPrune against the same remote on every
    // rapid click.
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
    });
    let releaseBg: () => void = () => {};
    asMock(git.fetchAllPrune).mockImplementation(
      () => new Promise<void>((r) => { releaseBg = () => r(); }),
    );

    const tick = () => new Promise<void>((r) => setTimeout(r, 0));

    const bgFetch = runFetchOnce();
    for (let i = 0; i < 3; i++) await tick();

    const userClick = runFetchOnce({ userInitiated: true });
    for (let i = 0; i < 3; i++) await tick();

    releaseBg();
    await bgFetch;
    await userClick;

    // Exactly one fetchAllPrune — the original in-flight background fetch.
    expect(asMock(git.fetchAllPrune)).toHaveBeenCalledTimes(1);
  });

  it('narrow pass is a no-op when the repo has no GitHub owner/name', async () => {
    // Non-GitHub remote (or remote that couldn't be resolved to an
    // owner/name pair). The narrow pass short-circuits before issuing
    // API calls; the optimistic pass already committed and is the
    // authoritative state.
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main' }, // no owner/name
    });
    asMock(git.snapshotRemoteRefs).mockResolvedValue('same\n');

    await runFetchOnce({ userInitiated: true });

    // Optimistic's listOpenPRs is also skipped because runRefreshOnce
    // guards on owner/name. Net: zero calls.
    expect(asMock(github.listOpenPRsForBranches)).not.toHaveBeenCalled();
    expect(asMock(github.batchFetchPRs)).not.toHaveBeenCalled();
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

describe('targeted PR cache invalidation on background ticks', () => {
  // The background fetch loop deliberately doesn't drop the per-PR cache
  // (5min TTL — see the `if (userInitiated) invalidatePrCacheForRepo(...)`
  // branch in `runFetchOnce`'s post-fetch block). Without targeted help,
  // a PR that gets squash-merged on github.com is brought into origin/main
  // by the next 60s fetch but the cached PRInfo still says state:'open',
  // so detectSquashMerges' batchFetchPRs serves stale data and the squash
  // classification doesn't land for up to 5min on auto-refresh. The diff
  // injected into runRefreshOnce soft-expires only the PR entries whose
  // (#N) tag is newly present in mainCommits — preserves the cost of the
  // 5min TTL elsewhere while plugging the squash-detection gap.

  function makeMainCommit(sha: string, prNumber?: number) {
    const subject = prNumber !== undefined ? `do thing (#${prNumber})` : 'no pr';
    return { sha, subject, date: '2026-01-01T00:00:00Z', prNumber };
  }

  it('invalidates only the newly-appeared PR numbers when origin/main advances', async () => {
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
      mainCommits: [makeMainCommit('a', 100)],
    });
    asMock(git.listMainCommits).mockResolvedValueOnce({
      commits: [makeMainCommit('c', 102), makeMainCommit('b', 101), makeMainCommit('a', 100)],
      total: 3,
    });

    await refreshOnce();

    expect(asMock(github.expirePrEntriesByNumbers)).toHaveBeenCalledTimes(1);
    expect(asMock(github.expirePrEntriesByNumbers)).toHaveBeenCalledWith('o', 'r', [102, 101]);
    // openPrListCache also dropped — soft-expire (not hard-delete). The (#N)
    // tag is proof PR #N is merged, but hard-deleting the whole list would
    // wipe getStale() recovery for unrelated active PRs on transport failure;
    // batchFetchPRs's authoritative state override handles the just-merged
    // PR row downstream.
    expect(asMock(github.invalidateOpenPrListCache)).toHaveBeenCalledWith('o', 'r');
  });

  it('does NOT invalidate when mainCommits is unchanged', async () => {
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
      mainCommits: [makeMainCommit('a', 100)],
    });
    asMock(git.listMainCommits).mockResolvedValueOnce({
      commits: [makeMainCommit('a', 100)],
      total: 1,
    });

    await refreshOnce();

    expect(asMock(github.expirePrEntriesByNumbers)).not.toHaveBeenCalled();
    expect(asMock(github.invalidateOpenPrListCache)).not.toHaveBeenCalled();
  });

  it('does NOT invalidate on the first refresh of a session (empty prevMainCommits)', async () => {
    // Cold boot — store.mainCommits is []. We can't diff so we skip.
    // The bootstrap's expireOpenPrEntries() covers this case via a
    // different mechanism (rehydrated cache state).
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
      mainCommits: [],
    });
    asMock(git.listMainCommits).mockResolvedValueOnce({
      commits: [makeMainCommit('a', 100)],
      total: 1,
    });

    await refreshOnce();

    expect(asMock(github.expirePrEntriesByNumbers)).not.toHaveBeenCalled();
  });

  it('does NOT invalidate when the repo has no GitHub remote', async () => {
    // Non-github remotes won't have owner/name, and there's no PR cache
    // to invalidate anyway. Skip the diff entirely.
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main' },
      mainCommits: [makeMainCommit('a', 100)],
    });
    asMock(git.listMainCommits).mockResolvedValueOnce({
      commits: [makeMainCommit('b', 101), makeMainCommit('a', 100)],
      total: 2,
    });

    await refreshOnce();

    expect(asMock(github.expirePrEntriesByNumbers)).not.toHaveBeenCalled();
    // No owner/name → diff block is skipped entirely; the open-PR list
    // cache must not be dropped either (paired with expirePrEntriesByNumbers
    // inside the same `if (newNumbers.length > 0)` branch).
    expect(asMock(github.invalidateOpenPrListCache)).not.toHaveBeenCalled();
  });

  it('tags squash-merged when open-list fallback serves stale data but batchFetchPRs returns merged', async () => {
    // Regression test for F016 + F031. Scenario:
    //   1. Prior tick cached an open-PR list containing PR #42 as open.
    //   2. A squash commit (#42) just landed on origin/main.
    //   3. The targeted invalidation fires, but the refetch transport
    //      fails — so `listOpenPRsForBranches` serves the pre-merge list
    //      back via its `getStale()` fallback (unconditionally stamped
    //      'open'). `batchFetchPRs` returns PR #42 with state: 'merged'
    //      (authoritative via GraphQL).
    //
    // Before the fix, the `{ ...full, state: rest.state }` clamp re-stamped
    // the PR as 'open', defeating detectSquashMerges' hasOpenPR guard and
    // leaving the branch as unmerged for up to 5 minutes. After the fix,
    // the unclobbered 'merged' state flows through and squashDetector tags
    // the branch squash-merged on the same tick.
    const branch = {
      name: 'feat/squash',
      hasLocal: true,
      hasRemote: true,
      lastCommitDate: '2026-01-01T00:00:00Z',
      lastCommitSha: 'deadbeef',
      aheadOfMain: 1,
      behindMain: 0,
      mergeStatus: 'unmerged' as const,
    };
    const stalePrEntry = {
      number: 42,
      title: 'Feat: squash me',
      headRef: 'feat/squash',
      url: 'https://github.com/o/r/pull/42',
    };
    const mergedPrFull = {
      ...stalePrEntry,
      state: 'merged' as const,
      mergeCommitSha: 'squashsha',
    };

    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
      mainCommits: [makeMainCommit('a', 100)],
    });
    asMock(git.listBranches).mockResolvedValueOnce([branch]);
    asMock(git.listMainCommits).mockResolvedValueOnce({
      commits: [makeMainCommit('squashsha', 42), makeMainCommit('a', 100)],
      total: 2,
    });
    // The open-list transport "failed" upstream: from the refresh loop's
    // perspective, listOpenPRsForBranches silently returned the stale
    // entry (state stamped 'open') via getStale(). We mock that here.
    asMock(github.listOpenPRsForBranches).mockResolvedValueOnce(
      new Map([['feat/squash', { ...stalePrEntry, state: 'open' }]]),
    );
    // batchFetchPRs returns the authoritative merged state.
    asMock(github.batchFetchPRs).mockResolvedValueOnce(
      new Map([[42, mergedPrFull]]),
    );
    // detectSquashMerges runs after the open-list attachment: if the PR
    // flows through as merged, the detector can tag the branch. Assert
    // on the shape it receives.
    asMock(squash.detectSquashMerges).mockImplementationOnce(async ({ branches: bs }: { branches: Branch[] }) => {
      const tagged = bs.map((b) =>
        b.name === 'feat/squash' && b.pr?.state === 'merged'
          ? { ...b, mergeStatus: 'squash-merged' as const }
          : b,
      );
      return { updatedBranches: tagged, mappings: [] };
    });

    await refreshOnce();

    // The targeted invalidation still fires for the newly-seen (#42) tag.
    expect(asMock(github.expirePrEntriesByNumbers)).toHaveBeenCalledWith('o', 'r', [42]);
    expect(asMock(github.invalidateOpenPrListCache)).toHaveBeenCalledWith('o', 'r');

    const feat = useRepoStore.getState().branches.find((b) => b.name === 'feat/squash');
    expect(feat?.pr?.state).toBe('merged');
    expect(feat?.mergeStatus).toBe('squash-merged');
  });

  it('skips main commits with no (#N) PR tag', async () => {
    // First-parent commits without a PR-style suffix (e.g. local merge
    // commits, manual fast-forwards) carry no prNumber and contribute
    // nothing to the diff.
    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
      mainCommits: [makeMainCommit('a', 100)],
    });
    asMock(git.listMainCommits).mockResolvedValueOnce({
      commits: [
        makeMainCommit('c', 102),
        makeMainCommit('b'), // no PR tag
        makeMainCommit('a', 100),
      ],
      total: 3,
    });

    await refreshOnce();

    expect(asMock(github.expirePrEntriesByNumbers)).toHaveBeenCalledWith('o', 'r', [102]);
    // newNumbers is non-empty ([102]) — the no-PR-tag commit is filtered
    // out but the tagged one still triggers the paired open-PR list drop
    // (soft-expire so getStale() can recover unrelated active PRs on
    // transport failure).
    expect(asMock(github.invalidateOpenPrListCache)).toHaveBeenCalledWith('o', 'r');
  });

  it('does NOT misclassify a name-collision branch as squash-merged when the open-PR refetch fails', async () => {
    // Regression test for F004. Scenario: a branch name X has been reused —
    // a historical PR #99 with headRef='X' was previously merged (squash),
    // and the user is now working on a NEW branch X with an active open
    // PR #200. On the tick that brings in a fresh (#250) tag (unrelated
    // squash for some other branch), the targeted invalidation soft-expires
    // the open-PR list. If the refetch transport then fails,
    // listOpenPRsForBranches.getStale() must still serve the pre-tick list
    // (which contains X→PR #200 as open) so squashDetector pass-1 sees
    // X has hasOpenPR=true and skips the misclassification.
    //
    // Under the old hard-delete behavior, getStale() returned undefined →
    // empty open-PR map → X had no .pr attached → hasOpenPR=false → if
    // PR #99's mergeCommitSha happened to appear in mainCommits and #99
    // was warm in prCache, X got incorrectly tagged squash-merged.
    const branchX = {
      name: 'X',
      hasLocal: true,
      hasRemote: true,
      lastCommitDate: '2026-01-01T00:00:00Z',
      lastCommitSha: 'newsha',
      aheadOfMain: 3,
      behindMain: 0,
      mergeStatus: 'unmerged' as const,
    };
    const stalePr200 = {
      number: 200,
      title: 'Active PR for X',
      headRef: 'X',
      url: 'https://github.com/o/r/pull/200',
    };

    useRepoStore.setState({
      repo: { path: '/tmp/repo', defaultBranch: 'main', owner: 'o', name: 'r' },
      // Prior tick: mainCommits includes the historical squash for PR #99.
      // The (#250) tag is what's NEW on this tick — the diff fires the
      // soft-expire for that one only.
      mainCommits: [makeMainCommit('histsha', 99), makeMainCommit('a', 100)],
    });
    asMock(git.listBranches).mockResolvedValueOnce([branchX]);
    asMock(git.listMainCommits).mockResolvedValueOnce({
      commits: [
        makeMainCommit('newsquash', 250),
        makeMainCommit('histsha', 99),
        makeMainCommit('a', 100),
      ],
      total: 3,
    });
    // listOpenPRsForBranches under transport failure: githubService catches
    // the throw and falls back to getStale(). With soft-expire, the prior
    // entry is still reachable as stale and stamped 'open'. We mock the
    // observable behavior here — the function returns the pre-tick map.
    asMock(github.listOpenPRsForBranches).mockResolvedValueOnce(
      new Map([['X', { ...stalePr200, state: 'open' }]]),
    );
    // batchFetchPRs returns the full data for #200 (still open) — no
    // 'merged' entry that could clobber the row.
    asMock(github.batchFetchPRs).mockResolvedValueOnce(
      new Map([[200, { ...stalePr200, state: 'open' as const }]]),
    );
    // squashDetector receives the branches with X carrying its open PR.
    // Simulate pass-1's hasOpenPR guard: when the branch carries an open
    // PR, do NOT tag squash-merged. This is what the production detector
    // does at squashDetector.ts:101.
    asMock(squash.detectSquashMerges).mockImplementationOnce(async ({ branches: bs }: { branches: Branch[] }) => ({
      updatedBranches: bs.map((b) =>
        b.name === 'X' && b.pr?.state === 'open'
          ? b // guard fires — leave unmerged
          : b,
      ),
      mappings: [],
    }));

    await refreshOnce();

    // The soft-expire still fired for the new (#250) tag.
    expect(asMock(github.expirePrEntriesByNumbers)).toHaveBeenCalledWith('o', 'r', [250]);
    // Soft-expire (no third arg) — hard-delete here would have cleared
    // the open-PR list and undefined'd getStale(), removing the .pr
    // attachment from X and unblocking the misclassification.
    expect(asMock(github.invalidateOpenPrListCache)).toHaveBeenCalledWith('o', 'r');

    const x = useRepoStore.getState().branches.find((b) => b.name === 'X');
    // Open PR survives via getStale() fallback.
    expect(x?.pr?.state).toBe('open');
    expect(x?.pr?.number).toBe(200);
    // Critical: X is NOT misclassified as squash-merged.
    expect(x?.mergeStatus).toBe('unmerged');
  });
});
