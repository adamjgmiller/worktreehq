import clsx from 'clsx';
import { LayoutGrid, GitBranch, Archive, Network, FolderArchive } from 'lucide-react';

export type TabKey = 'worktrees' | 'branches' | 'squash' | 'graph' | 'archive';

type TabDef = { key: TabKey; label: string; icon: any; shortcut: string };

// The two groups split by importance. "Core" tabs are the daily-driver
// surfaces (worktrees + branches) and live on the left in their normal
// styling. "Auxiliary" tabs are occasional / rescue tools (squash
// archaeology, the graph view, the new archive) — they live on the right
// and render in a dimmer color so the eye is drawn to the core tabs first.
//
// The split is purely cosmetic; both groups behave identically (same role,
// same tabpanel wiring). If a tab graduates from auxiliary to core, just
// move it between these arrays.
const coreTabs: TabDef[] = [
  { key: 'worktrees', label: 'Worktrees', icon: LayoutGrid, shortcut: '1' },
  { key: 'branches', label: 'Branches', icon: GitBranch, shortcut: '2' },
];

const auxiliaryTabs: TabDef[] = [
  { key: 'squash', label: 'Squash Archaeology', icon: Archive, shortcut: '3' },
  { key: 'graph', label: 'Graph', icon: Network, shortcut: '4' },
  { key: 'archive', label: 'Worktree Archive', icon: FolderArchive, shortcut: '5' },
];

export function Tabs({ value, onChange }: { value: TabKey; onChange: (v: TabKey) => void }) {
  function renderTab(t: TabDef, auxiliary: boolean) {
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
        title={`${t.label} (${t.shortcut})`}
        onClick={() => onChange(t.key)}
        className={clsx(
          'flex items-center gap-2 px-4 py-3 text-sm border-b-2 -mb-px transition-colors',
          selected
            ? 'border-wt-info text-neutral-100'
            : auxiliary
            ? // Auxiliary unselected: dimmer baseline so the eye lands on
              // core tabs first. Hover restores them to a normal-secondary
              // brightness so the affordance is still obvious.
              'border-transparent text-neutral-600 hover:text-neutral-400'
            : 'border-transparent text-neutral-500 hover:text-neutral-300',
        )}
      >
        <Icon
          className={clsx('w-4 h-4', auxiliary && !selected && 'opacity-70')}
          aria-hidden="true"
        />
        {t.label}
      </button>
    );
  }

  return (
    <div
      role="tablist"
      className="flex gap-1 px-4 border-b border-wt-border bg-wt-panel"
    >
      {coreTabs.map((t) => renderTab(t, false))}
      {/* Spacer pushes the auxiliary group to the right edge of the bar. */}
      <div className="flex-1" />
      {auxiliaryTabs.map((t) => renderTab(t, true))}
    </div>
  );
}
