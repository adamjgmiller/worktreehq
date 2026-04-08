import { RefreshCw, Settings, Github, Download } from 'lucide-react';
import { useRepoStore } from '../store/useRepoStore';
import { refreshOnce, runFetchOnce } from '../services/refreshLoop';
import { relativeTime } from '../lib/format';

export function RepoBar({ onSettings }: { onSettings: () => void }) {
  const repo = useRepoStore((s) => s.repo);
  const loading = useRepoStore((s) => s.loading);
  const fetching = useRepoStore((s) => s.fetching);
  const lastRefresh = useRepoStore((s) => s.lastRefresh);
  const tokenSet = useRepoStore((s) => s.githubTokenSet);
  return (
    <div className="flex items-center gap-4 px-6 py-3 border-b border-wt-border bg-wt-panel">
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
      <button
        onClick={runFetchOnce}
        disabled={fetching}
        className="p-1.5 rounded hover:bg-wt-border disabled:opacity-50"
        aria-label="fetch"
        title="git fetch --all --prune"
      >
        <Download className={`w-4 h-4 ${fetching ? 'animate-pulse' : ''}`} />
      </button>
      <button
        onClick={refreshOnce}
        disabled={loading}
        className="p-1.5 rounded hover:bg-wt-border disabled:opacity-50"
        aria-label="refresh"
      >
        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
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
