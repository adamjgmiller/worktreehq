import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { WorktreePreset } from '../../lib/worktreeFilters';
import { Tooltip } from '../common/Tooltip';

const presets: Array<{ key: WorktreePreset; label: string; tip: string; description?: string }> = [
  { key: 'all', label: 'All', tip: 'Show every worktree' },
  { key: 'dirty', label: 'Dirty', tip: 'Worktrees with modified, staged, or untracked files' },
  {
    key: 'conflict',
    label: 'Conflict',
    tip: 'Worktrees with unresolved merge/rebase/cherry-pick/revert state',
  },
  {
    key: 'empty',
    label: 'Empty',
    tip: 'Worktrees whose branch has no commits ahead of the default branch',
    description:
      'Showing worktrees whose branch has no commits ahead of main. Includes fresh worktrees that were never pushed.',
  },
  {
    key: 'merged',
    label: 'Merged',
    tip: 'Worktrees whose branch has been merged (normal, squash, or direct)',
  },
  {
    key: 'safe-to-remove',
    label: 'Safe to remove',
    tip: 'Clean worktrees on merged branches — bulk-remove to clean up',
    description:
      'Showing clean worktrees whose branch is merged. The primary worktree and worktrees on the default branch are excluded since they aren’t cleanup candidates.',
  },
  { key: 'stale', label: 'Stale', tip: 'Worktrees whose branch has had no commits in 30 days' },
  {
    key: 'orphaned',
    label: 'Orphaned',
    tip: 'Git’s bookkeeping points at a directory that no longer exists',
    description:
      'Showing orphaned worktrees. These can be pruned (not removed) to clear git’s stale bookkeeping.',
  },
];

export function WorktreeFilterBar({
  value,
  onChange,
  search,
  onSearch,
  leftActions,
  belowDescriptionExtra,
}: {
  value: WorktreePreset;
  onChange: (v: WorktreePreset) => void;
  search: string;
  onSearch: (s: string) => void;
  // Slot for parent-owned controls that should live on the same row as the
  // filter chips (New worktree, Sort menu). Kept as a render slot rather
  // than baked-in props so this component stays generic and the parent
  // controls keyboard shortcuts, click handlers, etc.
  leftActions?: ReactNode;
  // Optional secondary line under the active-filter description (e.g.,
  // "drag-to-reorder paused while filtered"). Same row as `description` so
  // they don't fight for vertical space when both apply.
  belowDescriptionExtra?: ReactNode;
}) {
  const active = presets.find((p) => p.key === value);
  return (
    <div className="border-b border-wt-border bg-wt-panel">
      {/* flex-wrap on the row keeps narrow windows readable: actions stay
          left, chips wrap onto a second line, search drops below as a third
          line (still ml-auto so it stays right-aligned within whatever line
          it lands on). */}
      <div className="flex items-center gap-3 p-4 flex-wrap">
        {leftActions && (
          <>
            <div className="flex items-center gap-2">{leftActions}</div>
            {/* Vertical divider visually separates actions from filter chips.
                Hidden on the wrap break so a wrapped chip row doesn't get a
                stray trailing divider above it. */}
            <div className="hidden sm:block h-6 w-px bg-wt-border" />
          </>
        )}
        <div className="flex gap-1 flex-wrap">
          {presets.map((p) => (
            <Tooltip key={p.key} label={p.tip}>
              <button
                onClick={() => onChange(p.key)}
                className={clsx(
                  'px-3 py-1.5 text-xs rounded-full border transition-colors',
                  value === p.key
                    ? 'border-wt-info bg-wt-info/15 text-wt-info'
                    : 'border-wt-border text-wt-fg-2 hover:text-wt-fg',
                )}
              >
                {p.label}
              </button>
            </Tooltip>
          ))}
        </div>
        <input
          id="worktree-search-input"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="search worktrees…"
          className="ml-auto w-64 bg-wt-bg border border-wt-border rounded px-3 py-1.5 text-sm font-mono"
        />
      </div>
      {(active?.description || belowDescriptionExtra) && (
        <div className="px-4 pb-3 text-xs text-wt-muted space-y-1">
          {active?.description && <div>{active.description}</div>}
          {belowDescriptionExtra && <div>{belowDescriptionExtra}</div>}
        </div>
      )}
    </div>
  );
}
