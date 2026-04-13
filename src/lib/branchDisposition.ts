import type { Branch, Worktree, MergeStatus } from '../types';
import { mergeStatusClass, mergeStatusLabel } from './colors';

export interface BranchDisposition {
  label: string;
  className: string;
  tooltip: string;
  // Optional inline action surfaced next to the pill in the WorktreeCard.
  // Currently only used for "main is behind origin/main → offer a pull
  // button". The card decides how to render and execute the action — the
  // helper just signals that one is available so the policy stays in one
  // place.
  action?: BranchDispositionAction;
}

export type BranchDispositionAction =
  | { kind: 'pull-default-branch'; label: string; ariaLabel: string };

// Compose the WorktreeCard branch-lifecycle pill from BOTH the branch's
// commit-history mergeStatus AND the worktree's filesystem state. The
// underlying conflict this resolves: a branch can be `merged-normally` (its
// commits are in main) while the worktree still has uncommitted edits — the
// bare "MERGED" pill misleads in that case, because the work in the tree is
// NOT merged.
//
// Contradiction suffixes only fire on the merged side. UNMERGED + dirty is a
// consistent reading (in-flight work has loose ends by definition; the card
// border + stat grid already convey it) so suffixing it would be noise.
//
// A worktree checked out directly on the default branch gets a dedicated
// "on <main>" pill instead of the lineage label — main is technically merged
// into itself, but the tautology is unhelpful. The pill escalates to a red
// warning when local work is accumulating, because committing on main
// bypasses the PR flow and is almost always a mistake.
//
// Returns null only when there is no branch entry AND the worktree isn't on
// the default branch (i.e., a detached HEAD).
export function branchDisposition(
  branch: Branch | undefined,
  worktree: Worktree,
  defaultBranch: string,
): BranchDisposition | null {
  // Default-branch check first: the warning is about the worktree's checkout,
  // not its commit lineage, so it must fire even when `branch` is undefined
  // (e.g., a fresh repo whose main hasn't been indexed yet). It also wins
  // over the merged/squash branches below — we never want a "main" worktree
  // showing "merged" when we have a more useful thing to say about it.
  if (worktree.branch === defaultBranch) {
    return defaultBranchDisposition(worktree, defaultBranch);
  }

  if (!branch) return null;

  // `empty` reflects the branch's commit history (no commits of its own), but
  // the moment the worktree shows ANY uncommitted activity — untracked files,
  // modifications, staged changes, conflicts, or an in-progress op — the
  // "empty" label is misleading because real work IS happening in the tree,
  // just not yet committed. Demote to `unmerged` so the pill matches the
  // user's mental model of "this branch has work in flight." We deliberately
  // do NOT mutate the input Branch; this is a display-only override and
  // BranchRow (which has no worktree context) keeps showing the raw `empty`.
  const displayStatus: MergeStatus =
    branch.mergeStatus === 'empty' && worktreeHasActivity(worktree)
      ? 'unmerged'
      : branch.mergeStatus;

  const baseLabel = mergeStatusLabel(displayStatus);
  const isMerged =
    displayStatus === 'merged-normally' || displayStatus === 'squash-merged';

  const contradiction = isMerged ? mergedContradiction(worktree) : null;

  if (!contradiction) {
    return {
      label: baseLabel,
      className: mergeStatusClass(displayStatus),
      tooltip: defaultTooltip(displayStatus),
    };
  }

  return {
    label: `${baseLabel} · ${contradiction.suffix}`,
    // Swap only the border to a dirty accent. Keeping bg/text on the merged
    // palette preserves "this is still the merged pill" while the orange
    // outline says "read the suffix before you delete this".
    className: dirtyAccentClass(displayStatus as 'merged-normally' | 'squash-merged'),
    tooltip: contradiction.tooltip,
  };
}

