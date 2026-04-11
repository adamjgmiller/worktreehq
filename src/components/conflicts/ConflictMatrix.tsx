import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { GitBranch, AlertTriangle, Check, ChevronDown } from 'lucide-react';
import { Tooltip } from '../common/Tooltip';
import type { Worktree, WorktreePairOverlap } from '../../types';
import { basename } from '../../lib/format';

// ─── Pair row ──────────────────────────────────────────────────────────

function PairRow({
  pair,
  wtA,
  wtB,
  isSelected,
  onSelect,
  index,
}: {
  pair: WorktreePairOverlap;
  wtA: Worktree;
  wtB: Worktree;
  isSelected: boolean;
  onSelect: () => void;
  index: number;
}) {
  const isConflict = pair.severity === 'conflict';
  const conflictCount = pair.files.filter((f) => f.severity === 'conflict').length;
  const cleanCount = pair.files.filter((f) => f.severity === 'clean').length;

  return (
    <motion.button
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: index * 0.03 }}
      onClick={onSelect}
      className={clsx(
        'w-full text-left group relative',
        'rounded-lg border transition-all duration-150',
        isSelected
          ? isConflict
            ? 'border-wt-conflict/60 bg-wt-conflict/[0.08]'
            : 'border-wt-dirty/60 bg-wt-dirty/[0.08]'
          : 'border-wt-border hover:border-wt-muted bg-wt-panel/60 hover:bg-wt-panel',
      )}
    >
      {/* Severity accent — left edge stripe */}
      <div
        className={clsx(
          'absolute left-0 top-3 bottom-3 w-[3px] rounded-full transition-opacity',
          isConflict ? 'bg-wt-conflict' : 'bg-wt-dirty',
          isSelected ? 'opacity-100' : 'opacity-40 group-hover:opacity-70',
        )}
      />

      <div className="pl-4 pr-3 py-3">
        {/* Branch pair header */}
        <div className="flex items-center gap-2 mb-2">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <GitBranch className="w-3 h-3 text-wt-muted flex-shrink-0" />
            <span className="font-mono text-xs text-wt-fg truncate">
              {basename(wtA.path)}
            </span>
          </div>

          {/* Connection indicator */}
          <div className="flex items-center gap-1 flex-shrink-0 px-2">
            <div className={clsx(
              'h-px w-3',
              isConflict ? 'bg-wt-conflict/50' : 'bg-wt-dirty/50',
            )} />
            {isConflict ? (
              <AlertTriangle className="w-3 h-3 text-wt-conflict" />
            ) : (
              <Check className="w-3 h-3 text-wt-dirty" />
            )}
            <div className={clsx(
              'h-px w-3',
              isConflict ? 'bg-wt-conflict/50' : 'bg-wt-dirty/50',
            )} />
          </div>

          <div className="flex items-center gap-1.5 min-w-0 flex-1 justify-end">
            <span className="font-mono text-xs text-wt-fg truncate text-right">
              {basename(wtB.path)}
            </span>
            <GitBranch className="w-3 h-3 text-wt-muted flex-shrink-0" />
          </div>
        </div>

        {/* Stats row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {conflictCount > 0 && (
              <span className="flex items-center gap-1 text-[0.625rem] font-mono text-wt-conflict">
                <span className="w-1.5 h-1.5 rounded-full bg-wt-conflict" />
                {conflictCount} conflict{conflictCount !== 1 ? 's' : ''}
              </span>
            )}
            {cleanCount > 0 && (
              <span className="flex items-center gap-1 text-[0.625rem] font-mono text-wt-dirty">
                <span className="w-1.5 h-1.5 rounded-full bg-wt-dirty" />
                {cleanCount} clean overlap{cleanCount !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <ChevronDown
            className={clsx(
              'w-3.5 h-3.5 text-wt-muted transition-transform duration-150',
              isSelected && 'rotate-180 text-wt-fg-2',
            )}
          />
        </div>
      </div>
    </motion.button>
  );
}

// ─── Summary bar ───────────────────────────────────────────────────────

function SummaryBar({
  totalPairs,
  conflictPairs,
  cleanPairs,
  safePairs,
}: {
  totalPairs: number;
  conflictPairs: number;
  cleanPairs: number;
  safePairs: number;
}) {
  // Proportional segments
  const segments = [
    { count: conflictPairs, color: 'bg-wt-conflict', label: 'conflict' },
    { count: cleanPairs, color: 'bg-wt-dirty', label: 'clean overlap' },
    { count: safePairs, color: 'bg-wt-clean/40', label: 'no overlap' },
  ].filter((s) => s.count > 0);

  return (
    <div className="mb-5">
      {/* Proportion bar */}
      <div className="flex h-1.5 rounded-full overflow-hidden bg-wt-border/50 mb-2.5">
        {segments.map((seg) => (
          <Tooltip
            key={seg.label}
            label={`${seg.count} pair${seg.count !== 1 ? 's' : ''} — ${seg.label}`}
          >
            <div
              className={clsx('h-full transition-all duration-300', seg.color)}
              style={{ width: `${(seg.count / totalPairs) * 100}%` }}
            />
          </Tooltip>
        ))}
      </div>

      {/* Legend counts */}
      <div className="flex items-center gap-4 text-[0.625rem] font-mono text-wt-muted">
        {conflictPairs > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-wt-conflict" />
            <span className="text-wt-conflict">{conflictPairs}</span> conflict{conflictPairs !== 1 ? 's' : ''}
          </span>
        )}
        {cleanPairs > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-wt-dirty" />
            <span className="text-wt-dirty">{cleanPairs}</span> clean
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm bg-wt-clean/30 border border-wt-clean/30" />
          <span className="text-wt-clean">{safePairs}</span> clear
        </span>
        <span className="ml-auto text-wt-muted">
          {totalPairs} pair{totalPairs !== 1 ? 's' : ''} total
        </span>
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────

export function ConflictMatrix({
  worktrees,
  pairs,
  selected,
  onSelect,
}: {
  worktrees: Worktree[];
  pairs: WorktreePairOverlap[];
  selected: { a: string; b: string } | null;
  onSelect: (pair: { a: string; b: string } | null) => void;
}) {
  const [showClean, setShowClean] = useState(true);

  // Sort: conflicts first, then clean overlaps
  const interestingPairs = pairs
    .filter((p) => p.severity !== 'none')
    .sort((a, b) => {
      // Group by left branch so all pairs for the same worktree are together,
      // then severity (conflicts first), then right branch.
      const left = a.branchA.localeCompare(b.branchA);
      if (left !== 0) return left;
      if (a.severity !== b.severity) return a.severity === 'conflict' ? -1 : 1;
      return a.branchB.localeCompare(b.branchB);
    });

  const conflictPairs = pairs.filter((p) => p.severity === 'conflict');
  const cleanPairs = pairs.filter((p) => p.severity === 'clean');
  const safePairs = pairs.filter((p) => p.severity === 'none');

  const visiblePairs = showClean
    ? interestingPairs
    : interestingPairs.filter((p) => p.severity === 'conflict');

  // Build worktree lookup by branch
  const wtByBranch = new Map(worktrees.map((w) => [w.branch, w]));

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-medium text-wt-fg">
          Worktree Overlaps
        </h3>
        {cleanPairs.length > 0 && conflictPairs.length > 0 && (
          <button
            onClick={() => setShowClean(!showClean)}
            className="text-[0.625rem] font-mono text-wt-muted hover:text-wt-fg-2 transition-colors"
          >
            {showClean ? 'hide clean' : 'show clean'}
          </button>
        )}
      </div>

      {/* Summary proportion bar */}
      <SummaryBar
        totalPairs={pairs.length}
        conflictPairs={conflictPairs.length}
        cleanPairs={cleanPairs.length}
        safePairs={safePairs.length}
      />

      {/* Pair list */}
      <div className="flex-1 overflow-y-auto min-h-0 -mx-1 px-1">
        {visiblePairs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-wt-muted">
            <Check className="w-8 h-8 mb-2 text-wt-clean/50" />
            <span className="text-sm">No file overlap detected</span>
            <span className="text-xs text-wt-muted mt-1">
              {worktrees.length} worktrees checked, all clear
            </span>
          </div>
        ) : (
          <div className="space-y-2">
            <AnimatePresence mode="popLayout">
              {visiblePairs.map((pair, idx) => {
                const wtA = wtByBranch.get(pair.branchA);
                const wtB = wtByBranch.get(pair.branchB);
                if (!wtA || !wtB) return null;

                const isSelected =
                  selected &&
                  ((selected.a === pair.branchA && selected.b === pair.branchB) ||
                    (selected.a === pair.branchB && selected.b === pair.branchA));

                return (
                  <PairRow
                    key={`${pair.branchA}:${pair.branchB}`}
                    pair={pair}
                    wtA={wtA}
                    wtB={wtB}
                    isSelected={!!isSelected}
                    onSelect={() => {
                      if (isSelected) {
                        onSelect(null);
                      } else {
                        onSelect({ a: pair.branchA, b: pair.branchB });
                      }
                    }}
                    index={idx}
                  />
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}
