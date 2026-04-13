import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Worktree } from '../../types';
import { Dialog, DialogHeader, DialogFooter } from '../common/Dialog';

export function RemoveWorktreeDialog({
  worktree,
  hasLocalBranch,
  hasRemoteBranch,
  isDefaultBranch,
  onCancel,
  onConfirm,
}: {
  worktree: Worktree;
  hasLocalBranch: boolean;
  hasRemoteBranch: boolean;
  isDefaultBranch: boolean;
  onCancel: () => void;
  onConfirm: (opts: {
    force: boolean;
    deleteLocalBranch: boolean;
    deleteRemoteBranch: boolean;
  }) => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [deleteLocal, setDeleteLocal] = useState(hasLocalBranch && !isDefaultBranch);
  const [deleteRemote, setDeleteRemote] = useState(hasRemoteBranch && !isDefaultBranch);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const dirty =
    worktree.untrackedCount > 0 ||
    worktree.modifiedCount > 0 ||
    worktree.stagedCount > 0 ||
    worktree.hasConflicts ||
    !!worktree.inProgress;
  const requiresForce = dirty;
  // Tier the typed confirmation to actual blast radius. Worktree removal on a
  // clean tree with no branch cleanup is reversible (`git worktree add`
  // recreates it). Each of the other paths is unrecoverable in some way:
  // force-removing a dirty worktree discards uncommitted work; deleting the
  // remote branch is team-visible; deleting the local branch here uses
  // `git branch -D` (force=true at WorktreesView handleConfirmRemove) so it
  // can silently drop unmerged commits — unlike the ConfirmDeleteDialog local
  // path which uses `git -d` and is refused by git for unmerged branches.
  // Any of those three keeps the typing gate.
  const requiresTyping = dirty || deleteRemote || deleteLocal;
  const typedOk = !requiresTyping || typed === 'delete';

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const handleConfirm = async () => {
    if (!typedOk) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm({
        force: requiresForce,
        deleteLocalBranch: deleteLocal,
        deleteRemoteBranch: deleteRemote,
      });
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog onClose={onCancel} disabled={submitting}>
      <DialogHeader
        title="Remove worktree"
        icon={<AlertTriangle className="w-5 h-5" />}
        titleClassName="text-wt-conflict"
        onClose={onCancel}
        disabled={submitting}
      />
      <p className="text-sm text-wt-fg-2 mb-2">
        Removing <span className="font-mono">{worktree.branch}</span>:
      </p>
      <div className="font-mono text-xs text-wt-muted mb-3 break-all">
        {worktree.path}
      </div>
      {requiresForce ? (
        <div className="bg-wt-conflict/10 border border-wt-conflict/40 rounded p-3 mb-3 text-xs space-y-1 text-wt-conflict">
          <div className="font-semibold">
            This worktree has uncommitted state. Force-removing will discard:
          </div>
          <ul className="ml-4 list-disc text-wt-fg-2">
            {worktree.untrackedCount > 0 && (
              <li>{worktree.untrackedCount} untracked file(s)</li>
            )}
            {worktree.modifiedCount > 0 && (
              <li>{worktree.modifiedCount} modified file(s)</li>
            )}
            {worktree.stagedCount > 0 && (
              <li>{worktree.stagedCount} staged file(s)</li>
            )}
            {worktree.stashCount > 0 && (
              <li>
                {worktree.stashCount} stash(es) — these survive in the repo's
                stash list, not in the worktree dir
              </li>
            )}
            {worktree.hasConflicts && <li>Unresolved merge conflicts</li>}
            {worktree.inProgress && (
              <li>In-progress {worktree.inProgress} operation</li>
            )}
          </ul>
        </div>
      ) : (
        <div className="bg-wt-clean/10 border border-wt-clean/40 rounded p-3 mb-3 text-xs text-wt-fg-2">
          Worktree is clean.
        </div>
      )}
      {!isDefaultBranch && (hasLocalBranch || hasRemoteBranch) && (
        <div className="mb-3 space-y-1.5">
          {hasLocalBranch && (
            <label className="flex items-start gap-2 text-xs text-wt-fg-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={deleteLocal}
                onChange={(e) => setDeleteLocal(e.target.checked)}
                disabled={submitting}
                className="mt-0.5"
              />
              <span>
                Delete local branch{' '}
                <span className="font-mono">{worktree.branch}</span>
              </span>
            </label>
          )}
          {hasRemoteBranch && (
            <label className="flex items-start gap-2 text-xs text-wt-fg-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={deleteRemote}
                onChange={(e) => setDeleteRemote(e.target.checked)}
                disabled={submitting}
                className="mt-0.5"
              />
              <span>
                Delete remote branch{' '}
                <span className="font-mono">origin/{worktree.branch}</span>
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
      {error && (
        <div className="text-xs text-wt-conflict bg-wt-conflict/10 border border-wt-conflict/40 rounded px-2 py-1.5 font-mono mb-3 break-all">
          {error}
        </div>
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
          disabled={submitting || !typedOk}
          className="px-3 py-1.5 text-sm bg-wt-conflict/20 border border-wt-conflict/60 text-wt-conflict rounded hover:bg-wt-conflict/30 disabled:opacity-40"
        >
          {submitting
            ? 'Removing…'
            : requiresForce
            ? 'Force remove'
            : 'Remove'}
        </button>
      </DialogFooter>
    </Dialog>
  );
}
