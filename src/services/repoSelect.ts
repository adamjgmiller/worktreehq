// Runtime repo selection. The bootstrap hook resolves the repo once at mount
// from `last_repo_path`; this module provides the user-driven path: open a
// directory picker, validate via `resolve_repo`, persist to config, and feed
// the new state into the store. The poll/fetch loops have idempotent
// `running` guards so we don't need to stop/start them — they pick up the
// new repo on the next tick.

import { useRepoStore } from '../store/useRepoStore';
import { invoke } from './tauriBridge';
import { getDefaultBranch, getRemoteUrl } from './gitService';
import { refreshOnce } from './refreshLoop';

interface RepoInfo {
  path: string;
  is_git: boolean;
}

interface AppConfigShape {
  github_token: string;
  github_token_explicitly_set?: boolean;
  refresh_interval_ms: number;
  fetch_interval_ms: number;
  last_repo_path?: string | null;
}

// Open the system directory picker. Returns the selected path or null.
// Used by both this module and CreateWorktreeDialog.
export async function pickDirectory(): Promise<string | null> {
  try {
    const mod = await import('@tauri-apps/plugin-dialog');
    const result = await mod.open({ directory: true, multiple: false });
    if (typeof result === 'string') return result;
    return null;
  } catch {
    return null;
  }
}

// Resolve a candidate path to a git repo and load it into the store.
// On success persists the path to config so next launch reuses it.
// On failure sets the store error and leaves the prior repo in place.
export async function loadRepoAtPath(candidate: string): Promise<boolean> {
  const { setRepo, setError } = useRepoStore.getState();
  try {
    const info = await invoke<RepoInfo>('resolve_repo', { path: candidate });
    if (!info.is_git) {
      setError(`Not a git repository: ${info.path}`);
      return false;
    }
    const defaultBranch = await getDefaultBranch(info.path);
    const remote = await getRemoteUrl(info.path);
    setRepo({
      path: info.path,
      defaultBranch,
      owner: remote.owner,
      name: remote.name,
    });
    setError(null);
    // Persist last_repo_path. Read the current config first so we don't
    // clobber other fields.
    try {
      const cfg = await invoke<AppConfigShape>('read_config');
      await invoke('write_config', {
        cfg: {
          ...cfg,
          last_repo_path: info.path,
        },
      });
    } catch {
      /* persist is best-effort; the in-memory repo still works */
    }
    // Kick off an immediate refresh against the new repo.
    void refreshOnce({ userInitiated: true });
    return true;
  } catch (e: any) {
    setError(`Could not load repo: ${e?.message ?? e}`);
    return false;
  }
}

// Open the picker and load the chosen path. Returns true on success.
export async function pickAndLoadRepo(): Promise<boolean> {
  const picked = await pickDirectory();
  if (!picked) return false;
  return loadRepoAtPath(picked);
}
