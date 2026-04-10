import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parsePrNumberFromSubject,
  isStale,
  detectSquashMerges,
  _clearCherryCacheForTests,
} from './squashDetector';
import type { Branch } from '../types';

vi.mock('./gitService', () => ({
  cherryCheck: vi.fn(),
  // detectSquashMerges now resolves the upstream ref set (local + origin/main
  // when present) once per run and passes it into cherryCheck. Mock it to
  // the 2-ref shape so tests exercise the same code path production does.
  resolveMainUpstreams: vi.fn(async (_repo: string, defaultBranch: string) => [
    defaultBranch,
    `origin/${defaultBranch}`,
  ]),
}));
vi.mock('./githubService', () => ({
  batchFetchPRs: vi.fn(async () => new Map()),
}));

import { cherryCheck, resolveMainUpstreams } from './gitService';
import { batchFetchPRs } from './githubService';
const cherryCheckMock = cherryCheck as unknown as ReturnType<typeof vi.fn>;
const resolveMainUpstreamsMock = resolveMainUpstreams as unknown as ReturnType<typeof vi.fn>;
const batchFetchPRsMock = batchFetchPRs as unknown as ReturnType<typeof vi.fn>;

describe('parsePrNumberFromSubject', () => {
  it('extracts PR number from trailing (#N)', () => {
    expect(parsePrNumberFromSubject('Fix foo (#149)')).toBe(149);
    expect(parsePrNumberFromSubject('chore: update deps (#2)  ')).toBe(2);
  });
  it('returns undefined for no match', () => {
    expect(parsePrNumberFromSubject('Fix foo')).toBeUndefined();
    expect(parsePrNumberFromSubject('(#12) mid')).toBeUndefined();
  });
});

describe('isStale', () => {
  const base: Branch = {
    name: 'x',
    hasLocal: true,
    hasRemote: false,
    lastCommitDate: '',
    lastCommitSha: 'abc',
    aheadOfMain: 1,
    behindMain: 0,
    mergeStatus: 'unmerged',
  };
  it('true for unmerged older than 30 days', () => {
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    expect(isStale({ ...base, lastCommitDate: old })).toBe(true);
  });
  it('false for recent', () => {
    const recent = new Date(Date.now() - 5 * 86400_000).toISOString();
    expect(isStale({ ...base, lastCommitDate: recent })).toBe(false);
  });
  it('false if already merged', () => {
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    expect(isStale({ ...base, lastCommitDate: old, mergeStatus: 'merged-normally' })).toBe(false);
  });
  // An `'empty'` branch has no commits of its own — its lastCommitDate
  // reflects whatever main was at when the branch was created. Aging that
  // into `'stale'` would surface a "consider pruning" warning on a branch
  // the user just created and may not have started using yet.
  it('false if branch is empty (no commits of its own)', () => {
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    expect(isStale({ ...base, lastCommitDate: old, mergeStatus: 'empty' })).toBe(false);
  });
});

