import { describe, it, expect } from 'vitest';
import { applyPreset, filterMine, searchBranches } from './filters';
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
  it('safe-to-delete includes empty branches older than 1 day', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const out = applyPreset(
      [...branches, b({ name: 'old-empty', mergeStatus: 'empty', lastCommitDate: twoDaysAgo })],
      'safe-to-delete',
    ).map((x) => x.name);
    expect(out).toContain('old-empty');
  });
  it('safe-to-delete includes direct-merged branches', () => {
    const out = applyPreset(
      [...branches, b({ name: 'direct', mergeStatus: 'direct-merged' })],
      'safe-to-delete',
    ).map((x) => x.name);
    expect(out).toContain('direct');
  });
  it('safe-to-delete excludes empty branches with missing date (safe direction)', () => {
    const out = applyPreset(
      [...branches, b({ name: 'no-date', mergeStatus: 'empty', lastCommitDate: '' })],
      'safe-to-delete',
    ).map((x) => x.name);
    expect(out).not.toContain('no-date');
  });
  it('safe-to-delete excludes empty branches with unparseable date (safe direction)', () => {
    const out = applyPreset(
      [...branches, b({ name: 'bad-date', mergeStatus: 'empty', lastCommitDate: 'not-a-date' })],
      'safe-to-delete',
    ).map((x) => x.name);
    expect(out).not.toContain('bad-date');
  });
  it('safe-to-delete excludes empty branches created today', () => {
    const out = applyPreset(
      [...branches, b({ name: 'fresh', mergeStatus: 'empty', lastCommitDate: new Date().toISOString() })],
      'safe-to-delete',
    ).map((x) => x.name);
    expect(out).not.toContain('fresh');
  });
  it('empty preset returns only empty branches', () => {
    const out = applyPreset(
      [...branches, b({ name: 'fresh', mergeStatus: 'empty' })],
      'empty',
    ).map((x) => x.name);
    expect(out).toEqual(['fresh']);
  });
  it('empty preset excludes the repo default branch', () => {
    const out = applyPreset(
      [b({ name: 'main', mergeStatus: 'empty' }), b({ name: 'scratch', mergeStatus: 'empty' })],
      'empty',
      { defaultBranch: 'main' },
    ).map((x) => x.name);
    expect(out).toEqual(['scratch']);
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

describe('filterMine', () => {
  const branches: Branch[] = [
    b({ name: 'ada-branch', authorEmail: 'ada@example.com' }),
    b({ name: 'grace-branch', authorEmail: 'grace@example.com' }),
    b({ name: 'unknown-branch' }),
    b({ name: 'ada-upper', authorEmail: 'ADA@Example.com' }),
  ];

  it('matches the current user email case-insensitively', () => {
    const out = filterMine(branches, 'ada@example.com').map((x) => x.name);
    expect(out).toEqual(['ada-branch', 'ada-upper']);
  });
  it('includes local empty branches regardless of author', () => {
    const withEmpty = [...branches, b({ name: 'empty-local', mergeStatus: 'empty', hasLocal: true, authorEmail: 'other@example.com' })];
    const out = filterMine(withEmpty, 'ada@example.com').map((x) => x.name);
    expect(out).toContain('empty-local');
  });
  it('excludes remote-only empty branches', () => {
    const withRemoteEmpty = [...branches, b({ name: 'empty-remote', mergeStatus: 'empty', hasLocal: false, hasRemote: true, authorEmail: 'other@example.com' })];
    const out = filterMine(withRemoteEmpty, 'ada@example.com').map((x) => x.name);
    expect(out).not.toContain('empty-remote');
  });
  it('returns empty when no user email is supplied', () => {
    expect(filterMine(branches, undefined).length).toBe(0);
    expect(filterMine(branches, '').length).toBe(0);
  });
  it('ignores branches with no recorded authorEmail', () => {
    const out = filterMine(branches, 'someone-else@example.com');
    expect(out.map((x) => x.name)).toEqual([]);
  });
  it('layers on top of a preset', () => {
    const all = [
      b({ name: 'my-merged', mergeStatus: 'merged-normally', authorEmail: 'me@x.com' }),
      b({ name: 'other-merged', mergeStatus: 'merged-normally', authorEmail: 'other@x.com' }),
      b({ name: 'my-empty', mergeStatus: 'empty', authorEmail: 'other@x.com',
        lastCommitDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() }),
    ];
    const safeToDelete = applyPreset(all, 'safe-to-delete');
    const mineOnly = filterMine(safeToDelete, 'me@x.com').map((x) => x.name);
    expect(mineOnly).toContain('my-merged');
    expect(mineOnly).not.toContain('other-merged');
    // local empty branches pass through mine regardless of author
    expect(mineOnly).toContain('my-empty');
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
