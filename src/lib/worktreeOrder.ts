import type { ClaudePresence, MergeStatus, Worktree, WorktreeSortMode } from '../types';

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

// Higher = sorts earlier in 'status' mode. Two-tier ranking: all unmerged
// worktrees sort above all merged ones, with working-tree status as the
// tiebreaker within each group. Prunable (orphaned) worktrees always sink
// to the very bottom.
//
// Unmerged tier (1–5): conflict > in-progress > dirty > diverged > clean
// Merged tier  (-9–-5): same relative order, offset by -10
// Prunable:     -20
function statusRank(wt: Worktree, mergeStatus?: MergeStatus): number {
  if (wt.prunable) return -20;

  let rank: number;
  if (wt.hasConflicts || wt.status === 'conflict') rank = 5;
  else if (wt.inProgress) rank = 4;
  else if (wt.status === 'dirty') rank = 3;
  else if (wt.status === 'diverged') rank = 2;
  else rank = 1; // clean

  const isMerged =
    mergeStatus === 'merged-normally' || mergeStatus === 'squash-merged' || mergeStatus === 'direct-merged';
  return isMerged ? rank - 10 : rank;
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
  /** Branch name → MergeStatus. Used by 'status' mode to group unmerged above merged. */
  mergeStatusByBranch?: Map<string, MergeStatus>;
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
          const msMap = ctx.mergeStatusByBranch;
          const diff =
            statusRank(b, msMap?.get(b.branch)) -
            statusRank(a, msMap?.get(a.branch));
          if (diff !== 0) return diff;
          // Tiebreak alphabetically so cards within a status tier have a
          // fully stable order. The previous recency tiebreaker caused
          // cards to shuffle on background refreshes whenever Claude
          // presence timestamps ticked forward.
          return worktreeName(a).localeCompare(worktreeName(b));
        };
    }
  })();

  return [...primary, ...[...rest].sort(cmp)];
}
