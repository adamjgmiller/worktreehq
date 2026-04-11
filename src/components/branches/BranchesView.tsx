import { useEffect, useMemo, useState } from 'react';
import { useRepoStore } from '../../store/useRepoStore';
import { FilterBar } from './FilterBar';
import { BranchTable } from './BranchTable';
import { BulkActionBar } from './BulkActionBar';
import { ConfirmDeleteDialog, type DeleteMode } from './ConfirmDeleteDialog';
import { ForceDeleteSquashDialog, type RejectedSquash } from './ForceDeleteSquashDialog';
import { applyPreset, filterMine, searchBranches, type FilterPreset } from '../../lib/filters';
import {
  deleteLocalBranch,
  deleteRemoteBranch,
  tagBranch,
  archiveTagNameFor,
  getUserEmail,
} from '../../services/gitService';
import { refreshOnce } from '../../services/refreshLoop';
import { EmptyState } from '../common/EmptyState';

export function BranchesView() {
  const branches = useRepoStore((s) => s.branches);
  const repo = useRepoStore((s) => s.repo);
  const [preset, setPreset] = useState<FilterPreset>('all');
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<DeleteMode | null>(null);
  const [userEmail, setUserEmail] = useState<string | undefined>(undefined);
  // Local error slot — setError on the store gets clobbered by refreshOnce's `setError(null)`,
  // so bulk-delete errors need their own home where refreshes don't touch them.
  const [deleteErrors, setDeleteErrors] = useState<string[]>([]);
  const [rejectedSquash, setRejectedSquash] = useState<RejectedSquash[] | null>(null);
  // In-flight guard for performDelete and performForceDeleteSquash. Both are
  // bound to dialogs whose primary buttons used to remain clickable while the
  // async work was running, so a double-click could fire two parallel delete
  // loops against the same selection. The dialogs read this prop to disable
  // their controls and flip the title to "Deleting…".
  const [deleting, setDeleting] = useState(false);

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

  // Listen for global keyboard shortcuts dispatched by useKeyboardShortcuts.
  useEffect(() => {
    const onToggleAll = () => toggleAll();
    const onEscape = () => {
      if (search) {
        setSearch('');
      } else if (selection.size > 0) {
        setSelection(new Set());
      }
    };
    window.addEventListener('wthq:toggle-all-branches', onToggleAll);
    window.addEventListener('wthq:branches-escape', onEscape);
    return () => {
      window.removeEventListener('wthq:toggle-all-branches', onToggleAll);
      window.removeEventListener('wthq:branches-escape', onEscape);
    };
  });

  const filtered = useMemo(() => {
    let result = applyPreset(branches, preset, { defaultBranch: repo?.defaultBranch });
    if (mine) result = filterMine(result, userEmail);
    return searchBranches(result, search);
  }, [branches, preset, mine, search, userEmail, repo?.defaultBranch]);
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
    if (!repo || deleting) return;
    setDeleting(true);
    // Clear any stale error pile from a previous run before adding new ones —
    // otherwise a successful retry of a failed batch leaves the old errors
    // visible above the fresh result and the user can't tell what came from
    // which run.
    setDeleteErrors([]);
    const rejected: RejectedSquash[] = [];
    const errors: string[] = [];
    const deletesLocal = mode !== 'remote';
    const deletesRemote = mode !== 'local';

    try {
      for (const b of selectedBranches) {
        let localRejectedAsSquash = false;
        try {
          if (deletesLocal && b.hasLocal) {
            // Tag-then-delete: tag FIRST so the archive points at the live tip,
            // but only if the branch actually looks deletable. For non-squash,
            // non-merged branches we'd otherwise create an orphan archive tag
            // (delete fails → tag remains pointing at a still-live branch).
            // squash-merged branches are expected to fail -d and route to the
            // force-delete follow-up dialog, so the tag IS desired in that case.
            const shouldTag =
              mode === 'archive-and-delete' &&
              (b.mergeStatus === 'merged-normally' || b.mergeStatus === 'squash-merged');
            if (shouldTag) {
              await tagBranch(repo.path, b.name, archiveTagNameFor(b.name));
            }
            try {
              // Never auto-force: git -d refuses unmerged branches and that's a feature.
              // Squash-merged rejections route to the force-delete follow-up dialog.
              await deleteLocalBranch(repo.path, b.name, false);
            } catch (e: any) {
              if (b.mergeStatus === 'squash-merged') {
                rejected.push({ branch: b, mode });
                localRejectedAsSquash = true;
              } else {
                errors.push(`${b.name}: ${e?.message ?? e}`);
                continue;
              }
            }
          }
          // The remote side runs regardless of whether the local delete was deferred
          // to the force-delete follow-up — otherwise `both`/`archive-and-delete` strand
          // the remote ref for the user to clean up manually.
          if (deletesRemote && b.hasRemote && !localRejectedAsSquash) {
            await deleteRemoteBranch(repo.path, 'origin', b.name);
          }
        } catch (e: any) {
          errors.push(`${b.name}: ${e?.message ?? e}`);
        }
      }

      setSelection(new Set());
      setConfirm(null);
      setDeleteErrors(errors);
      if (rejected.length > 0) {
        setRejectedSquash(rejected);
      }
      await refreshOnce({ userInitiated: true });
    } finally {
      setDeleting(false);
    }
  }

  async function performForceDeleteSquash() {
    if (!repo || !rejectedSquash || deleting) return;
    setDeleting(true);
    try {
      const errors: string[] = [];
      for (const item of rejectedSquash) {
        try {
          if (item.branch.hasLocal) {
            await deleteLocalBranch(repo.path, item.branch.name, true);
          }
          // Honor the original mode: if the user picked `both` or `archive-and-delete`,
          // their confirmation covered the remote ref too, so remove it now that the
          // local force-delete succeeded.
          const wantsRemote = item.mode === 'both' || item.mode === 'archive-and-delete';
          if (wantsRemote && item.branch.hasRemote) {
            await deleteRemoteBranch(repo.path, 'origin', item.branch.name);
          }
        } catch (e: any) {
          errors.push(`${item.branch.name}: ${e?.message ?? e}`);
        }
      }
      setRejectedSquash(null);
      if (errors.length > 0) {
        setDeleteErrors((prev) => [...prev, ...errors]);
      }
      await refreshOnce({ userInitiated: true });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <FilterBar value={preset} onChange={setPreset} mine={mine} onMineChange={setMine} search={search} onSearch={setSearch} />
      {deleteErrors.length > 0 && (
        <div className="px-4 py-2 bg-wt-conflict/10 border-b border-wt-conflict/40 text-xs text-wt-conflict font-mono flex items-start gap-3">
          <div className="flex-1 whitespace-pre-wrap">{deleteErrors.join('\n')}</div>
          <button
            onClick={() => setDeleteErrors([])}
            className="text-wt-fg-2 hover:text-wt-fg"
            aria-label="dismiss errors"
          >
            ×
          </button>
        </div>
      )}
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
          submitting={deleting}
          onCancel={() => setConfirm(null)}
          onConfirm={() => performDelete(confirm)}
        />
      )}
      {rejectedSquash && rejectedSquash.length > 0 && (
        <ForceDeleteSquashDialog
          rejected={rejectedSquash}
          submitting={deleting}
          onCancel={() => setRejectedSquash(null)}
          onConfirm={performForceDeleteSquash}
        />
      )}
    </div>
  );
}
