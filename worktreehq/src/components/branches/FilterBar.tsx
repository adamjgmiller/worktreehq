import clsx from 'clsx';
import type { FilterPreset } from '../../lib/filters';

const presets: Array<{ key: FilterPreset; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'safe-to-delete', label: 'Safe to delete' },
  { key: 'stale', label: 'Stale' },
  { key: 'active', label: 'Active' },
  { key: 'orphaned', label: 'Orphaned' },
];

export function FilterBar({
  value,
  onChange,
  search,
  onSearch,
}: {
  value: FilterPreset;
  onChange: (v: FilterPreset) => void;
  search: string;
  onSearch: (s: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 p-4 border-b border-wt-border bg-wt-panel">
      <div className="flex gap-1">
        {presets.map((p) => (
          <button
            key={p.key}
            onClick={() => onChange(p.key)}
            className={clsx(
              'px-3 py-1.5 text-xs rounded-full border transition-colors',
              value === p.key
                ? 'border-wt-info bg-wt-info/15 text-wt-info'
                : 'border-wt-border text-neutral-400 hover:text-neutral-200',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      <input
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="search branches or PRs…"
        className="ml-auto w-72 bg-wt-bg border border-wt-border rounded px-3 py-1.5 text-sm font-mono"
      />
    </div>
  );
}
