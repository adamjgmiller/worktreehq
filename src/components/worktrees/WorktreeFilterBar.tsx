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
}: {
  value: WorktreePreset;
  onChange: (v: WorktreePreset) => void;
  search: string;
  onSearch: (s: string) => void;
}) {
  const active = presets.find((p) => p.key === value);
  return (
    <div className="border-b border-wt-border bg-wt-panel">
      <div className="flex items-center gap-3 p-4">
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
          placeholder="search worktrees, branches, or PRs…"
          className="ml-auto w-72 bg-wt-bg border border-wt-border rounded px-3 py-1.5 text-sm font-mono"
        />
      </div>
      {active?.description && (
        <div className="px-4 pb-3 text-xs text-wt-muted">{active.description}</div>
      )}
    </div>
  );
}
