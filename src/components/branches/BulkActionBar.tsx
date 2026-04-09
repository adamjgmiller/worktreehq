import { Archive, Trash2 } from 'lucide-react';
import type { DeleteMode } from './ConfirmDeleteDialog';

export function BulkActionBar({
  count,
  onAction,
}: {
  count: number;
  onAction: (mode: DeleteMode) => void;
}) {
  if (count === 0) return null;
  return (
    <div className="sticky bottom-0 flex items-center gap-3 px-4 py-3 border-t border-wt-border bg-wt-panel">
      <div className="text-sm text-neutral-300">
        <span className="font-mono text-wt-info">{count}</span> selected
      </div>
      <div className="flex-1" />
      <button
        onClick={() => onAction('archive-and-delete')}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-wt-clean/15 border border-wt-clean/50 text-wt-clean rounded hover:bg-wt-clean/25"
        title="Create archive/<branch> tags, then delete local + remote"
      >
        <Archive className="w-3.5 h-3.5" /> Archive + delete
      </button>
      <button
        onClick={() => onAction('local')}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-wt-border rounded hover:bg-wt-border"
      >
        <Trash2 className="w-3.5 h-3.5" /> Delete local
      </button>
      <button
        onClick={() => onAction('remote')}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-wt-border rounded hover:bg-wt-border"
      >
        <Trash2 className="w-3.5 h-3.5" /> Delete remote
      </button>
      <button
        onClick={() => onAction('both')}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-wt-conflict/20 border border-wt-conflict/50 text-wt-conflict rounded hover:bg-wt-conflict/30"
      >
        <Trash2 className="w-3.5 h-3.5" /> Delete local + remote
      </button>
    </div>
  );
}
