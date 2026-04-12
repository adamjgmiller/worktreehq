import { describe, expect, it } from 'vitest';
import { reconcileOrder, sortWorktrees } from './worktreeOrder';
import type { ClaudePresence, MergeStatus, Worktree } from '../types';

function wt(
  overrides: Partial<Worktree> & { path: string; branch?: string },
): Worktree {
  return {
    branch: 'feat',
    isPrimary: false,
    head: 'deadbeef',
    untrackedCount: 0,
    modifiedCount: 0,
    stagedCount: 0,
    stashCount: 0,
    ahead: 0,
    behind: 0,
    aheadOfMain: 0,
    behindMain: 0,
    hasConflicts: false,
    status: 'clean',
    lastCommit: {
      sha: 'deadbeef',
      message: 'x',
      date: '2026-01-01T00:00:00Z',
      author: 'x',
    },
    ...overrides,
  };
}

function presence(lastActivity: string): ClaudePresence {
  return {
    status: 'recent',
    lastActivity,
    inactiveSessions: [],
    liveSessionCount: 0,
  };
}

describe('reconcileOrder', () => {
  it('returns worktrees unchanged when saved order is empty', () => {
    const a = wt({ path: '/a' });
    const b = wt({ path: '/b' });
    expect(reconcileOrder([a, b], [])).toEqual([a, b]);
  });

  it('honors saved order and appends new worktrees at the end', () => {
    const a = wt({ path: '/a' });
    const b = wt({ path: '/b' });
    const c = wt({ path: '/c' });
    expect(reconcileOrder([a, b, c], ['/b', '/a'])).toEqual([b, a, c]);
  });

  it('drops stale entries in saved order', () => {
    const a = wt({ path: '/a' });
    const b = wt({ path: '/b' });
    expect(reconcileOrder([a, b], ['/gone', '/b', '/also-gone'])).toEqual([
      b,
      a,
    ]);
  });
});

describe('sortWorktrees', () => {
  const primary = wt({
    path: '/repo',
    isPrimary: true,
    lastCommit: {
      sha: 's',
      message: 'm',
      date: '2020-01-01T00:00:00Z',
      author: 'a',
    },
  });
  const old = wt({
    path: '/repo/wt-old',
    lastCommit: {
      sha: 's',
      message: 'm',
      date: '2024-01-01T00:00:00Z',
      author: 'a',
    },
  });
  const fresh = wt({
    path: '/repo/wt-fresh',
    lastCommit: {
      sha: 's',
      message: 'm',
      date: '2026-04-01T00:00:00Z',
      author: 'a',
    },
  });
  const dirty = wt({
    path: '/repo/wt-dirty',
    status: 'dirty',
    lastCommit: {
      sha: 's',
      message: 'm',
      date: '2025-01-01T00:00:00Z',
      author: 'a',
    },
  });
  const conflict = wt({
    path: '/repo/wt-conflict',
    status: 'conflict',
    hasConflicts: true,
    lastCommit: {
      sha: 's',
      message: 'm',
      date: '2024-06-01T00:00:00Z',
      author: 'a',
    },
  });

  const emptyPresence = new Map<string, ClaudePresence>();

  it("recent mode: primary pinned, rest by activity desc", () => {
    const out = sortWorktrees([old, primary, fresh], 'recent', {
      claudePresence: emptyPresence,
      manualOrder: [],
    });
    expect(out.map((w) => w.path)).toEqual([
      '/repo',
      '/repo/wt-fresh',
      '/repo/wt-old',
    ]);
  });

  it('recent mode: Claude activity beats stale commit date', () => {
    const claudePresence = new Map<string, ClaudePresence>([
      ['/repo/wt-old', presence('2026-04-05T00:00:00Z')],
    ]);
    const out = sortWorktrees([fresh, old], 'recent', {
      claudePresence,
      manualOrder: [],
    });
    expect(out.map((w) => w.path)).toEqual([
      '/repo/wt-old',
      '/repo/wt-fresh',
    ]);
  });

  it('name mode: primary pinned, rest alphabetical by basename', () => {
    const out = sortWorktrees([fresh, primary, dirty, old], 'name', {
      claudePresence: emptyPresence,
      manualOrder: [],
    });
    expect(out.map((w) => w.path)).toEqual([
      '/repo',
      '/repo/wt-dirty',
      '/repo/wt-fresh',
      '/repo/wt-old',
    ]);
  });

  it('status mode: conflicts before dirty before clean, tiebreak by recency', () => {
    const out = sortWorktrees(
      [old, conflict, primary, fresh, dirty],
      'status',
      { claudePresence: emptyPresence, manualOrder: [] },
    );
    expect(out.map((w) => w.path)).toEqual([
      '/repo',
      '/repo/wt-conflict',
      '/repo/wt-dirty',
      '/repo/wt-fresh',
      '/repo/wt-old',
    ]);
  });

  it('status mode: unmerged worktrees sort above squash-merged ones', () => {
    const merged = wt({
      path: '/repo/wt-merged',
      branch: 'merged-feat',
      status: 'dirty',
      lastCommit: {
        sha: 's',
        message: 'm',
        date: '2026-04-01T00:00:00Z',
        author: 'a',
      },
    });
    const unmergedClean = wt({
      path: '/repo/wt-unmerged',
      branch: 'active-feat',
      status: 'clean',
      lastCommit: {
        sha: 's',
        message: 'm',
        date: '2024-01-01T00:00:00Z',
        author: 'a',
      },
    });
    const mergeStatusByBranch = new Map<string, MergeStatus>([
      ['merged-feat', 'squash-merged'],
      ['active-feat', 'unmerged'],
    ]);
    // Even though merged is dirty (rank 3 normally) and unmergedClean is
    // clean (rank 1 normally), unmerged should still come first.
    const out = sortWorktrees(
      [merged, primary, unmergedClean],
      'status',
      { claudePresence: emptyPresence, manualOrder: [], mergeStatusByBranch },
    );
    expect(out.map((w) => w.path)).toEqual([
      '/repo',
      '/repo/wt-unmerged',
      '/repo/wt-merged',
    ]);
  });

  it('manual mode: delegates to reconcileOrder', () => {
    const out = sortWorktrees([primary, fresh, old], 'manual', {
      claudePresence: emptyPresence,
      manualOrder: ['/repo/wt-old', '/repo'],
    });
    expect(out.map((w) => w.path)).toEqual([
      '/repo/wt-old',
      '/repo',
      '/repo/wt-fresh',
    ]);
  });
});
