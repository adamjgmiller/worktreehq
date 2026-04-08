import { useEffect, useRef } from 'react';
import { useRepoStore } from '../store/useRepoStore';
import { invoke, isTauri } from '../services/tauriBridge';
import { hydratePrCache, initGithub } from '../services/githubService';
import { getDefaultBranch, resolveWatchDirs } from '../services/gitService';
import {
  refreshOnce,
  startFetchLoop,
  startRefreshLoop,
  stopFetchLoop,
  stopRefreshLoop,
} from '../services/refreshLoop';

// Minimum gap between watcher-driven refreshes. The 250ms debounce below
// coalesces a burst of events, but on its own doesn't cap throughput — a
// continuous write stream (hot reload, `npm install`) would otherwise fire
// a refresh every 250ms forever. With the watcher scoped to `.git/` this
// rarely matters in practice, but the floor is cheap insurance.
const WATCHER_MIN_INTERVAL_MS = 2000;

interface AppConfig {
  github_token: string;
  refresh_interval_ms: number;
  fetch_interval_ms: number;
  last_repo_path?: string;
}

interface RepoInfo {
  path: string;
  is_git: boolean;
}

export function useRepoBootstrap() {
  const setRepo = useRepoStore((s) => s.setRepo);
  const setError = useRepoStore((s) => s.setError);
  const setTokenPresent = useRepoStore((s) => s.setTokenPresent);
  const setRefreshInterval = useRepoStore((s) => s.setRefreshInterval);
  const setFetchInterval = useRepoStore((s) => s.setFetchInterval);
  // Derive just the sorted-paths key so the watcher effect only re-runs when the
  // actual path SET changes — not on every refresh tick when other worktree
  // fields (branch name, commit count, etc.) churn.
  const worktreePathsKey = useRepoStore((s) =>
    s.worktrees
      .map((w) => w.path)
      .sort()
      .join('\u0001'),
  );

  // Debounced + rate-limited refresh trigger for watcher events. The debounce
  // coalesces bursts (many files change in one tick); the rate-limit enforces
  // a minimum gap between actually-fired refreshes so a steady event stream
  // can't saturate the pipeline. Both are local to this hook instance.
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWatcherRefresh = useRef<number>(0);
  const scheduleRefresh = () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    const now = Date.now();
    const sinceLast = now - lastWatcherRefresh.current;
    const delay = sinceLast < WATCHER_MIN_INTERVAL_MS
      ? WATCHER_MIN_INTERVAL_MS - sinceLast
      : 250;
    debounceTimer.current = setTimeout(() => {
      lastWatcherRefresh.current = Date.now();
      void refreshOnce();
    }, delay);
  };

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        if (!isTauri()) {
          setError('Not running inside Tauri — backend commands unavailable.');
          return;
        }
        const cfg = await invoke<AppConfig>('read_config');
        initGithub(cfg.github_token || '');
        setTokenPresent(!!cfg.github_token);
        setRefreshInterval(cfg.refresh_interval_ms || 5000);
        setFetchInterval(cfg.fetch_interval_ms ?? 60_000);
        await hydratePrCache();

        const info = await invoke<RepoInfo>('resolve_repo', { path: cfg.last_repo_path ?? null });
        if (!info.is_git) {
          setError(`Not a git repository: ${info.path}`);
          return;
        }
        const defaultBranch = await getDefaultBranch(info.path);
        if (cancelled) return;
        setRepo({ path: info.path, defaultBranch });
        startRefreshLoop();
        startFetchLoop();

        // Wire the filesystem watcher events to a debounced refresh tick.
        try {
          const ev = await import('@tauri-apps/api/event');
          const u = await ev.listen('worktree-changed', () => {
            scheduleRefresh();
          });
          unlisten = u;
        } catch {
          /* watcher is a nice-to-have — polling still covers the UI */
        }
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      stopRefreshLoop();
      stopFetchLoop();
    };
  }, [setRepo, setError, setTokenPresent, setRefreshInterval, setFetchInterval]);

  // Re-register the watcher on the Rust side whenever the set of worktree paths changes.
  // `start_watching` on its own replaces any prior watcher, so a second call reseats it.
  // The selector above returns the joined-paths string, so strict equality on it
  // means this effect only fires when a worktree path is added, removed, or renamed.
  //
  // We watch the per-worktree git dirs (+ common git dir) rather than the
  // worktree roots — the latter would fire on every `node_modules`, `dist/`,
  // or log-file write and wedge the refresh loop. See `resolveWatchDirs` in
  // `gitService.ts` for the full rationale.
  useEffect(() => {
    if (!isTauri()) return;
    if (!worktreePathsKey) return;
    const worktreePaths = worktreePathsKey.split('\u0001');
    let cancelled = false;
    void (async () => {
      const paths = await resolveWatchDirs(worktreePaths);
      if (cancelled || paths.length === 0) return;
      await invoke('start_watching', { paths }).catch(() => {
        /* best-effort */
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [worktreePathsKey]);
}
