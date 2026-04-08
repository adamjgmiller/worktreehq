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
} from 'lucide-react';
import type { ClaudePresence, Worktree } from '../../types';
import { worktreeStatusClass } from '../../lib/colors';
import { relativeTime, shortSha, aheadBehind } from '../../lib/format';
import { resumeCommand } from '../../services/claudeAwarenessService';
import { useRepoStore } from '../../store/useRepoStore';
import { Notepad } from './Notepad';

export function WorktreeCard({ wt }: { wt: Worktree }) {
  const presence = useRepoStore((s) => s.claudePresence.get(wt.path));

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
        {presence && presence.status !== 'none' && <ClaudeBadge presence={presence} />}
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
