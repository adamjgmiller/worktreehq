import { describe, it, expect } from 'vitest';
import { applyWorktreePreset, searchWorktrees } from './worktreeFilters';
import type { Branch, Worktree, LastCommit } from '../types';

const lastCommit: LastCommit = {
  sha: 'abc123def456',
  message: 's',
  author: 'a',
  date: '2026-01-01T00:00:00Z',
};

function w(over: Partial<Worktree> = {}): Worktree {
  return {
    path: '/tmp/wt/feature',
    branch: 'feature',
    isPrimary: false,
    head: 'abc',
    untrackedCount: 0,
    modifiedCount: 0,
    stagedCount: 0,
    stashCount: 0,
    ahead: 0,
    behind: 0,
    aheadOfMain: 0,
    behindMain: 0,
    hasConflicts: false,
    lastCommit,
    status: 'clean',
    ...over,
  };
}

function b(over: Partial<Branch> = {}): Branch {
  return {
    name: 'feature',
    hasLocal: true,
    hasRemote: true,
    lastCommitDate: '2026-01-01T00:00:00Z',
    lastCommitSha: 'abc',
    aheadOfMain: 1,
    behindMain: 0,
    mergeStatus: 'unmerged',
    ...over,
  };
}

function byName(branches: Branch[]): Map<string, Branch> {
  return new Map(branches.map((br) => [br.name, br]));
}

describe('applyWorktreePreset', () => {
  it('all returns input unchanged', () => {
    const wts = [w({ branch: 'a' }), w({ branch: 'b' })];
    expect(applyWorktreePreset(wts, byName([]), 'all')).toEqual(wts);
  });

  it('dirty matches status=dirty and excludes orphans', () => {
    const wts = [
      w({ branch: 'a', status: 'dirty' }),
      w({ branch: 'b', status: 'clean' }),
      w({ branch: 'c', status: 'dirty', prunable: 'gone' }),
    ];
    const out = applyWorktreePreset(wts, byName([]), 'dirty').map((x) => x.branch);
    expect(out).toEqual(['a']);
  });

  it('conflict matches status=conflict OR inProgress, excluding orphans', () => {
    const wts = [
      w({ branch: 'rebase', status: 'clean', inProgress: 'rebase' }),
      w({ branch: 'merge', status: 'conflict' }),
      w({ branch: 'clean', status: 'clean' }),
      w({ branch: 'orphan', status: 'conflict', prunable: 'gone' }),
    ];
    const out = applyWorktreePreset(wts, byName([]), 'conflict').map((x) => x.branch);
    expect(out.sort()).toEqual(['merge', 'rebase']);
  });

  it('empty catches a worktree whose branch has mergeStatus=empty (incl. no upstream)', () => {
    // The case the user flagged: a worktree they just created where the
    // branch has no commits ahead of main and was never pushed (no upstream).
    const wts = [
      w({ branch: 'fresh' }),
      w({ branch: 'pushed-empty' }),
      w({ branch: 'has-work' }),
    ];
    const branches = [
      b({ name: 'fresh', mergeStatus: 'empty', hasRemote: false, aheadOfMain: 0 }),
      b({ name: 'pushed-empty', mergeStatus: 'empty', hasRemote: true, aheadOfMain: 0 }),
      b({ name: 'has-work', mergeStatus: 'unmerged', aheadOfMain: 3 }),
    ];
    const out = applyWorktreePreset(wts, byName(branches), 'empty').map((x) => x.branch);
    expect(out.sort()).toEqual(['fresh', 'pushed-empty']);
  });

  it('merged includes squash/normal/direct merged, excludes primary and default-branch worktrees', () => {
    const wts = [
      w({ branch: 'main', isPrimary: true, path: '/repo' }),
      w({ branch: 'main-clone' }),
      w({ branch: 'sq' }),
      w({ branch: 'normal' }),
      w({ branch: 'direct' }),
      w({ branch: 'unmerged' }),
    ];
    const branches = [
      b({ name: 'main-clone', mergeStatus: 'unmerged' }),
      b({ name: 'sq', mergeStatus: 'squash-merged' }),
      b({ name: 'normal', mergeStatus: 'merged-normally' }),
      b({ name: 'direct', mergeStatus: 'direct-merged' }),
      b({ name: 'unmerged', mergeStatus: 'unmerged' }),
    ];
    const out = applyWorktreePreset(wts, byName(branches), 'merged', {
      defaultBranch: 'main',
    }).map((x) => x.branch);
    // Primary is excluded because removing it isn't a user goal; default-branch
    // worktree is excluded because it isn't a candidate for cleanup either.
    expect(out.sort()).toEqual(['direct', 'normal', 'sq']);
  });

  it('safe-to-remove requires clean filesystem AND merged branch, excludes primary/default/orphans', () => {
    const wts = [
      w({ branch: 'main', isPrimary: true }),
      w({ branch: 'sq-clean' }),
      w({ branch: 'sq-dirty', status: 'dirty' }),
      w({ branch: 'unmerged-clean' }),
      w({ branch: 'sq-orphan', prunable: 'gone' }),
    ];
    const branches = [
      b({ name: 'sq-clean', mergeStatus: 'squash-merged' }),
      b({ name: 'sq-dirty', mergeStatus: 'squash-merged' }),
      b({ name: 'unmerged-clean', mergeStatus: 'unmerged' }),
      b({ name: 'sq-orphan', mergeStatus: 'squash-merged' }),
    ];
    const out = applyWorktreePreset(wts, byName(branches), 'safe-to-remove', {
      defaultBranch: 'main',
    }).map((x) => x.branch);
    expect(out).toEqual(['sq-clean']);
  });

  it('stale matches branches with mergeStatus=stale and excludes default/orphans', () => {
    const wts = [
      w({ branch: 'main' }),
      w({ branch: 'old' }),
      w({ branch: 'fresh' }),
      w({ branch: 'old-orphan', prunable: 'gone' }),
    ];
    const branches = [
      b({ name: 'old', mergeStatus: 'stale' }),
      b({ name: 'fresh', mergeStatus: 'unmerged' }),
      b({ name: 'old-orphan', mergeStatus: 'stale' }),
    ];
    const out = applyWorktreePreset(wts, byName(branches), 'stale', {
      defaultBranch: 'main',
    }).map((x) => x.branch);
    expect(out).toEqual(['old']);
  });

  it('orphaned matches only prunable worktrees', () => {
    const wts = [
      w({ branch: 'a' }),
      w({ branch: 'ghost', prunable: 'gone' }),
      w({ branch: 'ghost2', prunable: 'gitdir-missing' }),
    ];
    const out = applyWorktreePreset(wts, byName([]), 'orphaned').map((x) => x.branch);
    expect(out.sort()).toEqual(['ghost', 'ghost2']);
  });
});

