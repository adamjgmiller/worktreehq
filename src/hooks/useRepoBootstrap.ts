import { useEffect, useRef } from 'react';
import { useRepoStore } from '../store/useRepoStore';
import { invoke, isTauri } from '../services/tauriBridge';
import { hydratePrCache, initGithub } from '../services/githubService';
import { getDefaultBranch } from '../services/gitService';
import {
  refreshOnce,
  startFetchLoop,
  startRefreshLoop,
  stopFetchLoop,
  stopRefreshLoop,
} from '../services/refreshLoop';

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
  const worktrees = useRepoStore((s) => s.worktrees);

  // Debounced refresh trigger for watcher events — rapid file edits should coalesce
  // into one refresh.
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      void refreshOnce();
    }, 250);
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
  const lastPaths = useRef<string>('');
  useEffect(() => {
    if (!isTauri()) return;
    const paths = worktrees.map((w) => w.path).sort();
    const key = paths.join('\u0001');
    if (key === lastPaths.current) return;
    lastPaths.current = key;
    if (paths.length === 0) return;
    invoke('start_watching', { paths }).catch(() => {
      /* best-effort */
    });
  }, [worktrees]);
}
