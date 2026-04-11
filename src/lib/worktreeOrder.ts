import type { Worktree } from '../types';

/**
 * Reconcile live worktrees with a persisted ordering.
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
