import { describe, it, expect } from 'vitest';
import { branchDisposition } from './branchDisposition';
import type { Branch, Worktree, MergeStatus, WorktreeStatus, InProgressOp } from '../types';

function mkBranch(over: Partial<Branch> & { mergeStatus: MergeStatus }): Branch {
  return {
    name: 'feat/x',
    hasLocal: true,
    hasRemote: true,
    lastCommitDate: new Date().toISOString(),
    lastCommitSha: 'abc',
    aheadOfMain: 0,
    behindMain: 0,
    ...over,
  };
}

function mkWorktree(over: Partial<Worktree> & { status: WorktreeStatus }): Worktree {
  return {
    path: '/tmp/wt',
    branch: 'feat/x',
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
    lastCommit: { sha: 'abc', message: '', date: '', author: '' },
    ...over,
  };
}

// Default the test default-branch to "main" — feature-branch tests use
// `feat/x` as the worktree name so they never collide with the main path.
// The default-branch suite below overrides this where it matters.
function callDisp(
  branch: Branch | undefined,
  worktree: Worktree,
  defaultBranch = 'main',
) {
  return branchDisposition(branch, worktree, defaultBranch);
}

describe('branchDisposition — null cases', () => {
  it('returns null when no branch entry exists (detached HEAD)', () => {
    expect(callDisp(undefined, mkWorktree({ status: 'clean' }))).toBeNull();
  });
});

describe('branchDisposition — clean worktree (no contradiction)', () => {
  it('merged-normally + clean → plain "merged"', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'merged-normally' }),
      mkWorktree({ status: 'clean' }),
    );
    expect(d?.label).toBe('merged');
    expect(d?.className).toContain('border-wt-info');
    expect(d?.className).not.toContain('border-wt-dirty');
    expect(d?.tooltip).toMatch(/safe to remove/);
  });

  it('squash-merged + clean → plain "merged (squash)"', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'squash-merged' }),
      mkWorktree({ status: 'clean' }),
    );
    expect(d?.label).toBe('merged (squash)');
    expect(d?.className).toContain('border-wt-squash');
    expect(d?.className).not.toContain('border-wt-dirty');
  });

  it('unmerged + clean → plain "unmerged"', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'unmerged' }),
      mkWorktree({ status: 'clean' }),
    );
    expect(d?.label).toBe('unmerged');
    expect(d?.className).toContain('border-wt-clean');
  });

  it('empty + clean → plain "empty" with slate accent', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'empty' }),
      mkWorktree({ status: 'clean' }),
    );
    expect(d?.label).toBe('empty');
    expect(d?.className).toContain('border-wt-active');
    expect(d?.className).not.toContain('border-wt-clean');
    expect(d?.tooltip).toMatch(/no commits of its own/);
  });

  it('stale + clean → plain "stale"', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'stale' }),
      mkWorktree({ status: 'clean' }),
    );
    expect(d?.label).toBe('stale');
    expect(d?.className).toContain('border-wt-dirty');
  });
});

// `empty` is a commit-history label, but the moment the worktree shows any
// uncommitted activity the label is misleading — there IS work happening,
// just not committed yet. The disposition layer demotes empty→unmerged so
// the WorktreeCard pill matches the user's mental model. BranchRow (which
// has no worktree context) still renders the raw `empty` from the data layer.
describe('branchDisposition — empty + worktree activity demotes to unmerged', () => {
  it('empty + untracked file → "unmerged"', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'empty' }),
      mkWorktree({ status: 'dirty', untrackedCount: 1 }),
    );
    expect(d?.label).toBe('unmerged');
    expect(d?.className).toContain('border-wt-clean');
  });

  it('empty + modified file → "unmerged"', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'empty' }),
      mkWorktree({ status: 'dirty', modifiedCount: 1 }),
    );
    expect(d?.label).toBe('unmerged');
  });

  it('empty + staged file → "unmerged"', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'empty' }),
      mkWorktree({ status: 'dirty', stagedCount: 1 }),
    );
    expect(d?.label).toBe('unmerged');
  });

  it('empty + conflict → "unmerged"', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'empty' }),
      mkWorktree({ status: 'conflict', hasConflicts: true }),
    );
    expect(d?.label).toBe('unmerged');
  });

  it('empty + in-progress rebase → "unmerged"', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'empty' }),
      mkWorktree({ status: 'clean', inProgress: 'rebase' }),
    );
    expect(d?.label).toBe('unmerged');
  });

  it('empty + clean stays "empty"', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'empty' }),
      mkWorktree({ status: 'clean' }),
    );
    expect(d?.label).toBe('empty');
  });

  // Stash count is intentionally not part of the activity check — see comment
  // in worktreeHasActivity. A stash on an otherwise-pristine empty branch
  // shouldn't make the pill claim work is in flight.
  it('empty + stash only → still "empty"', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'empty' }),
      mkWorktree({ status: 'clean', stashCount: 2 }),
    );
    expect(d?.label).toBe('empty');
  });
});

