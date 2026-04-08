import { useMemo, useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import type { Branch } from '../../types';
import { pathExists } from '../../services/tauriBridge';

export interface CreateWorktreeValue {
  path: string;
  branch: string;
  newBranch: boolean;
}

// Dialog for `git worktree add` — picks a target directory and a branch
// (existing or to-be-created). The directory picker is wired by the parent so
// this component stays pure and easy to test.
export function CreateWorktreeDialog({
  branches,
  defaultBranch,
  onCancel,
  onConfirm,
  onPickDirectory,
}: {
  branches: Branch[];
  defaultBranch: string;
  onCancel: () => void;
  onConfirm: (v: CreateWorktreeValue) => void;
  onPickDirectory: () => Promise<string | null>;
}) {
  const [path, setPath] = useState('');
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [existingBranch, setExistingBranch] = useState<string>(defaultBranch);
  const [newBranchName, setNewBranchName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const existingNames = useMemo(
    () =>
      Array.from(
        new Set(
          branches
            .filter((b) => b.hasLocal || b.hasRemote)
            .map((b) => b.name)
            .sort((a, b) => a.localeCompare(b)),
        ),
      ),
    [branches],
  );

  const pick = async () => {
    const picked = await onPickDirectory();
    if (picked) setPath(picked);
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
    // Pre-check: git worktree add will reject an existing directory anyway,
    // but the error surfaces post-click and is cryptic. Catching it here gives
    // inline feedback before the user commits. pathExists returns false on
    // any error (per tauriBridge.ts), so this fails open if the backend is
    // unreachable, preserving the pre-change behavior.
    if (await pathExists(trimmed)) {
      setError(`Path already exists: ${trimmed}`);
      return;
    }
    onConfirm({ path: trimmed, branch, newBranch: mode === 'new' });
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-wt-panel border border-wt-border rounded-xl p-6 w-[560px]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Create worktree</h2>
          <button onClick={onCancel} aria-label="close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="text-xs uppercase tracking-wide text-neutral-500">Path</label>
            <div className="mt-1 flex gap-2">
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/path/to/new-worktree"
                className="flex-1 bg-wt-bg border border-wt-border rounded px-3 py-2 font-mono text-sm"
              />
              <button
                type="button"
                onClick={pick}
                className="flex items-center gap-1 px-3 py-2 text-xs border border-wt-border rounded hover:bg-wt-border"
              >
                <FolderOpen className="w-3.5 h-3.5" /> Browse
              </button>
            </div>
          </div>
          <div>
            <div className="flex gap-2 text-xs mb-2">
              <button
                type="button"
                onClick={() => setMode('existing')}
                className={
                  mode === 'existing'
                    ? 'px-3 py-1 rounded-full border border-wt-info bg-wt-info/15 text-wt-info'
                    : 'px-3 py-1 rounded-full border border-wt-border text-neutral-400'
                }
              >
                Existing branch
              </button>
              <button
                type="button"
                onClick={() => setMode('new')}
                className={
                  mode === 'new'
                    ? 'px-3 py-1 rounded-full border border-wt-info bg-wt-info/15 text-wt-info'
                    : 'px-3 py-1 rounded-full border border-wt-border text-neutral-400'
                }
              >
                New branch
              </button>
            </div>
            {mode === 'existing' ? (
              <select
                value={existingBranch}
                onChange={(e) => setExistingBranch(e.target.value)}
                className="w-full bg-wt-bg border border-wt-border rounded px-3 py-2 font-mono text-sm"
              >
                {existingNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                placeholder="feat/my-branch"
                className="w-full bg-wt-bg border border-wt-border rounded px-3 py-2 font-mono text-sm"
              />
            )}
          </div>
          {error && <div className="text-xs text-wt-conflict">{error}</div>}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-sm text-neutral-400">
            Cancel
          </button>
          <button
            onClick={submit}
            className="px-3 py-1.5 text-sm bg-wt-info/20 border border-wt-info/50 rounded hover:bg-wt-info/30"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
