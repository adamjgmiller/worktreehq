import { describe, it, expect, vi, beforeEach } from 'vitest';

// The bridge is imported transitively via githubService; stub it so imports are
// safe in a non-Tauri test environment.
vi.mock('./tauriBridge', () => ({
  readPrCacheFile: vi.fn().mockResolvedValue(''),
  writePrCacheFile: vi.fn().mockResolvedValue(undefined),
  ghExec: vi.fn().mockRejectedValue(new Error('Tauri runtime unavailable')),
  keychainRead: vi.fn().mockResolvedValue(null),
  keychainStore: vi.fn().mockResolvedValue(undefined),
  keychainDelete: vi.fn().mockResolvedValue(undefined),
}));
import { readPrCacheFile, writePrCacheFile } from './tauriBridge';
const readPrCacheFileMock = readPrCacheFile as unknown as ReturnType<typeof vi.fn>;
const writePrCacheFileMock = writePrCacheFile as unknown as ReturnType<typeof vi.fn>;

// Mock Octokit with shared graphql + paginate methods so tests can configure
// them per-case. The Octokit class is now imported in octokitTransport.ts.
const graphqlMock = vi.fn();
const paginateMock = vi.fn();
const usersGetAuthenticatedMock = vi.fn();
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    graphql: graphqlMock,
    pulls: { list: vi.fn(), get: vi.fn() },
    paginate: paginateMock,
    users: { getAuthenticated: usersGetAuthenticatedMock },
  })),
}));

import {
  mapChecksStatus,
  mapMergeable,
  mapReviewDecision,
  batchFetchPRs,
  expireOpenPrEntries,
  expirePrEntriesByNumbers,
  initGithub,
  hydratePrCache,
  getPR,
  listOpenPRsForBranches,
  invalidateOpenPrListCache,
  invalidatePrCacheForRepo,
  validateToken,
  _clearPrCacheForTests,
  _getPrCacheKeysForTests,
  _simulateCacheEvictionForTests,
} from './githubService';

describe('mapChecksStatus', () => {
  it('maps GraphQL rollup states to our union', () => {
    expect(mapChecksStatus('SUCCESS')).toBe('success');
    expect(mapChecksStatus('FAILURE')).toBe('failure');
    expect(mapChecksStatus('ERROR')).toBe('failure');
    expect(mapChecksStatus('PENDING')).toBe('pending');
    expect(mapChecksStatus('EXPECTED')).toBe('pending');
    expect(mapChecksStatus(undefined)).toBe('none');
    expect(mapChecksStatus(null)).toBe('none');
    expect(mapChecksStatus('WEIRD')).toBe('none');
  });
});

describe('mapReviewDecision', () => {
  it('normalizes GraphQL values, defaulting unknowns to null', () => {
    expect(mapReviewDecision('APPROVED')).toBe('approved');
    expect(mapReviewDecision('CHANGES_REQUESTED')).toBe('changes_requested');
    expect(mapReviewDecision('REVIEW_REQUIRED')).toBe('review_required');
    expect(mapReviewDecision(null)).toBeNull();
    expect(mapReviewDecision(undefined)).toBeNull();
  });
});

describe('mapMergeable', () => {
  it('maps the tri-state to boolean | null', () => {
    expect(mapMergeable('MERGEABLE')).toBe(true);
    expect(mapMergeable('CONFLICTING')).toBe(false);
    expect(mapMergeable('UNKNOWN')).toBeNull();
    expect(mapMergeable(undefined)).toBeNull();
  });
});

describe('batchFetchPRs: chunking', () => {
  beforeEach(() => {
    _clearPrCacheForTests();
    graphqlMock.mockReset();
    initGithub('test-token');
  });

  // Build a fake GraphQL response for a chunk of PR numbers: every number
  // maps to a minimal PR node under its `p${n}` alias.
  const fakeResponseFor = (numbers: number[]) => {
    const repository: Record<string, unknown> = {};
    for (const n of numbers) {
      repository[`p${n}`] = {
        number: n,
        title: `PR ${n}`,
        state: 'OPEN',
        merged: false,
        mergedAt: null,
        mergeCommit: null,
        headRefName: `feat/${n}`,
        url: `https://github.com/o/r/pull/${n}`,
        isDraft: false,
        mergeable: 'MERGEABLE',
        reviewDecision: null,
        commits: { nodes: [] },
      };
    }
    return { repository };
  };

  it('chunks requests of >50 PRs into multiple GraphQL calls', async () => {
    // Capture which numbers each call asked for by inspecting the query string.
    graphqlMock.mockImplementation(async (query: string) => {
      const matches = [...query.matchAll(/p(\d+): pullRequest/g)].map((m) =>
        parseInt(m[1], 10),
      );
      return fakeResponseFor(matches);
    });

    const numbers = Array.from({ length: 120 }, (_, i) => i + 1);
    const result = await batchFetchPRs('o', 'r', numbers);

    // 50 + 50 + 20 = 3 calls
    expect(graphqlMock).toHaveBeenCalledTimes(3);
    expect(result.size).toBe(120);
    // Sanity: check a couple of mapped entries.
    expect(result.get(1)?.headRef).toBe('feat/1');
    expect(result.get(120)?.headRef).toBe('feat/120');
  });

  it('issues a single call when under the chunk size', async () => {
    graphqlMock.mockImplementation(async (query: string) => {
      const matches = [...query.matchAll(/p(\d+): pullRequest/g)].map((m) =>
        parseInt(m[1], 10),
      );
      return fakeResponseFor(matches);
    });

    const numbers = Array.from({ length: 30 }, (_, i) => i + 1);
    const result = await batchFetchPRs('o', 'r', numbers);

    expect(graphqlMock).toHaveBeenCalledTimes(1);
    expect(result.size).toBe(30);
  });
});

