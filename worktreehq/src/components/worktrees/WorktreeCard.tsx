import { motion } from 'framer-motion';
import { FileEdit, GitCommit, Circle, AlertTriangle, Star } from 'lucide-react';
import type { Worktree } from '../../types';
import { worktreeStatusClass } from '../../lib/colors';
import { relativeTime, shortSha, aheadBehind } from '../../lib/format';

export function WorktreeCard({ wt }: { wt: Worktree }) {
  const statusIcon = {
    clean: <Circle className="w-4 h-4 text-wt-clean" fill="currentColor" />,
    dirty: <FileEdit className="w-4 h-4 text-wt-dirty" />,
    conflict: <AlertTriangle className="w-4 h-4 text-wt-conflict" />,
    diverged: <GitCommit className="w-4 h-4 text-wt-info" />,
  }[wt.status];

  return (
    <motion.div
      layout
      animate={{ opacity: 1 }}
      initial={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.2 }}
      className={`rounded-xl border-2 p-5 min-w-[300px] bg-wt-panel ${worktreeStatusClass(wt.status)}`}
    >
      <div className="flex items-center gap-2 mb-3">
        {statusIcon}
        <div className="font-mono text-sm text-neutral-100 truncate flex-1" title={wt.branch}>
          {wt.branch}
        </div>
        {wt.isPrimary && (
          <span title="primary worktree" className="text-wt-info">
            <Star className="w-4 h-4" fill="currentColor" />
          </span>
        )}
      </div>
      <div className="text-xs font-mono text-neutral-500 mb-4 truncate" title={wt.path}>
        {wt.path}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs mb-3">
        <Stat label="uncommitted" value={wt.uncommittedCount} />
        <Stat label="staged" value={wt.stagedCount} />
        <Stat label="ahead / behind" value={aheadBehind(wt.ahead, wt.behind)} />
        <Stat label="conflicts" value={wt.hasConflicts ? 'yes' : 'no'} />
      </div>
      <div className="text-xs text-neutral-400 border-t border-wt-border pt-3">
        <div className="truncate" title={wt.lastCommit.message}>
          <span className="font-mono text-neutral-500">{shortSha(wt.lastCommit.sha)}</span>{' '}
          {wt.lastCommit.message || '(no commits)'}
        </div>
        <div className="text-neutral-600 mt-1">
          {wt.lastCommit.author} · {relativeTime(wt.lastCommit.date)}
        </div>
      </div>
    </motion.div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-wt-bg/60 border border-wt-border rounded px-2 py-1.5">
      <div className="text-neutral-500 text-[10px] uppercase tracking-wide">{label}</div>
      <div className="font-mono text-neutral-100">{value}</div>
    </div>
  );
}
