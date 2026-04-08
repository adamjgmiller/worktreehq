import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
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
  ExternalLink,
  Trash2,
  ArrowDownToLine,
  Loader2,
} from 'lucide-react';
import type { ClaudePresence, Worktree, InProgressOp } from '../../types';
import { worktreeStatusClass } from '../../lib/colors';
import { branchDisposition, type BranchDispositionAction } from '../../lib/branchDisposition';
import { relativeTime, shortSha, aheadBehind } from '../../lib/format';
import { resumeCommand } from '../../services/claudeAwarenessService';
import { pullFastForward } from '../../services/gitService';
import { refreshOnce } from '../../services/refreshLoop';
import { useRepoStore } from '../../store/useRepoStore';
import { Tooltip } from '../common/Tooltip';
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
  onPruneOrphan,
}: {
  wt: Worktree;
  onRemove?: (wt: Worktree) => void;
  onPrune?: () => void;
  onPruneOrphan?: () => void;
}) {
  // Orphaned branch: bookkeeping survives but the directory doesn't. Branch
  // out before reading any per-worktree store state — none of it would be
  // meaningful for a ghost, and most of the normal card render would either
  // crash or paint dishonest "all good" indicators (clean status, 0/0
  // ahead/behind, green border via PR #16's merge-status logic). The
  // OrphanedCard variant uses the same outer motion shape so the layout
  // animation between states is smooth when the user clicks Prune.
  if (wt.prunable) {
    return <OrphanedCard wt={wt} onPruneOrphan={onPruneOrphan} onRemove={onRemove} />;
  }
  const presence = useRepoStore((s) => s.claudePresence.get(wt.path));
  // Join the worktree to its branch entry so we can render lifecycle state
  // (merge status, ahead-of-main, PR) on the card. The data already exists
  // in the store; the type split between Worktree (filesystem) and Branch
  // (lifecycle) just meant the WorktreeCard never read it. Detached HEADs
  // and main itself aren't in the branches list, so this can be undefined —
  // the badge row only renders when it's defined.
  const branchInfo = useRepoStore((s) =>
    s.branches.find((b) => b.name === wt.branch),
  );
  const defaultBranch = useRepoStore((s) => s.repo?.defaultBranch ?? 'main');
  const setError = useRepoStore((s) => s.setError);
  // Composite pill that respects BOTH the branch's commit-history merge
  // status and the worktree's filesystem state, and replaces the lineage
  // label entirely on the default branch with an "on main" hint that warns
  // about local work. See src/lib/branchDisposition.ts for the full mapping.
  const disposition = branchDisposition(branchInfo, wt, defaultBranch);
  // "Effectively merged" — used to drive both the green border and the
  // solid-vs-ring status icon. The primary worktree (and any worktree on
  // the default branch) is merged-by-definition; otherwise we trust the
  // squash detector's verdict on Branch.mergeStatus.
  const isOnDefaultBranch = wt.isPrimary || wt.branch === defaultBranch;
  const isMerged =
    isOnDefaultBranch ||
    branchInfo?.mergeStatus === 'merged-normally' ||
    branchInfo?.mergeStatus === 'squash-merged';
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Close the action menu on outside click or Escape. Without this the menu
  // sticks open until the user clicks the three-dot button again — and on
  // a screen with multiple cards, every card can have its menu open at once.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);
  // Solid-dot vs ring is the visual analogue of the new green semantic:
  // a solid green dot means "clean AND merged into main", a slate ring
  // means "clean but the work hasn't landed yet". The other three states
  // (dirty/conflict/diverged) are filesystem-urgent and don't change shape.
  const statusIconMap = {
    clean: isMerged
      ? {
          icon: <Circle className="w-4 h-4 text-wt-clean" fill="currentColor" />,
          label: isOnDefaultBranch
            ? 'Clean — on the default branch'
            : 'Clean and merged into main',
        }
      : {
          icon: <Circle className="w-4 h-4 text-wt-active" />,
          label: 'Clean — work not yet merged into main',
        },
    dirty: {
      icon: <FileEdit className="w-4 h-4 text-wt-dirty" />,
      label: 'Dirty — modified, staged, or untracked files present',
    },
    conflict: {
      icon: <AlertTriangle className="w-4 h-4 text-wt-conflict" />,
      label: 'Conflict — unresolved merge or rebase conflicts',
    },
    diverged: {
      icon: <GitCommit className="w-4 h-4 text-wt-info" />,
      label: 'Diverged — local and upstream have moved in different directions',
    },
  };
  const statusIconEntry = statusIconMap[wt.status];

  return (
    <motion.div
      layout
      animate={{ opacity: 1 }}
      initial={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.2 }}
      className={`rounded-xl border-2 p-5 min-w-[18.75rem] bg-wt-panel ${worktreeStatusClass(
        wt.status,
        branchInfo?.mergeStatus,
        isOnDefaultBranch,
      )}`}
    >
      <div className="flex items-start gap-2 mb-3">
        <Tooltip label={statusIconEntry.label}>
          <div className="mt-0.5">{statusIconEntry.icon}</div>
        </Tooltip>
        <div className="flex-1 min-w-0">
          <div className="font-mono text-sm text-neutral-100 truncate" title={wt.branch}>
            {wt.branch}
          </div>
          <div
            className="font-mono text-[0.6875rem] text-neutral-500 truncate"
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
          {disposition && (
            // Lifecycle row: composite disposition pill + optional inline
            // action + ahead-of-default + PR. Skips cleanly for detached
            // HEADs (no disposition). The ahead-of-default and PR badges
            // still require a branchInfo entry — the disposition can be
            // present without one (default-branch worktree in a fresh repo).
            <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
              <Tooltip label={disposition.tooltip}>
                <span
                  className={clsx(
                    'px-1.5 py-0.5 text-[0.5625rem] font-mono border rounded uppercase tracking-wide cursor-help',
                    disposition.className,
                  )}
                >
                  {disposition.label}
                </span>
              </Tooltip>
              {disposition.action && (
                <DispositionActionButton
                  action={disposition.action}
                  worktreePath={wt.path}
                  onError={setError}
                />
              )}
              {branchInfo && (branchInfo.aheadOfMain > 0 || branchInfo.behindMain > 0) && (
                <Tooltip
                  label={`${branchInfo.aheadOfMain} ahead, ${branchInfo.behindMain} behind ${defaultBranch}`}
                >
                  <span className="font-mono text-[0.625rem] text-neutral-400 cursor-help">
                    {aheadBehind(branchInfo.aheadOfMain, branchInfo.behindMain)} vs{' '}
                    {defaultBranch}
                  </span>
                </Tooltip>
              )}
              {branchInfo?.pr && (
                <a
                  href={branchInfo.pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-[0.625rem] font-mono text-wt-info hover:underline"
                  title={branchInfo.pr.title}
                >
                  #{branchInfo.pr.number}
                  <ExternalLink className="w-2.5 h-2.5" />
                </a>
              )}
            </div>
          )}
        </div>
        {presence && (presence.status !== 'none' || presence.liveSessionCount > 0) && (
          <ClaudeBadge presence={presence} />
        )}
        {wt.isPrimary && (
          <Tooltip label="Primary worktree — the original repo checkout, cannot be removed">
            <span className="text-wt-info mt-0.5 inline-flex">
              <Star className="w-4 h-4" fill="currentColor" />
            </span>
          </Tooltip>
        )}
        {(onRemove || onPrune) && (
          <div className="relative" ref={menuRef}>
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
        <Tooltip
          label={`A ${wt.inProgress} is partially completed in this worktree — finish or abort it before switching branches`}
        >
          <div className="mb-3 flex items-center gap-1.5 px-2 py-1 rounded border border-wt-conflict/60 bg-wt-conflict/10 text-wt-conflict text-[0.625rem] font-mono tracking-wider cursor-help">
            <AlertTriangle className="w-3 h-3" />
            {inProgressLabel[wt.inProgress]}
          </div>
        </Tooltip>
      )}
      <div className="mb-4">
        <Tooltip block label={<span className="font-mono break-all">{wt.path}</span>}>
          <div className="text-xs font-mono text-neutral-500 truncate cursor-help">
            {wt.path}
          </div>
        </Tooltip>
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
        <PastSessionsList worktreePath={wt.path} sessions={presence.inactiveSessions} />
      )}
      <Notepad worktreePath={wt.path} />
    </motion.div>
  );
}