describe('searchWorktrees', () => {
  const wts = [
    w({ path: '/tmp/wt/feature-login', branch: 'feat/login' }),
    w({ path: '/tmp/wt/chore-deps', branch: 'chore/deps' }),
    w({ path: '/tmp/wt/with-pr', branch: 'has-pr' }),
  ];
  const branches = [
    b({ name: 'has-pr', pr: { number: 42, title: 'Add caching layer', state: 'open', headRef: 'has-pr', url: '' } }),
  ];
  const map = byName(branches);

  it('matches by path basename', () => {
    expect(searchWorktrees(wts, map, 'login').map((x) => x.branch)).toEqual(['feat/login']);
  });
  it('matches by branch name', () => {
    expect(searchWorktrees(wts, map, 'chore').map((x) => x.branch)).toEqual(['chore/deps']);
  });
  it('matches by PR title', () => {
    expect(searchWorktrees(wts, map, 'caching').map((x) => x.branch)).toEqual(['has-pr']);
  });
  it('matches by PR number', () => {
    expect(searchWorktrees(wts, map, '42').map((x) => x.branch)).toEqual(['has-pr']);
  });
  it('case-insensitive', () => {
    expect(searchWorktrees(wts, map, 'LOGIN').map((x) => x.branch)).toEqual(['feat/login']);
  });
  it('empty query returns all', () => {
    expect(searchWorktrees(wts, map, '   ').length).toBe(wts.length);
  });
  it('no match returns empty', () => {
    expect(searchWorktrees(wts, map, 'zzz').length).toBe(0);
  });
  it('matches Windows-native paths by basename', () => {
    // git worktree list emits native paths; on Windows that's `\` separators.
    // Without the cross-platform basename helper, the search would silently
    // miss folder-name matches on Windows.
    const winWts = [
      w({ path: 'C:\\Users\\dev\\repo\\wt\\windows-thing', branch: 'wt/win' }),
    ];
    expect(searchWorktrees(winWts, byName([]), 'windows-thing').map((x) => x.branch)).toEqual([
      'wt/win',
    ]);
  });
});
