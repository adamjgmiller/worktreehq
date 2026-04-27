import { useEffect, useRef } from 'react';
import { useRepoStore } from '../store/useRepoStore';
import { invoke, isTauri, keychainRead, setGitAuthMethod, updateConfig } from '../services/tauriBridge';
import {
  expireOpenPrEntries,
  hydratePrCache,
  initGithub,
  detectGhCli,
  validateToken,
  type AuthMethod,
} from '../services/githubService';
import { checkGitAvailable, setGitVersion, getDefaultBranch, getRemoteUrl, resolveWatchDirs } from '../services/gitService';
import {
  refreshOnce,
  runFetchOnce,
  startFetchLoop,
  startRefreshLoop,
  stopFetchLoop,
  stopRefreshLoop,
} from '../services/refreshLoop';
import {
  readWorktreeOrder,
  readWorktreeSortMode,
} from '../services/worktreeOrderService';

// Minimum gap between watcher-driven refreshes. The 250ms debounce below
// coalesces a burst of events, but on its own doesn't cap throughput — a
// continuous write stream (hot reload, `npm install`) would otherwise fire
// a refresh every 250ms forever. With the watcher scoped to `.git/` this
// rarely matters in practice, but the floor is cheap insurance.
//
// Raised from 2s to 5s as part of #72 cadence cleanup. 2s was aggressive
// enough that the watcher-driven refresh cadence felt more like a glitch
// than a feature — the "updated X ago" label would reset at unpredictable
// sub-poll intervals whenever anything inside `.git/` wrote (including
// our own `git fetch`'s FETCH_HEAD write; see the linked follow-up issue).
// 5s preserves the "I just committed" immediacy case (the debounce still
// fires within 250ms if nothing else has refreshed lately) but prevents
// the label from resetting 3-4 times per minute on a routinely-busy repo.
const WATCHER_MIN_INTERVAL_MS = 5000;

interface AppConfig {
  github_token: string;
  // Legacy field — kept for config deserialization compat only; no longer read.
  github_token_explicitly_set?: boolean;
  // Persisted auth method preference. When set, bootstrap uses this instead
  // of auto-detecting. Allows the user to force a specific method (e.g.
  // prefer PAT over gh-cli, or explicitly opt out).
  auth_method?: AuthMethod;
  refresh_interval_ms: number;
  fetch_interval_ms: number;
  last_repo_path?: string;
  recent_repo_paths?: string[];
  zoom_level?: number;
  theme?: 'light' | 'dark' | 'system';
}

interface RepoInfo {
  path: string;
  is_git: boolean;
}

/**
 * Auth detection cascade:
 *   1. Check persisted auth_method preference (handled synchronously by
 *      `syncInitAuthFromConfig`)
 *   2. Try gh CLI (auto-detect; persists to config on success)
 *   3. Try keychain PAT (persists to config on success)
 *   4. Fall back to 'none'
 *
 * When auth is established, triggers an extra refreshOnce() so PR
 * enrichment and squash detection land as soon as auth is ready, rather
 * than waiting for the next 15s poll tick.
 */

/**
 * Synchronous explicit-auth bootstrap. Returns `true` if `cfg.auth_method`
 * was an explicit value (`'gh-cli' | 'pat' | 'none'`) and was handled
 * here — in which case `initGithub` was already called synchronously and
 * the caller can safely proceed with PR cache hydration without racing
 * against an async auth path that would re-`initGithub` (and therefore
 * re-`prCache.clear()`) after hydration.
 *
 * Returns `false` when `cfg.auth_method` is unset (auto-detect), so the
 * caller knows to fire the async auto-detect path.
 *
 * The PAT branch is async-but-awaited-by-caller only because it needs to
 * read the keychain; this is still synchronous *relative to the rest of
 * bootstrap* — hydratePrCache is awaited after it. This keeps the
 * invariant that for any explicit method, initGithub runs before
 * hydratePrCache and no second initGithub fires later.
 */
