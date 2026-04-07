import type { Branch } from '../types';

export type FilterPreset = 'all' | 'safe-to-delete' | 'stale' | 'active' | 'orphaned';

export function applyPreset(branches: Branch[], preset: FilterPreset): Branch[] {
  switch (preset) {
    case 'all':
      return branches;
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
