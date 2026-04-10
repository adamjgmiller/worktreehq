import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useRepoStore } from '../../store/useRepoStore';
import { WorktreeCard } from './WorktreeCard';
import { EmptyState } from '../common/EmptyState';
import { CreateWorktreeDialog, type CreateWorktreeValue } from './CreateWorktreeDialog';
import { RemoveWorktreeDialog } from './RemoveWorktreeDialog';
import {
  createWorktree,
  removeWorktree,
  pruneWorktrees,
  deleteLocalBranch,
  deleteRemoteBranch,
} from '../../services/gitService';
import { refreshOnce } from '../../services/refreshLoop';
import { pickDirectory } from '../../services/repoSelect';
import type { Worktree } from '../../types';

export function WorktreesView() {
  const worktrees = useRepoStore((s) => s.worktrees);
  const branches = useRepoStore((s) => s.branches);
  const repo = useRepoStore((s) => s.repo);
  const setError = useRepoStore((s) => s.setError);
  const [createOpen, setCreateOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Worktree | null>(null);

  // Listen for the global keyboard shortcut (N) to open the Create dialog.
  useEffect(() => {
    const handler = () => setCreateOpen(true);
    window.addEventListener('wthq:create-worktree', handler);
    return () => window.removeEventListener('wthq:create-worktree', handler);
  }, []);

  async function handleCreate(v: CreateWorktreeValue) {
    if (!repo) return;
    try {
      await createWorktree(repo.path, v.path, v.branch, v.newBranch);
      setCreateOpen(false);
      await refreshOnce({ userInitiated: true });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  function handleRemove(wt: Worktree) {
    setRemoveTarget(wt);
  }

  async function handleConfirmRemove(opts: {
    force: boolean;
    cleanupBranches: boolean;
  }) {
    if (!repo || !removeTarget) return;
    // Phase 1: remove the worktree. Throws on failure so the dialog's local
    // error path can render the git stderr inline — the worktree still
    // exists and the user might want to retry from the same modal.
    await removeWorktree(repo.path, removeTarget.path, opts.force);
    // Phase 2: branch cleanup. Errors here are surfaced via the store error
    // banner, NOT re-thrown: the worktree removal already succeeded, so
    // keeping the modal open would misleadingly imply the whole op rolled
    // back. We still want the user to see what failed, but next to the
    // (now empty) worktree slot.
    const cleanupErrors: string[] = [];
    if (opts.cleanupBranches) {
      // Look up the Branch record fresh so we only attempt deletes for refs
      // that actually exist — avoids a confusing "remote ref does not
      // exist" error when only the local branch is around (or vice versa).
      const branch = branches.find((b) => b.name === removeTarget.branch);
      if (branch && branch.name !== repo.defaultBranch) {
        // Local first: if the remote delete succeeds but the local one
        // fails, the user is left with an orphaned local ref that's
        // harder to explain than the reverse.
        if (branch.hasLocal) {
          try {
            // Force (-D): the worktree was just removed and a clean worktree
            // for a squash-merged branch still looks "unmerged" to `git
            // branch -d`, which would reject the delete. The whole point of
            // this checkbox is to clean those up.
            await deleteLocalBranch(repo.path, branch.name, true);
          } catch (e: any) {
            cleanupErrors.push(`local branch: ${e?.message ?? String(e)}`);
          }
        }
        if (branch.hasRemote) {
          try {
            await deleteRemoteBranch(repo.path, 'origin', branch.name);
          } catch (e: any) {
            // Tolerate "remote ref does not exist": GitHub's auto-delete-
            // after-merge setting can remove the remote branch before our
            // 15s poll refreshes hasRemote, so the user's intent ("make the
            // remote branch not exist") is already satisfied.
            const msg = e?.message ?? String(e);
            if (!/remote ref does not exist|unable to delete.*remote ref/i.test(msg)) {
              cleanupErrors.push(`remote branch: ${msg}`);
            }
          }
        }
      }
    }
    setRemoveTarget(null);
    if (cleanupErrors.length > 0) {
      setError(
        `Worktree removed, but branch cleanup failed — ${cleanupErrors.join('; ')}`,
      );
    }
    await refreshOnce({ userInitiated: true });
  }

  async function handlePrune() {
    if (!repo) return;
    try {
      await pruneWorktrees(repo.path);
      await refreshOnce({ userInitiated: true });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  // Per-card "prune this orphan" handler. Differs from the repo-wide prune
  // above by passing `--expire=now`: the user explicitly clicked a button on
  // a card we already know is orphaned, so honoring git's 3h grace period
  // here would mean the click does nothing for new ghosts. Explicit user
  // action wins over the heuristic.
  async function handlePruneOrphan() {
    if (!repo) return;
    try {
      await pruneWorktrees(repo.path, { expire: 'now' });
      await refreshOnce({ userInitiated: true });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-6 pt-4">
        <button
          onClick={() => setCreateOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-wt-info/20 border border-wt-info/50 text-wt-info rounded hover:bg-wt-info/30"
        >
          <Plus className="w-3.5 h-3.5" /> New worktree <kbd className="ml-1 text-[10px] opacity-60">N</kbd>
        </button>
      </div>
      {worktrees.length === 0 ? (
        // A valid git repo always has at least the primary worktree, so an
        // empty list here means listWorktrees failed (or hasn't completed
        // yet). Frame the empty state accordingly instead of suggesting the
        // user add one with the button.
        <EmptyState
          title="No worktrees loaded"
          hint="Either the repo isn't readable yet or `git worktree list` failed. Check the error banner above."
        />
      ) : (
        // Wrap the grid in a flex-1 scroll container so cards below the
        // viewport are reachable. Without this the grid spills out of the
        // parent (which is `flex-1 overflow-hidden` in App.tsx) and lower
        // cards are simply clipped — there's no way to scroll to them.
        <div className="flex-1 overflow-auto">
          {/*
            Rem-based responsive grid: column count is derived from how many
            20rem-wide tracks fit in the viewport, not from fixed pixel
            breakpoints. When the user zooms in, 20rem grows in pixel terms,
            so fewer columns fit and cards become genuinely wider — not just
            taller. With the old breakpoint grid (md:cols-2 xl:cols-3) the
            column count was locked to viewport pixels, so zoom only changed
            card height, never width.
          */}
          <div className="p-6 grid grid-cols-[repeat(auto-fit,minmax(20rem,1fr))] gap-5">
            {worktrees.map((w) => (
              // Vary the key on prunable so React unmounts the old card and
              // mounts the orphaned variant when a worktree transitions
              // (e.g. user `rm -rf`s the directory, refresh detects it).
              // Otherwise the early-return inside WorktreeCard would change
              // its hook count between renders and crash with a hooks-order
              // violation.
              <WorktreeCard
                key={w.prunable ? `orphan:${w.path}` : w.path}
                wt={w}
                onRemove={handleRemove}
                onPrune={handlePrune}
                onPruneOrphan={handlePruneOrphan}
              />
            ))}
          </div>
        </div>
      )}
      {createOpen && repo && (
        <CreateWorktreeDialog
          branches={branches}
          defaultBranch={repo.defaultBranch}
          onCancel={() => setCreateOpen(false)}
          onConfirm={handleCreate}
          onPickDirectory={pickDirectory}
        />
      )}
      {removeTarget && (() => {
        const branch = branches.find((b) => b.name === removeTarget.branch);
        return (
          <RemoveWorktreeDialog
            worktree={removeTarget}
            hasLocalBranch={branch?.hasLocal ?? false}
            hasRemoteBranch={branch?.hasRemote ?? false}
            isDefaultBranch={removeTarget.branch === repo?.defaultBranch}
            onCancel={() => setRemoveTarget(null)}
            onConfirm={handleConfirmRemove}
          />
        );
      })()}
    </div>
  );
}
