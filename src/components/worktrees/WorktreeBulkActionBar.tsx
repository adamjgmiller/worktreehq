import { Trash2, Eraser } from 'lucide-react';

export function WorktreeBulkActionBar({
  totalSelected,
  removableCount,
  pruneableCount,
  skippedPrimary,
  onRemove,
  onPruneOrphans,
}: {
  totalSelected: number;
  removableCount: number;
  pruneableCount: number;
  skippedPrimary: number;
  onRemove: () => void;
  onPruneOrphans: () => void;
}) {
  if (totalSelected === 0) return null;
  return (
    <div className="sticky bottom-0 z-20 flex items-center gap-3 px-4 py-3 border-t border-wt-border bg-wt-panel">
      <div className="text-sm text-wt-fg-2">
        <span className="font-mono text-wt-info">{totalSelected}</span> selected
        {skippedPrimary > 0 && (
          <span className="ml-2 text-xs text-wt-muted">
            (primary worktree will be skipped)
          </span>
        )}
      </div>
      <div className="flex-1" />
      {pruneableCount > 0 && (
        <button
          onClick={onPruneOrphans}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-wt-border rounded hover:bg-wt-border"
          title="Prune git's bookkeeping for orphaned worktrees"
        >
          <Eraser className="w-3.5 h-3.5" /> Prune orphans ({pruneableCount})
        </button>
      )}
      {removableCount > 0 && (
        <button
          onClick={onRemove}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-wt-conflict/20 border border-wt-conflict/50 text-wt-conflict rounded hover:bg-wt-conflict/30"
        >
          <Trash2 className="w-3.5 h-3.5" /> Remove ({removableCount})
        </button>
      )}
    </div>
  );
}