// Orphaned variant: bookkeeping survives but the directory doesn't. Renders
// with an amber border + AlertTriangle so it's visually distinct from a tidy
// worktree (which would be the misleading default if we let the normal card
// render against a missing path). The "Prune this orphan" button bypasses
// git's 3h grace period via --expire=now because explicit user action should
// always win over the heuristic.
function OrphanedCard({
  wt,
  onPruneOrphan,
  onRemove,
}: {
  wt: Worktree;
  onPruneOrphan?: () => void;
  onRemove?: (wt: Worktree) => void;
}) {
  return (
    <motion.div
      layout
      animate={{ opacity: 1 }}
      initial={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.2 }}
      className="rounded-xl border-2 p-5 min-w-[18.75rem] bg-wt-panel border-wt-dirty/70 bg-wt-dirty/5"
    >
      <div className="flex items-start gap-2 mb-3">
        <Tooltip label="Orphaned — git's bookkeeping points at a directory that no longer exists">
          <div className="mt-0.5">
            <AlertTriangle className="w-4 h-4 text-wt-dirty" />
          </div>
        </Tooltip>
        <div className="flex-1 min-w-0">
          <div className="font-mono text-sm text-neutral-100 truncate" title={wt.branch}>
            {wt.branch}
          </div>
          <div className="font-mono text-[0.6875rem] text-wt-dirty uppercase tracking-wide mt-0.5">
            orphaned worktree
          </div>
        </div>
        {onRemove && (
          <Tooltip label="Remove the worktree entry from git's bookkeeping">
            <button
              onClick={() => onRemove(wt)}
              className="p-1 rounded hover:bg-wt-border"
              aria-label="remove orphaned worktree"
            >
              <MoreVertical className="w-4 h-4 text-neutral-400" />
            </button>
          </Tooltip>
        )}
      </div>
      <div className="mb-3 flex items-start gap-1.5 px-2 py-1.5 rounded border border-wt-dirty/60 bg-wt-dirty/10 text-wt-dirty text-[0.6875rem] font-mono">
        <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
        <div className="min-w-0">
          <div className="font-bold tracking-wider">DIRECTORY REMOVED</div>
          <div className="text-wt-dirty/80 mt-0.5 break-words">{wt.prunable}</div>
        </div>
      </div>
      <div className="mb-3">
        <Tooltip block label={<span className="font-mono break-all">{wt.path}</span>}>
          <div className="text-xs font-mono text-neutral-500 truncate cursor-help">
            {wt.path}
          </div>
        </Tooltip>
      </div>
      {onPruneOrphan && (
        <button
          onClick={onPruneOrphan}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs bg-wt-dirty/15 border border-wt-dirty/50 text-wt-dirty rounded hover:bg-wt-dirty/25"
          title="Run `git worktree prune --expire=now` to clean up this entry"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Prune this orphan
        </button>
      )}
    </motion.div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-wt-bg/60 border border-wt-border rounded px-2 py-1.5">
      <div className="text-neutral-500 text-[0.625rem] uppercase tracking-wide">{label}</div>
      <div className="font-mono text-neutral-100">{value}</div>
    </div>
  );
}

