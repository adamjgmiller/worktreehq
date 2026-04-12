import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { Worktree } from '../../types';

// Replaces the previous double window.confirm() flow. Surfaces the worktree's
// uncommitted state up front so users don't blindly click "Force remove?"
// after a confused git error and lose work. Force removal requires typing
// the worktree branch name as confirmation.
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
  // The dialog reports whether the user wanted to force; the parent runs
  // the actual removeWorktree call so its loading/error state lives in
  // the parent's normal handlers.
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
  // Forcing is required when there's uncommitted work, an in-progress op,
  // or stashes.
  const requiresForce = dirty;
  const typedOk = typed === 'delete';

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, submitting]);

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
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onCancel();
      }}
    >
      <div className="bg-wt-panel border border-wt-border rounded-xl p-6 w-[560px]">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 text-wt-conflict">
            <AlertTriangle className="w-5 h-5" />
            <h2 className="text-lg font-semibold">Remove worktree</h2>
          </div>
          <button onClick={onCancel} disabled={submitting} aria-label="close">
            <X className="w-4 h-4" />
          </button>
        </div>
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
        {error && (
          <div className="text-xs text-wt-conflict bg-wt-conflict/10 border border-wt-conflict/40 rounded px-2 py-1.5 font-mono mb-3 break-all">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
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
        </div>
      </div>
    </div>
  );
}
