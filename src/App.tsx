import { useState } from 'react';
import { Tabs, type TabKey } from './components/Tabs';
import { RepoBar } from './components/RepoBar';
import { WorktreesView } from './components/worktrees/WorktreesView';
import { BranchesView } from './components/branches/BranchesView';
import { SquashView } from './components/squash/SquashView';
import { GraphView } from './components/graph/GraphView';
import { ErrorBanner } from './components/common/ErrorBanner';
import { SettingsModal } from './components/common/SettingsModal';
import { useRepoStore } from './store/useRepoStore';
import { useRepoBootstrap } from './hooks/useRepoBootstrap';
import { pickAndLoadRepo } from './services/repoSelect';

export default function App() {
  const [tab, setTab] = useState<TabKey>('worktrees');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const repo = useRepoStore((s) => s.repo);
  const error = useRepoStore((s) => s.error);
  const tokenSet = useRepoStore((s) => s.githubTokenSet);
  const setError = useRepoStore((s) => s.setError);
  useRepoBootstrap();

  // When the bootstrap can't resolve a repo (last_repo_path moved/deleted)
  // there's no in-app way to recover without editing config.toml. Show a
  // dedicated picker affordance alongside the error banner.
  const showRepoPicker = !repo && !!error;

  return (
    <div className="h-screen flex flex-col bg-wt-bg text-neutral-100">
      <RepoBar onSettings={() => setSettingsOpen(true)} />
      <Tabs value={tab} onChange={setTab} />
      {error && (
        <div className="p-4 space-y-2">
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
          {showRepoPicker && (
            <div className="text-xs text-neutral-400">
              <button
                onClick={() => void pickAndLoadRepo()}
                className="px-3 py-1.5 bg-wt-info/20 border border-wt-info/50 text-wt-info rounded hover:bg-wt-info/30"
              >
                Pick a repository…
              </button>
              <span className="ml-3">
                Choose another git repository to load.
              </span>
            </div>
          )}
        </div>
      )}
      {!tokenSet && !error && (
        <div className="px-6 pt-4 text-xs text-wt-dirty">
          No GitHub token configured — squash-merge detection from PRs will be limited.{' '}
          <button onClick={() => setSettingsOpen(true)} className="underline">
            Set one
          </button>
          .
        </div>
      )}
      <div className="flex-1 overflow-hidden">
        {tab === 'worktrees' && <WorktreesView />}
        {tab === 'branches' && <BranchesView />}
        {tab === 'squash' && <SquashView />}
        {tab === 'graph' && <GraphView />}
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
