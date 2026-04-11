import { useEffect, useRef } from 'react';
import { useRepoStore } from '../store/useRepoStore';
import { invoke, isTauri } from '../services/tauriBridge';
import { hydratePrCache, initGithub, validateToken } from '../services/githubService';
import { getDefaultBranch, getRemoteUrl, resolveWatchDirs } from '../services/gitService';
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
const WATCHER_MIN_INTERVAL_MS = 2000;

interface AppConfig {
  github_token: string;
  // True once the user has explicitly set or cleared the token via Settings;
  // suppresses the GITHUB_TOKEN env fallback so explicit clears stick.
  github_token_explicitly_set?: boolean;
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

export function useRepoBootstrap() {
  const setRepo = useRepoStore((s) => s.setRepo);
  const setError = useRepoStore((s) => s.setError);
  const setGithubAuthStatus = useRepoStore((s) => s.setGithubAuthStatus);
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
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        if (!isTauri()) {
          setError('Not running inside Tauri — backend commands unavailable.');
          return;
        }
        const cfg = await invoke<AppConfig>('read_config');
        initGithub(cfg.github_token || '');
        // Kick token validation without awaiting so bootstrap keeps flowing.
        // The pill starts in 'checking' and flips to the real state within
        // ~200ms typical; a slow validation can't block the rest of the
        // boot sequence. `cancelled` is captured so a repo-switch mid-flight
        // doesn't overwrite the new repo's pill state.
        if (cfg.github_token) {
          void validateToken().then((status) => {
            if (!cancelled) setGithubAuthStatus(status);
          });
        } else {
          setGithubAuthStatus('missing');
        }
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
        await hydratePrCache();

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
        const defaultBranch = await getDefaultBranch(info.path);
        // Resolve the origin owner/name once at bootstrap and stash on the
        // repo state. This never changes for a given repo so paying the
        // `remote get-url` subprocess on every refresh tick was pure
        // waste. The refresh loop reads these off `repo` directly.
        const remote = await getRemoteUrl(info.path);
        if (cancelled) return;
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
          // `runFetchOnce` swallows all errors internally (see
          // refreshLoop.ts:313-397), so a try/catch here would never fire.
          // The reliable signal is `lastFetchError`: on background fetch
          // success it's cleared to null, on background fetch failure it's
          // set to the error message. This is the same signal the RepoBar
          // indicator reads and is covered by the `sets lastFetchError on
          // background fetch failure` test in refreshLoop.test.ts.
          initialFetchSucceeded = useRepoStore.getState().lastFetchError === null;
        }
        startRefreshLoop();
        // When the initial fetch actually succeeded, suppress startFetchLoop's
        // immediate first tick — otherwise it would fire a second back-to-back
        // `fetchAllPrune` subprocess against refs that were JUST fetched (the
        // `fetchInFlight` guard can't dedupe it because the awaited fetch
        // already cleared the flag). When the initial fetch *failed* (transient
        // network blip, SSH agent not yet unlocked at login, etc.), we do NOT
        // skip — we want the fetch loop's immediate tick to retry right away
        // instead of making the user wait a full `fetchIntervalMs` for fresh
        // data.
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
      if (unlisten) unlisten();
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      stopRefreshLoop();
      stopFetchLoop();
      // Don't call stopWatching() here — the second effect (worktree-paths
      // watcher) manages the Rust-side watcher's lifecycle, and
      // start_watching already replaces any prior watcher on its own. If
      // this cleanup runs (e.g. React strict-mode remount) without the
      // second effect re-firing, calling stopWatching() would kill the
      // native watcher with no re-registration, silently disabling
      // watcher-accelerated refreshes until a worktree path changes.
    };
  }, [
    setRepo,
    setError,
    setGithubAuthStatus,
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
