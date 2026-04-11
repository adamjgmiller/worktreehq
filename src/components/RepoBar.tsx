import { RefreshCw, Settings, Github, Download, AlertTriangle, Sun, Moon } from 'lucide-react';
import { useRepoStore } from '../store/useRepoStore';
import { isMac } from '../lib/platform';
import { runFetchOnce } from '../services/refreshLoop';
import { relativeTime } from '../lib/format';
import { RecentReposMenu } from './RecentReposMenu';
import { persistThemePreference, resolveTheme } from '../hooks/useTheme';

const MOD_KEY = isMac ? '⌘' : 'Ctrl+';

export function RepoBar({ onSettings }: { onSettings: () => void }) {
  const repo = useRepoStore((s) => s.repo);
  // Spinner reflects either phase: the fetch subprocess (`fetching`) AND the
  // chained re-derive (`userRefreshing`). The refresh button now always runs
  // both phases — see the onClick wiring below for the rationale.
  const userRefreshing = useRepoStore((s) => s.userRefreshing);
  const fetching = useRepoStore((s) => s.fetching);
  const busy = userRefreshing || fetching;
  const lastRefresh = useRepoStore((s) => s.lastRefresh);
  const lastFetchError = useRepoStore((s) => s.lastFetchError);
  const authStatus = useRepoStore((s) => s.githubAuthStatus);
  const themePreference = useRepoStore((s) => s.themePreference);
  const setThemePreference = useRepoStore((s) => s.setThemePreference);
  // What the user sees RIGHT NOW. When the preference is "system" this
  // resolves against the OS media query; the toggle flips to the opposite
  // concrete value so a click always visibly inverts the theme (never a
  // no-op where the user's pref changes from "system" → "dark" while they
  // were already on dark).
  const currentlyDark = resolveTheme(themePreference) === 'dark';
  const onToggleTheme = () => {
    const next = currentlyDark ? 'light' : 'dark';
    setThemePreference(next);
    void persistThemePreference(next);
  };
  return (
    <div className="flex items-center gap-4 px-6 py-3 border-b border-wt-border bg-wt-panel">
      {/* Repo switcher: dropdown trigger that lists recently-opened repos
          plus an "open another…" footer. Replaces the old static path
          label and the standalone folder-icon button — one affordance,
          not two. See src/components/RecentReposMenu.tsx for the menu. */}
      <RecentReposMenu />
      <div className="text-xs text-wt-muted">
        default: <span className="font-mono">{repo?.defaultBranch ?? '—'}</span>
      </div>
      <div className="flex-1" />
      {fetching && (
        <div className="flex items-center gap-1.5 text-xs text-wt-info" title="git fetch --all --prune">
          <Download className="w-3.5 h-3.5 animate-pulse" />
          fetching…
        </div>
      )}
      {lastFetchError && !fetching && (
        <button
          onClick={() => useRepoStore.getState().setLastFetchError(null)}
          className="flex items-center gap-1.5 text-xs text-wt-dirty hover:text-wt-conflict"
          title={`Last fetch failed: ${lastFetchError}\n\nClick to dismiss`}
        >
          <AlertTriangle className="w-3.5 h-3.5" />
          fetch failed
        </button>
      )}
      <div className="text-xs text-wt-muted">
        {lastRefresh ? `updated ${relativeTime(new Date(lastRefresh).toISOString())}` : 'never'}
      </div>
      {/*
        The refresh button always runs `runFetchOnce` (fetch → invalidate PR
        caches → re-derive). The previous wiring called `refreshOnce` only,
        which re-derived from local refs and the still-cached PR data, so a
        freshly-merged PR could stay marked "unmerged" until either the 60s
        background fetch tick fired or the 5min PR-cache TTL expired. The
        user's mental model of "refresh" is "make WorktreeHQ match reality
        NOW", and any version of refresh that doesn't fetch defeats it.
      */}
      <button
        onClick={() => void runFetchOnce({ userInitiated: true })}
        disabled={busy}
        className="p-1.5 rounded hover:bg-wt-border disabled:opacity-50"
        aria-label="refresh"
        title={`Fetch from origin and refresh (${MOD_KEY}R)`}
      >
        <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
      </button>
      {/*
        Tri-state auth pill. 'checking' renders with the 'missing' yellow so
        the brief bootstrap transition doesn't flash a fourth color — the
        user either sees yellow hold steady then go green, or yellow hold
        steady then go red, both of which read as a settled state.
      */}
      <div
        className={`flex items-center gap-1 text-xs ${
          authStatus === 'valid'
            ? 'text-wt-clean'
            : authStatus === 'invalid'
              ? 'text-wt-conflict'
              : 'text-wt-dirty'
        }`}
        title={
          authStatus === 'valid'
            ? 'GitHub token valid'
            : authStatus === 'invalid'
              ? 'GitHub token invalid or expired — open Settings to update it'
              : authStatus === 'checking'
                ? 'Checking GitHub token…'
                : 'No GitHub token configured'
        }
      >
        <Github className="w-4 h-4" />
        {authStatus === 'valid'
          ? 'auth'
          : authStatus === 'invalid'
            ? 'token invalid'
            : authStatus === 'checking'
              ? 'checking…'
              : 'no token'}
      </div>
      {/*
        Theme toggle. The icon shows the DESTINATION (Sun when dark, Moon
        when light) — iA Writer / GitHub convention. Kept visually quiet
        (inherits text-wt-muted) so it doesn't compete with the status
        colors next to it in a data-dense header.
      */}
      <button
        onClick={onToggleTheme}
        className="p-1.5 rounded text-wt-muted hover:text-wt-fg hover:bg-wt-border transition-colors"
        aria-label={currentlyDark ? 'switch to light mode' : 'switch to dark mode'}
        title={currentlyDark ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {currentlyDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
      </button>
      <button
        onClick={onSettings}
        className="p-1.5 rounded hover:bg-wt-border"
        aria-label="settings"
        title={`Settings (${MOD_KEY},)`}
      >
        <Settings className="w-4 h-4" />
      </button>
    </div>
  );
}