describe('detectSquashMerges: cherry-check cache', () => {
  beforeEach(() => {
    _clearCherryCacheForTests();
    cherryCheckMock.mockReset();
  });

  // With no owner/name provided, pass 1 is skipped and only the cherry-check
  // fallback runs. That's the path we want to measure.
  const makeInput = () => ({
    repoPath: '/repo',
    defaultBranch: 'main',
    mainCommits: [
      {
        sha: 'main-head',
        subject: '',
        date: new Date().toISOString(),
        prNumber: undefined,
      },
    ],
    branches: [
      {
        name: 'feat/a',
        hasLocal: true,
        hasRemote: false,
        lastCommitDate: new Date().toISOString(),
        lastCommitSha: 'sha-a',
        aheadOfMain: 1,
        behindMain: 0,
        mergeStatus: 'unmerged',
      } as Branch,
      {
        name: 'feat/b',
        hasLocal: true,
        hasRemote: false,
        lastCommitDate: new Date().toISOString(),
        lastCommitSha: 'sha-b',
        aheadOfMain: 1,
        behindMain: 0,
        mergeStatus: 'unmerged',
      } as Branch,
    ],
    tags: [],
  });

  it('caches results by (branch sha, main sha) so a second call skips the subprocess', async () => {
    cherryCheckMock.mockImplementation(
      async (_repo: string, _upstreams: string[], ref: string) => ref === 'feat/a',
    );

    const first = await detectSquashMerges(makeInput());
    expect(cherryCheckMock).toHaveBeenCalledTimes(2);
    expect(first.updatedBranches.find((b) => b.name === 'feat/a')!.mergeStatus).toBe(
      'squash-merged',
    );
    expect(first.updatedBranches.find((b) => b.name === 'feat/b')!.mergeStatus).toBe('unmerged');
    // cherryCheck received the full upstream set — this is the whole point of
    // the PR: detection must consider origin/main, not just local main.
    expect(cherryCheckMock.mock.calls[0]?.[1]).toEqual(['main', 'origin/main']);

    const second = await detectSquashMerges(makeInput());
    // Cache hit → cherryCheck is NOT called again.
    expect(cherryCheckMock).toHaveBeenCalledTimes(2);
    expect(second.updatedBranches.find((b) => b.name === 'feat/a')!.mergeStatus).toBe(
      'squash-merged',
    );
  });

  it('calls resolveMainUpstreams once per run, not per candidate branch', async () => {
    // Resolving the upstream set requires a rev-parse subprocess; doing it
    // N times (once per cherry candidate) in a 100-branch repo would be 100
    // extra subprocesses on every refresh tick. One call per run is the
    // whole point of hoisting the resolution into detectSquashMerges.
    resolveMainUpstreamsMock.mockClear();
    cherryCheckMock.mockResolvedValue(false);
    await detectSquashMerges(makeInput());
    expect(resolveMainUpstreamsMock).toHaveBeenCalledTimes(1);
    expect(cherryCheckMock).toHaveBeenCalledTimes(2); // two candidate branches
  });

  it('skips resolveMainUpstreams entirely when no branches need a cherry check', async () => {
    // If pass 1 already resolved every branch (or there are no unmerged
    // branches), the cherry fallback does nothing — and we shouldn't shell
    // out to rev-parse for an upstream set we're not going to use.
    resolveMainUpstreamsMock.mockClear();
    cherryCheckMock.mockReset();
    const input = makeInput();
    // Pre-mark both branches as something other than `unmerged` so they're
    // filtered out of cherryCandidates.
    input.branches.forEach((b) => {
      b.mergeStatus = 'merged-normally';
    });
    await detectSquashMerges(input);
    expect(resolveMainUpstreamsMock).not.toHaveBeenCalled();
    expect(cherryCheckMock).not.toHaveBeenCalled();
  });

  it('misses the cache when the branch sha moves', async () => {
    cherryCheckMock.mockResolvedValue(true);

    await detectSquashMerges(makeInput());
    expect(cherryCheckMock).toHaveBeenCalledTimes(2);

    const moved = makeInput();
    moved.branches[0].lastCommitSha = 'sha-a-new';
    await detectSquashMerges(moved);
    // feat/a re-checked (sha moved), feat/b still hits cache.
    expect(cherryCheckMock).toHaveBeenCalledTimes(3);
  });

  it('does not cache failures so they can be retried', async () => {
    cherryCheckMock.mockRejectedValue(new Error('transient'));

    await detectSquashMerges(makeInput());
    expect(cherryCheckMock).toHaveBeenCalledTimes(2);

    cherryCheckMock.mockResolvedValue(false);
    await detectSquashMerges(makeInput());
    // Both branches re-check because the prior failures weren't cached.
    expect(cherryCheckMock).toHaveBeenCalledTimes(4);
  });

  it('skips cherry-check for branches with an open PR', async () => {
    cherryCheckMock.mockResolvedValue(true);
    const input = makeInput();
    // Attach an open PR to feat/a — its patches may be on main via a
    // different PR, but the open PR means the user is still working on it.
    input.branches[0].pr = {
      number: 42,
      title: 'Add feature A',
      state: 'open',
      headRef: 'feat/a',
      url: 'https://github.com/o/r/pull/42',
    };
    const result = await detectSquashMerges(input);
    // feat/a should be excluded from cherry candidates → stays unmerged.
    expect(result.updatedBranches.find((b) => b.name === 'feat/a')!.mergeStatus).toBe('unmerged');
    // feat/b has no open PR → cherry-check runs and finds squash-merged.
    expect(result.updatedBranches.find((b) => b.name === 'feat/b')!.mergeStatus).toBe(
      'squash-merged',
    );
    // Only one cherry-check call (for feat/b), not two.
    expect(cherryCheckMock).toHaveBeenCalledTimes(1);
  });
});

