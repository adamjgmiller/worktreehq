import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  Clock,
  GripVertical,
  Type,
  AlertCircle,
} from 'lucide-react';
import type { WorktreeSortMode } from '../../types';

interface Option {
  mode: WorktreeSortMode;
  label: string;
  hint: string;
  Icon: typeof Clock;
}

// Keep manual last so "the default you probably want" is the first thing the
// user's eye lands on. Icons are chosen to match what the mode *does*, not
// what the user is currently looking at.
const OPTIONS: Option[] = [
  {
    mode: 'recent',
    label: 'Recent activity',
    hint: 'Most recently touched first',
    Icon: Clock,
  },
  {
    mode: 'name',
    label: 'Worktree name',
    hint: 'Alphabetical by folder',
    Icon: Type,
  },
  {
    mode: 'status',
    label: 'Status',
    hint: 'Conflicts and dirty work first',
    Icon: AlertCircle,
  },
  {
    mode: 'manual',
    label: 'Manual',
    hint: 'Your drag arrangement',
    Icon: GripVertical,
  },
];

interface Props {
  mode: WorktreeSortMode;
  onChange: (mode: WorktreeSortMode) => void;
}

export function WorktreeSortMenu({ mode, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click + Escape. Mirrors RecentReposMenu's pattern so
  // the whole app's dropdowns dismiss the same way.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const activeLabel = OPTIONS.find((o) => o.mode === mode)?.label ?? 'Sort';

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Change sort order"
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-wt-panel border border-wt-border text-wt-fg-2 rounded hover:bg-wt-border"
      >
        <ArrowUpDown className="w-3.5 h-3.5" />
        <span>Sort: {activeLabel}</span>
        <ChevronDown
          className={`w-3 h-3 text-wt-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-full left-0 mt-1 z-30 min-w-[16rem] rounded-md border border-wt-border bg-wt-panel shadow-lg overflow-hidden"
        >
          <ul className="py-1">
            {OPTIONS.map(({ mode: optMode, label, hint, Icon }) => {
              const active = optMode === mode;
              return (
                <li key={optMode}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    onClick={() => {
                      onChange(optMode);
                      setOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-wt-border"
                  >
                    <Icon className="w-3.5 h-3.5 text-wt-fg-2 shrink-0" />
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-sm">{label}</span>
                      <span className="text-[10px] text-wt-muted">{hint}</span>
                    </div>
                    {active && (
                      <Check className="w-3.5 h-3.5 text-wt-clean shrink-0" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
