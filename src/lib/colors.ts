import type { MergeStatus, WorktreeStatus } from '../types';

export function worktreeStatusClass(s: WorktreeStatus): string {
  switch (s) {
    case 'clean':
      return 'border-wt-clean/60 bg-wt-clean/5';
    case 'dirty':
      return 'border-wt-dirty/60 bg-wt-dirty/5';
    case 'conflict':
      return 'border-wt-conflict/70 bg-wt-conflict/10';
    case 'diverged':
      return 'border-wt-info/60 bg-wt-info/5';
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