// Inline action button rendered next to the disposition pill when the
// disposition exposes one. Currently only kind === 'pull-default-branch'
// (fast-forward main from origin), but the discriminated-union shape leaves
// room for more without changing the call site. Errors surface via the
// store's setError; success triggers a user-initiated refresh so the new
// ahead/behind state is reflected immediately instead of waiting for the
// next polling tick.
function DispositionActionButton({
  action,
  worktreePath,
  onError,
}: {
  action: BranchDispositionAction;
  worktreePath: string;
  onError: (msg: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      if (action.kind === 'pull-default-branch') {
        await pullFastForward(worktreePath);
      }
      await refreshOnce({ userInitiated: true });
    } catch (e: any) {
      onError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Tooltip label={action.ariaLabel}>
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        aria-label={action.ariaLabel}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[0.5625rem] font-mono uppercase tracking-wide rounded border border-wt-info/40 bg-wt-info/10 text-wt-info hover:bg-wt-info/20 disabled:opacity-50 disabled:cursor-wait transition-colors"
      >
        {busy ? (
          <Loader2 className="w-2.5 h-2.5 animate-spin" />
        ) : (
          <ArrowDownToLine className="w-2.5 h-2.5" />
        )}
        {action.label}
      </button>
    </Tooltip>
  );
}

// Small colored sparkle badge indicating Claude Code presence. Tooltip carries
// the IDE name (if any), the activity status, and last-seen relative time.
//
// When ≥2 Claudes are live in the same worktree, the badge flips to an
// unmistakable orange + pulse + count. Two simultaneous Claudes can stomp on
// each other's edits because each one reads/edits/writes files independently
// with no awareness of the other — surfacing this is the whole point of the
// presence display.
function ClaudeBadge({ presence }: { presence: ClaudePresence }) {
  const isMultiLive = presence.liveSessionCount > 1;

  const colorClass = isMultiLive
    ? 'text-wt-claude-conflict'
    : ({
        'live-ide': 'text-wt-claude-ide',
        live: 'text-wt-claude-live',
        // Idle reuses the recent/amber color to convey "alive but not
        // currently working". Distinct from `recent` only in semantics:
        // recent = JSONL touched recently but no process detected;
        // idle = process running, JSONL not touched recently. The badge
        // tooltip is what tells them apart.
        idle: 'text-wt-claude-recent',
        recent: 'text-wt-claude-recent',
        dormant: 'text-wt-claude-dormant',
        none: 'text-wt-claude-dormant',
      }[presence.status]);

  const label = (() => {
    if (isMultiLive) {
      return (
        <span>
          <strong className="text-wt-claude-conflict">
            ⚠ {presence.liveSessionCount} Claude sessions live in this worktree
          </strong>
          <br />
          They can overwrite each other's edits — close all but one before
          continuing work.
        </span>
      );
    }
    const when = presence.lastActivity ? relativeTime(presence.lastActivity) : 'unknown';
    if (presence.status === 'live-ide') {
      return `Claude live in ${presence.ideName ?? 'IDE'} · ${when}`;
    }
    if (presence.status === 'live') return `Claude live · ${when}`;
    if (presence.status === 'idle') return `Claude idle (process running) · last activity ${when}`;
    if (presence.status === 'recent') return `Claude recent · ${when}`;
    return `Claude dormant · last active ${when}`;
  })();

  return (
    <Tooltip label={label}>
      <span
        className={`relative inline-flex items-center ${colorClass} ${
          isMultiLive ? 'animate-pulse' : ''
        }`}
      >
        <Sparkles className="w-4 h-4" />
        {isMultiLive && (
          <span className="ml-0.5 text-[0.625rem] font-bold leading-none">
            ×{presence.liveSessionCount}
          </span>
        )}
      </span>
    </Tooltip>
  );
}

// Default-collapsed expandable list of past Claude sessions for this
// worktree. Each row shows the session id (short) + relative time and a
// button that copies a `claude --resume <id>` command to the clipboard.
//
// Labeled "past" rather than "closed" because we can't *definitively* prove
// any individual session is closed — the running-process detection only
// tells us whether ANY claude is running in the worktree, and we attribute
// it to the most-recent JSONL. Sessions that fall into this list MAY have
// a long-idle process attached that we can't disambiguate.
function PastSessionsList({
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
        className="w-full flex items-center gap-1 text-[0.6875rem] text-wt-claude-dormant hover:text-wt-claude-recent transition-colors"
      >
        <ChevronRight
          className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <Sparkles className="w-3 h-3" />
        <span className="uppercase tracking-wide">
          {sessions.length} past Claude {sessions.length === 1 ? 'session' : 'sessions'}
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
                className="flex items-center gap-2 text-[0.6875rem] text-neutral-400"
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
