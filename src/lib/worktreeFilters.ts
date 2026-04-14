import type { Branch, Worktree } from '../types';

export type WorktreePreset =
  | 'all'
  | 'dirty'
  | 'conflict'
  | 'empty'
  | 'merged'
  | 'safe-to-remove'
  | 'stale'
  | 'orphaned';

// Pure filter over the already-sorted worktree list. Branch metadata is joined
// via the same branchByName Map WorktreesView builds for card prop-drilling
// (WorktreesView.tsx) so we never re-scan the branches array per worktree.
export function applyWorktreePreset(
  worktrees: Worktree[],
  branchByName: Map<string, Branch>,
  preset: WorktreePreset,
  ctx: { defaultBranch?: string } = {},
): Worktree[] {
  const isDefault = (w: Worktree) =>
    !!ctx.defaultBranch && w.branch === ctx.defaultBranch;
  // Mirrors the WorktreeCard.isMerged derivation: primary worktree and any
  // worktree on the default branch are merged-by-definition; otherwise trust
  // the squash detector's verdict on the joined branch.
  const isMerged = (w: Worktree) => {
    if (w.isPrimary || isDefault(w)) return true;
    const m = branchByName.get(w.branch)?.mergeStatus;
    return m === 'merged-normally' || m === 'squash-merged' || m === 'direct-merged';
  };
  switch (preset) {
    case 'all':
      return worktrees;
    case 'dirty':
      return worktrees.filter((w) => !w.prunable && w.status === 'dirty');
    case 'conflict':
      return worktrees.filter(
        (w) => !w.prunable && (w.status === 'conflict' || !!w.inProgress),
      );
    case 'empty':
      return worktrees.filter(
        (w) => !w.prunable && branchByName.get(w.branch)?.mergeStatus === 'empty',
      );
    case 'merged':
      return worktrees.filter(
        (w) => !w.prunable && !isDefault(w) && !w.isPrimary && isMerged(w),
      );
    case 'safe-to-remove':
      return worktrees.filter(
        (w) =>
          !w.prunable &&
          !isDefault(w) &&
          !w.isPrimary &&
          w.status === 'clean' &&
          isMerged(w),
      );
    case 'stale':
      return worktrees.filter(
        (w) =>
          !w.prunable &&
          !isDefault(w) &&
          branchByName.get(w.branch)?.mergeStatus === 'stale',
      );
    case 'orphaned':
      return worktrees.filter((w) => !!w.prunable);
  }
}

// Free-text search over basename of the worktree path, the branch name, and
// the joined PR's number/title. Matches the Branches search shape so users
// learn one mental model.
export function searchWorktrees(
  worktrees: Worktree[],
  branchByName: Map<string, Branch>,
  q: string,
): Worktree[] {
  const s = q.trim().toLowerCase();
  if (!s) return worktrees;
  return worktrees.filter((w) => {
    const basename = w.path.split('/').pop()?.toLowerCase() ?? '';
    if (basename.includes(s)) return true;
    if (w.branch.toLowerCase().includes(s)) return true;
    const pr = branchByName.get(w.branch)?.pr;
    if (pr?.title.toLowerCase().includes(s)) return true;
    if (pr && pr.number.toString().includes(s)) return true;
    return false;
  });
}
