import type { Branch } from '../types';

export type FilterPreset = 'all' | 'mine' | 'safe-to-delete' | 'stale' | 'active' | 'orphaned';

// `mine` is resolved by passing the current user's git email through to the filter —
// we keep the fn pure so tests don't have to stub gitService.
export function applyPreset(
  branches: Branch[],
  preset: FilterPreset,
  ctx: { userEmail?: string } = {},
): Branch[] {
  switch (preset) {
    case 'all':
      return branches;
    case 'mine': {
      const email = ctx.userEmail?.trim().toLowerCase();
      if (!email) return [];
      return branches.filter((b) => b.authorEmail?.trim().toLowerCase() === email);
    }
    case 'safe-to-delete':
      return branches.filter(
        (b) =>
          (b.mergeStatus === 'merged-normally' || b.mergeStatus === 'squash-merged') &&
          !b.worktreePath,
      );
    case 'stale':
      return branches.filter((b) => b.mergeStatus === 'stale');
    case 'active':
      return branches.filter(
        (b) => !!b.worktreePath || (b.pr && b.pr.state === 'open'),
      );
    case 'orphaned':
      return branches.filter((b) => b.hasLocal && (b.upstreamGone || !b.hasRemote));
  }
}

export function searchBranches(branches: Branch[], q: string): Branch[] {
  const s = q.trim().toLowerCase();
  if (!s) return branches;
  return branches.filter(
    (b) =>
      b.name.toLowerCase().includes(s) ||
      (b.pr?.title.toLowerCase().includes(s) ?? false) ||
      (b.pr?.number.toString().includes(s) ?? false),
  );
}
