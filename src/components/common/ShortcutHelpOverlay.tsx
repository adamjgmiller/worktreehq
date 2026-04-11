import { isMac } from '../../lib/platform';

const MOD = isMac ? '⌘' : 'Ctrl';

type ShortcutGroup = { title: string; items: { keys: string; desc: string }[] };

const groups: ShortcutGroup[] = [
  {
    title: 'Navigation',
    items: [
      { keys: '1 – 6', desc: 'Switch tabs (Worktrees, Conflicts, Branches, Squash, Graph, Archive)' },
      { keys: `Ctrl+Tab`, desc: 'Next recent repo' },
      { keys: `Ctrl+Shift+Tab`, desc: 'Previous recent repo' },
    ],
  },
  {
    title: 'Actions',
    items: [
      { keys: `${MOD}+R`, desc: 'Refresh (fetch + re-derive)' },
      { keys: `,  ${MOD}+,`, desc: 'Open settings' },
      { keys: 'N', desc: 'New worktree' },
      { keys: '/', desc: 'Focus branch search' },
    ],
  },
  {
    title: 'Branches tab',
    items: [
      { keys: `${MOD}+A`, desc: 'Select / deselect all' },
      { keys: 'Escape', desc: 'Clear search, then selection' },
    ],
  },
  {
    title: 'Other',
    items: [
      { keys: `${MOD}+ +/−/0`, desc: 'Zoom in / out / reset' },
      { keys: '?', desc: 'Toggle this help' },
    ],
  },
];

export function ShortcutHelpOverlay({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-wt-border bg-wt-panel shadow-xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-wt-border">
          <h2 className="text-sm font-semibold text-neutral-100">
            Keyboard shortcuts
          </h2>
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-200 text-lg leading-none"
            aria-label="close"
          >
            ×
          </button>
        </div>
        <div className="px-5 py-4 space-y-5 max-h-[70vh] overflow-y-auto">
          {groups.map((g) => (
            <div key={g.title}>
              <h3 className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2">
                {g.title}
              </h3>
              <dl className="space-y-1.5">
                {g.items.map((item) => (
                  <div key={item.keys} className="flex items-baseline gap-3">
                    <dt className="shrink-0 min-w-[8rem] text-right">
                      <kbd className="px-1.5 py-0.5 text-xs font-mono bg-wt-bg border border-wt-border rounded text-neutral-300">
                        {item.keys}
                      </kbd>
                    </dt>
                    <dd className="text-sm text-neutral-400">{item.desc}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
