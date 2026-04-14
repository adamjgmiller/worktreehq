// Runtime repo selection. The bootstrap hook resolves the repo once at mount
// from `last_repo_path`; this module provides the user-driven path: open a
// directory picker, validate via `resolve_repo`, persist to config, and feed
// the new state into the store. The poll/fetch loops have idempotent
// `running` guards so we don't need to stop/start them — they pick up the
// new repo on the next tick.

import { useRepoStore } from '../store/useRepoStore';
import { invoke, updateConfig } from './tauriBridge';
import { checkGitAvailable, setGitVersion, getDefaultBranch, getRemoteUrl } from './gitService';
import { setRepoAndRefresh } from './refreshLoop';
import { readWorktreeOrder } from './worktreeOrderService';

interface RepoInfo {
  path: string;
  is_git: boolean;
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
    setError,
    setLastFetchError,
    setRecentRepoPaths,
    recentRepoPaths,
    setWorktrees,
    setBranches,
    setMainCommits,
    setSquashMappings,
    setClaudePresence,
    setCrossWorktreeConflicts,
    setDataRepoPath,
    setWorktreeOrder,
  } = useRepoStore.getState();
  try {
    const info = await invoke<RepoInfo>('resolve_repo', { path: candidate });
    if (!info.is_git) {
      setError(`Not a git repository: ${info.path}`);
      return false;
    }
    // Ensure the git version is detected so supportsWriteTree() works.
    // On the normal bootstrap path useRepoBootstrap handles this, but when
    // the user picks a repo on first launch (no last_repo_path) or switches
    // repos at runtime, bootstrap may have exited early before calling
    // setGitVersion — leaving gitMajorMinor at [0,0].
    const gitVersion = await checkGitAvailable(info.path);
    if (!gitVersion) {
      setError(
        'git is not installed or not on your PATH. WorktreeHQ requires git — install it and restart the app.',
      );
      return false;
    }
    setGitVersion(gitVersion);
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
    setCrossWorktreeConflicts([], new Map());
    setDataRepoPath(null);
    setLastFetchError(null);
    // setRepoAndRefresh couples the store write to the follow-up refresh.
    // runRefreshOnce's repo-switch early return leaks `loading: true` on
    // purpose; the new repo's refresh is what clears it. A bare setRepo()
    // here would leave the shimmer pinned if the refresh call were ever
    // forgotten. See the CONTRACT comment in refreshLoop.ts.
    setRepoAndRefresh({
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
      await updateConfig({
        last_repo_path: nextRecents[0] ?? info.path,
        recent_repo_paths: nextRecents,
      });
    } catch {
      /* persist is best-effort; the in-memory repo still works */
    }
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
    await updateConfig({
      last_repo_path: next[0] ?? null,
      recent_repo_paths: next,
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