describe('detectSquashMerges: PR-tag pass respects open PRs', () => {
  beforeEach(() => {
    _clearCherryCacheForTests();
    cherryCheckMock.mockReset();
    batchFetchPRsMock.mockReset();
  });

  it('does not tag a branch as squash-merged when it carries an open PR', async () => {
    // Simulate: PR #10 was squash-merged from `feat/x`, and a commit on main
    // references it. But the local `feat/x` branch already carries a DIFFERENT
    // open PR (e.g., new work pushed after the merge, or same branch name in a
    // fork workflow).
    const mergedPR = {
      number: 10,
      title: 'Old work',
      state: 'merged' as const,
      mergeCommitSha: 'main-sha-1',
      headRef: 'feat/x',
      url: 'https://github.com/o/r/pull/10',
    };
    batchFetchPRsMock.mockResolvedValue(new Map([[10, mergedPR]]));
    cherryCheckMock.mockResolvedValue(false);

    const result = await detectSquashMerges({
      repoPath: '/repo',
      defaultBranch: 'main',
      mainCommits: [
        { sha: 'main-sha-1', subject: 'feat: old work (#10)', date: new Date().toISOString(), prNumber: 10 },
      ],
      branches: [
        {
          name: 'feat/x',
          hasLocal: true,
          hasRemote: false,
          lastCommitDate: new Date().toISOString(),
          lastCommitSha: 'branch-sha',
          aheadOfMain: 3,
          behindMain: 1,
          mergeStatus: 'unmerged',
          // Open PR already attached by refreshLoop before squash detection.
          pr: {
            number: 20,
            title: 'New work',
            state: 'open' as const,
            headRef: 'feat/x',
            url: 'https://github.com/o/r/pull/20',
          },
        } as Branch,
      ],
      tags: [],
      owner: 'o',
      name: 'r',
    });

    const branch = result.updatedBranches.find((b) => b.name === 'feat/x')!;
    // Should stay unmerged — the open PR takes priority.
    expect(branch.mergeStatus).toBe('unmerged');
    // The open PR should NOT be overwritten by the merged PR.
    expect(branch.pr!.number).toBe(20);
    expect(branch.pr!.state).toBe('open');
  });
});

describe('detectSquashMerges: PR-tag pass reclassifies empty branches', () => {
  beforeEach(() => {
    _clearCherryCacheForTests();
    cherryCheckMock.mockReset();
    batchFetchPRsMock.mockReset();
  });

  // Regression: a branch tagged `empty` by listBranches (aheadOfMain === 0)
  // could still match a squash-merged PR — e.g. the branch was squash-merged
  // and then its ref was moved to point at main. The PR-tag pass used to
  // skip these because it only checked `mergeStatus === 'unmerged'`.
  it('reclassifies an empty branch as squash-merged when it matches a merged PR', async () => {
    const mergedPR = {
      number: 15,
      title: 'Ship feature Y',
      state: 'merged' as const,
      mergeCommitSha: 'main-sha-1',
      headRef: 'feat/y',
      url: 'https://github.com/o/r/pull/15',
    };
    batchFetchPRsMock.mockResolvedValue(new Map([[15, mergedPR]]));
    cherryCheckMock.mockResolvedValue(false);

    const result = await detectSquashMerges({
      repoPath: '/repo',
      defaultBranch: 'main',
      mainCommits: [
        { sha: 'main-sha-1', subject: 'feat: ship feature Y (#15)', date: new Date().toISOString(), prNumber: 15 },
      ],
      branches: [
        {
          name: 'feat/y',
          hasLocal: true,
          hasRemote: false,
          lastCommitDate: new Date().toISOString(),
          lastCommitSha: 'main-sha-1',
          aheadOfMain: 0,
          behindMain: 0,
          // listBranches tagged this as `empty` because aheadOfMain === 0.
          mergeStatus: 'empty',
        } as Branch,
      ],
      tags: [],
      owner: 'o',
      name: 'r',
    });

    const branch = result.updatedBranches.find((b) => b.name === 'feat/y')!;
    expect(branch.mergeStatus).toBe('squash-merged');
    expect(branch.pr!.number).toBe(15);
  });
});