describe('batchFetchPRs: mergeTimeHeadSha freeze on merged state', () => {
  beforeEach(() => {
    _clearPrCacheForTests();
    graphqlMock.mockReset();
    initGithub('test-token');
  });

  const mergedPRResponse = (num: number, headOid: string) => ({
    repository: {
      [`p${num}`]: {
        number: num,
        title: `PR ${num}`,
        state: 'MERGED',
        merged: true,
        mergedAt: '2026-01-01T00:00:00Z',
        mergeCommit: { oid: `merge-${num}` },
        headRefName: `feat/${num}`,
        headRefOid: headOid,
        url: `https://github.com/o/r/pull/${num}`,
        isDraft: false,
        mergeable: 'MERGEABLE',
        reviewDecision: null,
        commits: { nodes: [] },
      },
    },
  });

  it('bootstraps mergeTimeHeadSha from live headSha on first fetch of a merged PR (observedLive=false)', async () => {
    // Cold bootstrap: no prior observation of this PR. The live headSha
    // might already be post-merge-advanced, so mark observedLive=false so
    // the supplementary `pr-<N>` detector pass fails closed on this entry.
    graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'initial-tip'));
    const result = await batchFetchPRs('o', 'r', [42]);
    const pr = result.get(42);
    expect(pr?.headSha).toBe('initial-tip');
    expect(pr?.mergeTimeHeadSha).toBe('initial-tip');
    expect(pr?.mergeTimeHeadShaObservedLive).toBe(false);
  });

  it('keeps observedLive=false across TTL refresh once cold-bootstrapped', async () => {
    // Sticky fail-closed invariant: once a PR is cold-bootstrapped
    // (observedLive=false), re-observing it merged should not flip the
    // flag to true. Without this, a user who first sees a pre-existing
    // merged PR on install, then lets TTL expire, would get that PR
    // "promoted" to observedLive=true on the next refetch — reintroducing
    // the exact CX-F4 misclassification path the flag exists to close.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'bootstrap-tip'));
      const first = await batchFetchPRs('o', 'r', [42]);
      expect(first.get(42)?.mergeTimeHeadShaObservedLive).toBe(false);

      // Advance past TTL; second fetch sees the same merged state. The
      // live headSha may have advanced post-merge, but the frozen
      // mergeTimeHeadSha + observedLive=false must stay stuck.
      vi.setSystemTime(new Date('2026-01-01T00:06:00Z'));
      graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'post-merge-tip'));
      const second = await batchFetchPRs('o', 'r', [42]);
      const pr = second.get(42);
      expect(pr?.headSha).toBe('post-merge-tip');
      expect(pr?.mergeTimeHeadSha).toBe('bootstrap-tip');
      expect(pr?.mergeTimeHeadShaObservedLive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sets observedLive=true when a PR transitions from open to merged during this process', async () => {
    // First observation: PR is open. No mergeTimeHeadSha — it only gets set
    // on merged state. Second observation: PR is now merged. setPrCacheEntry
    // sees priorInCache with state !== 'merged' and treats the current
    // pr.headSha as the witnessed merge-time tip (observedLive=true).
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      graphqlMock.mockResolvedValueOnce({
        repository: {
          p42: {
            number: 42,
            title: 'PR 42',
            state: 'OPEN',
            merged: false,
            mergedAt: null,
            mergeCommit: null,
            headRefName: 'feat/42',
            headRefOid: 'open-tip',
            url: 'https://github.com/o/r/pull/42',
            isDraft: false,
            mergeable: 'MERGEABLE',
            reviewDecision: null,
            commits: { nodes: [] },
          },
        },
      });
      await batchFetchPRs('o', 'r', [42]);

      // Advance past TTL so the next fetch re-hits the network.
      vi.setSystemTime(new Date('2026-01-01T00:06:00Z'));
      graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'merge-tip'));
      const result = await batchFetchPRs('o', 'r', [42]);
      const pr = result.get(42);
      expect(pr?.state).toBe('merged');
      expect(pr?.mergeTimeHeadSha).toBe('merge-tip');
      expect(pr?.mergeTimeHeadShaObservedLive).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves mergeTimeHeadSha across re-fetches when live headSha advances', async () => {
    // Advance Date.now() past the 5-min in-memory TTL between fetches so the
    // second call actually hits the network (the first entry stays present
    // for getStale but is treated as expired by prCache.get). This exercises
    // the real production path: author pushes to head branch post-merge, the
    // app re-fetches on next refresh, and setPrCacheEntry must preserve the
    // originally-frozen merge-time tip.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'initial-tip'));
      await batchFetchPRs('o', 'r', [42]);

      // Advance past the 5-min TTL.
      vi.setSystemTime(new Date('2026-01-01T00:06:00Z'));
      graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'post-merge-tip'));
      const result = await batchFetchPRs('o', 'r', [42]);
      const pr = result.get(42);
      expect(pr?.headSha).toBe('post-merge-tip');
      // Frozen from first observation — not overwritten by the advanced tip.
      expect(pr?.mergeTimeHeadSha).toBe('initial-tip');
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves mergeTimeHeadSha + observedLive across user-initiated invalidation + re-fetch', async () => {
    // invalidatePrCacheForRepo is called on every user-initiated refresh
    // (refreshLoop.ts). It soft-expires cache entries so `get()` misses
    // trigger a refetch, while `getStale()` still returns the prior value
    // for setPrCacheEntry's fallback chain. Without this path, a follow-up
    // fetch would re-bootstrap mergeTimeHeadSha from the current live
    // headSha, defeating the freeze on the most common refresh path.
    graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'initial-tip'));
    await batchFetchPRs('o', 'r', [42]);

    // User clicks Refresh → repo cache invalidated (soft-expire).
    invalidatePrCacheForRepo('o', 'r');

    // Author pushed post-merge; live tip advanced.
    graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'post-merge-tip'));
    const result = await batchFetchPRs('o', 'r', [42]);
    const pr = result.get(42);
    expect(pr?.headSha).toBe('post-merge-tip');
    // Freeze survived the invalidation via getStale fallback.
    expect(pr?.mergeTimeHeadSha).toBe('initial-tip');
    // observedLive preserved from the prior entry (initial fetch cold-
    // bootstrapped with false; soft-expire preserves that through the
    // refetch).
    expect(pr?.mergeTimeHeadShaObservedLive).toBe(false);
  });

  it('preserves freeze + observedLive across simulated app restart (persist → rehydrate → refetch)', async () => {
    // The most critical case for soft-mark-stale: if the app crashes or
    // quits between invalidate and refetch, the on-disk cache keeps the
    // expired entries. On next boot, `hydratePrCache` rehydrates them with
    // their original `at` timestamp (so the crash-after-invalidate case
    // hydrates at `at: 0`, i.e. still expired). `get()` misses, `getStale()`
    // returns the entry, freeze survives.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      // Simulate a non-merged → merged observation so observedLive=true.
      graphqlMock.mockResolvedValueOnce({
        repository: {
          p42: {
            number: 42,
            title: 'PR 42',
            state: 'OPEN',
            merged: false,
            mergedAt: null,
            mergeCommit: null,
            headRefName: 'feat/42',
            headRefOid: 'open-tip',
            url: 'https://github.com/o/r/pull/42',
            isDraft: false,
            mergeable: 'MERGEABLE',
            reviewDecision: null,
            commits: { nodes: [] },
          },
        },
      });
      await batchFetchPRs('o', 'r', [42]);

      vi.setSystemTime(new Date('2026-01-01T00:06:00Z'));
      graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'merge-tip'));
      await batchFetchPRs('o', 'r', [42]);

      // User invalidates, then the app crashes before refetch completes.
      invalidatePrCacheForRepo('o', 'r');

      // Simulate app restart: clear in-memory state and rehydrate from
      // whatever the last persist flushed. The soft-expired entry is
      // serialized with the merged PR's value and at=0.
      const persistedBlob = JSON.stringify({
        version: 1,
        entries: {
          'o/r#42': {
            at: 0, // soft-expired
            pr: {
              number: 42,
              title: 'PR 42',
              state: 'merged',
              mergeCommitSha: 'merge-42',
              headRef: 'feat/42',
              headSha: 'merge-tip',
              mergeTimeHeadSha: 'merge-tip',
              mergeTimeHeadShaObservedLive: true,
              url: 'https://github.com/o/r/pull/42',
            },
          },
        },
      });
      _clearPrCacheForTests();
      readPrCacheFileMock.mockResolvedValueOnce(persistedBlob);
      await hydratePrCache();

      // Fresh fetch after restart — live head has advanced post-merge.
      graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'post-merge-tip'));
      const result = await batchFetchPRs('o', 'r', [42]);
      const pr = result.get(42);
      expect(pr?.headSha).toBe('post-merge-tip');
      // Freeze and observedLive both survived the restart.
      expect(pr?.mergeTimeHeadSha).toBe('merge-tip');
      expect(pr?.mergeTimeHeadShaObservedLive).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to grant observedLive=true when the only prior non-merged observation came from disk (rehydrated open entry)', async () => {
    // Regression test for round-7 UF-1: setPrCacheEntry previously used
    // `priorInCache.state !== 'merged'` as a proxy for "witnessed the
    // transition in-process". That proxy misfires after app restart —
    // hydratePrCache rehydrates persisted open entries, so the first post-
    // restart fetch that finds the PR merged would see a rehydrated open
    // prior and incorrectly flag observedLive=true. If post-merge commits
    // were pushed during the offline window, the frozen mergeTimeHeadSha
    // would then point PAST the actual merge, and pass 1b could classify
    // a pr-<N> with real un-upstreamed work as squash-merged.
    //
    // Fix: track live observations via an in-memory Set that doesn't
    // persist. Rehydrated entries don't populate it, so the first post-
    // restart observation falls through to the cold-bootstrap branch.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      // Persist an open entry with an `at` that's within STALE_OPEN_PR_MS
      // (so hydrate keeps it) but past the 5-min in-memory TTL (so the
      // next get() misses and the fetch hits the network).
      const persistedBlob = JSON.stringify({
        version: 1,
        entries: {
          'o/r#42': {
            at: Date.now() - 60 * 60 * 1000, // 1 hour old
            pr: {
              number: 42,
              title: 'PR 42',
              state: 'open',
              headRef: 'feat/42',
              headSha: 'pre-merge-tip',
              url: 'https://github.com/o/r/pull/42',
            },
          },
        },
      });
      readPrCacheFileMock.mockResolvedValueOnce(persistedBlob);
      await hydratePrCache();

      // First post-restart fetch returns the PR as merged with a live
      // headSha that is already past the actual merge tip.
      graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'post-merge-tip'));
      const result = await batchFetchPRs('o', 'r', [42]);
      const pr = result.get(42);
      expect(pr?.state).toBe('merged');
      // Cold-bootstrap path: headSha becomes the freeze, observedLive=false.
      expect(pr?.mergeTimeHeadSha).toBe('post-merge-tip');
      expect(pr?.mergeTimeHeadShaObservedLive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to grant observedLive=true when the live observation was evicted before the merged fetch', async () => {
    // Regression test for round-8 CX-F5: `liveObservations` Set membership
    // alone is insufficient. If a PR is observed non-merged in-process,
    // the cache fills past maxSize and FIFO-trims the entry, and a later
    // fetch finds the PR merged — `priorInCache` is undefined (evicted)
    // but the Set still has the key. Without the AND guard, setPrCacheEntry
    // would fire branch 2 and trust the (possibly post-merge-advanced)
    // headSha. The AND of (priorInCache non-merged) && (Set membership)
    // forces branch 3 so post-eviction fetches fail closed.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      // In-process observation of PR 42 as open: Set populated, cache has entry.
      graphqlMock.mockResolvedValueOnce({
        repository: {
          p42: {
            number: 42,
            title: 'PR 42',
            state: 'OPEN',
            merged: false,
            mergedAt: null,
            mergeCommit: null,
            headRefName: 'feat/42',
            headRefOid: 'open-tip',
            url: 'https://github.com/o/r/pull/42',
            isDraft: false,
            mergeable: 'MERGEABLE',
            reviewDecision: null,
            commits: { nodes: [] },
          },
        },
      });
      await batchFetchPRs('o', 'r', [42]);

      // Simulate FIFO trim dropping PR 42 while leaving liveObservations intact.
      _simulateCacheEvictionForTests('o/r#42');

      // Advance past TTL and refetch: PR is now merged, live head may be
      // post-merge-advanced.
      vi.setSystemTime(new Date('2026-01-01T00:06:00Z'));
      graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'post-merge-tip'));
      const result = await batchFetchPRs('o', 'r', [42]);
      const pr = result.get(42);
      expect(pr?.state).toBe('merged');
      // Fail-closed: no priorInCache to corroborate the in-process witness.
      expect(pr?.mergeTimeHeadSha).toBe('post-merge-tip');
      expect(pr?.mergeTimeHeadShaObservedLive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT set mergeTimeHeadSha for open PRs', async () => {
    graphqlMock.mockResolvedValueOnce({
      repository: {
        p42: {
          number: 42,
          title: 'Open PR',
          state: 'OPEN',
          merged: false,
          mergedAt: null,
          mergeCommit: null,
          headRefName: 'feat/42',
          headRefOid: 'open-tip',
          url: 'https://github.com/o/r/pull/42',
          isDraft: false,
          mergeable: 'MERGEABLE',
          reviewDecision: null,
          commits: { nodes: [] },
        },
      },
    });
    const result = await batchFetchPRs('o', 'r', [42]);
    const pr = result.get(42);
    expect(pr?.state).toBe('open');
    expect(pr?.headSha).toBe('open-tip');
    expect(pr?.mergeTimeHeadSha).toBeUndefined();
  });
});

