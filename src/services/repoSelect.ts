// Runtime repo selection. The bootstrap hook resolves the repo once at mount
// from `last_repo_path`; this module provides the user-driven path: open a
// directory picker, validate via `resolve_repo`, persist to config, and feed
// the new state into the store. The poll/fetch loops have idempotent
// `running` guards so we don't need to stop/start them — they pick up the
// new repo on the next tick.

import { useRepoStore } from '../store/useRepoStore';
import { invoke, updateConfig } from './tauriBridge';
import { checkGitAvailable, setGitVersion, getDefaultBranch, getRemoteUrl } from './gitService';
import { setRepoAndFetch, setRepoAndRefresh } from './refreshLoop';
import { invalidateOpenPrListCache, invalidatePrCacheForRepo } from './githubService';
import { readWorktreeOrder, readWorktreeSortMode } from './worktreeOrderService';

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
    setWorktreeSortMode,
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
    // Hydrate the persisted card order AND sort mode for the new repo
    // BEFORE we flip `repo` and queue the refresh. Otherwise
    // `setRepoAndRefresh` fires its refresh pipeline immediately, and if
    // `commitRefreshResult` lands before the reads resolve, the Worktrees
    // tab will render using the PREVIOUS repo's `worktreeOrder` /
    // `worktreeSortMode` — and then flicker once the reads complete.
    // Awaiting here preserves the old pre-#74 ordering guarantee on repo
    // switches (a manual-sort repo never briefly shows the old repo's
    // arrangement). Sort mode mirrors useRepoBootstrap's hydration block:
    // if no mode is persisted but a manual order exists, default to
    // 'manual' so a legacy drag arrangement isn't silently overwritten by
    // the new 'recent' default; otherwise default to 'recent'.
    try {
      const order = await readWorktreeOrder(info.path);
      setWorktreeOrder(order);
      const savedMode = await readWorktreeSortMode(info.path);
      if (savedMode) {
        setWorktreeSortMode(savedMode);
      } else if (order.length > 0) {
        setWorktreeSortMode('manual');
      } else {
        setWorktreeSortMode('recent');
      }
    } catch {
      setWorktreeOrder([]);
      setWorktreeSortMode('recent');
    }
    // Soft-expire any cached PR entries for the destination repo BEFORE
    // we flip `repo` and kick the refresh chain. Re-entering a previously-
    // visited repo would otherwise serve last-visit's cached
    // `state: 'open'` PRInfo to detectSquashMerges, missing any squash
    // merge that landed remotely while we were away. Soft-expire (not
    // hard-delete) preserves `mergeTimeHeadSha` + `observedLive` via
    // `setPrCacheEntry`'s getStale() fallback chain.
    // Both caches must drop together — the optimistic refreshOnce in
    // runFetchOnce (below) would otherwise serve merged PRs as still-open
    // from the 60s-TTL openPrListCache, blocking squashDetector.hasOpenPR
    // and the cherry-fallback filter.
    if (remote.owner && remote.name) {
      invalidatePrCacheForRepo(remote.owner, remote.name);
      invalidateOpenPrListCache(remote.owner, remote.name);
    }
    // Flip the store, then queue a refresh — using `setRepoAndFetch` when
    // auto-fetch is enabled so re-entering a repo also pulls remote refs.
    // Without the fetch, a squash that landed on the remote while we were
    // on a different repo wouldn't appear in `mainCommits` until the next
    // 60s background fetch tick. `runFetchOnce` with `userInitiated: true`
    // fires its own immediate optimistic `refreshOnce({ userInitiated:
    // true })` synchronously inside `runFetchOnce` before the fetch await,
    // which preserves the synchronous-follow-up contract that
    // runRefreshOnce's repo-switch early return relies on (see the
    // CONTRACT comment in refreshLoop.ts). When `fetchIntervalMs === 0`
    // (users who explicitly disabled auto-fetch — mirrors the bootstrap
    // gate in useRepoBootstrap.ts), fall back to `setRepoAndRefresh` so
    // the shimmer still lifts on the new repo's data without a surprise
    // network call; that path also satisfies the CONTRACT (a queued
    // refresh must follow a `setRepo` call).
    const { fetchIntervalMs } = useRepoStore.getState();
    const repoState = {
      path: info.path,
      defaultBranch,
      owner: remote.owner,
      name: remote.name,
    };
    if (fetchIntervalMs > 0) {
      setRepoAndFetch(repoState);
    } else {
      setRepoAndRefresh(repoState);
    }
    setError(null);
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
