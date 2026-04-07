import { useRepoStore } from '../../store/useRepoStore';
import { WorktreeCard } from './WorktreeCard';
import { EmptyState } from '../common/EmptyState';

export function WorktreesView() {
  const worktrees = useRepoStore((s) => s.worktrees);
  if (worktrees.length === 0) {
    return <EmptyState title="No worktrees yet" hint="Add one via `git worktree add`." />;
  }
  return (
    <div className="p-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
      {worktrees.map((w) => (
        <WorktreeCard key={w.path} wt={w} />
      ))}
    </div>
  );
}
