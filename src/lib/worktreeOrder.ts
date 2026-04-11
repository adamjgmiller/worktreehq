import type { ClaudePresence, Worktree, WorktreeSortMode } from '../types';

/**
 * Reconcile live worktrees with a persisted manual ordering.
 * - Worktrees present in savedOrder keep their saved position.
 * - New worktrees (not in savedOrder) are appended at the end.
 * - Stale entries in savedOrder (no longer in worktrees) are silently dropped.
 */
export function reconcileOrder(
  worktrees: Worktree[],
  savedOrder: string[],
): Worktree[] {
  if (savedOrder.length === 0) return worktrees;

  const wtMap = new Map(worktrees.map((w) => [w.path, w]));
  const ordered: Worktree[] = [];
  const seen = new Set<string>();

  for (const path of savedOrder) {
    const wt = wtMap.get(path);
    if (wt) {
      ordered.push(wt);
      seen.add(path);
    }
  }

  for (const wt of worktrees) {
    if (!seen.has(wt.path)) {
      ordered.push(wt);
    }
  }

  return ordered;
}

// Higher = sorts earlier in 'status' mode. Conflicts win over in-progress ops
// because an unresolved conflict is the most urgent thing a user can be
// looking at; in-progress ops (rebase/merge/cherry-pick) come next because
// they're a step away from becoming conflicts. Dirty/diverged are routine.
// Orphaned ('prunable') cards sink to the bottom regardless of other state.
function statusRank(wt: Worktree): number {
  if (wt.prunable) return -1;
  if (wt.hasConflicts || wt.status === 'conflict') return 5;
  if (wt.inProgress) return 4;
  if (wt.status === 'dirty') return 3;
  if (wt.status === 'diverged') return 2;
  return 1; // clean
}

// Timestamp (ms) of the most recent user-visible activity on a worktree:
// the max of the HEAD commit date and — if Claude has been open in this
// worktree — the newest Claude session mtime. This captures "I'm working
// on this right now" even when the user hasn't committed yet.
function lastActivityMs(
  wt: Worktree,
  presence: ClaudePresence | undefined,
): number {
  const commitMs = Date.parse(wt.lastCommit.date);
  const claudeMs = presence?.lastActivity
    ? Date.parse(presence.lastActivity)
    : NaN;
  const commit = Number.isFinite(commitMs) ? commitMs : 0;
  const claude = Number.isFinite(claudeMs) ? claudeMs : 0;
  return Math.max(commit, claude);
}

function worktreeName(wt: Worktree): string {
  // basename of path. Primary worktrees usually sit at the repo root so the
  // name is the repo folder; linked worktrees have whatever directory name
  // the user passed to `git worktree add`. Locale-aware so "café" sorts
  // predictably next to "cafe".
  const idx = wt.path.lastIndexOf('/');
  return idx === -1 ? wt.path : wt.path.slice(idx + 1);
}

export interface SortContext {
  claudePresence: Map<string, ClaudePresence>;
  manualOrder: string[];
}

/**
 * Sort worktrees according to the current sort mode.
 *
 * For every non-manual mode the primary worktree is pinned to the top: it's
 * the user's "home base" (default branch, repo root) and should not drift
 * down when a feature worktree picks up a fresh commit. Manual mode is
 * unopinionated — the user owns the order completely.
 */
export function sortWorktrees(
  worktrees: Worktree[],
  mode: WorktreeSortMode,
  ctx: SortContext,
): Worktree[] {
  if (mode === 'manual') {
    return reconcileOrder(worktrees, ctx.manualOrder);
  }

  // Stable-sort by pulling primary out first and then applying the
  // mode's comparator to the remainder. Array.prototype.sort is stable
  // in modern JS so equal-key worktrees preserve their incoming order.
  const primary = worktrees.filter((w) => w.isPrimary);
  const rest = worktrees.filter((w) => !w.isPrimary);

  const cmp = (() => {
    switch (mode) {
      case 'recent':
        return (a: Worktree, b: Worktree) =>
          lastActivityMs(b, ctx.claudePresence.get(b.path)) -
          lastActivityMs(a, ctx.claudePresence.get(a.path));
      case 'name':
        return (a: Worktree, b: Worktree) =>
          worktreeName(a).localeCompare(worktreeName(b));
      case 'status':
        return (a: Worktree, b: Worktree) => {
          const diff = statusRank(b) - statusRank(a);
          if (diff !== 0) return diff;
          // Tiebreak by recency so "all clean" lists still feel useful.
          return (
            lastActivityMs(b, ctx.claudePresence.get(b.path)) -
            lastActivityMs(a, ctx.claudePresence.get(a.path))
          );
        };
    }
  })();

  return [...primary, ...[...rest].sort(cmp)];
}
