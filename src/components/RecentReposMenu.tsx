import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, FolderOpen, X } from 'lucide-react';
import { useRepoStore } from '../store/useRepoStore';
import {
  loadRepoAtPath,
  pickAndLoadRepo,
  removeFromRecents,
} from '../services/repoSelect';
import { pathExists } from '../services/tauriBridge';

// Module-scoped cache: we only need to resolve the user's home dir once per
// process. The async fetch is lazy (first dropdown open) so we don't pay it
// on bootstrap, and a failed lookup just falls back to showing the raw path.
let cachedHomeDir: string | null = null;
let homeDirPromise: Promise<string | null> | null = null;
async function getHomeDir(): Promise<string | null> {
  if (cachedHomeDir !== null) return cachedHomeDir;
  if (homeDirPromise) return homeDirPromise;
  homeDirPromise = (async () => {
    try {
      const mod = await import('@tauri-apps/api/path');
      const dir = await mod.homeDir();
      cachedHomeDir = dir.replace(/\/$/, '');
      return cachedHomeDir;
    } catch {
      return null;
    }
  })();
  return homeDirPromise;
}

// Tilde-collapse a path's home prefix. Pure function so it's cheap to call
// inline during render once the home dir is known.
function tildify(p: string, home: string | null): string {
  if (!home) return p;
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
  return p;
}

// Split a path into the basename (the repo's "name" as a user thinks of it)
// and the parent directory. Used to render two-line entries.
function splitPath(p: string): { base: string; parent: string } {
  // Strip a trailing slash so `/foo/bar/` doesn't yield an empty basename.
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx < 0) return { base: trimmed, parent: '' };
  return { base: trimmed.slice(idx + 1), parent: trimmed.slice(0, idx) };
}

