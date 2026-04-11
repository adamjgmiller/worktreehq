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
import { readWorktreeOrder } from './worktreeOrderService';

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
  recent_repo_paths?: string[];
  zoom_level?: number;
}

// Cap on the persisted recent-repos list. Eight is enough to comfortably
// cover a "what am I working on this week" set without the dropdown growing
// unwieldy. The cap lives in TS because the policy (dedupe + cap + bump) all
// lives here; the Rust side just stores whatever it's handed.
export const RECENT_REPOS_MAX = 8;

// Pure transform: produce the next MRU list when `path` is opened.
// - Dedupes (case-sensitive — paths are case-sensitive on macOS in practice
//   for git repos and we don't want to silently merge two distinct entries).
// - Bumps `path` to position 0.
// - Caps the result at RECENT_REPOS_MAX.
export function bumpRecent(prev: readonly string[], path: string): string[] {
  const filtered = prev.filter((p) => p !== path);
  filtered.unshift(path);
  return filtered.slice(0, RECENT_REPOS_MAX);
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
  const {
    setRepo,
    setError,
    setLastFetchError,
    setRecentRepoPaths,
    recentRepoPaths,
    setWorktrees,
    setBranches,
    setMainCommits,
    setSquashMappings,
    setClaudePresence,
    setDataRepoPath,
    setWorktreeOrder,
  } = useRepoStore.getState();
  try {
    const info = await invoke<RepoInfo>('resolve_repo', { path: candidate });
    if (!info.is_git) {
      setError(`Not a git repository: ${info.path}`);
      return false;
    }
    const defaultBranch = await getDefaultBranch(info.path);
    const remote = await getRemoteUrl(info.path);
    // Drop the previous repo's collections BEFORE flipping `repo`. App.tsx
    // gates the content region on `dataRepoPath === repo.path`, so resetting
    // dataRepoPath to null here puts the new repo into the shimmer state
    // instantly — no flash of the previous repo's worktree cards / branch
    // table while the new refresh is in flight. We also clear the actual
    // collections (rather than relying on the gate alone) so the store stays
    // coherent even if a future code path forgets to check the gate.
    setWorktrees([]);
    setBranches([]);
    setMainCommits([]);
    setSquashMappings([]);
    setClaudePresence(new Map());
    setDataRepoPath(null);
    setLastFetchError(null);
    setRepo({
      path: info.path,
      defaultBranch,
      owner: remote.owner,
      name: remote.name,
    });
    setError(null);
    // Hydrate persisted card order for the new repo.
    try {
      const order = await readWorktreeOrder(info.path);
      setWorktreeOrder(order);
    } catch {
      setWorktreeOrder([]);
    }
    // Update the in-memory MRU list immediately so the dropdown re-renders
    // before the config write resolves. The store is the source of truth
    // for the UI; the config write below mirrors it for persistence.
    const nextRecents = bumpRecent(recentRepoPaths, info.path);
    setRecentRepoPaths(nextRecents);
    // Persist. Read the current config first so we don't clobber other fields.
    // We write BOTH `recent_repo_paths` and `last_repo_path` (kept in sync as
    // recents[0]) so an older binary that only knows about `last_repo_path`
    // still resolves to the same repo on launch.
    try {
      const cfg = await invoke<AppConfigShape>('read_config');
      await invoke('write_config', {
        cfg: {
          ...cfg,
          last_repo_path: nextRecents[0] ?? info.path,
          recent_repo_paths: nextRecents,
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

// Remove a path from the recents list. Used by the per-row dismiss button in
// the dropdown — typically for entries whose underlying directory has moved
// or been deleted. Updates the store and persists in the same read-modify-
// write pattern as loadRepoAtPath. Best-effort persistence.
export async function removeFromRecents(path: string): Promise<void> {
  const { setRecentRepoPaths, recentRepoPaths } = useRepoStore.getState();
  const next = recentRepoPaths.filter((p) => p !== path);
  if (next.length === recentRepoPaths.length) return;
  setRecentRepoPaths(next);
  try {
    const cfg = await invoke<AppConfigShape>('read_config');
    await invoke('write_config', {
      cfg: {
        ...cfg,
        last_repo_path: next[0] ?? null,
        recent_repo_paths: next,
      },
    });
  } catch {
    /* persistence is best-effort; the in-memory list is already updated */
  }
}

// Open the picker and load the chosen path. Returns true on success.
export async function pickAndLoadRepo(): Promise<boolean> {
  const picked = await pickDirectory();
  if (!picked) return false;
  return loadRepoAtPath(picked);
}
