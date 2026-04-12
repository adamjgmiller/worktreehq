import { useEffect, useMemo, useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import type { Branch } from '../../types';
import { pathExists } from '../../services/tauriBridge';

export interface CreateWorktreeValue {
  path: string;
  branch: string;
  newBranch: boolean;
  pushToRemote: boolean;
  postCreateCommands: string;
}

// Dialog for `git worktree add` — picks a target directory and a branch
// (existing or to-be-created). The directory picker is wired by the parent so
// this component stays pure and easy to test.
export function CreateWorktreeDialog({
  repoPath,
  branches,
  defaultBranch,
  defaultPostCreateCommands,
  onCancel,
  onConfirm,
  onPickDirectory,
}: {
  repoPath: string;
  branches: Branch[];
  defaultBranch: string;
  defaultPostCreateCommands: string;
  onCancel: () => void;
  onConfirm: (v: CreateWorktreeValue) => void;
  onPickDirectory: () => Promise<string | null>;
}) {
  const [path, setPath] = useState('');
  // Once the user manually edits the path (typing or picking a directory),
  // stop auto-syncing it from the branch. Otherwise switching branch modes
  // or retyping the branch name would clobber their edit. Resetting the
  // branch after touching the path is a deliberate "I know what I'm doing"
  // signal — so we honor it.
  const [pathTouched, setPathTouched] = useState(false);
  const [mode, setMode] = useState<'existing' | 'new'>('new');
  const [existingBranch, setExistingBranch] = useState<string>(defaultBranch);
  const [newBranchName, setNewBranchName] = useState('');
  const [pushToRemote, setPushToRemote] = useState(true);
  // Seeded from the saved default but live-editable before submit. A user
  // might keep `npm install` as the default but, for this particular
  // creation, also want `cp ../main/.env .env`. The parent re-reads config
  // each time the dialog opens so this reflects the latest saved default.
  const [postCreateCommands, setPostCreateCommands] = useState(defaultPostCreateCommands);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Escape closes. Unlike destructive dialogs we don't focus Cancel — the
  // branch name input has autoFocus so the user can start typing immediately.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, submitting]);

  const existingBranches = useMemo(() => {
    const seen = new Set<string>();
    return branches
      .filter((b) => b.hasLocal || b.hasRemote)
      .sort((a, b) => a.name.localeCompare(b.name))
      .filter((b) => {
        if (seen.has(b.name)) return false;
        seen.add(b.name);
        return true;
      });
  }, [branches]);

  // The branch that currently drives the suggested path. In "new" mode this
  // is whatever the user has typed so far; in "existing" mode it's the
  // selected branch. Empty → no suggestion yet.
  const currentBranch = mode === 'new' ? newBranchName.trim() : existingBranch;

  // Default convention: `<repo>/.claude/worktrees/<branch>`. Matches Claude
  // Code's own worktree convention and `.claude/` is already gitignored at
  // the repo root, so a branch with slashes (`feat/foo`) becomes nested
  // directories which git worktree add handles fine.
  const suggestedPath =
    repoPath && currentBranch
      ? `${repoPath}/.claude/worktrees/${currentBranch.replace(/\//g, '-')}`
      : '';

  // Auto-fill the path input with the suggestion whenever it changes —
  // unless the user has manually edited it, in which case we keep hands
  // off. This means: open the dialog → path pre-filled from defaultBranch;
  // flip to "new branch" and type → path updates live as they type; pick a
  // directory with Browse → sticky.
  useEffect(() => {
    if (!pathTouched) setPath(suggestedPath);
  }, [suggestedPath, pathTouched]);

  const pick = async () => {
    const picked = await onPickDirectory();
    if (picked) {
      setPath(picked);
      setPathTouched(true);
    }
  };

  const submit = async () => {
    const trimmed = path.trim();
    if (!trimmed) {
      setError('Path is required');
      return;
    }
    const branch = mode === 'new' ? newBranchName.trim() : existingBranch;
    if (!branch) {
      setError('Branch is required');
      return;
    }
    setSubmitting(true);
    try {
      // Pre-check: git worktree add will reject an existing directory anyway,
      // but the error surfaces post-click and is cryptic. Catching it here gives
      // inline feedback before the user commits. pathExists returns false on
      // any error (per tauriBridge.ts), so this fails open if the backend is
      // unreachable, preserving the pre-change behavior.
      if (await pathExists(trimmed)) {
        setError(`Path already exists: ${trimmed}`);
        return;
      }
      onConfirm({
        path: trimmed,
        branch,
        newBranch: mode === 'new',
        pushToRemote: mode === 'new' && pushToRemote,
        postCreateCommands,
      });
    } finally {
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
      <div className="bg-wt-panel border border-wt-border rounded-xl p-6 w-[680px]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Create worktree</h2>
          <button onClick={onCancel} disabled={submitting} aria-label="close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <div className="flex gap-2 text-xs mb-2">
              <button
                type="button"
                onClick={() => setMode('new')}
                className={
                  mode === 'new'
                    ? 'px-3 py-1 rounded-full border border-wt-info bg-wt-info/15 text-wt-info'
                    : 'px-3 py-1 rounded-full border border-wt-border text-wt-fg-2'
                }
              >
                New branch
              </button>
              <button
                type="button"
                onClick={() => setMode('existing')}
                className={
                  mode === 'existing'
                    ? 'px-3 py-1 rounded-full border border-wt-info bg-wt-info/15 text-wt-info'
                    : 'px-3 py-1 rounded-full border border-wt-border text-wt-fg-2'
                }
              >
                Existing branch
              </button>
            </div>
            {mode === 'existing' ? (
              <select
                value={existingBranch}
                onChange={(e) => setExistingBranch(e.target.value)}
                className="w-full bg-wt-bg border border-wt-border rounded px-3 py-2 font-mono text-sm"
              >
                {existingBranches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                    {b.hasLocal && b.hasRemote ? '' : b.hasLocal ? '  (local)' : '  (remote)'}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <input
                  autoFocus
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  placeholder="feat/my-branch"
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full bg-wt-bg border border-wt-border rounded px-3 py-2 font-mono text-sm"
                />
                <label className="mt-2 flex items-center gap-2 text-xs text-wt-fg-2">
                  <input
                    type="checkbox"
                    checked={pushToRemote}
                    onChange={(e) => setPushToRemote(e.target.checked)}
                  />
                  Push to origin
                </label>
              </>
            )}
          </div>
          <div>
            <label className="text-xs uppercase tracking-wide text-wt-muted">Path</label>
            <div className="mt-1 flex gap-2">
              <input
                value={path}
                onChange={(e) => {
                  setPath(e.target.value);
                  setPathTouched(true);
                }}
                placeholder={suggestedPath || '/path/to/new-worktree'}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                className="flex-1 bg-wt-bg border border-wt-border rounded px-3 py-2 font-mono text-xs"
              />
              <button
                type="button"
                onClick={pick}
                title="Browse"
                className="flex items-center px-2 py-2 text-wt-fg-2 border border-wt-border rounded hover:bg-wt-border"
              >
                <FolderOpen className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div>
            <div className="flex items-baseline justify-between">
              <label className="text-xs uppercase tracking-wide text-wt-muted">
                Post-create commands
              </label>
              <button
                type="button"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('wthq:open-settings'));
                }}
                className="text-[11px] text-wt-info hover:underline"
              >
                Edit default in Settings
              </button>
            </div>
            <textarea
              value={postCreateCommands}
              onChange={(e) => setPostCreateCommands(e.target.value)}
              placeholder={'cp ../main/.env .env\nnpm install'}
              rows={4}
              spellCheck={false}
              className="mt-1 w-full bg-wt-bg border border-wt-border rounded px-3 py-2 font-mono text-xs resize-y"
            />
            <p className="mt-1 text-[11px] text-wt-fg-2">
              Runs in the new worktree via <code className="font-mono">/bin/sh</code>.
              Non-zero exit surfaces an error but does not undo the worktree.
            </p>
          </div>
          {error && <div className="text-xs text-wt-conflict">{error}</div>}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="px-3 py-1.5 text-sm text-wt-fg-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="px-3 py-1.5 text-sm bg-wt-info/20 border border-wt-info/50 rounded hover:bg-wt-info/30 disabled:opacity-50"
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