async function syncInitAuthFromConfig(
  cfg: AppConfig,
  setGithubAuthStatus: (s: 'missing' | 'checking' | 'valid' | 'invalid') => void,
  setAuthMethod: (m: AuthMethod) => void,
  cancelled: { current: boolean },
): Promise<boolean> {
  if (cfg.auth_method === 'gh-cli') {
    initGithub('gh-cli');
    setAuthMethod('gh-cli');
    void setGitAuthMethod('gh-cli');
    validateAndRefresh(setGithubAuthStatus, cancelled);
    return true;
  }

  if (cfg.auth_method === 'pat') {
    const keychainToken = await tryKeychainToken();
    if (cancelled.current) return true;
    const token = keychainToken || cfg.github_token || '';
    if (token) {
      initGithub('pat', token);
      setAuthMethod('pat');
      void setGitAuthMethod('pat', token);
      validateAndRefresh(setGithubAuthStatus, cancelled);
      return true;
    }
    // Explicit PAT preference but no token found — fall through to 'none'
    // rather than auto-detect, so the user's explicit choice is respected.
    initGithub('none');
    setAuthMethod('none');
    void setGitAuthMethod('none');
    setGithubAuthStatus('missing');
    return true;
  }

  if (cfg.auth_method === 'none') {
    initGithub('none');
    setAuthMethod('none');
    void setGitAuthMethod('none');
    setGithubAuthStatus('missing');
    return true;
  }

  return false;
}

// Helper: after auth is established, validate and kick a refresh so the
// first load gets PR data without waiting a full poll interval. The
// refresh is gated on `dataRepoPath` (not just `repo`) so it only fires
// after the initial fetch + refresh cycle has committed data. Without
// this, a fast auth detection could trigger refreshOnce() between
// setRepo() and runFetchOnce(), committing a snapshot derived from stale
// origin/* refs — the shimmer would lift on pre-fetch data until the
// fetch-corrected refresh lands. When auth resolves before the fetch,
// the extra tick is harmlessly skipped: initGithub() already ran
// synchronously, so the fetch's own chained refreshOnce has the
// transport set and picks up PR data on its own.
function validateAndRefresh(
  setGithubAuthStatus: (s: 'missing' | 'checking' | 'valid' | 'invalid') => void,
  cancelled: { current: boolean },
) {
  setGithubAuthStatus('checking');
  void validateToken().then((status) => {
    if (cancelled.current) return;
    setGithubAuthStatus(status);
    if (status === 'valid' && useRepoStore.getState().dataRepoPath) {
      void refreshOnce();
    }
  });
}

/**
 * Async auto-detect path. ONLY runs when `cfg.auth_method` is unset —
 * i.e. `syncInitAuthFromConfig` returned `false`. Must not be called for
 * explicit-method configs: doing so would re-invoke `initGithub`, which
 * triggers `prCache.clear()` and would wipe just-hydrated entries.
 *
 * Caller must AWAIT this before `hydratePrCache()` — detection transitions
 * `initGithub` from the module-level default 'none' to 'gh-cli' or 'pat'
 * on first launch, and the method change triggers `prCache.clear()` inside
 * githubService. A fire-and-forget dispatch would race the hydrate and
 * wipe entries we just seeded from disk.
 */
async function autoDetectAndInitAuth(
  setGithubAuthStatus: (s: 'missing' | 'checking' | 'valid' | 'invalid') => void,
  setAuthMethod: (m: AuthMethod) => void,
  cancelled: { current: boolean },
): Promise<void> {
  // Auto-detect: try gh CLI first (preferred default)
  const ghAvailable = await detectGhCli();
  if (cancelled.current) return;
  if (ghAvailable) {
    initGithub('gh-cli');
    setAuthMethod('gh-cli');
    void setGitAuthMethod('gh-cli');
    // Persist so subsequent launches skip the subprocess detection.
    void updateConfig({ auth_method: 'gh-cli' }).catch(() => {});
    validateAndRefresh(setGithubAuthStatus, cancelled);
    return;
  }

  // Try keychain PAT
  const keychainToken = await tryKeychainToken();
  if (cancelled.current) return;
  if (keychainToken) {
    initGithub('pat', keychainToken);
    setAuthMethod('pat');
    void setGitAuthMethod('pat', keychainToken);
    // Persist so subsequent launches skip the detection cascade.
    void updateConfig({ auth_method: 'pat' }).catch(() => {});
    validateAndRefresh(setGithubAuthStatus, cancelled);
    return;
  }

  // No auth available
  initGithub('none');
  setAuthMethod('none');
  void setGitAuthMethod('none');
  setGithubAuthStatus('missing');
}

async function tryKeychainToken(): Promise<string | null> {
  try {
    return await keychainRead('github_token');
  } catch {
    return null;
  }
}

