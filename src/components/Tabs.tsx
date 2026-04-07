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
    <div className="flex gap-1 px-4 border-b border-wt-border bg-wt-panel">
      {tabs.map((t) => {
        const Icon = t.icon;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={clsx(
              'flex items-center gap-2 px-4 py-3 text-sm border-b-2 -mb-px transition-colors',
              value === t.key
                ? 'border-wt-info text-neutral-100'
                : 'border-transparent text-neutral-500 hover:text-neutral-300',
            )}
          >
            <Icon className="w-4 h-4" />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
