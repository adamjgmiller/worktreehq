import { describe, it, expect, vi, beforeEach } from 'vitest';

// The bridge is imported transitively via githubService; stub it so imports are
// safe in a non-Tauri test environment.
vi.mock('./tauriBridge', () => ({
  readPrCacheFile: vi.fn().mockResolvedValue(''),
  writePrCacheFile: vi.fn().mockResolvedValue(undefined),
}));

// Mock Octokit with a configurable graphql method per test.
const graphqlMock = vi.fn();
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    graphql: graphqlMock,
    pulls: { list: vi.fn(), get: vi.fn() },
    paginate: vi.fn(),
  })),
}));

import {
  mapChecksStatus,
  mapMergeable,
  mapReviewDecision,
  batchFetchPRs,
  initGithub,
  _clearPrCacheForTests,
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