// "Has the user touched the worktree at all?" — used by both the refresh
// loop's post-ratchet demotion (data layer: mutates Branch.mergeStatus in
// the store) and the branchDisposition display-only override (belt-and-
// suspenders). We treat any uncommitted edit, conflict, or in-progress op
// as activity. Stash count is intentionally NOT included: stashes can
// outlive their original branch context and a stash on an otherwise-
// pristine empty branch shouldn't make it look in-flight.
export function worktreeHasActivity(wt: Worktree): boolean {
  if (wt.inProgress) return true;
  if (wt.hasConflicts) return true;
  if (wt.untrackedCount > 0 || wt.modifiedCount > 0 || wt.stagedCount > 0) {
    return true;
  }
  return false;
}

interface Contradiction {
  suffix: string;
  tooltip: string;
}

// Precedence mirrors urgency: an in-progress op is the loudest signal (the
// user is mid-rebase / mid-merge), then unresolved conflicts, then a real
// fork from upstream, then plain uncommitted edits. wt.status itself is a
// discriminated union of clean/dirty/conflict/diverged (see gitService
// worktreeCore), but `inProgress` is an orthogonal flag that can coexist
// with any of them — check it first.
function mergedContradiction(wt: Worktree): Contradiction | null {
  if (wt.inProgress) {
    return {
      suffix: wt.inProgress,
      tooltip: `Branch is merged into main, but a ${wt.inProgress} is partially completed in this worktree. Finish or abort it before removing the worktree.`,
    };
  }
  if (wt.status === 'conflict') {
    return {
      suffix: 'conflict',
      tooltip:
        'Branch is merged into main, but the worktree has unresolved conflicts. Resolve them before removing the worktree.',
    };
  }
  if (wt.status === 'diverged') {
    return {
      suffix: 'diverged',
      tooltip:
        'Branch is merged into main, but local and upstream have moved in different directions. Reconcile before removing the worktree.',
    };
  }
  if (wt.status === 'dirty') {
    const parts: string[] = [];
    if (wt.untrackedCount > 0) parts.push(`${wt.untrackedCount} untracked`);
    if (wt.modifiedCount > 0) parts.push(`${wt.modifiedCount} modified`);
    if (wt.stagedCount > 0) parts.push(`${wt.stagedCount} staged`);
    const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    return {
      suffix: 'edits',
      tooltip: `Branch is merged into main, but the worktree has uncommitted work${breakdown}. Commit, stash, or discard before removing the worktree.`,
    };
  }
  return null;
}

function dirtyAccentClass(s: 'merged-normally' | 'squash-merged'): string {
  switch (s) {
    case 'merged-normally':
      return 'bg-wt-info/15 text-wt-info border-wt-dirty/60';
    case 'squash-merged':
      return 'bg-wt-squash/15 text-wt-squash border-wt-dirty/60';
  }
}

function defaultTooltip(s: MergeStatus): string {
  switch (s) {
    case 'merged-normally':
      return 'Branch is merged into main and the worktree is clean — safe to remove.';
    case 'squash-merged':
      return 'Branch was squash-merged into main (patch-equivalent commits are present). Worktree is clean — safe to remove.';
    case 'unmerged':
      return 'Branch has commits not yet in main.';
    case 'empty':
      return "Branch has no commits of its own — it points at main. Nothing to merge yet.";
    case 'stale':
      return 'Branch is unmerged and has been idle for at least 30 days — consider pruning.';
  }
}

