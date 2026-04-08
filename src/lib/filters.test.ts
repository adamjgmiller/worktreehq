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

describe('applyPreset: default-branch guard', () => {
  // Guards against the edge case where the repo's default branch ends up matching
  // a destructive preset (e.g. fork named `main` showing up as squash-merged).
  // Git would reject the delete, but the UI should prevent the click entirely.
  it('safe-to-delete excludes the repo default branch', () => {
    const branches: Branch[] = [
      b({ name: 'main', mergeStatus: 'squash-merged' }),
      b({ name: 'feature', mergeStatus: 'squash-merged' }),
    ];
    const out = applyPreset(branches, 'safe-to-delete', { defaultBranch: 'main' }).map(
      (x) => x.name,
    );
    expect(out).toEqual(['feature']);
  });
  it('stale excludes the repo default branch', () => {
    const branches: Branch[] = [
      b({ name: 'main', mergeStatus: 'stale' }),
      b({ name: 'old-branch', mergeStatus: 'stale' }),
    ];
    const out = applyPreset(branches, 'stale', { defaultBranch: 'main' }).map((x) => x.name);
    expect(out).toEqual(['old-branch']);
  });
  it('orphaned excludes the repo default branch', () => {
    const branches: Branch[] = [
      b({ name: 'main', hasLocal: true, hasRemote: false, upstreamGone: true }),
      b({ name: 'stray', hasLocal: true, hasRemote: false, upstreamGone: true }),
    ];
    const out = applyPreset(branches, 'orphaned', { defaultBranch: 'main' }).map(
      (x) => x.name,
    );
    expect(out).toEqual(['stray']);
  });
});

describe('applyPreset: mine', () => {
  const branches: Branch[] = [
    b({ name: 'ada-branch', authorEmail: 'ada@example.com' }),
    b({ name: 'grace-branch', authorEmail: 'grace@example.com' }),
    b({ name: 'unknown-branch' }),
    b({ name: 'ada-upper', authorEmail: 'ADA@Example.com' }),
  ];

  it('matches the current user email case-insensitively', () => {
    const out = applyPreset(branches, 'mine', { userEmail: 'ada@example.com' }).map((x) => x.name);
    expect(out).toEqual(['ada-branch', 'ada-upper']);
  });
  it('returns empty when no user email is supplied', () => {
    expect(applyPreset(branches, 'mine').length).toBe(0);
    expect(applyPreset(branches, 'mine', { userEmail: '' }).length).toBe(0);
  });
  it('ignores branches with no recorded authorEmail', () => {
    const out = applyPreset(branches, 'mine', { userEmail: 'someone-else@example.com' });
    expect(out.map((x) => x.name)).toEqual([]);
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