// Dropdown trigger + menu for switching between recently-opened repos.
// Replaces the old static repo path label and the standalone folder-icon
// "open repo" button. The trigger shows the current repo's basename (or a
// placeholder when no repo is loaded), and the menu hangs `recent-other`
// repos beneath the current one. See plan in CLAUDE.md / chat for the
// design rationale (dropdown over inline chips for path-length scaling).
export function RecentReposMenu() {
  const repo = useRepoStore((s) => s.repo);
  const recents = useRepoStore((s) => s.recentRepoPaths);
  const [open, setOpen] = useState(false);
  const [homeDir, setHomeDir] = useState<string | null>(cachedHomeDir);
  // Map of path → exists. Populated when the dropdown opens; missing paths
  // get rendered grayed-out and become non-clickable. We probe lazily on
  // open (rather than on bootstrap) so a deep recents list with offline
  // external drives doesn't slow launch.
  const [existsMap, setExistsMap] = useState<Record<string, boolean>>({});
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // Active row index for keyboard navigation. -1 means "no row focused".
  // Reset to -1 whenever the menu closes so re-opening starts fresh.
  const [activeIdx, setActiveIdx] = useState<number>(-1);

  // Listen for the global keyboard shortcut to toggle this menu open/closed.
  useEffect(() => {
    const handler = () => setOpen((v) => !v);
    window.addEventListener('wthq:toggle-repo-menu', handler);
    return () => window.removeEventListener('wthq:toggle-repo-menu', handler);
  }, []);

  // Resolve home dir on first render so tildify works without a flash of
  // raw paths. Cheap: ~1 IPC call total per app session (cached at module
  // scope after the first call).
  useEffect(() => {
    if (homeDir !== null) return;
    let cancelled = false;
    void getHomeDir().then((dir) => {
      if (!cancelled) setHomeDir(dir);
    });
    return () => {
      cancelled = true;
    };
  }, [homeDir]);

  // Probe path existence whenever the menu opens. We re-run on every open
  // (not just first) because a previously-missing external drive may have
  // been remounted between opens, and the user shouldn't have to restart
  // the app to see the entry become clickable again.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        recents.map(async (p) => [p, await pathExists(p)] as const),
      );
      if (cancelled) return;
      const next: Record<string, boolean> = {};
      for (const [p, ok] of entries) next[p] = ok;
      setExistsMap(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, recents]);

  // Close on outside click + Escape. Mirrors the pattern in WorktreeCard's
  // action menu (src/components/worktrees/WorktreeCard.tsx:81-97) so the
  // muscle memory matches across the app.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }
      // Arrow-key navigation across the visible "other recents" rows.
      // The current repo row is informational (not selectable), and the
      // "Open another…" footer is always last.
      const others = recents.filter((p) => p !== repo?.path);
      const rowCount = others.length + 1; // +1 for the picker footer row
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % rowCount);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => (i <= 0 ? rowCount - 1 : i - 1));
      } else if (e.key === 'Enter') {
        if (activeIdx < 0) return;
        e.preventDefault();
        if (activeIdx === others.length) {
          // Footer row.
          setOpen(false);
          void pickAndLoadRepo();
        } else {
          const target = others[activeIdx];
          if (existsMap[target] === false) return; // missing → no-op
          setOpen(false);
          void loadRepoAtPath(target);
        }
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, recents, repo?.path, activeIdx, existsMap]);

  // When the menu closes, reset keyboard focus state so the next open
  // doesn't pre-highlight a stale row.
  useEffect(() => {
    if (!open) setActiveIdx(-1);
  }, [open]);

  const others = useMemo(
    () => recents.filter((p) => p !== repo?.path),
    [recents, repo?.path],
  );

  const triggerLabel = repo
    ? splitPath(repo.path).base
    : 'No repository';
  const triggerSubtitle = repo
    ? tildify(splitPath(repo.path).parent, homeDir)
    : 'Click to open one';

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={repo?.path ?? 'Open a repository'}
        className="flex items-center gap-2 px-2 py-1 rounded hover:bg-wt-border text-left"
      >
        <FolderOpen className="w-4 h-4 text-neutral-400 shrink-0" />
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-mono text-neutral-100">
            {triggerLabel}
          </span>
          <span className="text-[10px] font-mono text-neutral-500 max-w-[20rem] truncate">
            {triggerSubtitle}
          </span>
        </div>
        <ChevronDown
          className={`w-3.5 h-3.5 text-neutral-500 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-full left-0 mt-1 z-30 min-w-[20rem] max-w-[28rem] rounded-md border border-wt-border bg-wt-panel shadow-lg overflow-hidden"
        >
          {/* Current repo header — informational, not clickable. The check
              mirrors the "you are here" affordance from VS Code's recent menu. */}
          {repo && (
            <div className="flex items-center gap-2 px-3 py-2 border-b border-wt-border bg-wt-bg/50">
              <Check className="w-3.5 h-3.5 text-wt-clean shrink-0" />
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-mono truncate">
                  {splitPath(repo.path).base}
                </span>
                <span className="text-[10px] font-mono text-neutral-500 truncate">
                  {tildify(splitPath(repo.path).parent, homeDir)}
                </span>
              </div>
            </div>
          )}

          {/* Other recents. Empty when the user has only ever opened one repo. */}
          {others.length > 0 && (
            <ul className="py-1 max-h-[60vh] overflow-y-auto">
              {others.map((path, i) => {
                const { base, parent } = splitPath(path);
                const exists = existsMap[path];
                // existsMap[path] === undefined → still probing, render
                // optimistically as if it exists so the row doesn't flash
                // gray during the IPC roundtrip.
                const missing = exists === false;
                const active = i === activeIdx;
                return (
                  <li key={path}>
                    <div
                      className={`group flex items-center gap-2 px-3 py-2 ${
                        active ? 'bg-wt-border' : 'hover:bg-wt-border'
                      } ${missing ? 'opacity-50' : ''}`}
                    >
                      <button
                        type="button"
                        disabled={missing}
                        onClick={() => {
                          setOpen(false);
                          void loadRepoAtPath(path);
                        }}
                        onMouseEnter={() => setActiveIdx(i)}
                        className="flex-1 flex flex-col min-w-0 text-left disabled:cursor-not-allowed"
                        title={missing ? `${path} (missing)` : path}
                      >
                        <span className="text-sm font-mono truncate">
                          {base}
                        </span>
                        <span className="text-[10px] font-mono text-neutral-500 truncate">
                          {tildify(parent, homeDir)}
                          {missing && (
                            <span className="ml-2 text-wt-dirty">missing</span>
                          )}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${base} from recent repositories`}
                        onClick={(e) => {
                          // Don't bubble — clicking X must not also load the repo.
                          e.stopPropagation();
                          void removeFromRecents(path);
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-wt-bg text-neutral-500 hover:text-neutral-200 shrink-0"
                        title="Remove from recents"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Footer: open another repo via the system directory picker. */}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void pickAndLoadRepo();
            }}
            onMouseEnter={() => setActiveIdx(others.length)}
            className={`w-full flex items-center gap-2 px-3 py-2 text-sm border-t border-wt-border ${
              activeIdx === others.length ? 'bg-wt-border' : 'hover:bg-wt-border'
            }`}
          >
            <FolderOpen className="w-4 h-4 text-neutral-400" />
            <span>Open another repository…</span>
          </button>
        </div>
      )}
    </div>
  );
}
