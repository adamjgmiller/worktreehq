import type { Branch } from '../types';

export type FilterPreset = 'all' | 'safe-to-delete' | 'empty' | 'stale' | 'active' | 'orphaned';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function isEmptyAndAbandoned(b: Branch, now = Date.now()): boolean {
  if (b.mergeStatus !== 'empty') return false;
  if (!b.lastCommitDate) return true; // no date → assume old
  const t = new Date(b.lastCommitDate).getTime();
  if (Number.isNaN(t)) return true;
  return now - t >= ONE_DAY_MS;
}

export function applyPreset(
  branches: Branch[],
  preset: FilterPreset,
  ctx: { defaultBranch?: string } = {},
): Branch[] {
  const isDefault = (b: Branch) =>
    !!ctx.defaultBranch && b.name === ctx.defaultBranch;
  switch (preset) {
    case 'all':
      return branches;
    case 'safe-to-delete':
      return branches.filter(
        (b) =>
          !isDefault(b) &&
          !b.worktreePath &&
          (b.mergeStatus === 'merged-normally' ||
            b.mergeStatus === 'squash-merged' ||
            isEmptyAndAbandoned(b)),
      );
    case 'empty':
      return branches.filter((b) => b.mergeStatus === 'empty' && !isDefault(b));
    case 'stale':
      return branches.filter((b) => b.mergeStatus === 'stale' && !isDefault(b));
    case 'active':
      return branches.filter(
        (b) => !!b.worktreePath || (b.pr && b.pr.state === 'open'),
      );
    case 'orphaned':
      return branches.filter(
        (b) => b.hasLocal && (b.upstreamGone || !b.hasRemote) && !isDefault(b),
      );
  }
}

// Layered "mine" filter — applied on top of any preset. Empty branches have
// no unique commits, so authorEmail is meaningless (it reflects the main
// commit they point at). Use hasLocal as a proxy: if a local ref exists you
// at least checked it out, so it's reasonable to surface. Remote-only empty
// branches are likely someone else's and get filtered out.
export function filterMine(branches: Branch[], userEmail: string | undefined): Branch[] {
  const email = userEmail?.trim().toLowerCase();
  if (!email) return [];
  return branches.filter(
    (b) =>
      (b.mergeStatus === 'empty' && b.hasLocal) ||
      b.authorEmail?.trim().toLowerCase() === email,
  );
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
