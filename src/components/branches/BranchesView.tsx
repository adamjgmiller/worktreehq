import { useEffect, useMemo, useState } from 'react';
import { useRepoStore } from '../../store/useRepoStore';
import { FilterBar } from './FilterBar';
import { BranchTable } from './BranchTable';
import { BulkActionBar } from './BulkActionBar';
import { ConfirmDeleteDialog, type DeleteMode } from './ConfirmDeleteDialog';
import { applyPreset, searchBranches, type FilterPreset } from '../../lib/filters';
import {
  deleteLocalBranch,
  deleteRemoteBranch,
  tagBranch,
  archiveTagNameFor,
  getUserEmail,
} from '../../services/gitService';
import { refreshOnce } from '../../services/refreshLoop';
import { EmptyState } from '../common/EmptyState';
import type { Branch } from '../../types';

export function BranchesView() {
  const branches = useRepoStore((s) => s.branches);
  const repo = useRepoStore((s) => s.repo);
  const setError = useRepoStore((s) => s.setError);
  const [preset, setPreset] = useState<FilterPreset>('all');
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<DeleteMode | null>(null);
  const [userEmail, setUserEmail] = useState<string | undefined>(undefined);
  // Squash-merged branches that git -d refused. Setting this opens a follow-up prompt.
  const [rejectedSquash, setRejectedSquash] = useState<Branch[] | null>(null);

  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    (async () => {
      const email = await getUserEmail(repo.path);
      if (!cancelled) setUserEmail(email);
    })();
    return () => {
      cancelled = true;
    };
  }, [repo]);

  const filtered = useMemo(
    () => searchBranches(applyPreset(branches, preset, { userEmail }), search),
    [branches, preset, search, userEmail],
  );
  const selectedBranches = filtered.filter((b) => selection.has(b.name));

  const toggle = (name: string) =>
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const toggleAll = () =>
    setSelection((prev) => {
      if (filtered.every((b) => prev.has(b.name))) return new Set();
      return new Set(filtered.map((b) => b.name));
    });

  async function performDelete(mode: DeleteMode) {
    if (!repo) return;
    const rejectedSquashMerged: Branch[] = [];
    const errors: string[] = [];
    const deletesLocal = mode !== 'remote';
    const deletesRemote = mode !== 'local';

    for (const b of selectedBranches) {
      try {
        if (mode === 'archive-and-delete' && b.hasLocal) {
          await tagBranch(repo.path, b.name, archiveTagNameFor(b.name));
        }
        if (deletesLocal && b.hasLocal) {
          try {
            // Never auto-force: git -d refuses unmerged branches and that's a
            // feature. For squash-merged branches we surface a dedicated follow-up
            // prompt; for other refusals we report the error so the user can act.
            await deleteLocalBranch(repo.path, b.name, false);
          } catch (e: any) {
            if (b.mergeStatus === 'squash-merged') {
              rejectedSquashMerged.push(b);
            } else {
              errors.push(`${b.name}: ${e?.message ?? e}`);
            }
            continue;
          }
        }
        if (deletesRemote && b.hasRemote) {
          await deleteRemoteBranch(repo.path, 'origin', b.name);
        }
      } catch (e: any) {
        errors.push(`${b.name}: ${e?.message ?? e}`);
      }
    }

    setSelection(new Set());
    setConfirm(null);
    if (errors.length > 0) {
      setError(errors.join('\n'));
    }
    if (rejectedSquashMerged.length > 0) {
      setRejectedSquash(rejectedSquashMerged);
    }
    await refreshOnce();
  }

  async function performForceDeleteSquash() {
    if (!repo || !rejectedSquash) return;
    try {
      for (const b of rejectedSquash) {
        if (b.hasLocal) await deleteLocalBranch(repo.path, b.name, true);
      }
      setRejectedSquash(null);
      await refreshOnce();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setRejectedSquash(null);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <FilterBar value={preset} onChange={setPreset} search={search} onSearch={setSearch} />
      {filtered.length === 0 ? (
        <EmptyState title="No branches match" hint="Try a different filter." />
      ) : (
        <div className="flex-1 overflow-auto">
          <BranchTable
            branches={filtered}
            selection={selection}
            onToggle={toggle}
            onToggleAll={toggleAll}
          />
        </div>
      )}
      <BulkActionBar count={selection.size} onAction={(m) => setConfirm(m)} />
      {confirm && (
        <ConfirmDeleteDialog
          branches={selectedBranches}
          mode={confirm}
          onCancel={() => setConfirm(null)}
          onConfirm={() => performDelete(confirm)}
        />
      )}
      {rejectedSquash && rejectedSquash.length > 0 && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-wt-panel border border-wt-border rounded-xl p-6 w-[520px]">
            <h2 className="text-lg font-semibold mb-2">Force delete squash-merged?</h2>
            <p className="text-sm text-neutral-400 mb-3">
              Git refused to delete {rejectedSquash.length}{' '}
              {rejectedSquash.length === 1 ? 'branch' : 'branches'} because they don't look merged
              from git's perspective. WorktreeHQ detected them as squash-merged via the PR merge
              commit. Force delete?
            </p>
            <div className="border border-wt-border rounded p-3 bg-wt-bg font-mono text-xs space-y-1 mb-4 max-h-48 overflow-auto">
              {rejectedSquash.map((b) => (
                <div key={b.name}>{b.name}</div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRejectedSquash(null)}
                className="px-3 py-1.5 text-sm text-neutral-400"
              >
                Cancel
              </button>
              <button
                onClick={performForceDeleteSquash}
                className="px-3 py-1.5 text-sm bg-wt-conflict/20 border border-wt-conflict/60 text-wt-conflict rounded hover:bg-wt-conflict/30"
              >
                Force delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
