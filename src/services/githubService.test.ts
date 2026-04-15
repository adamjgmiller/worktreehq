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
import { readPrCacheFile } from './tauriBridge';
const readPrCacheFileMock = readPrCacheFile as unknown as ReturnType<typeof vi.fn>;

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
  initGithub,
  hydratePrCache,
  getPR,
  listOpenPRsForBranches,
  invalidateOpenPrListCache,
  invalidatePrCacheForRepo,
  validateToken,
  _clearPrCacheForTests,
  _getPrCacheKeysForTests,
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

  it('bootstraps mergeTimeHeadSha from live headSha on first fetch of a merged PR', async () => {
    graphqlMock.mockResolvedValueOnce(mergedPRResponse(42, 'initial-tip'));
    const result = await batchFetchPRs('o', 'r', [42]);
    const pr = result.get(42);
    expect(pr?.headSha).toBe('initial-tip');
    expect(pr?.mergeTimeHeadSha).toBe('initial-tip');
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
});

describe('invalidatePrCacheForRepo', () => {
  beforeEach(() => {
    _clearPrCacheForTests();
    graphqlMock.mockReset();
    initGithub('test-token');
  });

  it('drops only the entries for the named repo', async () => {
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

    expect(_getPrCacheKeysForTests()).toEqual(['owner2/repoB#1']);
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
    const out = await listOpenPRsForBranches('o', 'r', ['feat/a']);
    expect(out.size).toBe(0);
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