describe('hydratePrCache: on-disk TTL for open PRs', () => {
  beforeEach(() => {
    _clearPrCacheForTests();
    graphqlMock.mockReset();
    readPrCacheFileMock.mockReset();
    initGithub('test-token');
  });

  // Build a persisted-cache JSON blob with three entries: one fresh open, one
  // stale open, and one stale merged. Hydration should drop only the stale
  // open entry.
  const buildDiskCache = () => {
    const now = Date.now();
    const EIGHT_DAYS = 8 * 24 * 60 * 60 * 1000;
    const ONE_HOUR = 60 * 60 * 1000;
    return JSON.stringify({
      version: 1,
      entries: {
        'o/r#1': {
          at: now - ONE_HOUR,
          pr: {
            number: 1,
            title: 'fresh-open',
            state: 'open',
            headRef: 'feat/fresh',
            url: '',
          },
        },
        'o/r#2': {
          at: now - EIGHT_DAYS,
          pr: {
            number: 2,
            title: 'stale-open',
            state: 'open',
            headRef: 'feat/stale',
            url: '',
          },
        },
        'o/r#3': {
          at: now - EIGHT_DAYS,
          pr: {
            number: 3,
            title: 'stale-merged',
            state: 'merged',
            headRef: 'feat/old-merged',
            url: '',
          },
        },
      },
    });
  };

  it('keeps fresh open-PR entries and drops stale ones', async () => {
    readPrCacheFileMock.mockResolvedValueOnce(buildDiskCache());
    await hydratePrCache();
    const keys = _getPrCacheKeysForTests();
    // Fresh open + stale merged survive; stale open is dropped.
    expect(keys).toContain('o/r#1');
    expect(keys).not.toContain('o/r#2');
    expect(keys).toContain('o/r#3');
  });

  it('serves entries written recently enough to be within getPR TTL', async () => {
    const now = Date.now();
    const freshBlob = JSON.stringify({
      version: 1,
      entries: {
        'o/r#1': {
          at: now - 1000,
          pr: {
            number: 1,
            title: 'fresh-open',
            state: 'open',
            headRef: 'feat/fresh',
            url: '',
          },
        },
      },
    });
    readPrCacheFileMock.mockResolvedValueOnce(freshBlob);
    await hydratePrCache();
    const pr = await getPR('o', 'r', 1);
    expect(pr?.title).toBe('fresh-open');
    expect(graphqlMock).not.toHaveBeenCalled();
  });

  it('keeps stale merged-PR entries because their fields are immutable', async () => {
    readPrCacheFileMock.mockResolvedValueOnce(buildDiskCache());
    await hydratePrCache();
    const keys = _getPrCacheKeysForTests();
    expect(keys).toContain('o/r#3');
  });

  it('enforces maxSize after bulk hydrate from disk (round-7 UF-2)', async () => {
    // setWithTimestamp intentionally skips the FIFO trim (cacheUtils.ts:57)
    // so bulk loaders can insert without per-entry overhead, but that left
    // the `maxSize: 500` cap on prCache unenforced on the restart path: a
    // persisted cache of thousands of merged-PR entries would hydrate in
    // full and only shrink back to 500 after several subsequent set() calls.
    // hydratePrCache now calls trim() once after the bulk load.
    const now = Date.now();
    const entries: Record<string, { at: number; pr: unknown }> = {};
    for (let i = 0; i < 750; i++) {
      entries[`o/r#${i}`] = {
        at: now - 60 * 60 * 1000,
        pr: {
          number: i,
          title: `PR ${i}`,
          state: 'merged',
          mergeCommitSha: `merge-${i}`,
          headRef: `feat/${i}`,
          headSha: `tip-${i}`,
          url: `https://github.com/o/r/pull/${i}`,
        },
      };
    }
    readPrCacheFileMock.mockResolvedValueOnce(
      JSON.stringify({ version: 1, entries }),
    );
    await hydratePrCache();
    expect(_getPrCacheKeysForTests().length).toBeLessThanOrEqual(500);
  });
});

