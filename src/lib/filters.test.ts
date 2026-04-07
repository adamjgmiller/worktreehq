import { describe, it, expect } from 'vitest';
import { applyPreset, searchBranches } from './filters';
import type { Branch } from '../types';

function b(over: Partial<Branch>): Branch {
  return {
    name: 'x',
    hasLocal: true,
    hasRemote: true,
    lastCommitDate: new Date().toISOString(),
    lastCommitSha: 'a',
    aheadOfMain: 0,
    behindMain: 0,
    mergeStatus: 'unmerged',
    ...over,
  };
}

describe('applyPreset', () => {
  const branches: Branch[] = [
    b({ name: 'merged-normal', mergeStatus: 'merged-normally' }),
    b({ name: 'merged-squash', mergeStatus: 'squash-merged' }),
    b({ name: 'has-wt', mergeStatus: 'merged-normally', worktreePath: '/x' }),
    b({ name: 'stale', mergeStatus: 'stale' }),
    b({ name: 'orphan', hasLocal: true, hasRemote: false, upstreamGone: true }),
    b({ name: 'active-pr', pr: { number: 1, title: 't', state: 'open', headRef: 'active-pr', url: '' } }),
  ];

  it('safe-to-delete excludes worktree-attached', () => {
    const out = applyPreset(branches, 'safe-to-delete').map((x) => x.name);
    expect(out).toContain('merged-normal');
    expect(out).toContain('merged-squash');
    expect(out).not.toContain('has-wt');
  });
  it('stale only stale', () => {
    expect(applyPreset(branches, 'stale').map((x) => x.name)).toEqual(['stale']);
  });
  it('active includes worktree or open PR', () => {
    const out = applyPreset(branches, 'active').map((x) => x.name);
    expect(out).toContain('has-wt');
    expect(out).toContain('active-pr');
  });
  it('orphaned finds upstream-gone locals', () => {
    const out = applyPreset(branches, 'orphaned').map((x) => x.name);
    expect(out).toContain('orphan');
  });
});

describe('searchBranches', () => {
  const bs = [b({ name: 'feat/login' }), b({ name: 'chore/deps' })];
  it('matches by name', () => {
    expect(searchBranches(bs, 'log').map((x) => x.name)).toEqual(['feat/login']);
  });
  it('empty returns all', () => {
    expect(searchBranches(bs, '').length).toBe(2);
  });
});
