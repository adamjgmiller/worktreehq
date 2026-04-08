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
  onCancel,
  onConfirm,
}: {
  branches: Branch[];
  mode: DeleteMode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  // Type-to-confirm gates: bulk operations, AND any operation that touches
  // the remote (delete propagates to origin → not locally reversible). The
  // archive-and-delete mode is also remote-touching, so it's covered by the
  // touchesRemote clause. Previously this only triggered above 5 branches,
  // leaving 1-5 branch remote deletes one click away from a destructive op.
  const touchesRemote = mode !== 'local';
  const requiresType = branches.length > 5 || touchesRemote;
  const canConfirm = !requiresType || typed === 'delete';
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  // Focus Cancel on open (instead of the destructive primary action) and
  // wire up Escape-to-cancel + backdrop-click-to-cancel. Native dialogs
  // would give us this for free but the modal here is a plain div.
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bg-wt-panel border border-wt-border rounded-xl p-6 w-[560px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 text-wt-conflict">
            <AlertTriangle className="w-5 h-5" />
            <h2 className="text-lg font-semibold">Confirm delete</h2>
          </div>
          <button onClick={onCancel} aria-label="close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-neutral-400 mb-3">
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
          <p className="text-xs text-neutral-500 mb-3">
            Archive tags preserve the original commits so Squash Archaeology can recover them later.
          </p>
        )}
        {requiresType && (
          <div className="mb-3">
            <label className="text-xs text-neutral-400">
              Type <code className="font-mono text-wt-conflict">delete</code> to confirm:
            </label>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1 w-full bg-wt-bg border border-wt-border rounded px-2 py-1 font-mono text-sm"
            />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-neutral-400 rounded focus:outline-none focus:ring-2 focus:ring-wt-info/40"
          >
            Cancel
          </button>
          <button
            disabled={!canConfirm}
            onClick={onConfirm}
            className="px-3 py-1.5 text-sm bg-wt-conflict/20 border border-wt-conflict/60 text-wt-conflict rounded hover:bg-wt-conflict/30 disabled:opacity-40"
          >
            Delete {branches.length} {branches.length === 1 ? 'branch' : 'branches'}
          </button>
        </div>
      </div>
    </div>
  );
}
