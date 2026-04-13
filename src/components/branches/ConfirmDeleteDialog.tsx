import { useRef, useEffect, useState } from 'react';
import type { Branch } from '../../types';
import { AlertTriangle } from 'lucide-react';
import { Dialog, DialogHeader, DialogFooter } from '../common/Dialog';

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
  submitting?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  // Tier confirmation to blast radius: local-only deletes use `git -d` which
  // refuses unmerged branches, so git itself prevents data loss — no need to
  // gate behind typing. Remote-touching modes (remote, both, archive-and-delete)
  // are team-visible and stay behind the typed confirmation. Squash-merged
  // rejections route to ForceDeleteSquashDialog, which always requires typing.
  const requiresTyping = mode !== 'local';
  const canConfirm = !submitting && (!requiresTyping || typed === 'delete');
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <Dialog
      onClose={onCancel}
      disabled={submitting}
      ariaLabelledBy="confirm-delete-title"
      className="max-h-[80vh] flex flex-col"
    >
      <DialogHeader
        title="Confirm delete"
        titleId="confirm-delete-title"
        icon={<AlertTriangle className="w-5 h-5" />}
        titleClassName="text-wt-conflict"
        onClose={onCancel}
        disabled={submitting}
      />
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
      {requiresTyping && (
        <div className="mb-3">
          <label className="text-xs text-wt-fg-2">
            Type <code className="font-mono text-wt-conflict">delete</code> to confirm:
          </label>
          <p className="text-xs text-wt-muted mt-1">
            The remote branch is shared with collaborators; deleting it removes it for everyone.
          </p>
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
      )}
      <DialogFooter>
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
      </DialogFooter>
    </Dialog>
  );
}
