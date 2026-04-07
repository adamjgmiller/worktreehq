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

export default function App() {
  const [tab, setTab] = useState<TabKey>('worktrees');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const error = useRepoStore((s) => s.error);
  const tokenSet = useRepoStore((s) => s.githubTokenSet);
  const setError = useRepoStore((s) => s.setError);
  useRepoBootstrap();

  return (
    <div className="h-screen flex flex-col bg-wt-bg text-neutral-100">
      <RepoBar onSettings={() => setSettingsOpen(true)} />
      <Tabs value={tab} onChange={setTab} />
      {error && (
        <div className="p-4">
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
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