// Disposition for a worktree checked out directly on the default branch.
//
// Five cases, in priority order:
//   1. inProgress / conflict / diverged / dirty  → red WARNING (use a worktree!)
//   2. ahead of upstream                         → red WARNING (committed on main)
//   3. behind upstream                           → blue INFO + Pull action
//   4. clean and even with upstream              → quiet slate "on main" hint
//
// We surface the literal default branch name in the label (`on main`,
// `on master`, `on develop`) instead of a generic "DEFAULT" so the warning
// is unambiguous in repos with non-standard branch names. The label is
// rendered uppercase by the pill's CSS so we keep the source lowercase to
// match the rest of the disposition vocabulary.
function defaultBranchDisposition(wt: Worktree, defaultBranch: string): BranchDisposition {
  const baseLabel = `on ${defaultBranch}`;

  // Filesystem / in-progress contradictions reuse the merged-side vocabulary
  // so suffixes (`edits`, `conflict`, `rebase`, …) mean the same thing in
  // both contexts. We don't reuse mergedContradiction()'s tooltips though —
  // the actionable advice on main ("create a worktree") is different from
  // the actionable advice on a merged branch ("commit before deleting").
  if (wt.inProgress) {
    return warnOnDefault(
      `${baseLabel} · ${wt.inProgress}`,
      `A ${wt.inProgress} is partially completed directly on ${defaultBranch}. Finish or abort it, then move the work to a feature branch (\`git worktree add ../my-feature -b my-feature\`).`,
    );
  }
  if (wt.status === 'conflict') {
    return warnOnDefault(
      `${baseLabel} · conflict`,
      `Unresolved conflicts on ${defaultBranch}. Resolve them, then move the work to a feature branch before committing.`,
    );
  }
  if (wt.status === 'diverged') {
    return warnOnDefault(
      `${baseLabel} · diverged`,
      `${defaultBranch} has diverged from origin/${defaultBranch} (${wt.ahead} ahead, ${wt.behind} behind). You committed on main locally — move those commits to a feature branch and reset ${defaultBranch} to the remote.`,
    );
  }
  if (wt.status === 'dirty') {
    const parts: string[] = [];
    if (wt.untrackedCount > 0) parts.push(`${wt.untrackedCount} untracked`);
    if (wt.modifiedCount > 0) parts.push(`${wt.modifiedCount} modified`);
    if (wt.stagedCount > 0) parts.push(`${wt.stagedCount} staged`);
    const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    return warnOnDefault(
      `${baseLabel} · edits`,
      `You have uncommitted work directly on ${defaultBranch}${breakdown}. Don't commit it here — create a worktree (\`git worktree add ../my-feature -b my-feature\`) so the work can land via PR.`,
    );
  }

  // status === 'clean' from here. Two clean sub-cases that matter:
  // ahead-only (committed locally on main) and behind-only (remote moved
  // forward). The classifier in worktreeCore considers both "clean" because
  // there are no uncommitted files — but for the default branch they have
  // very different meanings.
  if (wt.ahead > 0) {
    return warnOnDefault(
      `${baseLabel} · ${wt.ahead} ahead`,
      `${wt.ahead} commit${wt.ahead === 1 ? '' : 's'} on ${defaultBranch} are not on origin/${defaultBranch}. You committed directly to main — move them to a feature branch (\`git switch -c my-feature\`, then reset ${defaultBranch} to the remote) before pushing.`,
    );
  }
  if (wt.behind > 0) {
    return {
      label: `${baseLabel} · ${wt.behind} behind`,
      // Blue info palette — this is informational, not a warning. The
      // remote moved forward, which is normal; the action is to pull.
      className: 'bg-wt-info/15 text-wt-info border-wt-info/40',
      tooltip: `${defaultBranch} is ${wt.behind} commit${wt.behind === 1 ? '' : 's'} behind origin/${defaultBranch}. Click Pull to fast-forward.`,
      action: {
        kind: 'pull-default-branch',
        label: 'Pull',
        ariaLabel: `Fast-forward ${defaultBranch} from origin`,
      },
    };
  }

  // Genuinely clean and up to date. Quiet slate hint — not an error, but
  // worth a small reminder so a user about to type `git commit` is nudged
  // toward `git worktree add` first.
  return {
    label: baseLabel,
    className: 'bg-wt-active/15 text-wt-active border-wt-active/40',
    tooltip: `You're checked out on ${defaultBranch}. For new work, create a worktree first (\`git worktree add ../my-feature -b my-feature\`) so changes land via PR instead of being committed directly to main.`,
  };
}

function warnOnDefault(label: string, tooltip: string): BranchDisposition {
  return {
    label,
    className: 'bg-wt-conflict/15 text-wt-conflict border-wt-conflict/60',
    tooltip,
  };
}
