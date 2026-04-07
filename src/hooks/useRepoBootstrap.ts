import { useEffect } from 'react';
import { useRepoStore } from '../store/useRepoStore';
import { invoke, isTauri } from '../services/tauriBridge';
import { initGithub } from '../services/githubService';
import { getDefaultBranch } from '../services/gitService';
import { startRefreshLoop, stopRefreshLoop } from '../services/refreshLoop';

interface AppConfig {
  github_token: string;
  refresh_interval_ms: number;
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

  useEffect(() => {
    let cancelled = false;
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

        const info = await invoke<RepoInfo>('resolve_repo', { path: cfg.last_repo_path ?? null });
        if (!info.is_git) {
          setError(`Not a git repository: ${info.path}`);
          return;
        }
        const defaultBranch = await getDefaultBranch(info.path);
        if (cancelled) return;
        setRepo({ path: info.path, defaultBranch });
        startRefreshLoop();
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
      stopRefreshLoop();
    };
  }, [setRepo, setError, setTokenPresent, setRefreshInterval]);
}