describe('branchDisposition — merged + workspace contradictions', () => {
  it('merged-normally + dirty → "merged · edits" with dirty accent', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'merged-normally' }),
      mkWorktree({ status: 'dirty', modifiedCount: 1 }),
    );
    expect(d?.label).toBe('merged · edits');
    expect(d?.className).toContain('text-wt-info'); // still recognizably merged
    expect(d?.className).toContain('border-wt-dirty/60'); // accent border
    expect(d?.tooltip).toMatch(/uncommitted work/);
    expect(d?.tooltip).toMatch(/1 modified/);
  });

  it('breakdown lists every nonzero file count', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'merged-normally' }),
      mkWorktree({
        status: 'dirty',
        untrackedCount: 2,
        modifiedCount: 1,
        stagedCount: 3,
      }),
    );
    expect(d?.tooltip).toMatch(/2 untracked/);
    expect(d?.tooltip).toMatch(/1 modified/);
    expect(d?.tooltip).toMatch(/3 staged/);
  });

  it('squash-merged + dirty → "merged (squash) · edits" with dirty accent', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'squash-merged' }),
      mkWorktree({ status: 'dirty', untrackedCount: 1 }),
    );
    expect(d?.label).toBe('merged (squash) · edits');
    expect(d?.className).toContain('text-wt-squash');
    expect(d?.className).toContain('border-wt-dirty/60');
  });

  it('merged-normally + conflict → "merged · conflict"', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'merged-normally' }),
      mkWorktree({ status: 'conflict', hasConflicts: true }),
    );
    expect(d?.label).toBe('merged · conflict');
    expect(d?.tooltip).toMatch(/unresolved conflicts/);
  });

  it('merged-normally + diverged → "merged · diverged"', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'merged-normally' }),
      mkWorktree({ status: 'diverged', ahead: 1, behind: 1 }),
    );
    expect(d?.label).toBe('merged · diverged');
    expect(d?.tooltip).toMatch(/different directions/);
  });

  const ops: InProgressOp[] = ['rebase', 'merge', 'cherry-pick', 'revert', 'bisect'];
  for (const op of ops) {
    it(`merged-normally + inProgress=${op} → "merged · ${op}"`, () => {
      const d = callDisp(
        mkBranch({ mergeStatus: 'merged-normally' }),
        mkWorktree({ status: 'clean', inProgress: op }),
      );
      expect(d?.label).toBe(`merged · ${op}`);
      expect(d?.tooltip).toMatch(new RegExp(op));
    });
  }

  it('inProgress takes precedence over conflict', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'merged-normally' }),
      mkWorktree({ status: 'conflict', hasConflicts: true, inProgress: 'rebase' }),
    );
    expect(d?.label).toBe('merged · rebase');
  });
});

describe('branchDisposition — unmerged side never gets a contradiction suffix', () => {
  it('unmerged + dirty → still plain "unmerged" (consistent reading)', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'unmerged' }),
      mkWorktree({ status: 'dirty', modifiedCount: 5 }),
    );
    expect(d?.label).toBe('unmerged');
    expect(d?.className).not.toContain('border-wt-dirty/60');
  });

  it('stale + dirty → still plain "stale"', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'stale' }),
      mkWorktree({ status: 'dirty', modifiedCount: 5 }),
    );
    expect(d?.label).toBe('stale');
  });

  it('unmerged + conflict → still plain "unmerged"', () => {
    const d = callDisp(
      mkBranch({ mergeStatus: 'unmerged' }),
      mkWorktree({ status: 'conflict', hasConflicts: true }),
    );
    expect(d?.label).toBe('unmerged');
  });
});

