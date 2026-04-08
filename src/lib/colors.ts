import type { MergeStatus, WorktreeStatus } from '../types';

// Layered priority: dirty/conflict/diverged are urgent filesystem signals and
// always win over the merge-state layer (you'd rather see "uncommitted work"
// than "old work landed"). Only `clean` worktrees fall through to the
// merge-state split, where green now means "branch has actually landed in
// main" rather than "filesystem is tidy". Primary worktree (main itself) is
// merged-by-definition and stays green when clean; detached/main branches
// don't appear in `listBranches`, so callers pass `mergeStatus` undefined for
// them and we treat that as "no info → in-progress" unless `isPrimary` is
// set.
export function worktreeStatusClass(
  s: WorktreeStatus,
  mergeStatus?: MergeStatus,
  isPrimary?: boolean,
): string {
  switch (s) {
    case 'conflict':
      return 'border-wt-conflict/70 bg-wt-conflict/10';
    case 'dirty':
      return 'border-wt-dirty/60 bg-wt-dirty/5';
    case 'diverged':
      return 'border-wt-info/60 bg-wt-info/5';
    case 'clean': {
      if (isPrimary) return 'border-wt-clean/60 bg-wt-clean/5';
      if (mergeStatus === 'merged-normally' || mergeStatus === 'squash-merged') {
        return 'border-wt-clean/60 bg-wt-clean/5';
      }
      return 'border-wt-active/60 bg-wt-active/5';
    }
  }
}

export function mergeStatusLabel(s: MergeStatus): string {
  switch (s) {
    case 'merged-normally':
      return 'merged';
    case 'squash-merged':
      return 'merged (squash)';
    case 'unmerged':
      return 'unmerged';
    case 'stale':
      return 'stale';
  }
}

export function mergeStatusClass(s: MergeStatus): string {
  switch (s) {
    case 'merged-normally':
      return 'bg-wt-info/15 text-wt-info border-wt-info/40';
    case 'squash-merged':
      return 'bg-wt-squash/15 text-wt-squash border-wt-squash/40';
    case 'unmerged':
      return 'bg-wt-clean/15 text-wt-clean border-wt-clean/40';
    case 'stale':
      return 'bg-wt-dirty/15 text-wt-dirty border-wt-dirty/40';
  }
}
