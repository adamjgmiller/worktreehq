import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { Branch } from '../../types';
import { pathExists } from '../../services/tauriBridge';
import { Dialog, DialogHeader, DialogFooter } from '../common/Dialog';

// Built-in path presets for different tool conventions. Exported for Settings,
// which only offers these three as saved defaults — "Custom" is a runtime mode,
// not a persistable default.
export const PATH_PRESETS = [
  { id: 'claude', label: 'Claude Code (.claude/worktrees/)', template: '{repo}/.claude/worktrees/{name}' },
  { id: 'dotworktrees', label: 'Generic (.worktrees/)', template: '{repo}/.worktrees/{name}' },
  { id: 'sibling', label: 'Sibling directory', template: '{repo}__worktrees/{name}' },
] as const;

export type PathPresetId = (typeof PATH_PRESETS)[number]['id'];

// Dialog-local preset list adds a "Custom path…" entry so users can see the
// escape hatch directly in the dropdown rather than having to intuit that the
// path input is freely editable. `template: null` signals "no template — the
// user-entered path is authoritative."
type DialogPresetId = PathPresetId | 'custom';
const DIALOG_PRESETS: Array<{ id: DialogPresetId; label: string; template: string | null }> = [
  ...PATH_PRESETS,
  { id: 'custom', label: 'Custom path…', template: null },
];

export interface CreateWorktreeValue {
  path: string;
  branch: string;
  newBranch: boolean;
  detached: boolean;
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
  defaultPathPreset = 'claude',
  onCancel,
  onConfirm,
  onPickDirectory,
}: {
  repoPath: string;
  branches: Branch[];
  defaultBranch: string;
  defaultPostCreateCommands: string;
  defaultPathPreset?: PathPresetId;
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
  const [mode, setMode] = useState<'existing' | 'new' | 'detached'>('new');
  const [existingBranch, setExistingBranch] = useState<string>(defaultBranch);
  const [newBranchName, setNewBranchName] = useState('');
  const [detachedName, setDetachedName] = useState('');
  const [pushToRemote, setPushToRemote] = useState(true);
  const [pathPreset, setPathPreset] = useState<DialogPresetId>(defaultPathPreset);
  const pathInputRef = useRef<HTMLInputElement>(null);
  // Seeded from the saved default but live-editable before submit. A user
  // might keep `npm install` as the default but, for this particular
  // creation, also want `cp ../main/.env .env`. The parent re-reads config
  // each time the dialog opens so this reflects the latest saved default.
  const [postCreateCommands, setPostCreateCommands] = useState(defaultPostCreateCommands);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  // Keep existingBranch in sync with the list. If the current value isn't
  // in the list (seeded defaultBranch filtered out, or a branch deleted
  // mid-dialog), snap to the first item — otherwise the <select> silently
  // falls back to displaying the first option while state stays stale,
  // and the path input auto-fills from the stale state.
  useEffect(() => {
    if (existingBranches.length === 0) return;
    if (!existingBranches.some((b) => b.name === existingBranch)) {
      setExistingBranch(existingBranches[0].name);
    }
  }, [existingBranches, existingBranch]);

  // The name that drives the suggested path. In branch modes this is the
  // branch; in detached mode it's the user-typed session name.
  const currentName =
    mode === 'detached'
      ? detachedName.trim()
      : mode === 'new'
        ? newBranchName.trim()
        : existingBranch;

  // Compute suggested path from the selected preset template. In "custom"
  // mode there's no template — the user's typed path is authoritative, so
  // suggestedPath is empty and the auto-fill effect no-ops.
  const activeTemplate =
    DIALOG_PRESETS.find((p) => p.id === pathPreset)?.template ?? null;
  const suggestedPath =
    activeTemplate && repoPath && currentName
      ? activeTemplate
          .replace('{repo}', repoPath)
          .replace('{name}', currentName.replace(/\//g, '-'))
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
      // A user-picked directory is by definition a custom path — keep the
      // dropdown honest so it reflects what's actually in the input.
      setPathPreset('custom');
    }
  };

  const submit = async () => {
    const trimmed = path.trim();
    if (!trimmed) {
      setError('Path is required');
      return;
    }
    const isDetached = mode === 'detached';
    const branch = isDetached ? '' : mode === 'new' ? newBranchName.trim() : existingBranch;
    if (!isDetached && !branch) {
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
        detached: isDetached,
        pushToRemote: mode === 'new' && pushToRemote,
        postCreateCommands,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog onClose={onCancel} disabled={submitting} width="w-[680px]">
      <DialogHeader title="Create worktree" onClose={onCancel} disabled={submitting} />
        <div className="space-y-4">
          <div>
            <div className="flex gap-2 text-xs mb-2">
              {(['new', 'existing', 'detached'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={
                    mode === m
                      ? 'px-3 py-1 rounded-full border border-wt-info bg-wt-info/15 text-wt-info'
                      : 'px-3 py-1 rounded-full border border-wt-border text-wt-fg-2'
                  }
                >
                  {m === 'new' ? 'New branch' : m === 'existing' ? 'Existing branch' : 'Detached HEAD'}
                </button>
              ))}
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
            ) : mode === 'detached' ? (
              <>
                <input
                  autoFocus
                  value={detachedName}
                  onChange={(e) => setDetachedName(e.target.value)}
                  placeholder="experiment-1"
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full bg-wt-bg border border-wt-border rounded px-3 py-2 font-mono text-sm"
                />
                <p className="mt-1 text-[11px] text-wt-fg-2">
                  Creates a worktree at the current HEAD with no branch. Useful for
                  throwaway experiments or tools like Codex that work in detached HEAD.
                </p>
              </>
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
            <div className="flex items-center gap-3 mb-1">
              <label className="text-xs uppercase tracking-wide text-wt-muted">Path</label>
              <select
                value={pathPreset}
                onChange={(e) => {
                  const next = e.target.value as DialogPresetId;
                  setPathPreset(next);
                  if (next === 'custom') {
                    // Explicit opt-in to custom mode: clear any preset-driven
                    // value and put focus on the input so the user can just
                    // start typing.
                    setPath('');
                    setPathTouched(true);
                    setTimeout(() => pathInputRef.current?.focus(), 0);
                  } else {
                    // Switching back to a real preset re-enables auto-fill.
                    setPathTouched(false);
                  }
                }}
                className="bg-wt-bg border border-wt-border rounded px-2 py-0.5 text-[11px] text-wt-fg-2"
              >
                {DIALOG_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <input
                ref={pathInputRef}
                value={path}
                onChange={(e) => {
                  setPath(e.target.value);
                  setPathTouched(true);
                  // Typing anything makes the input authoritative — reflect
                  // that in the dropdown so it doesn't claim a preset the
                  // path no longer matches.
                  setPathPreset('custom');
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
            {!pathTouched && !currentName && repoPath && activeTemplate && (
              <p className="mt-1 text-[11px] text-wt-fg-2">
                Will create at:{' '}
                <span className="font-mono">
                  {activeTemplate
                    .replace('{repo}', repoPath)
                    .replace('{name}', mode === 'detached' ? '<name>' : '<branch>')}
                </span>
              </p>
            )}
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
        <div className="mt-6">
          <DialogFooter>
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
          </DialogFooter>
        </div>
    </Dialog>
  );
}
