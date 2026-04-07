import { useMemo, useState } from 'react';
import { useRepoStore } from '../../store/useRepoStore';
import { FilterBar } from './FilterBar';
import { BranchTable } from './BranchTable';
import { BulkActionBar } from './BulkActionBar';
import { ConfirmDeleteDialog, type DeleteMode } from './ConfirmDeleteDialog';
import { applyPreset, searchBranches, type FilterPreset } from '../../lib/filters';
import { deleteLocalBranch, deleteRemoteBranch } from '../../services/gitService';
import { refreshOnce } from '../../services/refreshLoop';
import { EmptyState } from '../common/EmptyState';

export function BranchesView() {
  const branches = useRepoStore((s) => s.branches);
  const repo = useRepoStore((s) => s.repo);
  const setError = useRepoStore((s) => s.setError);
  const [preset, setPreset] = useState<FilterPreset>('all');
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<DeleteMode | null>(null);

  const filtered = useMemo(
    () => searchBranches(applyPreset(branches, preset), search),
    [branches, preset, search],
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
    try {
      for (const b of selectedBranches) {
        if (mode !== 'remote' && b.hasLocal) {
          await deleteLocalBranch(repo.path, b.name, true);
        }
        if (mode !== 'local' && b.hasRemote) {
          await deleteRemoteBranch(repo.path, 'origin', b.name);
        }
      }
      setSelection(new Set());
      setConfirm(null);
      await refreshOnce();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setConfirm(null);
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
    </div>
  );
}
