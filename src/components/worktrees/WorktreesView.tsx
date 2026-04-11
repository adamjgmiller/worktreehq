import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
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
import { runShellCommands } from '../../services/shellService';
import { invoke } from '../../services/tauriBridge';
import {
  writeWorktreeOrder,
  writeWorktreeSortMode,
} from '../../services/worktreeOrderService';
import { sortWorktrees } from '../../lib/worktreeOrder';
import { WorktreeSortMenu } from './WorktreeSortMenu';
import { attachInteractionListeners } from '../../services/interactionBusy';
import type { Branch, Worktree, WorktreeSortMode } from '../../types';

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
  const worktreeSortMode = useRepoStore((s) => s.worktreeSortMode);
  const setWorktreeSortMode = useRepoStore((s) => s.setWorktreeSortMode);
  const claudePresence = useRepoStore((s) => s.claudePresence);
  const conflictSummaryByPath = useRepoStore((s) => s.conflictSummaryByPath);
  const [createOpen, setCreateOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Worktree | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Saved default for post-create commands. Re-read from config each time
  // the Create dialog opens so edits made in Settings between creations
  // are reflected. The dialog seeds its own editable state from this.
  const [defaultPostCreate, setDefaultPostCreate] = useState('');
  // Enables framer-motion's layout animation on the card shell. Kept OFF by
  // default so refresh ticks don't pay the per-card getBoundingClientRect
  // cost. Flipped ON just before an explicit reorder (sort-mode change) via
  // flushSync, then back OFF after the 600ms animation window. See
  // handleSortModeChange below for the why.
  const [animateLayout, setAnimateLayout] = useState(false);
  const animateTimerRef = useRef<number | null>(null);
  // Callback ref for the scroll container. Tracks scroll/pointer activity
  // on the grid so the refresh commit can defer itself until the user is
  // idle. See services/interactionBusy.ts — listeners are passive so they
  // never block scroll themselves; they just poke a module-level busy-until
  // timestamp that waitForInteractionIdle polls.
  //
  // Using a callback ref (rather than useRef + useEffect) ties listener
  // lifetime to the actual DOM node's mount/unmount, so any remount of the
  // container cleanly detaches from the old node and re-attaches to the new.
  // The inner ref holds the detach fn from the previously-attached node.
  const scrollListenerCleanupRef = useRef<(() => void) | null>(null);
  const scrollContainerRef = useCallback((el: HTMLDivElement | null) => {
    if (scrollListenerCleanupRef.current) {
      scrollListenerCleanupRef.current();
      scrollListenerCleanupRef.current = null;
    }
    if (el) {
      scrollListenerCleanupRef.current = attachInteractionListeners(el);
    }
  }, []);
  useEffect(() => {
    return () => {
      if (animateTimerRef.current != null) {
        window.clearTimeout(animateTimerRef.current);
      }
    };
  }, []);

  const sensors = useSensors(
    useSensor(CardPointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const orderedWorktrees = useMemo(
    () =>
      sortWorktrees(worktrees, worktreeSortMode, {
        claudePresence,
        manualOrder: worktreeOrder,
      }),
    [worktrees, worktreeSortMode, claudePresence, worktreeOrder],
  );
  const sortableIds = useMemo(
    () => orderedWorktrees.map((w) => w.path),
    [orderedWorktrees],
  );
  // Precompute the branch-by-name lookup so each card gets O(1) access to
  // its branch entry — the old approach had every card run `.find()` over
  // the whole branches array on every render, which is what made
  // `setBranches` cascade into N linear scans per tick.
  const branchByName = useMemo(() => {
    const m = new Map<string, Branch>();
    for (const b of branches) m.set(b.name, b);
    return m;
  }, [branches]);
  const defaultBranch = repo?.defaultBranch ?? 'main';
  const activeWorktree = activeId
    ? orderedWorktrees.find((w) => w.path === activeId) ?? null
    : null;

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragCancel() {
    setActiveId(null);
  }

  // Explicit sort-mode change is the one moment we want a layout animation:
  // the user clicked a new mode and should see cards slide into their new
  // positions. The trick is that framer-motion's `layout` prop needs to be
  // TRUE during both the "before" render (to capture old positions via its
  // useLayoutEffect) and the "after" render (to measure and animate to new
  // positions). If we just toggle it in the same event handler as the sort
  // change, React batches both into one render and framer never sees the
  // "before" state — no animation.
  //
  // flushSync forces the first setState to commit synchronously. By the
  // time we call setWorktreeSortMode, framer has already measured the old
  // positions in its layout effect. The second commit re-renders with the
  // new data, framer compares, and the FLIP animation runs. After ~600ms
  // (cover the 300ms default + easing headroom) we flip animateLayout back
  // OFF so subsequent refresh ticks skip the per-card measurement cost.
  function handleSortModeChange(next: WorktreeSortMode) {
    if (worktreeSortMode !== next) {
      flushSync(() => setAnimateLayout(true));
    }
    setWorktreeSortMode(next);
    if (repo) {
      void writeWorktreeSortMode(repo.path, next);
    }
    if (animateTimerRef.current != null) {
      window.clearTimeout(animateTimerRef.current);
    }
    animateTimerRef.current = window.setTimeout(() => {
      setAnimateLayout(false);
      animateTimerRef.current = null;
    }, 600);
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
    // Dragging always implies the user wants their manual arrangement honored
    // from now on. If they were previously on an auto-sort mode, flip to
    // 'manual' so their drag doesn't get immediately re-sorted away on the
    // next activity tick. The sort menu is the escape hatch back.
    if (worktreeSortMode !== 'manual') {
      setWorktreeSortMode('manual');
      if (repo) void writeWorktreeSortMode(repo.path, 'manual');
    }
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

  // Re-read the saved default whenever the Create dialog opens so a change
  // made in Settings between creations shows up immediately. Best-effort:
  // on failure we just fall back to whatever was last loaded (or empty).
  useEffect(() => {
    if (!createOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const cfg = await invoke<{ post_create_commands?: string }>('read_config');
        if (!cancelled) setDefaultPostCreate(cfg.post_create_commands ?? '');
      } catch {
        /* leave previous value in place */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [createOpen]);

  async function handleCreate(v: CreateWorktreeValue) {
    if (!repo) return;
    try {
      await createWorktree(repo.path, v.path, v.branch, v.newBranch);
      // Close the dialog as soon as the worktree exists — the refresh and
      // post-create script both run after. Keeping it open through a long
      // `npm install` would be confusing UX.
      setCreateOpen(false);
      await refreshOnce({ userInitiated: true });
      // Post-create script runs AFTER git succeeds. If it fails we surface
      // the output via the error banner but deliberately do NOT roll back
      // the worktree — the directory is real and might contain files the
      // user wants to inspect. Empty scripts short-circuit in the Rust
      // command so the common case has no overhead.
      if (v.postCreateCommands.trim()) {
        const result = await runShellCommands(v.path, v.postCreateCommands);
        if (result.code !== 0) {
          const body = (result.stderr || result.stdout || '').trim();
          setError(
            `Worktree created, but post-create commands failed (exit ${result.code})` +
              (body ? `:\n${body}` : '.'),
          );
        }
      }
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
        <WorktreeSortMenu
          mode={worktreeSortMode}
          onChange={handleSortModeChange}
        />
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
        <div ref={scrollContainerRef} className="flex-1 overflow-auto">
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
                    branchInfo={branchByName.get(w.branch)}
                    presence={claudePresence.get(w.path)}
                    conflictSummary={conflictSummaryByPath.get(w.path)}
                    defaultBranch={defaultBranch}
                    onRemove={handleRemove}
                    onPrune={handlePrune}
                    onPruneOrphan={handlePruneOrphan}
                    isDragging={activeId === w.path}
                    animateLayout={animateLayout}
                  />
                ))}
              </div>
            </SortableContext>
            <DragOverlay>
              {activeWorktree && (
                <WorktreeCard
                  wt={activeWorktree}
                  branchInfo={branchByName.get(activeWorktree.branch)}
                  presence={claudePresence.get(activeWorktree.path)}
                  conflictSummary={conflictSummaryByPath.get(activeWorktree.path)}
                  defaultBranch={defaultBranch}
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
          defaultPostCreateCommands={defaultPostCreate}
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
