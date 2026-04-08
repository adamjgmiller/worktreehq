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
}));
vi.mock('./githubService', () => ({
  batchFetchPRs: vi.fn(async () => new Map()),
}));

import { cherryCheck } from './gitService';
const cherryCheckMock = cherryCheck as unknown as ReturnType<typeof vi.fn>;

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
    cherryCheckMock.mockImplementation(async (_repo: string, _main: string, ref: string) =>
      ref === 'feat/a',
    );

    const first = await detectSquashMerges(makeInput());
    expect(cherryCheckMock).toHaveBeenCalledTimes(2);
    expect(first.updatedBranches.find((b) => b.name === 'feat/a')!.mergeStatus).toBe(
      'squash-merged',
    );
    expect(first.updatedBranches.find((b) => b.name === 'feat/b')!.mergeStatus).toBe('unmerged');

    const second = await detectSquashMerges(makeInput());
    // Cache hit → cherryCheck is NOT called again.
    expect(cherryCheckMock).toHaveBeenCalledTimes(2);
    expect(second.updatedBranches.find((b) => b.name === 'feat/a')!.mergeStatus).toBe(
      'squash-merged',
    );
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