describe('invalidatePrCacheForRepo', () => {
  beforeEach(() => {
    _clearPrCacheForTests();
    graphqlMock.mockReset();
    initGithub('test-token');
  });

  it('soft-expires only the entries for the named repo (other repos unaffected)', async () => {
    // Soft-mark-stale semantics: entries for the named repo have their TTL
    // forced to 0 so `getPR()` misses and refetches, but they remain in the
    // map so `getStale()` can preserve `mergeTimeHeadSha` for the refetch.
    // Entries for OTHER repos are untouched.
    const now = Date.now();
    const blob = JSON.stringify({
      version: 1,
      entries: {
        'owner1/repoA#1': {
          at: now - 1000,
          pr: { number: 1, title: 'a1', state: 'open', headRef: 'feat/a1', url: '' },
        },
        'owner1/repoA#2': {
          at: now - 1000,
          pr: { number: 2, title: 'a2', state: 'open', headRef: 'feat/a2', url: '' },
        },
        'owner2/repoB#1': {
          at: now - 1000,
          pr: { number: 1, title: 'b1', state: 'open', headRef: 'feat/b1', url: '' },
        },
      },
    });
    readPrCacheFileMock.mockResolvedValueOnce(blob);
    await hydratePrCache();
    expect(_getPrCacheKeysForTests().sort()).toEqual([
      'owner1/repoA#1',
      'owner1/repoA#2',
      'owner2/repoB#1',
    ]);

    invalidatePrCacheForRepo('owner1', 'repoA');

    // All keys still present (entries remain for getStale fallback).
    expect(_getPrCacheKeysForTests().sort()).toEqual([
      'owner1/repoA#1',
      'owner1/repoA#2',
      'owner2/repoB#1',
    ]);
    // But a batchFetchPRs for the invalidated repo triggers a GraphQL call —
    // proves the soft-expire worked (cached entries miss on `get()`).
    graphqlMock.mockResolvedValueOnce({
      repository: {
        p1: {
          number: 1,
          title: 'a1-refetched',
          state: 'OPEN',
          merged: false,
          mergedAt: null,
          mergeCommit: null,
          headRefName: 'feat/a1',
          headRefOid: 'fresh-tip',
          url: '',
          isDraft: false,
          mergeable: 'MERGEABLE',
          reviewDecision: null,
          commits: { nodes: [] },
        },
      },
    });
    const refetched = await batchFetchPRs('owner1', 'repoA', [1]);
    expect(refetched.get(1)?.title).toBe('a1-refetched');
    expect(graphqlMock).toHaveBeenCalledTimes(1);

    // Conversely, the other repo's cache entry is still fresh — no network
    // call needed.
    graphqlMock.mockReset();
    const unaffected = await batchFetchPRs('owner2', 'repoB', [1]);
    expect(unaffected.get(1)?.title).toBe('b1');
    expect(graphqlMock).not.toHaveBeenCalled();
  });

  it('is a no-op (and skips the disk write) when the repo has no entries', async () => {
    expect(() => invalidatePrCacheForRepo('owner', 'repo')).not.toThrow();
    expect(_getPrCacheKeysForTests()).toEqual([]);
  });
});

