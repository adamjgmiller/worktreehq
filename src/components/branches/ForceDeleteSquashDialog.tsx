import { useRef, useEffect, useState } from 'react';
import type { Branch } from '../../types';
import type { DeleteMode } from './ConfirmDeleteDialog';
import { AlertTriangle } from 'lucide-react';
import { Dialog, DialogHeader, DialogFooter } from '../common/Dialog';

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
  }, []);

  return (
    <Dialog
      onClose={onCancel}
      disabled={submitting}
      ariaLabelledBy="force-delete-squash-title"
      className="max-h-[80vh] flex flex-col"
    >
      <DialogHeader
        title="Force delete squash-merged?"
        titleId="force-delete-squash-title"
        icon={<AlertTriangle className="w-5 h-5" />}
        titleClassName="text-wt-conflict"
        onClose={onCancel}
        disabled={submitting}
      />
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
        <p className="text-xs text-wt-muted mt-1">
          If WorktreeHQ's detection is wrong, the commits on these branches will be unrecoverable.
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
          onClick={onConfirm}
          disabled={!canConfirm}
          className="px-3 py-1.5 text-sm bg-wt-conflict/20 border border-wt-conflict/60 text-wt-conflict rounded hover:bg-wt-conflict/30 disabled:opacity-40"
        >
          {submitting ? 'Force deleting…' : 'Force delete'}
        </button>
      </DialogFooter>
    </Dialog>
  );
}
