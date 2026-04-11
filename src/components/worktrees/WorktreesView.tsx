import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
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
import { writeWorktreeOrder } from '../../services/worktreeOrderService';
import { reconcileOrder } from '../../lib/worktreeOrder';
import type { Worktree } from '../../types';

// Walk up from the pointer-event target to the card boundary. If we hit an
// interactive element first, suppress drag so clicks on buttons/links/
// textareas/menus behave normally. Everything else on the card is fair game.
function isInteractiveElement(el: HTMLElement | null): boolean {
  while (el) {
    if (el.dataset.dndCard !== undefined) return false;
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' ||
        tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    el = el.parentElement;
  }
  return false;
}

// PointerSensor subclass that skips drags originating from interactive
// elements inside the card. This lets the whole card surface be draggable
// without needing a dedicated drag handle.
class CardPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: (event: React.PointerEvent) => {
        return !isInteractiveElement(event.nativeEvent.target as HTMLElement);
      },
    },
  ];
}

export function WorktreesView() {
  const worktrees = useRepoStore((s) => s.worktrees);
  const branches = useRepoStore((s) => s.branches);
  const repo = useRepoStore((s) => s.repo);
  const setError = useRepoStore((s) => s.setError);
  const worktreeOrder = useRepoStore((s) => s.worktreeOrder);
  const setWorktreeOrder = useRepoStore((s) => s.setWorktreeOrder);
  const [createOpen, setCreateOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Worktree | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(CardPointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const orderedWorktrees = useMemo(
    () => reconcileOrder(worktrees, worktreeOrder),
    [worktrees, worktreeOrder],
  );
  const sortableIds = useMemo(
    () => orderedWorktrees.map((w) => w.path),
    [orderedWorktrees],
  );
  const activeWorktree = activeId
    ? orderedWorktrees.find((w) => w.path === activeId) ?? null
    : null;

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragCancel() {
    setActiveId(null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = sortableIds.indexOf(active.id as string);
    const newIndex = sortableIds.indexOf(over.id as string);
    if (oldIndex === -1 || newIndex === -1) return;
    const newOrder = [...sortableIds];
    newOrder.splice(oldIndex, 1);
    newOrder.splice(newIndex, 0, active.id as string);
    setWorktreeOrder(newOrder);
    if (repo) {
      void writeWorktreeOrder(repo.path, newOrder);
    }
  }

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
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <SortableContext items={sortableIds} strategy={rectSortingStrategy}>
              <div className="p-6 grid grid-cols-[repeat(auto-fit,minmax(20rem,1fr))] gap-5">
                {orderedWorktrees.map((w) => (
                  <WorktreeCard
                    key={w.prunable ? `orphan:${w.path}` : w.path}
                    wt={w}
                    onRemove={handleRemove}
                    onPrune={handlePrune}
                    onPruneOrphan={handlePruneOrphan}
                    isDragging={activeId === w.path}
                    isAnyDragging={activeId !== null}
                  />
                ))}
              </div>
            </SortableContext>
            <DragOverlay>
              {activeWorktree && (
                <WorktreeCard
                  wt={activeWorktree}
                  isOverlay
                />
              )}
            </DragOverlay>
          </DndContext>
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
