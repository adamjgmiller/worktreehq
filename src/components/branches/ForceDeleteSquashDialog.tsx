import { useEffect, useRef, useState } from 'react';
import type { Branch } from '../../types';
import type { DeleteMode } from './ConfirmDeleteDialog';
import { AlertTriangle, X } from 'lucide-react';

// Follow-up confirmation when git -d refused to delete a squash-merged branch
// (git's perspective: "not fully merged"). This is a destructive flow — it
// runs `git branch -D` and may also touch the remote when the original mode
// was 'both' or 'archive-and-delete' — so it gets the same shape as the other
// destructive dialogs: Escape closes, backdrop closes, focus on Cancel,
// type-to-confirm, submitting state to block double-submit.
export interface RejectedSquash {
  branch: Branch;
  mode: DeleteMode;
}

export function ForceDeleteSquashDialog({
  rejected,
  submitting = false,
  onCancel,
  onConfirm,
}: {
  rejected: RejectedSquash[];
  submitting?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const canConfirm = !submitting && typed === 'delete';
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, submitting]);

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="force-delete-squash-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onCancel();
      }}
    >
      <div className="bg-wt-panel border border-wt-border rounded-xl p-6 w-[560px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 text-wt-conflict">
            <AlertTriangle className="w-5 h-5" />
            <h2 id="force-delete-squash-title" className="text-lg font-semibold">
              Force delete squash-merged?
            </h2>
          </div>
          <button onClick={onCancel} disabled={submitting} aria-label="close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-wt-fg-2 mb-3">
          Git refused to delete {rejected.length}{' '}
          {rejected.length === 1 ? 'branch' : 'branches'} because they don't look merged from
          git's perspective. WorktreeHQ detected them as squash-merged via the PR merge commit.
          Force delete?
        </p>
        <div className="border border-wt-border rounded p-3 bg-wt-bg font-mono text-xs space-y-1 mb-4 max-h-48 overflow-auto">
          {rejected.map(({ branch, mode }) => (
            <div key={branch.name}>
              <div>local:  {branch.name}</div>
              {(mode === 'both' || mode === 'archive-and-delete') && branch.hasRemote && (
                <div>remote: origin/{branch.name}</div>
              )}
            </div>
          ))}
        </div>
        <div className="mb-3">
          <label className="text-xs text-wt-fg-2">
            Type <code className="font-mono text-wt-conflict">delete</code> to confirm:
          </label>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={submitting}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            className="mt-1 w-full bg-wt-bg border border-wt-border rounded px-2 py-1 font-mono text-sm disabled:opacity-50"
          />
        </div>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={onCancel}
            disabled={submitting}
            className="px-3 py-1.5 text-sm text-wt-fg-2 rounded focus:outline-none focus:ring-2 focus:ring-wt-info/40 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            className="px-3 py-1.5 text-sm bg-wt-conflict/20 border border-wt-conflict/60 text-wt-conflict rounded hover:bg-wt-conflict/30 disabled:opacity-40"
          >
            {submitting ? 'Force deleting…' : 'Force delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