describe('listOpenPRsForBranches caching', () => {
  beforeEach(() => {
    invalidateOpenPrListCache();
    paginateMock.mockReset();
    initGithub('test-token');
  });

  // Build a fake `pulls.list` paginated response.
  const fakePr = (n: number, ref: string) => ({
    number: n,
    title: `PR ${n}`,
    head: { ref },
    html_url: `https://github.com/o/r/pull/${n}`,
    draft: false,
  });

  it('serves a second call from cache without re-paginating', async () => {
    paginateMock.mockResolvedValue([fakePr(1, 'feat/a'), fakePr(2, 'feat/b')]);

    const a = await listOpenPRsForBranches('o', 'r', ['feat/a', 'feat/b']);
    const b = await listOpenPRsForBranches('o', 'r', ['feat/a', 'feat/b']);

    expect(a.size).toBe(2);
    expect(b.size).toBe(2);
    expect(paginateMock).toHaveBeenCalledTimes(1);
  });

  it('filters cached results by the current branch set on each call', async () => {
    paginateMock.mockResolvedValue([fakePr(1, 'feat/a'), fakePr(2, 'feat/b')]);

    const all = await listOpenPRsForBranches('o', 'r', ['feat/a', 'feat/b']);
    const onlyA = await listOpenPRsForBranches('o', 'r', ['feat/a']);

    expect(all.size).toBe(2);
    expect(onlyA.size).toBe(1);
    expect(onlyA.get('feat/a')?.number).toBe(1);
    // Still only one underlying paginate call.
    expect(paginateMock).toHaveBeenCalledTimes(1);
  });

  it('re-paginates after invalidate', async () => {
    paginateMock.mockResolvedValueOnce([fakePr(1, 'feat/a')]);
    paginateMock.mockResolvedValueOnce([fakePr(1, 'feat/a'), fakePr(2, 'feat/b')]);

    await listOpenPRsForBranches('o', 'r', ['feat/a', 'feat/b']);
    invalidateOpenPrListCache('o', 'r');
    const after = await listOpenPRsForBranches('o', 'r', ['feat/a', 'feat/b']);

    expect(after.size).toBe(2);
    expect(paginateMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to a stale entry when a refresh fetch throws', async () => {
    paginateMock.mockResolvedValueOnce([fakePr(1, 'feat/a')]);
    paginateMock.mockRejectedValueOnce(new Error('rate limited'));

    await listOpenPRsForBranches('o', 'r', ['feat/a']);
    invalidateOpenPrListCache('o', 'r');
    // After targeted invalidate (now soft-expire), a failed refetch must
    // recover the prior list via getStale() rather than collapsing to []
    // — otherwise a single flaky tick wipes every branch's open-PR data.
    const out = await listOpenPRsForBranches('o', 'r', ['feat/a']);
    expect(out.size).toBe(1);
    expect(out.get('feat/a')?.number).toBe(1);
  });
});

describe('validateToken', () => {
  beforeEach(() => {
    usersGetAuthenticatedMock.mockReset();
  });

  it('returns "missing" when no token is set without calling the API', async () => {
    initGithub('');
    const result = await validateToken();
    expect(result).toBe('missing');
    expect(usersGetAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('returns "valid" on a 200 response', async () => {
    initGithub('good-token');
    usersGetAuthenticatedMock.mockResolvedValue({ data: { login: 'octocat' } });
    expect(await validateToken()).toBe('valid');
    expect(usersGetAuthenticatedMock).toHaveBeenCalledTimes(1);
  });

  it('returns "invalid" on 401 (bad credentials)', async () => {
    initGithub('expired-token');
    usersGetAuthenticatedMock.mockRejectedValue({ status: 401, message: 'Bad credentials' });
    expect(await validateToken()).toBe('invalid');
  });

  it('returns "invalid" on 403 (forbidden / revoked)', async () => {
    initGithub('revoked-token');
    usersGetAuthenticatedMock.mockRejectedValue({ status: 403, message: 'Forbidden' });
    expect(await validateToken()).toBe('invalid');
  });

  it('falls back to "valid" on inconclusive network errors so an offline launch doesn\'t false-flag a working token', async () => {
    initGithub('token-during-outage');
    usersGetAuthenticatedMock.mockRejectedValue(new Error('ENOTFOUND api.github.com'));
    // Silence the console.warn the implementation emits for inconclusive errors.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await validateToken()).toBe('valid');
    warnSpy.mockRestore();
  });

  it('falls back to "valid" on 5xx server errors', async () => {
    initGithub('token-during-github-outage');
    usersGetAuthenticatedMock.mockRejectedValue({ status: 503, message: 'Service Unavailable' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await validateToken()).toBe('valid');
    warnSpy.mockRestore();
  });
});

describe('expirePrEntriesByNumbers', () => {
  beforeEach(() => {
    _clearPrCacheForTests();
    graphqlMock.mockReset();
    initGithub('test-token');
  });

  const openPRResponse = (num: number, headOid: string) => ({
    repository: {
      [`p${num}`]: {
        number: num,
        title: `PR ${num}`,
        state: 'OPEN',
        merged: false,
        mergedAt: null,
        mergeCommit: null,
        headRefName: `feat/${num}`,
        headRefOid: headOid,
        url: `https://github.com/o/r/pull/${num}`,
        isDraft: false,
        mergeable: 'MERGEABLE',
        reviewDecision: null,
        commits: { nodes: [] },
      },
    },
  });

  const mergedPRResponse = (num: number, headOid: string) => ({
    repository: {
      [`p${num}`]: {
        number: num,
        title: `PR ${num}`,
        state: 'MERGED',
        merged: true,
        mergedAt: '2026-01-01T00:00:00Z',
        mergeCommit: { oid: `merge-${num}` },
        headRefName: `feat/${num}`,
        headRefOid: headOid,
        url: `https://github.com/o/r/pull/${num}`,
        isDraft: false,
        mergeable: 'MERGEABLE',
        reviewDecision: null,
        commits: { nodes: [] },
      },
    },
  });

  it('soft-expires only the specified PR numbers, leaving siblings warm', async () => {
    // Cache three PRs from one repo and one from another. Calling
    // expirePrEntriesByNumbers([42, 43]) should make 42/43's next get()
    // miss (forcing refetch) while 44 and the cross-repo entry stay warm.
    graphqlMock.mockResolvedValueOnce({
      repository: {
        ...openPRResponse(42, 'tip-42').repository,
        ...openPRResponse(43, 'tip-43').repository,
        ...openPRResponse(44, 'tip-44').repository,
      },
    });
    await batchFetchPRs('o', 'r', [42, 43, 44]);
    graphqlMock.mockResolvedValueOnce(openPRResponse(99, 'tip-99'));
    await batchFetchPRs('other', 'repo', [99]);

    expirePrEntriesByNumbers('o', 'r', [42, 43]);

    // Refetch all four; expect 42 and 43 to hit the network (one merged
    // call covering both), and 44 + cross-repo 99 to be served from cache
    // (no graphql call).
    graphqlMock.mockResolvedValueOnce({
      repository: {
        ...mergedPRResponse(42, 'tip-42').repository,
        ...mergedPRResponse(43, 'tip-43').repository,
      },
    });
    graphqlMock.mockClear();
    const refetched = await batchFetchPRs('o', 'r', [42, 43, 44]);
    expect(graphqlMock).toHaveBeenCalledTimes(1);
    expect(refetched.get(42)?.state).toBe('merged');
    expect(refetched.get(43)?.state).toBe('merged');
    expect(refetched.get(44)?.state).toBe('open');

    graphqlMock.mockClear();
    const crossRepo = await batchFetchPRs('other', 'repo', [99]);
    expect(graphqlMock).not.toHaveBeenCalled();
    expect(crossRepo.get(99)?.state).toBe('open');
  });

  it('preserves mergeTimeHeadSha + observedLive across the soft-expire + refetch path', async () => {
    // The same freeze-preservation guarantee that invalidatePrCacheForRepo
    // gives us — verified for the targeted helper too. This is the load-
    // bearing property that lets the background-tick path use soft-expire
    // safely without dropping observedLive=true. Uses fake timers to step
    // past the 5-min TTL between observations (matches the open→merged
    // transition test at line ~213).
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      graphqlMock.mockResolvedValueOnce(openPRResponse(42, 'open-tip'));
      await batchFetchPRs('o', 'r', [42]);

      vi.setSystemTime(new Date('2026-01-01T00:06:00Z'));
      graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'merge-tip'));
      await batchFetchPRs('o', 'r', [42]);

      // Soft-expire mid-window — the next get() misses, getStale() still
      // returns the merged entry so setPrCacheEntry preserves the freeze.
      expirePrEntriesByNumbers('o', 'r', [42]);

      graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'post-merge-tip'));
      const refetched = await batchFetchPRs('o', 'r', [42]);
      const pr = refetched.get(42);
      expect(pr?.headSha).toBe('post-merge-tip');
      expect(pr?.mergeTimeHeadSha).toBe('merge-tip');
      expect(pr?.mergeTimeHeadShaObservedLive).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a no-op for an empty number list', () => {
    expirePrEntriesByNumbers('o', 'r', []);
    // No throw, no state changes — function should return early without
    // iterating the cache.
    expect(_getPrCacheKeysForTests()).toEqual([]);
  });

  it('skips numbers with no cache entry', async () => {
    graphqlMock.mockResolvedValueOnce(openPRResponse(42, 'tip-42'));
    await batchFetchPRs('o', 'r', [42]);
    // 999 isn't cached — expire() returns false for it and is a no-op.
    // 42's entry should still be expired.
    expirePrEntriesByNumbers('o', 'r', [42, 999]);
    graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'tip-42'));
    const refetched = await batchFetchPRs('o', 'r', [42]);
    expect(refetched.get(42)?.state).toBe('merged');
  });
});

