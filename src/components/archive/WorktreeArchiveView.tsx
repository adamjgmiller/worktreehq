import { useEffect, useMemo, useState } from 'react';
import { Archive, Copy, Check, Trash2, AlertTriangle } from 'lucide-react';
import { useRepoStore } from '../../store/useRepoStore';
import { EmptyState } from '../common/EmptyState';
import {
  deleteNotepad,
  listNotepads,
  type NotepadListEntry,
} from '../../services/notepadService';

// The Worktree Archive view: surfaces notepad entries whose worktree no
// longer exists in `git worktree list`. Today the only thing that survives
// a `git worktree remove` is the notepad entry in notepads.json (the dir
// is gone, the branch ref usually still exists but has its own UI surface
// in the Branches tab) — this view is the rescue path for those notes.
//
// Filtering happens client-side because the Rust list_notepads command has
// no notion of "current repo" or "live worktrees". We do it here so the
// command stays context-free and reusable.
export function WorktreeArchiveView() {
  const repo = useRepoStore((s) => s.repo);
  const worktrees = useRepoStore((s) => s.worktrees);
  // Subscribing to lastRefresh keeps the archive list in sync with the
  // 15s polling tick — if the user removes a worktree elsewhere in the
  // app, the next refresh re-runs listNotepads and the new orphan shows
  // up here without a manual reload.
  const lastRefresh = useRepoStore((s) => s.lastRefresh);

  const [entries, setEntries] = useState<NotepadListEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listNotepads()
      .then((rows) => {
        if (cancelled) return;
        setEntries(rows);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [lastRefresh, repo?.path]);

  // Build the set of live worktree paths once per render so the filter
  // below is O(1) per entry instead of O(n). Includes the primary
  // worktree, which has its own notepad keyed at the repo root.
  const livePaths = useMemo(
    () => new Set(worktrees.map((w) => w.path)),
    [worktrees],
  );

  // The two-stage filter:
  //   1) Path-prefix scope to this repo. We compare against `repo.path + '/'`
  //      so a different repo whose path happens to share a prefix doesn't
  //      bleed in (e.g. /Projects/foo vs /Projects/foo-bar). The repo root
  //      itself is allowed via the `=== repo.path` clause but that case is
  //      already filtered out by the live-worktree check below.
  //   2) Not currently a live worktree. This is the "archived" signal.
  const archived = useMemo(() => {
    if (!repo) return [];
    const prefix = repo.path.endsWith('/') ? repo.path : repo.path + '/';
    return entries
      .filter((e) => e.path === repo.path || e.path.startsWith(prefix))
      .filter((e) => !livePaths.has(e.path));
  }, [entries, repo, livePaths]);

  async function handleDelete(path: string) {
    try {
      await deleteNotepad(path);
      // Optimistic local update so the row vanishes immediately. The next
      // refresh tick will re-fetch and confirm.
      setEntries((prev) => prev.filter((e) => e.path !== path));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!repo) {
    return (
      <EmptyState
        title="No repository loaded"
        hint="Pick a repository to see its archived notes."
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-4 pb-3 border-b border-wt-border">
        <div className="flex items-center gap-2 text-neutral-300">
          <Archive className="w-4 h-4" />
          <h2 className="text-sm font-semibold">Worktree Archive</h2>
        </div>
        <p className="text-xs text-neutral-500 mt-1 max-w-2xl">
          Notes from worktrees that no longer exist on disk. When you remove
          a worktree, the notepad entry survives in <code className="font-mono">notepads.json</code>{' '}
          — this view is where you can read it, copy it out, or delete it permanently.
        </p>
      </div>
      {error && (
        <div className="mx-6 mt-3 text-xs text-wt-conflict bg-wt-conflict/10 border border-wt-conflict/40 rounded px-3 py-2 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div className="font-mono break-all">{error}</div>
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {!loaded ? null : archived.length === 0 ? (
          <EmptyState
            title="No archived notes"
            hint="When you remove a worktree, its notepad entry will appear here."
          />
        ) : (
          <ul className="p-6 space-y-3">
            {archived.map((entry) => (
              <ArchiveRow
                key={entry.path}
                entry={entry}
                repoPath={repo.path}
                onDelete={() => handleDelete(entry.path)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// One archived note. Pulls the worktree's tail name out of the path for the
// headline, shows the full path in mono small text below, then the note
// content in a slightly inset box, and a row of actions on the right.
function ArchiveRow({
  entry,
  repoPath,
  onDelete,
}: {
  entry: NotepadListEntry;
  repoPath: string;
  onDelete: () => void;
}) {
  // Extract a friendly label: the last segment of the path (i.e. the
  // worktree directory name, which usually matches the branch). For the
  // edge case where the entry IS the repo root (shouldn't happen here
  // because the live-worktree filter excludes it, but be defensive), fall
  // back to "(repo root)".
  const label = useMemo(() => {
    if (entry.path === repoPath) return '(repo root)';
    const segments = entry.path.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? entry.path;
  }, [entry.path, repoPath]);

  // Two-click delete with a 4s revert. We don't pop a modal because each
  // archive row is low-stakes (a few hundred bytes of JSON) but it IS
  // irreversible, so the second click is the actual confirmation.
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = window.setTimeout(() => setConfirming(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirming]);

  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(entry.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write can fail in unfocused tabs / locked-down envs.
      // Silently ignore — the row also shows the content inline so the
      // user can manually select it.
    }
  }

  const empty = entry.content.trim() === '';

  return (
    <li className="rounded-lg border border-wt-border bg-wt-panel/40 p-4">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm text-neutral-200 truncate">
            {label}
          </div>
          <div
            className="font-mono text-[0.625rem] text-neutral-600 truncate mt-0.5"
            title={entry.path}
          >
            {entry.path}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleCopy}
            disabled={empty}
            className="flex items-center gap-1 px-2 py-1 text-[0.625rem] text-neutral-400 hover:text-neutral-200 hover:bg-wt-border/40 rounded disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Copy note"
          >
            {copied ? (
              <>
                <Check className="w-3 h-3" /> copied
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" /> copy
              </>
            )}
          </button>
          <button
            onClick={() => {
              if (confirming) {
                onDelete();
              } else {
                setConfirming(true);
              }
            }}
            className={`flex items-center gap-1 px-2 py-1 text-[0.625rem] rounded ${
              confirming
                ? 'bg-wt-conflict/20 border border-wt-conflict/60 text-wt-conflict'
                : 'text-neutral-400 hover:text-wt-conflict hover:bg-wt-conflict/10'
            }`}
            aria-label={confirming ? 'Confirm delete' : 'Delete note'}
          >
            <Trash2 className="w-3 h-3" />
            {confirming ? 'click to confirm' : 'delete'}
          </button>
        </div>
      </div>
      {empty ? (
        <div className="text-xs text-neutral-600 italic">(empty note)</div>
      ) : (
        <div className="text-xs text-neutral-300 whitespace-pre-wrap break-words bg-wt-bg/60 border border-wt-border rounded px-3 py-2 max-h-48 overflow-auto">
          {entry.content}
        </div>
      )}
    </li>
  );
}
