import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Branch, Worktree } from '../../types';
import { Dialog, DialogHeader, DialogFooter } from '../common/Dialog';
import { basename } from '../../lib/format';

export interface BulkRemoveOptions {
  force: boolean;
  deleteLocalBranch: boolean;
  deleteRemoteBranch: boolean;
}

// Bulk-remove dialog. Mirrors RemoveWorktreeDialog's tiered typed-confirm
// (see PRs #100/#101) — the typing gate fires when ANY removal in the batch
// has irreversible reach: discards uncommitted state (force-remove), drops
// unmerged commits (delete-local-branch is `git -D` per existing single-flow
// at WorktreesView.handleConfirmRemove), or touches the remote (team-visible).
// Each gate has a muted "why we're asking" line right under the input.
export function BulkRemoveWorktreesDialog({
  worktrees,
  branchByName,
  defaultBranch,
  skippedPrimary,
  submitting,
  onCancel,
  onConfirm,
}: {
  worktrees: Worktree[];
  branchByName: Map<string, Branch>;
  defaultBranch: string;
  skippedPrimary: number;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: (opts: BulkRemoveOptions) => Promise<void>;
}) {
  // Default the branch-cleanup checkboxes ON only when at least one worktree
  // in the batch actually has the corresponding branch state to clean up
  // AND the branch isn't the default. This matches the per-worktree dialog's
  // initial-state derivation (RemoveWorktreeDialog.tsx:28-29) so users get
  // the same defaults whether they remove one or many.
  const hasAnyLocal = useMemo(
    () =>
      worktrees.some((w) => {
        if (w.branch === defaultBranch) return false;
        return branchByName.get(w.branch)?.hasLocal === true;
      }),
    [worktrees, branchByName, defaultBranch],
  );
  const hasAnyRemote = useMemo(
    () =>
      worktrees.some((w) => {
        if (w.branch === defaultBranch) return false;
        return branchByName.get(w.branch)?.hasRemote === true;
      }),
    [worktrees, branchByName, defaultBranch],
  );
  const [deleteLocal, setDeleteLocal] = useState(hasAnyLocal);
  const [deleteRemote, setDeleteRemote] = useState(hasAnyRemote);
  const [typed, setTyped] = useState('');
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const dirtyOnes = useMemo(
    () =>
      worktrees.filter(
        (w) =>
          w.untrackedCount > 0 ||
          w.modifiedCount > 0 ||
          w.stagedCount > 0 ||
          w.hasConflicts ||
          !!w.inProgress,
      ),
    [worktrees],
  );
  const requiresForce = dirtyOnes.length > 0;
  // Same tiering rule as the per-worktree dialog: typing required if
  // dirty (force-remove discards uncommitted state) OR delete-remote OR
  // delete-local (git -D under the hood).
  const requiresTyping = requiresForce || deleteRemote || deleteLocal;
  const typedOk = !requiresTyping || typed === 'delete';

  const handleConfirm = async () => {
    if (submitting || !typedOk) return;
    await onConfirm({
      force: requiresForce,
      deleteLocalBranch: deleteLocal,
      deleteRemoteBranch: deleteRemote,
    });
  };

  return (
    <Dialog onClose={onCancel} disabled={submitting} width="w-[640px]">
      <DialogHeader
        title={`Remove ${worktrees.length} worktree${worktrees.length === 1 ? '' : 's'}`}
        icon={<AlertTriangle className="w-5 h-5" />}
        titleClassName="text-wt-conflict"
        onClose={onCancel}
        disabled={submitting}
      />
      {worktrees.length === 0 ? (
        <p className="text-sm text-wt-muted mb-3">No removable worktrees in selection.</p>
      ) : (
        <>
          <p className="text-sm text-wt-fg-2 mb-2">Removing:</p>
          <div className="mb-3 max-h-48 overflow-auto rounded border border-wt-border bg-wt-bg/40">
            <ul className="text-xs font-mono divide-y divide-wt-border">
              {worktrees.map((w) => (
                <li key={w.path} className="px-2 py-1.5 flex items-center gap-2">
                  <span className="text-wt-fg flex-shrink-0">{basename(w.path)}</span>
                  <span className="text-wt-muted">·</span>
                  <span className="text-wt-fg-2 truncate">{w.branch}</span>
                  {(w.untrackedCount + w.modifiedCount + w.stagedCount > 0 ||
                    w.hasConflicts ||
                    w.inProgress) && (
                    <span className="ml-auto text-wt-conflict text-[0.625rem] uppercase tracking-wide flex-shrink-0">
                      dirty
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          {skippedPrimary > 0 && (
            <p className="text-xs text-wt-muted mb-3">
              Primary worktree in the selection will be skipped — it can’t be removed.
            </p>
          )}
          {requiresForce && (
            <div className="bg-wt-conflict/10 border border-wt-conflict/40 rounded p-3 mb-3 text-xs text-wt-conflict">
              <span className="font-semibold">{dirtyOnes.length}</span> of these{' '}
              {dirtyOnes.length === 1 ? 'is' : 'are'} dirty. Force-remove will discard their
              uncommitted state.
            </div>
          )}
          {(hasAnyLocal || hasAnyRemote) && (
            <div className="mb-3 space-y-1.5">
              {hasAnyLocal && (
                <label className="flex items-start gap-2 text-xs text-wt-fg-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={deleteLocal}
                    onChange={(e) => setDeleteLocal(e.target.checked)}
                    disabled={submitting}
                    className="mt-0.5"
                  />
                  <span>
                    Also delete local branches (force; can drop unmerged commits — default
                    branch is always skipped)
                  </span>
                </label>
              )}
              {hasAnyRemote && (
                <label className="flex items-start gap-2 text-xs text-wt-fg-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={deleteRemote}
                    onChange={(e) => setDeleteRemote(e.target.checked)}
                    disabled={submitting}
                    className="mt-0.5"
                  />
                  <span>
                    Also delete remote branches on origin (default branch is always skipped)
                  </span>
                </label>
              )}
            </div>
          )}
          {requiresTyping && (
            <div className="mb-3">
              <label className="text-xs text-wt-fg-2">
                Type <code className="font-mono text-wt-conflict">delete</code> to confirm:
              </label>
              {requiresForce ? (
                <p className="text-xs text-wt-muted mt-1">
                  Force-remove discards the uncommitted state in the dirty worktrees above
                  and can’t be undone.
                </p>
              ) : deleteRemote ? (
                <p className="text-xs text-wt-muted mt-1">
                  Remote branches are shared with collaborators — deletion is visible to
                  everyone on the team.
                </p>
              ) : deleteLocal ? (
                <p className="text-xs text-wt-muted mt-1">
                  Local branches are force-deleted, which can drop commits not merged
                  anywhere else.
                </p>
              ) : null}
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
        </>
      )}
      <DialogFooter>
        <button
          ref={cancelRef}
          onClick={onCancel}
          disabled={submitting}
          className="px-3 py-1.5 text-sm text-wt-fg-2 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={handleConfirm}
          disabled={submitting || worktrees.length === 0 || !typedOk}
          className="px-3 py-1.5 text-sm bg-wt-conflict/20 border border-wt-conflict/60 text-wt-conflict rounded hover:bg-wt-conflict/30 disabled:opacity-40"
        >
          {submitting ? 'Removing…' : requiresForce ? 'Force remove' : 'Remove'}
        </button>
      </DialogFooter>
    </Dialog>
  );
}
