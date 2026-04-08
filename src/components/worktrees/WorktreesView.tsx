import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useRepoStore } from '../../store/useRepoStore';
import { WorktreeCard } from './WorktreeCard';
import { EmptyState } from '../common/EmptyState';
import { CreateWorktreeDialog, type CreateWorktreeValue } from './CreateWorktreeDialog';
import { createWorktree, removeWorktree, pruneWorktrees } from '../../services/gitService';
import { refreshOnce } from '../../services/refreshLoop';
import type { Worktree } from '../../types';

async function pickDirectory(): Promise<string | null> {
  try {
    const mod = await import('@tauri-apps/plugin-dialog');
    const result = await mod.open({ directory: true, multiple: false });
    if (typeof result === 'string') return result;
    return null;
  } catch {
    return null;
  }
}

export function WorktreesView() {
  const worktrees = useRepoStore((s) => s.worktrees);
  const branches = useRepoStore((s) => s.branches);
  const repo = useRepoStore((s) => s.repo);
  const setError = useRepoStore((s) => s.setError);
  const [createOpen, setCreateOpen] = useState(false);

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

  async function handleRemove(wt: Worktree) {
    if (!repo) return;
    if (!confirm(`Remove worktree ${wt.path}?`)) return;
    try {
      await removeWorktree(repo.path, wt.path, false);
      await refreshOnce({ userInitiated: true });
    } catch (e: any) {
      // Retry with --force only if the first attempt failed.
      if (confirm(`Remove failed: ${e?.message ?? e}\n\nForce remove?`)) {
        try {
          await removeWorktree(repo.path, wt.path, true);
          await refreshOnce({ userInitiated: true });
        } catch (e2: any) {
          setError(e2?.message ?? String(e2));
        }
      }
    }
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

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-6 pt-4">
        <button
          onClick={() => setCreateOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-wt-info/20 border border-wt-info/50 text-wt-info rounded hover:bg-wt-info/30"
        >
          <Plus className="w-3.5 h-3.5" /> New worktree
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
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {worktrees.map((w) => (
            <WorktreeCard key={w.path} wt={w} onRemove={handleRemove} onPrune={handlePrune} />
          ))}
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
    </div>
  );
}