describe('expireOpenPrEntries', () => {
  beforeEach(() => {
    _clearPrCacheForTests();
    graphqlMock.mockReset();
    initGithub('test-token');
  });

  const openPRResponse = (num: number) => ({
    repository: {
      [`p${num}`]: {
        number: num,
        title: `PR ${num}`,
        state: 'OPEN',
        merged: false,
        mergedAt: null,
        mergeCommit: null,
        headRefName: `feat/${num}`,
        headRefOid: `tip-${num}`,
        url: `https://github.com/o/r/pull/${num}`,
        isDraft: false,
        mergeable: 'MERGEABLE',
        reviewDecision: null,
        commits: { nodes: [] },
      },
    },
  });

  const mergedPRResponse = (num: number) => ({
    repository: {
      [`p${num}`]: {
        number: num,
        title: `PR ${num}`,
        state: 'MERGED',
        merged: true,
        mergedAt: '2026-01-01T00:00:00Z',
        mergeCommit: { oid: `merge-${num}` },
        headRefName: `feat/${num}`,
        headRefOid: `tip-${num}`,
        url: `https://github.com/o/r/pull/${num}`,
        isDraft: false,
        mergeable: 'MERGEABLE',
        reviewDecision: null,
        commits: { nodes: [] },
      },
    },
  });

  const closedPRResponse = (num: number) => ({
    repository: {
      [`p${num}`]: {
        number: num,
        title: `PR ${num}`,
        state: 'CLOSED',
        merged: false,
        mergedAt: null,
        mergeCommit: null,
        headRefName: `feat/${num}`,
        headRefOid: `tip-${num}`,
        url: `https://github.com/o/r/pull/${num}`,
        isDraft: false,
        mergeable: 'MERGEABLE',
        reviewDecision: null,
        commits: { nodes: [] },
      },
    },
  });

  it('expires non-terminal (open + closed) entries; leaves merged warm', async () => {
    // Seed the cache: open PR 1, merged PR 2, closed PR 4, plus a cross-repo
    // open PR 3. After expireOpenPrEntries, 1, 3, and 4 should refetch on
    // next read (reopen→merge between sessions is possible for closed PRs);
    // only merged PR 2 stays warm (GitHub disallows reopening a merged PR).
    graphqlMock.mockResolvedValueOnce(openPRResponse(1));
    await batchFetchPRs('o', 'r', [1]);
    graphqlMock.mockResolvedValueOnce(mergedPRResponse(2));
    await batchFetchPRs('o', 'r', [2]);
    graphqlMock.mockResolvedValueOnce(openPRResponse(3));
    await batchFetchPRs('other', 'repo', [3]);
    graphqlMock.mockResolvedValueOnce(closedPRResponse(4));
    await batchFetchPRs('o', 'r', [4]);

    expireOpenPrEntries();

    // Open PR 1 — refetched (now merged).
    graphqlMock.mockResolvedValueOnce(mergedPRResponse(1));
    graphqlMock.mockClear();
    const r1 = await batchFetchPRs('o', 'r', [1]);
    expect(graphqlMock).toHaveBeenCalledTimes(1);
    expect(r1.get(1)?.state).toBe('merged');

    // Merged PR 2 — served from cache (no graphql call).
    graphqlMock.mockClear();
    const r2 = await batchFetchPRs('o', 'r', [2]);
    expect(graphqlMock).not.toHaveBeenCalled();
    expect(r2.get(2)?.state).toBe('merged');

    // Cross-repo open PR 3 — also refetched (repo-agnostic helper).
    graphqlMock.mockResolvedValueOnce(openPRResponse(3));
    graphqlMock.mockClear();
    const r3 = await batchFetchPRs('other', 'repo', [3]);
    expect(graphqlMock).toHaveBeenCalledTimes(1);
    expect(r3.get(3)?.state).toBe('open');

    // Closed PR 4 — refetched (simulates reopen+merge between sessions).
    graphqlMock.mockResolvedValueOnce(mergedPRResponse(4));
    graphqlMock.mockClear();
    const r4 = await batchFetchPRs('o', 'r', [4]);
    expect(graphqlMock).toHaveBeenCalledTimes(1);
    expect(r4.get(4)?.state).toBe('merged');
  });

  it('is a no-op when only merged entries are cached', async () => {
    graphqlMock.mockResolvedValueOnce(mergedPRResponse(2));
    await batchFetchPRs('o', 'r', [2]);

    expireOpenPrEntries();

    // Merged entry stays warm — refetch hits cache.
    graphqlMock.mockClear();
    const result = await batchFetchPRs('o', 'r', [2]);
    expect(graphqlMock).not.toHaveBeenCalled();
    expect(result.get(2)?.state).toBe('merged');
  });
});

