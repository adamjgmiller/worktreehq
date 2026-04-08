import clsx from 'clsx';
import { LayoutGrid, GitBranch, Archive, Network } from 'lucide-react';

export type TabKey = 'worktrees' | 'branches' | 'squash' | 'graph';

const tabs: Array<{ key: TabKey; label: string; icon: any }> = [
  { key: 'worktrees', label: 'Worktrees', icon: LayoutGrid },
  { key: 'branches', label: 'Branches', icon: GitBranch },
  { key: 'squash', label: 'Squash Archaeology', icon: Archive },
  { key: 'graph', label: 'Graph', icon: Network },
];

export function Tabs({ value, onChange }: { value: TabKey; onChange: (v: TabKey) => void }) {
  return (
    <div role="tablist" className="flex gap-1 px-4 border-b border-wt-border bg-wt-panel">
      {tabs.map((t) => {
        const Icon = t.icon;
        const selected = value === t.key;
        return (
          <button
            key={t.key}
            id={`tab-${t.key}`}
            role="tab"
            aria-selected={selected}
            aria-controls={`panel-${t.key}`}
            // Selected tab is in the tab order; unselected tabs are reachable
            // only by re-focusing the tablist. Full arrow-key navigation is
            // out of scope — this is the 80/20 for screen readers.
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.key)}
            className={clsx(
              'flex items-center gap-2 px-4 py-3 text-sm border-b-2 -mb-px transition-colors',
              selected
                ? 'border-wt-info text-neutral-100'
                : 'border-transparent text-neutral-500 hover:text-neutral-300',
            )}
          >
            <Icon className="w-4 h-4" aria-hidden="true" />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
