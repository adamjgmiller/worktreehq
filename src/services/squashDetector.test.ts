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
const cherryCheckMock = cherryCheck as unknown as ReturnType<typeof vi.fn>;
const resolveMainUpstreamsMock = resolveMainUpstreams as unknown as ReturnType<typeof vi.fn>;

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
});