describe('schedulePersist preserves soft-expired entries on disk (F003/F021 regression)', () => {
  // Regression suite for the round-9 finding: schedulePersist previously
  // skipped any entry with `at === 0`, so any schedulePersist fired while
  // entries were soft-expired (after invalidatePrCacheForRepo, or an
  // unrelated refetch during the 500ms debounce window) would rewrite
  // prs.json WITHOUT those entries — dropping mergeTimeHeadSha and losing
  // crash-survival. Fix: expire() snapshots the pre-expire `at` onto
  // `expiredAt`, schedulePersist writes `expiredAt ?? at`, so soft-expired
  // entries round-trip through disk with their real prior timestamp.
  //
  // Each test waits on a custom writePrCacheFileMock to fire (the 500ms
  // debounce means we need real or fake timers plus the mock).

  const mergedPRResponse = (num: number, headOid: string) => ({
    repository: {
      [`p${num}`]: {
        number: num,
        title: `PR ${num}`,
        state: 'MERGED',
        merged: true,
        mergedAt: '2026-01-01T00:00:00Z',
        mergeCommit: { oid: `merge-${num}` },
        headRefName: `feat/${num}`,
        headRefOid: headOid,
        url: `https://github.com/o/r/pull/${num}`,
        isDraft: false,
        mergeable: 'MERGEABLE',
        reviewDecision: null,
        commits: { nodes: [] },
      },
    },
  });

  beforeEach(() => {
    _clearPrCacheForTests();
    graphqlMock.mockReset();
    writePrCacheFileMock.mockReset();
    writePrCacheFileMock.mockResolvedValue(undefined);
    initGithub('test-token');
  });

  it('persists soft-expired entries with their pre-expire timestamp (invalidate + persist round-trip)', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      // Seed with a merged PR — cold-bootstrap path, so mergeTimeHeadSha
      // gets frozen on first fetch.
      graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'merge-tip'));
      await batchFetchPRs('o', 'r', [42]);
      // Flush the debounced persist from batchFetchPRs.
      await vi.advanceTimersByTimeAsync(600);
      writePrCacheFileMock.mockClear();

      const invalidateAt = Date.parse('2026-01-01T00:05:00Z');
      vi.setSystemTime(new Date(invalidateAt));

      // Soft-invalidate and flush the debounce. The disk write must
      // contain the entry with its pre-expire timestamp, not `at: 0`.
      invalidatePrCacheForRepo('o', 'r');
      await vi.advanceTimersByTimeAsync(600);

      expect(writePrCacheFileMock).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(writePrCacheFileMock.mock.calls[0][0] as string);
      expect(payload.entries['o/r#42']).toBeDefined();
      expect(payload.entries['o/r#42'].at).not.toBe(0);
      // at should match the pre-expire fetch time (Date.now() at seed).
      expect(payload.entries['o/r#42'].at).toBe(
        Date.parse('2026-01-01T00:00:00Z'),
      );
      expect(payload.entries['o/r#42'].pr.mergeTimeHeadSha).toBe('merge-tip');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not drop soft-expired entries when an unrelated PR fetch triggers schedulePersist mid-debounce', async () => {
    // F003's most insidious symptom: invalidatePrCacheForRepo schedules a
    // persist, and before the 500ms debounce fires, an unrelated getPR /
    // batchFetchPRs on a different PR fires its own schedulePersist (which
    // clears the pending timeout). Under the old implementation, the
    // eventual single disk write skipped all at=0 entries, permanently
    // losing them even though the map still held them. With expiredAt, the
    // race-triggered write still contains them.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      // Seed two merged PRs in different repos.
      graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'merge-tip-42'));
      await batchFetchPRs('o', 'r', [42]);
      await vi.advanceTimersByTimeAsync(600);

      graphqlMock.mockResolvedValueOnce(mergedPRResponse(99, 'merge-tip-99'));
      await batchFetchPRs('other', 'repo', [99]);
      await vi.advanceTimersByTimeAsync(600);
      writePrCacheFileMock.mockClear();

      // Invalidate repo o/r, then immediately fetch PR 99 on the other
      // repo (cached — but force-refetch by clearing cache for it would
      // require plumbing; instead, simulate via getPR on a fresh PR).
      vi.setSystemTime(new Date('2026-01-01T00:05:00Z'));
      invalidatePrCacheForRepo('o', 'r');

      // Unrelated fetch that also schedules persist (resets the debounce).
      graphqlMock.mockResolvedValueOnce(mergedPRResponse(100, 'merge-tip-100'));
      // getPR-style fetch — need to fire the persist without affecting
      // o/r#42's entry. Advance a tick but don't fire the debounce yet.
      await batchFetchPRs('x', 'y', [100]);

      // Flush the combined debounce.
      await vi.advanceTimersByTimeAsync(600);

      expect(writePrCacheFileMock).toHaveBeenCalled();
      const calls = writePrCacheFileMock.mock.calls;
      const payload = JSON.parse(calls[calls.length - 1][0] as string);
      // The soft-expired o/r#42 entry MUST still be on disk with its
      // pre-expire timestamp.
      expect(payload.entries['o/r#42']).toBeDefined();
      expect(payload.entries['o/r#42'].at).toBe(
        Date.parse('2026-01-01T00:00:00Z'),
      );
      expect(payload.entries['o/r#42'].pr.mergeTimeHeadSha).toBe('merge-tip-42');
    } finally {
      vi.useRealTimers();
    }
  });

  it('crash-after-invalidate: rehydrating from the disk blob recovers freeze + observedLive', async () => {
    // Full crash-survival trace: set up an observedLive=true PR, invalidate,
    // capture the persist payload, then simulate a restart by clearing the
    // cache and rehydrating from the captured blob. getStale must still
    // return the frozen mergeTimeHeadSha.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      // Observe PR 42 open, then merged — gives observedLive=true.
      graphqlMock.mockResolvedValueOnce({
        repository: {
          p42: {
            number: 42,
            title: 'PR 42',
            state: 'OPEN',
            merged: false,
            mergedAt: null,
            mergeCommit: null,
            headRefName: 'feat/42',
            headRefOid: 'open-tip',
            url: 'https://github.com/o/r/pull/42',
            isDraft: false,
            mergeable: 'MERGEABLE',
            reviewDecision: null,
            commits: { nodes: [] },
          },
        },
      });
      await batchFetchPRs('o', 'r', [42]);
      await vi.advanceTimersByTimeAsync(600);

      vi.setSystemTime(new Date('2026-01-01T00:06:00Z'));
      graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'merge-tip'));
      await batchFetchPRs('o', 'r', [42]);
      await vi.advanceTimersByTimeAsync(600);
      writePrCacheFileMock.mockClear();

      // Invalidate, let persist fire.
      invalidatePrCacheForRepo('o', 'r');
      await vi.advanceTimersByTimeAsync(600);

      expect(writePrCacheFileMock).toHaveBeenCalledTimes(1);
      const capturedBlob = writePrCacheFileMock.mock.calls[0][0] as string;
      const parsed = JSON.parse(capturedBlob);
      // Entry is on disk with real timestamp + preserved freeze metadata.
      expect(parsed.entries['o/r#42'].pr.mergeTimeHeadSha).toBe('merge-tip');
      expect(parsed.entries['o/r#42'].pr.mergeTimeHeadShaObservedLive).toBe(true);

      // Simulate app restart: clear memory, rehydrate from captured blob.
      _clearPrCacheForTests();
      readPrCacheFileMock.mockResolvedValueOnce(capturedBlob);
      await hydratePrCache();

      // Cache now holds the entry again — a follow-up fetch hits
      // setPrCacheEntry's first branch (prior freeze wins).
      vi.setSystemTime(new Date('2026-01-01T00:12:00Z'));
      graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'post-merge-tip'));
      const result = await batchFetchPRs('o', 'r', [42]);
      const pr = result.get(42);
      expect(pr?.headSha).toBe('post-merge-tip');
      expect(pr?.mergeTimeHeadSha).toBe('merge-tip');
      expect(pr?.mergeTimeHeadShaObservedLive).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('upgrade-compat: rehydrated `at: 0` entries from a pre-fix release are not silently dropped on the next persist', async () => {
    // Round-9 F003: a pre-fix release's `expire()` zeroed `at` without
    // snapshotting it onto `expiredAt`, so a disk blob written by that
    // release carries `{at: 0, pr: <merged-pr>}`. With the new
    // `persistAt = entry.expiredAt ?? entry.at` rule in schedulePersist,
    // any rehydrated legacy at:0 entry resolves to `null ?? 0 = 0` and
    // gets dropped by the `if (persistAt === 0) continue` guard — silently
    // wiping mergeTimeHeadSha off disk on the first post-upgrade persist.
    //
    // Fix lives in hydratePrCache: when v.at === 0 (legacy disk shape),
    // re-stamp it with `Date.now() - Math.floor(STALE_OPEN_PR_MS / 2)` so
    // the entry enters the cache with a synthetic-but-non-zero timestamp.
    // schedulePersist then writes a real number, and the legacy entry
    // round-trips cleanly across the upgrade boundary.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-04-01T00:00:00Z'));
      // Synthetic pre-fix disk blob: at:0 + merged PR with full freeze
      // metadata (mergeTimeHeadSha + observedLive=true). This is exactly
      // what release 49581fe would have written after a user-initiated
      // refresh that soft-expired the entry.
      const legacyBlob = JSON.stringify({
        version: 1,
        entries: {
          'o/r#42': {
            at: 0,
            pr: {
              number: 42,
              title: 'PR 42',
              state: 'merged',
              mergeCommitSha: 'merge-42',
              headRef: 'feat/42',
              headSha: 'merge-tip',
              mergeTimeHeadSha: 'merge-tip',
              mergeTimeHeadShaObservedLive: true,
              url: 'https://github.com/o/r/pull/42',
            },
          },
        },
      });
      readPrCacheFileMock.mockResolvedValueOnce(legacyBlob);
      await hydratePrCache();

      // Trigger schedulePersist via batchFetchPRs on an UNRELATED PR. The
      // fetch path calls schedulePersist() unconditionally at its tail
      // (githubService.ts:460), so this works even though o/r#42 itself
      // isn't being refetched.
      graphqlMock.mockResolvedValueOnce(mergedPRResponse(100, 'merge-tip-100'));
      await batchFetchPRs('x', 'y', [100]);
      await vi.advanceTimersByTimeAsync(600);

      expect(writePrCacheFileMock).toHaveBeenCalled();
      const calls = writePrCacheFileMock.mock.calls;
      const payload = JSON.parse(calls[calls.length - 1][0] as string);
      // Legacy at:0 entry survives the upgrade — present on disk with a
      // non-zero timestamp and freeze metadata intact.
      expect(payload.entries['o/r#42']).toBeDefined();
      expect(payload.entries['o/r#42'].at).not.toBe(0);
      // Synthetic timestamp lands at Date.now() - STALE_OPEN_PR_MS/2 ≈
      // 3.5 days ago. We don't assert exact value (it's an implementation
      // detail of the clamp), only that it's a plausible recent timestamp:
      // strictly less than now and strictly greater than a year ago.
      const now = Date.parse('2026-04-01T00:00:00Z');
      expect(payload.entries['o/r#42'].at).toBeGreaterThan(now - 365 * 24 * 60 * 60 * 1000);
      expect(payload.entries['o/r#42'].at).toBeLessThan(now);
      // Freeze + observedLive survive the round-trip.
      expect(payload.entries['o/r#42'].pr.mergeTimeHeadSha).toBe('merge-tip');
      expect(payload.entries['o/r#42'].pr.mergeTimeHeadShaObservedLive).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
