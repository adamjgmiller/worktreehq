import type {
  Worktree,
  Branch,
  ClaudePresence,
  WorktreeConflictSummary,
} from '../types';

// Reconcile a freshly-produced list against the previous list by stable key
// and reuse prior object references when every field is equal. The store
// then publishes references that are === across ticks whenever content is
// unchanged, which is what lets React.memo on WorktreeCard skip re-render on
// cards whose data didn't actually move.
//
// All five helpers here use shallow field equality — none of the reconciled
// types contain nested objects that mutate independently, so deep equality
// isn't required. If a new nested field is added later, add it to the
// corresponding equality check below.

function worktreeEqual(a: Worktree, b: Worktree): boolean {
  return (
    a.path === b.path &&
    a.branch === b.branch &&
    a.upstream === b.upstream &&
    a.isPrimary === b.isPrimary &&
    a.head === b.head &&
    a.untrackedCount === b.untrackedCount &&
    a.modifiedCount === b.modifiedCount &&
    a.stagedCount === b.stagedCount &&
    a.stashCount === b.stashCount &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.aheadOfMain === b.aheadOfMain &&
    a.behindMain === b.behindMain &&
    a.hasConflicts === b.hasConflicts &&
    a.inProgress === b.inProgress &&
    a.status === b.status &&
    a.prunable === b.prunable &&
    a.lastCommit.sha === b.lastCommit.sha &&
    a.lastCommit.message === b.lastCommit.message &&
    a.lastCommit.date === b.lastCommit.date &&
    a.lastCommit.author === b.lastCommit.author
  );
}

function branchEqual(a: Branch, b: Branch): boolean {
  if (
    a.name !== b.name ||
    a.hasLocal !== b.hasLocal ||
    a.hasRemote !== b.hasRemote ||
    a.lastCommitDate !== b.lastCommitDate ||
    a.lastCommitSha !== b.lastCommitSha ||
    a.aheadOfMain !== b.aheadOfMain ||
    a.behindMain !== b.behindMain ||
    a.mergeStatus !== b.mergeStatus ||
    a.worktreePath !== b.worktreePath ||
    a.upstreamGone !== b.upstreamGone ||
    a.authorEmail !== b.authorEmail
  ) {
    return false;
  }
  // PRInfo is immutable per tick (constructed fresh by githubService) but
  // references the same remote truth. Compare by the handful of fields the
  // UI actually reads so a fresh fetch that returns identical PR state
  // still reuses the branch reference.
  const ap = a.pr;
  const bp = b.pr;
  if (!ap && !bp) return true;
  if (!ap || !bp) return false;
  return (
    ap.number === bp.number &&
    ap.state === bp.state &&
    ap.mergedAt === bp.mergedAt &&
    ap.mergeCommitSha === bp.mergeCommitSha &&
    ap.isDraft === bp.isDraft &&
    ap.mergeable === bp.mergeable &&
    ap.checksStatus === bp.checksStatus &&
    ap.reviewDecision === bp.reviewDecision &&
    ap.title === bp.title &&
    ap.url === bp.url
  );
}

function presenceEqual(a: ClaudePresence, b: ClaudePresence): boolean {
  if (
    a.status !== b.status ||
    a.ideName !== b.ideName ||
    a.pid !== b.pid ||
    a.lastActivity !== b.lastActivity ||
    a.activeSessionId !== b.activeSessionId ||
    a.liveSessionCount !== b.liveSessionCount ||
    a.inactiveSessions.length !== b.inactiveSessions.length
  ) {
    return false;
  }
  for (let i = 0; i < a.inactiveSessions.length; i++) {
    const sa = a.inactiveSessions[i];
    const sb = b.inactiveSessions[i];
    if (sa.sessionId !== sb.sessionId || sa.lastActivity !== sb.lastActivity) {
      return false;
    }
  }
  return true;
}

function conflictSummaryEqual(
  a: WorktreeConflictSummary,
  b: WorktreeConflictSummary,
): boolean {
  return (
    a.conflictCount === b.conflictCount &&
    a.cleanOverlapCount === b.cleanOverlapCount
  );
}

// Reconcile a new list against the previous list, keyed by a stable field,
// reusing references when content is equal. The outer array identity is
// also preserved when every element is reused, so a consumer comparing the
// array reference across ticks can short-circuit too.
function reconcileList<T>(
  prev: T[],
  next: T[],
  keyOf: (t: T) => string,
  isEqual: (a: T, b: T) => boolean,
): T[] {
  if (prev.length === 0) return next;
  const prevByKey = new Map<string, T>();
  for (const item of prev) prevByKey.set(keyOf(item), item);
  const out: T[] = new Array(next.length);
  let allReused = next.length === prev.length;
  for (let i = 0; i < next.length; i++) {
    const item = next[i];
    const existing = prevByKey.get(keyOf(item));
    if (existing && isEqual(existing, item)) {
      out[i] = existing;
      if (allReused && prev[i] !== existing) allReused = false;
    } else {
      out[i] = item;
      allReused = false;
    }
  }
  return allReused ? prev : out;
}

function reconcileMap<V>(
  prev: Map<string, V>,
  next: Map<string, V>,
  isEqual: (a: V, b: V) => boolean,
): Map<string, V> {
  if (prev.size === 0) return next;
  if (prev.size !== next.size) {
    const merged = new Map<string, V>();
    for (const [k, v] of next) {
      const existing = prev.get(k);
      merged.set(k, existing && isEqual(existing, v) ? existing : v);
    }
    return merged;
  }
  // Same cardinality: try to reuse values in place. If every value is
  // reference-equal to the prior map's value, keep the prior map reference
  // so consumers that memoize on the Map reference can skip work entirely.
  const merged = new Map<string, V>();
  let allReused = true;
  for (const [k, v] of next) {
    const existing = prev.get(k);
    if (existing && isEqual(existing, v)) {
      merged.set(k, existing);
    } else {
      merged.set(k, v);
      allReused = false;
    }
  }
  if (allReused) {
    for (const k of prev.keys()) {
      if (!merged.has(k)) {
        return merged;
      }
    }
    return prev;
  }
  return merged;
}

export function reconcileWorktrees(prev: Worktree[], next: Worktree[]): Worktree[] {
  return reconcileList(prev, next, (w) => w.path, worktreeEqual);
}

export function reconcileBranches(prev: Branch[], next: Branch[]): Branch[] {
  return reconcileList(prev, next, (b) => b.name, branchEqual);
}

export function reconcileClaudePresence(
  prev: Map<string, ClaudePresence>,
  next: Map<string, ClaudePresence>,
): Map<string, ClaudePresence> {
  return reconcileMap(prev, next, presenceEqual);
}

export function reconcileConflictSummary(
  prev: Map<string, WorktreeConflictSummary>,
  next: Map<string, WorktreeConflictSummary>,
): Map<string, WorktreeConflictSummary> {
  return reconcileMap(prev, next, conflictSummaryEqual);
}
