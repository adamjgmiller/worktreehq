import { useState } from 'react';
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
  const requiresType = branches.length > 5;
  const canConfirm = !requiresType || typed === 'delete';
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
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
              Type <code className="font-mono text-wt-conflict">delete</code> to confirm (bulk {'>'}5):
            </label>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1 w-full bg-wt-bg border border-wt-border rounded px-2 py-1 font-mono text-sm"
            />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-sm text-neutral-400">
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