describe('branchDisposition — worktree on the default branch', () => {
  function mkMain(over: Partial<Worktree> & { status: WorktreeStatus }): Worktree {
    return mkWorktree({ branch: 'main', isPrimary: true, ...over });
  }
  function mkMainBranch(): Branch {
    return mkBranch({ name: 'main', mergeStatus: 'merged-normally' });
  }

  it('clean and even with upstream → quiet "on main" hint', () => {
    const d = callDisp(mkMainBranch(), mkMain({ status: 'clean' }));
    expect(d?.label).toBe('on main');
    expect(d?.className).toContain('text-wt-active');
    expect(d?.tooltip).toMatch(/create a worktree/);
    expect(d?.action).toBeUndefined();
  });

  it('overrides the merged pill — never returns "merged" on the default branch', () => {
    // Even though the main branch entry has mergeStatus 'merged-normally',
    // the disposition for a worktree CHECKED OUT on main should not be the
    // tautological "merged" pill.
    const d = callDisp(mkMainBranch(), mkMain({ status: 'clean' }));
    expect(d?.label).not.toContain('merged');
  });

  it('uses the actual default-branch name in the label', () => {
    const wt = mkWorktree({ branch: 'develop', status: 'clean' });
    const d = callDisp(undefined, wt, 'develop');
    expect(d?.label).toBe('on develop');
    expect(d?.tooltip).toMatch(/develop/);
  });

  it('fires even when branchInfo is undefined (defensive — fresh repo)', () => {
    const d = callDisp(undefined, mkMain({ status: 'clean' }));
    expect(d?.label).toBe('on main');
  });

  it('triggers on a non-primary worktree on main', () => {
    const wt = mkWorktree({ branch: 'main', isPrimary: false, status: 'clean' });
    const d = callDisp(mkMainBranch(), wt);
    expect(d?.label).toBe('on main');
  });

  describe('warning escalations (red)', () => {
    it('dirty → "on main · edits" with conflict-red palette and breakdown', () => {
      const d = callDisp(
        mkMainBranch(),
        mkMain({ status: 'dirty', modifiedCount: 1, untrackedCount: 2 }),
      );
      expect(d?.label).toBe('on main · edits');
      expect(d?.className).toContain('text-wt-conflict');
      expect(d?.tooltip).toMatch(/uncommitted work/);
      expect(d?.tooltip).toMatch(/2 untracked/);
      expect(d?.tooltip).toMatch(/1 modified/);
      expect(d?.tooltip).toMatch(/git worktree add/);
    });

    it('conflict → "on main · conflict" red', () => {
      const d = callDisp(
        mkMainBranch(),
        mkMain({ status: 'conflict', hasConflicts: true }),
      );
      expect(d?.label).toBe('on main · conflict');
      expect(d?.className).toContain('text-wt-conflict');
    });

    it('diverged → "on main · diverged" red with ahead/behind in tooltip', () => {
      const d = callDisp(
        mkMainBranch(),
        mkMain({ status: 'diverged', ahead: 2, behind: 3 }),
      );
      expect(d?.label).toBe('on main · diverged');
      expect(d?.className).toContain('text-wt-conflict');
      expect(d?.tooltip).toMatch(/2 ahead/);
      expect(d?.tooltip).toMatch(/3 behind/);
    });

    it('inProgress → "on main · {op}" red, takes precedence over status', () => {
      const d = callDisp(
        mkMainBranch(),
        mkMain({ status: 'conflict', hasConflicts: true, inProgress: 'rebase' }),
      );
      expect(d?.label).toBe('on main · rebase');
      expect(d?.className).toContain('text-wt-conflict');
    });

    it('clean but ahead of upstream → "on main · N ahead" red (committed on main)', () => {
      const d = callDisp(mkMainBranch(), mkMain({ status: 'clean', ahead: 1 }));
      expect(d?.label).toBe('on main · 1 ahead');
      expect(d?.className).toContain('text-wt-conflict');
      expect(d?.tooltip).toMatch(/git switch -c/);
    });

    it('1 ahead vs many ahead → singular/plural in tooltip', () => {
      const d1 = callDisp(mkMainBranch(), mkMain({ status: 'clean', ahead: 1 }));
      expect(d1?.tooltip).toMatch(/1 commit on/);
      const d3 = callDisp(mkMainBranch(), mkMain({ status: 'clean', ahead: 3 }));
      expect(d3?.tooltip).toMatch(/3 commits on/);
    });
  });

  describe('behind upstream (info pill + pull action)', () => {
    it('clean, behind > 0 → "on main · N behind" info pill', () => {
      const d = callDisp(mkMainBranch(), mkMain({ status: 'clean', behind: 4 }));
      expect(d?.label).toBe('on main · 4 behind');
      expect(d?.className).toContain('text-wt-info');
      expect(d?.className).not.toContain('text-wt-conflict');
    });

    it('exposes a pull-default-branch action', () => {
      const d = callDisp(mkMainBranch(), mkMain({ status: 'clean', behind: 1 }));
      expect(d?.action).toEqual({
        kind: 'pull-default-branch',
        label: 'Pull',
        ariaLabel: expect.stringMatching(/main/i),
      });
    });

    it('singular "1 commit" / plural "N commits" in tooltip', () => {
      const one = callDisp(mkMainBranch(), mkMain({ status: 'clean', behind: 1 }));
      expect(one?.tooltip).toMatch(/1 commit behind/);
      const many = callDisp(mkMainBranch(), mkMain({ status: 'clean', behind: 7 }));
      expect(many?.tooltip).toMatch(/7 commits behind/);
    });

    it('does not offer the pull action when also dirty', () => {
      // dirty wins (the user must clean up before pulling). The disposition
      // should fall into the dirty branch and never reach the behind branch.
      const d = callDisp(
        mkMainBranch(),
        mkMain({ status: 'dirty', modifiedCount: 1, behind: 2 }),
      );
      expect(d?.label).toBe('on main · edits');
      expect(d?.action).toBeUndefined();
    });

    it('does not offer the pull action when ahead-only on main', () => {
      // ahead is a warning state, not pullable.
      const d = callDisp(mkMainBranch(), mkMain({ status: 'clean', ahead: 1 }));
      expect(d?.action).toBeUndefined();
    });
  });
});
