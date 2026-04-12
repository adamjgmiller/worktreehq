import { useEffect, useRef, useState } from 'react';
import type { Branch } from '../../types';
import { AlertTriangle, X } from 'lucide-react';

export type DeleteMode = 'local' | 'remote' | 'both' | 'archive-and-delete';

const modeHeadline: Record<DeleteMode, string> = {
  local: 'local',
  remote: 'remote',
  both: 'local + remote',
  'archive-and-delete': 'archive + local + remote',
};

export function ConfirmDeleteDialog({
  branches,
  mode,
  submitting = false,
  onCancel,
  onConfirm,
}: {
  branches: Branch[];
  mode: DeleteMode;
  // True while the parent's async delete is in flight; disables Cancel +
  // Confirm so a double-click can't fire two parallel delete loops, and
  // the title flips to "Deleting…" so the user has feedback for slow
  // remote pushes. Mirrors RemoveWorktreeDialog's pattern.
  submitting?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const canConfirm = !submitting && typed === 'delete';
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  // Focus Cancel on open (instead of the destructive primary action) and
  // wire up Escape-to-cancel + backdrop-click-to-cancel. Native dialogs
  // would give us this for free but the modal here is a plain div.
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
      aria-labelledby="confirm-delete-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onCancel();
      }}
    >
      <div className="bg-wt-panel border border-wt-border rounded-xl p-6 w-[560px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 text-wt-conflict">
            <AlertTriangle className="w-5 h-5" />
            <h2 id="confirm-delete-title" className="text-lg font-semibold">
              Confirm delete
            </h2>
          </div>
          <button onClick={onCancel} disabled={submitting} aria-label="close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-wt-fg-2 mb-3">
          The following refs will be removed ({modeHeadline[mode]}):
        </p>
        <div className="flex-1 overflow-auto border border-wt-border rounded p-3 bg-wt-bg font-mono text-xs space-y-1 mb-4">
          {branches.map((b) => (
            <div key={b.name}>
              {mode === 'archive-and-delete' && <div>tag:   archive/{b.name}</div>}
              {mode !== 'remote' && b.hasLocal && <div>local:  {b.name}</div>}
              {mode !== 'local' && b.hasRemote && <div>remote: origin/{b.name}</div>}
            </div>
          ))}
        </div>
        {mode === 'archive-and-delete' && (
          <p className="text-xs text-wt-muted mb-3">
            Archive tags preserve the original commits so Squash Archaeology can recover them later.
          </p>
        )}
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
            disabled={!canConfirm}
            onClick={onConfirm}
            className="px-3 py-1.5 text-sm bg-wt-conflict/20 border border-wt-conflict/60 text-wt-conflict rounded hover:bg-wt-conflict/30 disabled:opacity-40"
          >
            {submitting
              ? 'Deleting…'
              : `Delete ${branches.length} ${branches.length === 1 ? 'branch' : 'branches'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
