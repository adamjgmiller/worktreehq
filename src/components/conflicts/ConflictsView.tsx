import { useState } from 'react';
import { useRepoStore } from '../../store/useRepoStore';
import { ConflictMatrix } from './ConflictMatrix';
import { ConflictPairDetail } from './ConflictPairDetail';
import { EmptyState } from '../common/EmptyState';

export function ConflictsView() {
  const worktrees = useRepoStore((s) => s.worktrees);
  const branches = useRepoStore((s) => s.branches);
  const pairs = useRepoStore((s) => s.crossWorktreeConflicts);
  const [selectedPair, setSelectedPair] = useState<{ a: string; b: string } | null>(null);

  // Need at least 2 non-primary worktrees for pairwise comparison.
  // Exclude merged branches — conflicts between them aren't actionable.
  const mergedBranches = new Set(
    branches
      .filter((b) => b.mergeStatus === 'merged-normally' || b.mergeStatus === 'squash-merged' || b.mergeStatus === 'direct-merged')
      .map((b) => b.name),
  );
  const candidates = worktrees.filter(
    (w) =>
      !w.isPrimary &&
      !w.prunable &&
      w.branch &&
      w.branch !== '(detached)' &&
      !mergedBranches.has(w.branch),
  );
  if (candidates.length < 2) {
    return (
      <EmptyState
        title="Not enough worktrees"
        hint="Cross-worktree conflict detection requires at least two non-primary worktrees."
      />
    );
  }

  const detail = selectedPair
    ? pairs.find(
        (p) =>
          (p.branchA === selectedPair.a && p.branchB === selectedPair.b) ||
          (p.branchA === selectedPair.b && p.branchB === selectedPair.a),
      )
    : null;

  const hasAnyOverlap = pairs.some((p) => p.severity !== 'none');

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 overflow-hidden min-h-0">
        <div className="w-1/2 flex flex-col overflow-auto border-r border-wt-border p-4">
          <ConflictMatrix
            worktrees={candidates}
            pairs={pairs}
            selected={selectedPair}
            onSelect={setSelectedPair}
          />
        </div>
        <div className="flex-1 overflow-auto p-4">
          {detail ? (
            <ConflictPairDetail pair={detail} />
          ) : (
            <div className="flex items-center justify-center h-full text-wt-muted text-sm">
              {hasAnyOverlap
                ? 'Click a cell to see conflict details'
                : 'No file overlap detected between any worktree pairs'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
