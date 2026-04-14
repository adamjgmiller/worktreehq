import clsx from 'clsx';
import type { FilterPreset } from '../../lib/filters';
import { useRepoStore } from '../../store/useRepoStore';
import { Tooltip } from '../common/Tooltip';

const presets: Array<{ key: FilterPreset; label: string; tip: string; description?: string }> = [
  { key: 'all', label: 'All', tip: 'Show every branch in the repo' },
  {
    key: 'safe-to-delete',
    label: 'Safe to delete',
    tip: 'Branches that have been merged or are empty and abandoned',
    description:
      'Showing branches that are merged (normal or squash), or empty with no worktree and older than 1 day. Select and bulk-delete to clean up.',
  },
  { key: 'empty', label: 'Empty', tip: 'Branches with no commits ahead of main and not checked out in any worktree' },
  { key: 'stale', label: 'Stale', tip: 'Unmerged branches with no commits in the last 30 days' },
  { key: 'active', label: 'Active', tip: 'Branches checked out in a worktree or with an open PR' },
  { key: 'orphaned', label: 'Orphaned', tip: 'Local branches whose upstream remote ref has been deleted' },
];

export function FilterBar({
  value,
  onChange,
  mine,
  onMineChange,
  search,
  onSearch,
}: {
  value: FilterPreset;
  onChange: (v: FilterPreset) => void;
  mine: boolean;
  onMineChange: (v: boolean) => void;
  search: string;
  onSearch: (s: string) => void;
}) {
  const authStatus = useRepoStore((s) => s.githubAuthStatus);
  const authUnavailable = authStatus !== 'valid' && authStatus !== 'checking';
  const active = presets.find((p) => p.key === value);
  const description = mine && active?.description
    ? `${active.description} Local empty branches are included since they have no meaningful author.`
    : mine
      ? 'Filtered by your git email. Local empty branches are included since they have no meaningful author — remote-only empty branches are hidden.'
      : active?.description;
  return (
    <div className="border-b border-wt-border bg-wt-panel">
      <div className="flex items-center gap-3 p-4">
        <div className="flex gap-1">
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
        <Tooltip label="Further filter to branches whose last commit matches your git email. Local empty branches are included since they have no meaningful author.">
          <label className="flex items-center gap-1.5 text-xs text-wt-fg-2 hover:text-wt-fg cursor-pointer select-none">
            <input
              type="checkbox"
              checked={mine}
              onChange={(e) => onMineChange(e.target.checked)}
              className="accent-wt-info"
            />
            Mine
          </label>
        </Tooltip>
        <input
          id="branch-search-input"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="search branches or PRs…"
          className="ml-auto w-56 bg-wt-bg border border-wt-border rounded px-3 py-1.5 text-sm font-mono"
        />
      </div>
      {description && (
        <div className="px-4 pb-3 text-xs text-wt-muted">
          {description}
        </div>
      )}
      {value === 'active' && authUnavailable && (
        <div className="px-4 pb-3 text-xs text-wt-dirty">
          Without GitHub auth, this filter only shows branches checked out in a worktree — branches with open PRs won't appear.{' '}
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('wthq:open-settings'))}
            className="underline hover:text-wt-info transition-colors"
          >
            Set up auth
          </button>
        </div>
      )}
    </div>
  );
}
