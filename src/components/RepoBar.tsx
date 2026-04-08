import { RefreshCw, Settings, Github, Download, FolderOpen } from 'lucide-react';
import { useRepoStore } from '../store/useRepoStore';
import { runFetchOnce } from '../services/refreshLoop';
import { pickAndLoadRepo } from '../services/repoSelect';
import { relativeTime } from '../lib/format';

export function RepoBar({ onSettings }: { onSettings: () => void }) {
  const repo = useRepoStore((s) => s.repo);
  // Spinner reflects either phase: the fetch subprocess (`fetching`) AND the
  // chained re-derive (`userRefreshing`). The refresh button now always runs
  // both phases — see the onClick wiring below for the rationale.
  const userRefreshing = useRepoStore((s) => s.userRefreshing);
  const fetching = useRepoStore((s) => s.fetching);
  const busy = userRefreshing || fetching;
  const lastRefresh = useRepoStore((s) => s.lastRefresh);
  const tokenSet = useRepoStore((s) => s.githubTokenSet);
  return (
    <div className="flex items-center gap-4 px-6 py-3 border-b border-wt-border bg-wt-panel">
      <button
        onClick={() => void pickAndLoadRepo()}
        title="Open another repository"
        aria-label="open repo"
        className="p-1.5 rounded hover:bg-wt-border text-neutral-400"
      >
        <FolderOpen className="w-4 h-4" />
      </button>
      <div className="text-sm">
        <span className="text-neutral-500">repo</span>{' '}
        <span className="font-mono">{repo?.path ?? '—'}</span>
      </div>
      <div className="text-xs text-neutral-500">
        default: <span className="font-mono">{repo?.defaultBranch ?? '—'}</span>
      </div>
      <div className="flex-1" />
      {fetching && (
        <div className="flex items-center gap-1.5 text-xs text-wt-info" title="git fetch --all --prune">
          <Download className="w-3.5 h-3.5 animate-pulse" />
          fetching…
        </div>
      )}
      <div className="text-xs text-neutral-500">
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
        title="Fetch from origin and refresh"
      >
        <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
      </button>
      <div
        className={`flex items-center gap-1 text-xs ${tokenSet ? 'text-wt-clean' : 'text-wt-dirty'}`}
        title={tokenSet ? 'GitHub token configured' : 'No GitHub token'}
      >
        <Github className="w-4 h-4" />
        {tokenSet ? 'auth' : 'no token'}
      </div>
      <button
        onClick={onSettings}
        className="p-1.5 rounded hover:bg-wt-border"
        aria-label="settings"
      >
        <Settings className="w-4 h-4" />
      </button>
    </div>
  );
}
