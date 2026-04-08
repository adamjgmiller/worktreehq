import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FileEdit,
  GitCommit,
  Circle,
  AlertTriangle,
  Star,
  Sparkles,
  ChevronRight,
  Copy,
  Check,
  GitBranch,
  MoreVertical,
} from 'lucide-react';
import type { ClaudePresence, Worktree, InProgressOp } from '../../types';
import { worktreeStatusClass } from '../../lib/colors';
import { relativeTime, shortSha, aheadBehind } from '../../lib/format';
import { resumeCommand } from '../../services/claudeAwarenessService';
import { useRepoStore } from '../../store/useRepoStore';
import { Notepad } from './Notepad';

const inProgressLabel: Record<InProgressOp, string> = {
  rebase: 'REBASE IN PROGRESS',
  merge: 'MERGE IN PROGRESS',
  'cherry-pick': 'CHERRY-PICK IN PROGRESS',
  revert: 'REVERT IN PROGRESS',
  bisect: 'BISECT IN PROGRESS',
};

export function WorktreeCard({
  wt,
  onRemove,
  onPrune,
}: {
  wt: Worktree;
  onRemove?: (wt: Worktree) => void;
  onPrune?: () => void;
}) {
  const presence = useRepoStore((s) => s.claudePresence.get(wt.path));
  const [menuOpen, setMenuOpen] = useState(false);
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
      <div className="flex items-start gap-2 mb-3">
        <div className="mt-0.5">{statusIcon}</div>
        <div className="flex-1 min-w-0">
          <div className="font-mono text-sm text-neutral-100 truncate" title={wt.branch}>
            {wt.branch}
          </div>
          <div
            className="font-mono text-[11px] text-neutral-500 truncate"
            title={wt.upstream ? `tracks ${wt.upstream}` : 'no upstream configured'}
          >
            {wt.upstream ? (
              <>
                <span className="text-neutral-600">↳ </span>
                {wt.upstream}
              </>
            ) : (
              <span className="text-neutral-600 italic">↳ (no upstream)</span>
            )}
          </div>
        </div>
        {presence && presence.status !== 'none' && <ClaudeBadge presence={presence} />}
        {wt.isPrimary && (
          <span title="primary worktree" className="text-wt-info mt-0.5">
            <Star className="w-4 h-4" fill="currentColor" />
          </span>
        )}
        {(onRemove || onPrune) && (
          <div className="relative">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="p-1 rounded hover:bg-wt-border"
              aria-label="worktree actions"
            >
              <MoreVertical className="w-4 h-4 text-neutral-400" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 z-20 w-40 bg-wt-panel border border-wt-border rounded shadow-lg text-xs">
                {onRemove && (
                  <button
                    disabled={wt.isPrimary}
                    onClick={() => {
                      setMenuOpen(false);
                      onRemove(wt);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-wt-border disabled:opacity-40"
                    title={wt.isPrimary ? 'Cannot remove primary worktree' : ''}
                  >
                    Remove worktree
                  </button>
                )}
                {onPrune && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onPrune();
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-wt-border border-t border-wt-border"
                  >
                    Prune worktrees
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {wt.inProgress && (
        <div className="mb-3 flex items-center gap-1.5 px-2 py-1 rounded border border-wt-conflict/60 bg-wt-conflict/10 text-wt-conflict text-[10px] font-mono tracking-wider">
          <AlertTriangle className="w-3 h-3" />
          {inProgressLabel[wt.inProgress]}
        </div>
      )}
      <div className="relative group mb-4">
        <div
          className="text-xs font-mono text-neutral-500 truncate cursor-help"
          title={wt.path}
        >
          {wt.path}
        </div>
        <div
          className="hidden group-hover:block absolute bottom-full left-0 mb-1 z-10 max-w-[420px] bg-wt-panel border border-wt-border rounded px-2 py-1 shadow-lg text-xs font-mono text-neutral-200 break-all pointer-events-none"
          role="tooltip"
        >
          {wt.path}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs mb-3">
        <Stat label="untracked" value={wt.untrackedCount} />
        <Stat label="modified" value={wt.modifiedCount} />
        <Stat label="staged" value={wt.stagedCount} />
        <Stat label="stashes" value={wt.stashCount} />
        <Stat label="ahead / behind" value={aheadBehind(wt.ahead, wt.behind)} />
        <Stat label="conflicts" value={wt.hasConflicts ? 'yes' : 'no'} />
      </div>
      <div className="text-xs text-neutral-400 border-t border-wt-border pt-3">
        <div className="truncate" title={wt.lastCommit.message}>
          <span className="font-mono text-neutral-500">{shortSha(wt.lastCommit.sha)}</span>{' '}
          {wt.lastCommit.message || '(no commits)'}
        </div>
        <div className="text-neutral-600 mt-1 flex items-center gap-1">
          <GitBranch className="w-3 h-3" />
          {wt.lastCommit.author} · {relativeTime(wt.lastCommit.date)}
        </div>
      </div>
      {presence && presence.inactiveSessions.length > 0 && (
        <ClosedSessionsList worktreePath={wt.path} sessions={presence.inactiveSessions} />
      )}
      <Notepad worktreePath={wt.path} />
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

// Small colored sparkle badge indicating Claude Code presence. Tooltip carries
// the IDE name (if any), the activity status, and last-seen relative time.
function ClaudeBadge({ presence }: { presence: ClaudePresence }) {
  const colorClass = {
    'live-ide': 'text-wt-claude-ide',
    live: 'text-wt-claude-live',
    recent: 'text-wt-claude-recent',
    dormant: 'text-wt-claude-dormant',
    none: 'text-wt-claude-dormant',
  }[presence.status];

  const label = (() => {
    const when = presence.lastActivity ? relativeTime(presence.lastActivity) : 'unknown';
    if (presence.status === 'live-ide') {
      return `Claude live in ${presence.ideName ?? 'IDE'} · ${when}`;
    }
    if (presence.status === 'live') return `Claude live · ${when}`;
    if (presence.status === 'recent') return `Claude recent · ${when}`;
    return `Claude dormant · last active ${when}`;
  })();

  return (
    <span title={label} className={`inline-flex items-center ${colorClass}`}>
      <Sparkles className="w-4 h-4" />
    </span>
  );
}

// Default-collapsed expandable list of closed Claude sessions for this
// worktree. Each row shows the session id (short) + relative time and a
// button that copies a `claude --resume <id>` command to the clipboard.
function ClosedSessionsList({
  worktreePath,
  sessions,
}: {
  worktreePath: string;
  sessions: ClaudePresence['inactiveSessions'];
}) {
  const [open, setOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = async (sessionId: string) => {
    const cmd = resumeCommand(worktreePath, sessionId);
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedId(sessionId);
      setTimeout(() => setCopiedId((id) => (id === sessionId ? null : id)), 1500);
    } catch {
      // Clipboard API blocked — fall back to a prompt so the user can copy manually.
      window.prompt('Copy this command:', cmd);
    }
  };

  return (
    <div className="mt-3 border-t border-wt-border pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1 text-[11px] text-neutral-500 hover:text-neutral-300 transition-colors"
      >
        <ChevronRight
          className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="uppercase tracking-wide">
          {sessions.length} closed Claude {sessions.length === 1 ? 'session' : 'sessions'}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            layout
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden mt-1 space-y-1"
          >
            {sessions.map((s) => (
              <li
                key={s.sessionId}
                className="flex items-center gap-2 text-[11px] text-neutral-400"
              >
                <span className="font-mono text-neutral-500" title={s.sessionId}>
                  {s.sessionId.slice(0, 8)}
                </span>
                <span className="flex-1 truncate text-neutral-600">
                  {relativeTime(s.lastActivity)}
                </span>
                <button
                  type="button"
                  onClick={() => handleCopy(s.sessionId)}
                  title="Copy `claude --resume` command"
                  className="text-neutral-500 hover:text-wt-claude-ide transition-colors"
                >
                  {copiedId === s.sessionId ? (
                    <Check className="w-3 h-3" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