export function useRepoBootstrap() {
  const setRepo = useRepoStore((s) => s.setRepo);
  const setError = useRepoStore((s) => s.setError);
  const setGithubAuthStatus = useRepoStore((s) => s.setGithubAuthStatus);
  const setAuthMethod = useRepoStore((s) => s.setAuthMethod);
  const setRefreshInterval = useRepoStore((s) => s.setRefreshInterval);
  const setFetchInterval = useRepoStore((s) => s.setFetchInterval);
  const setZoomLevel = useRepoStore((s) => s.setZoomLevel);
  const setRecentRepoPaths = useRepoStore((s) => s.setRecentRepoPaths);
  const setWorktreeOrder = useRepoStore((s) => s.setWorktreeOrder);
  const setWorktreeSortMode = useRepoStore((s) => s.setWorktreeSortMode);
  const setThemePreference = useRepoStore((s) => s.setThemePreference);
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
    const cancelledRef = { current: false };
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        if (!isTauri()) {
          setError('Not running inside Tauri — backend commands unavailable.');
          return;
        }
        const cfg = await invoke<AppConfig>('read_config');

        // Auth bootstrap: kick off detection as a DETACHED promise so the
        // synchronous store-setters below (refresh/fetch interval, zoom,
        // theme, recents) can dispatch immediately — auth detection is
        // bounded by detectGhCli's subprocess timeout (~3s on first launch)
        // and the keychain read for the explicit-PAT path, both of which
        // would otherwise block the entire bootstrap critical path before
        // any UI-driving config landed in the store.
        //
        // The invariant we MUST preserve: `initGithub` (and any
        // `prCache.clear()` it triggers on auth-method change) fires BEFORE
        // hydratePrCache seeds the in-memory cache from disk. Otherwise a
        // late-resolving initGithub would wipe just-hydrated (and
        // still-warm) merged PR entries, silently regressing the PR-cache
        // invalidation work. We enforce this by awaiting `authDone` right
        // before `hydratePrCache()` below.
        //
        // The auto-detect branch is reached only when `cfg.auth_method` is
        // unset; on subsequent launches it persists `auth_method` so the
        // sync branch handles it.
        const authDone = syncInitAuthFromConfig(
          cfg,
          setGithubAuthStatus,
          setAuthMethod,
          cancelledRef,
        ).then((handledSync) =>
          handledSync
            ? null
            : autoDetectAndInitAuth(setGithubAuthStatus, setAuthMethod, cancelledRef),
        );

        // Mirror the Rust default (config.rs default_interval = 15_000) and the
        // store default. The previous `|| 5000` silently undermined the
        // documented 15s default whenever the field deserialized to 0.
        setRefreshInterval(cfg.refresh_interval_ms || 15_000);
        setFetchInterval(cfg.fetch_interval_ms ?? 60_000);
        // Hydrate persisted zoom. The Rust side already clamps and falls back
        // to 1.0 for malformed values, so we can trust whatever it returned.
        if (typeof cfg.zoom_level === 'number') setZoomLevel(cfg.zoom_level);
        // Hydrate the theme preference. The Rust side coerces unrecognized
        // values to "system", so whatever comes back is safe to trust. The
        // useTheme hook (mounted in App.tsx) picks up the change and applies
        // the .dark class on <html>.
        if (cfg.theme) setThemePreference(cfg.theme);
        // Hydrate recents into the store before any UI mounts that might
        // read it. Rust seeds this from `last_repo_path` on first read of an
        // older config so the list is non-empty for upgraders.
        setRecentRepoPaths(cfg.recent_repo_paths ?? []);
        // Block on auth before touching prCache: initGithub must run first
        // so that any prCache.clear() triggered by an auth-method change
        // happens before hydration seeds the cache from disk. Without this
        // await, a late-resolving initGithub would wipe just-hydrated
        // entries.
        await authDone;
        // Single cancellation guard covering both branches of the auth
        // pipeline (explicit syncInitAuthFromConfig including its
        // tryKeychainToken await, and the auto-detect autoDetectAndInitAuth
        // path). If cleanup ran during either await, bail out before
        // touching the store, the persisted PR cache, or scheduling any
        // intervals.
        if (cancelled) return;
        await hydratePrCache();
        // Soft-expire any rehydrated PR entries in a non-terminal state
        // (`open` or `closed`). The cache is persisted with original
        // timestamps, so anything cached more than 5 min before quit
        // auto-expires on first read, but entries cached within the 5-min
        // TTL window come back warm-and-stale. A PR that was open when we
        // quit but merged on github.com before relaunch would otherwise
        // serve cached `state: 'open'` to detectSquashMerges and the
        // squash-merged classification would lag until the TTL caught up;
        // the analogous reopen→merge case applies to cached `closed`
        // entries (GitHub allows reopening closed PRs and then merging
        // them). Only `merged` is truly terminal — leave those warm.
        expireOpenPrEntries();

        // Prefer the head of the MRU list; fall back to last_repo_path for
        // safety in case a hand-edited config has them out of sync.
        const launchPath =
          (cfg.recent_repo_paths && cfg.recent_repo_paths[0]) ||
          cfg.last_repo_path ||
          null;
        // First-launch path: no last_repo_path, no recents → don't try to
        // resolve current_dir() (which on a Mac dock launch is `/` and
        // produces a confusing "Not a git repository: /" error). Surface a
        // friendly onboarding message; App.tsx already renders the
        // "Pick a repository…" affordance when repo is null and an error
        // is set.
        if (!launchPath) {
          setError('No repository loaded. Pick a git repository to get started.');
          return;
        }
        const info = await invoke<RepoInfo>('resolve_repo', { path: launchPath });
        if (!info.is_git) {
          setError(`Not a git repository: ${info.path}`);
          return;
        }
        const gitVersion = await checkGitAvailable(info.path);
        if (!gitVersion) {
          setError(
            'git is not installed or not on your PATH. WorktreeHQ requires git — install it and restart the app.',
          );
          return;
        }
        setGitVersion(gitVersion);
        const defaultBranch = await getDefaultBranch(info.path);
        // Resolve the origin owner/name once at bootstrap and stash on the
        // repo state. This never changes for a given repo so paying the
        // `remote get-url` subprocess on every refresh tick was pure
        // waste. The refresh loop reads these off `repo` directly.
        const remote = await getRemoteUrl(info.path);
        if (cancelled) return;
        // Bootstrap path: uses raw `setRepo` (not `setRepoAndRefresh`)
        // because we deliberately defer the first refresh until after
        // `runFetchOnce()` below — starting the refresh before the fetch
        // commits would let the first tick commit a snapshot derived from
        // stale `origin/*` refs, leaving squash-merged branches shown as
        // "unmerged" until the fetch-chained follow-up corrected them.
        // The refresh that clears `loading` is driven by `startRefreshLoop`
        // after the initial fetch returns. Every other setRepo call site
        // should prefer `setRepoAndRefresh` — see the CONTRACT comment in
        // refreshLoop.ts.
        setRepo({
          path: info.path,
          defaultBranch,
          owner: remote.owner,
          name: remote.name,
        });
        // Hydrate persisted card order + sort mode for this repo before the
        // first refresh lands, so cards appear in the user's saved
        // arrangement. Migration rule: if the user has a saved manual order
        // but no saved mode (upgraded from before sort modes existed),
        // default to 'manual' so their drag arrangement isn't silently
        // overwritten by the new 'recent' default.
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
          /* best-effort; defaults in the store preserve sane behavior */
        }
        // Run the initial fetch BEFORE starting the refresh loop. Without
        // this, `startRefreshLoop()` synchronously begins its first tick
        // (and thus `runRefreshOnce`) BEFORE `startFetchLoop()` has even
        // been called — so runRefreshOnce reads a stale
        // `origin/<defaultBranch>` and squash-merged branches that landed
        // while the app was closed briefly render as "unmerged" until the
        // fetch-chained follow-up refresh corrects them. The recent
        // `pendingBackgroundRefresh` fix only rescues the race where the
        // fetch wins; when the first refresh wins, stale data gets
        // committed to the store and the shimmer lifts on it. Awaiting
        // runFetchOnce here guarantees the first data the user sees is
        // post-fetch — its internal chained refreshOnce populates the
        // store with up-to-date refs before the shimmer is lifted.
        // Respect `fetchIntervalMs === 0` so users who explicitly
        // disabled auto-fetch don't get a surprise startup network call.
        const { fetchIntervalMs } = useRepoStore.getState();
        let initialFetchSucceeded = false;
        if (fetchIntervalMs > 0) {
          await runFetchOnce();
          if (cancelled) return;
          initialFetchSucceeded = useRepoStore.getState().lastFetchError === null;
        }
        startRefreshLoop();
        startFetchLoop({ skipFirstTick: initialFetchSucceeded });

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
      cancelledRef.current = true;
      // Don't call stopWatching() here — the second effect (worktree-paths
      // watcher) manages the Rust-side watcher's lifecycle, and
      // start_watching already replaces any prior watcher on its own. If
      // this cleanup runs (e.g. React strict-mode remount) without the
      // second effect re-firing, calling stopWatching() would kill the
      // native watcher with no re-registration, silently disabling
      // watcher-accelerated refreshes until a worktree path changes.
      if (unlisten) unlisten();
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      stopRefreshLoop();
      stopFetchLoop();
    };
  }, [
    setRepo,
    setError,
    setGithubAuthStatus,
    setAuthMethod,
    setRefreshInterval,
    setFetchInterval,
    setZoomLevel,
    setRecentRepoPaths,
    setWorktreeOrder,
    setThemePreference,
  ]);

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
