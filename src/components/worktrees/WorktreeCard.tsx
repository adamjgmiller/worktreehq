import { memo, useEffect, useRef, useState } from 'react';
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
  FolderOpen,
  SquareTerminal,
} from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type {
  Branch,
  ClaudePresence,
  LastCommit,
  Worktree,
  InProgressOp,
  WorktreeConflictSummary,
} from '../../types';
import { worktreeStatusClass } from '../../lib/colors';
import { branchDisposition, type BranchDispositionAction } from '../../lib/branchDisposition';
import { relativeTime, shortSha, aheadBehind, basename } from '../../lib/format';
import { resumeCommand } from '../../services/claudeAwarenessService';
import { pullFastForward } from '../../services/gitService';
import { refreshOnce } from '../../services/refreshLoop';
import { readClaudeSessionFirstPrompt, shellOpen, openUrl } from '../../services/tauriBridge';
import { fileManagerLabel } from '../../lib/platform';
import { useRepoStore } from '../../store/useRepoStore';
import { Tooltip } from '../common/Tooltip';
import { Notepad } from './Notepad';
import { ConflictBadge } from '../conflicts/ConflictBadge';

const inProgressLabel: Record<InProgressOp, string> = {
  rebase: 'REBASE IN PROGRESS',
  merge: 'MERGE IN PROGRESS',
  'cherry-pick': 'CHERRY-PICK IN PROGRESS',
  revert: 'REVERT IN PROGRESS',
  bisect: 'BISECT IN PROGRESS',
};

// The card title doubles as a click-to-copy target for the full worktree path.
// Hover surfaces the path instantly via our Tooltip (which has no delay),
// click copies it. The tooltip label flips to "Copied!" for 1500ms after a
// successful write so the user gets feedback without a separate icon/button.
// Cursor is `cursor-copy` because click is the primary action — `cursor-help`
// would mislead ("hover for info") when click actually copies.
function CopyableTitle({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      window.prompt('Copy this path:', path);
      return;
    }
    setCopied(true);
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Tooltip
      block
      label={
        copied ? (
          <span>Copied!</span>
        ) : (
          <span className="font-mono break-all">{path}</span>
        )
      }
    >
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Copy worktree path"
        className="block w-full text-left font-mono text-sm text-wt-fg truncate cursor-copy hover:text-wt-fg-2 transition-colors"
      >
        {basename(path)}
      </button>
    </Tooltip>
  );
}

export interface WorktreeCardProps {
  wt: Worktree;
  // All per-card store data is prop-drilled from the parent so React.memo
  // can short-circuit re-renders for cards whose own data didn't move.
  // Reading these from the store per-card would fire on every refresh tick
  // because the store replaces the whole branches array / presence Map,
  // bypassing the memo shallow compare.
  branchInfo: Branch | undefined;
  presence: ClaudePresence | undefined;
  conflictSummary: WorktreeConflictSummary | undefined;
  defaultBranch: string;
  onRemove?: (wt: Worktree) => void;
  onPrune?: () => void;
  onPruneOrphan?: () => void;
  isDragging?: boolean;
  animateLayout?: boolean;
  isOverlay?: boolean;
}

function WorktreeCardInner({
  wt,
  branchInfo,
  presence,
  conflictSummary,
  defaultBranch,
  onRemove,
  onPrune,
  onPruneOrphan,
  isDragging,
  animateLayout,
  isOverlay,
}: WorktreeCardProps) {
  // Orphaned branch: bookkeeping survives but the directory doesn't. Branch
  // out before touching any live-card state — none of it would be meaningful
  // for a ghost, and most of the normal card render would either crash or
  // paint dishonest "all good" indicators (clean status, 0/0 ahead/behind,
  // green border via PR #16's merge-status logic). The OrphanedCard variant
  // uses the same outer shape so the transition between states stays smooth
  // when the user clicks Prune.
  if (wt.prunable) {
    return <OrphanedCard wt={wt} onPruneOrphan={onPruneOrphan} onRemove={onRemove} isDragging={isDragging} animateLayout={animateLayout} isOverlay={isOverlay} />;
  }
  const setError = useRepoStore((s) => s.setError);
  const authStatus = useRepoStore((s) => s.githubAuthStatus);
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
    branchInfo?.mergeStatus === 'squash-merged' ||
    branchInfo?.mergeStatus === 'direct-merged';
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
  const handleOpenInFileManager = async () => {
    setMenuOpen(false);
    setError(null);
    try {
      await shellOpen(wt.path, 'file_manager');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };
  const handleOpenInTerminal = async () => {
    setMenuOpen(false);
    setError(null);
    try {
      await shellOpen(wt.path, 'terminal');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };
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

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition: sortableTransition,
  } = useSortable({ id: wt.path, disabled: isOverlay });

  const sortableStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: sortableTransition ?? undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={sortableStyle}
      {...attributes}
      {...listeners}
      data-dnd-card
      role="group"
    >
    <motion.div
      layout={!!animateLayout && !isOverlay}
      animate={{ opacity: 1 }}
      initial={isOverlay ? false : { opacity: 0, y: 4 }}
      transition={{ duration: 0.15 }}
      className={clsx(
        'rounded-xl border-2 p-5 min-w-[18.75rem]',
        isDragging
          ? 'border-dashed border-wt-info/50 bg-wt-info/5'
          : `bg-wt-panel ${worktreeStatusClass(wt.status, branchInfo?.mergeStatus, isOnDefaultBranch)}`,
        isOverlay && 'shadow-2xl ring-2 ring-wt-info/40 bg-wt-panel',
      )}
    >
      <div className={isDragging ? 'invisible' : undefined}>
      <div className="flex items-start gap-2 mb-2">
        <Tooltip label={statusIconEntry.label}>
          <div className="mt-0.5">{statusIconEntry.icon}</div>
        </Tooltip>
        <div className="flex-1 min-w-0">
          {/*
            Worktree directory name owns the primary slot — this app is all
            about tracking worktrees, so the folder name is the first-class
            identifier. The branch follows one step down in size and luminance
            so both stay legible at a glance but the visual hierarchy matches
            the mental model (worktree = "where I am", branch = "what I'm
            working on"). Hovering surfaces the full path (instant tooltip);
            clicking copies it to the clipboard.
          */}
          <CopyableTitle path={wt.path} />
          <div
            className="font-mono text-xs text-wt-fg-2 mt-0.5 flex items-center gap-1 min-w-0"
            title={wt.branch}
          >
            <GitBranch className="w-3 h-3 flex-shrink-0" />
            <span className="truncate">{wt.branch}</span>
          </div>
          <div
            className="font-mono text-[0.6875rem] text-wt-muted truncate"
            title={wt.upstream ? `tracks ${wt.upstream}` : 'no upstream configured'}
          >
            {wt.upstream ? (
              <>
                <span className="text-wt-muted">↳ </span>
                {wt.upstream}
              </>
            ) : (
              <span className="text-wt-muted italic">↳ (no upstream)</span>
            )}
          </div>
        </div>
        {presence && (presence.status !== 'none' || presence.liveSessionCount > 0) && (
          <ClaudeBadge presence={presence} />
        )}
        {conflictSummary && (
          <ConflictBadge
            conflictCount={conflictSummary.conflictCount}
            cleanOverlapCount={conflictSummary.cleanOverlapCount}
          />
        )}
        {wt.isPrimary && (
          <Tooltip label="Primary worktree — the original repo checkout, cannot be removed">
            <span className="text-wt-info mt-0.5 inline-flex">
              <Star className="w-4 h-4" fill="currentColor" />
            </span>
          </Tooltip>
        )}
        {!isOverlay && (
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="p-1 -mt-0.5 rounded hover:bg-wt-border"
            aria-label="worktree actions"
          >
            <MoreVertical className="w-4 h-4 text-wt-fg-2" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 z-20 w-48 bg-wt-panel border border-wt-border rounded shadow-lg text-xs">
              <button
                type="button"
                onClick={handleOpenInFileManager}
                className="w-full text-left px-3 py-2 hover:bg-wt-border flex items-center gap-2"
              >
                <FolderOpen className="w-3.5 h-3.5 text-wt-fg-2" />
                {fileManagerLabel()}
              </button>
              <button
                type="button"
                onClick={handleOpenInTerminal}
                className="w-full text-left px-3 py-2 hover:bg-wt-border flex items-center gap-2 border-b border-wt-border"
              >
                <SquareTerminal className="w-3.5 h-3.5 text-wt-fg-2" />
                Open in Terminal
              </button>
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
      {disposition && (
        // Lifecycle row: composite disposition pill + optional inline action +
        // ahead-of-default + PR. Lives as a sibling of the title row (not a
        // child of the title block) so it can span the full card width — the
        // title block is constrained on its right by the icon cluster, which
        // would otherwise force this row to wrap prematurely. `ml-6` matches
        // the title block's left edge (status-icon w-4 + flex gap-2 = 24px)
        // so the pill visually aligns with the branch/upstream rows above.
        // Skips cleanly for detached HEADs (no disposition). The ahead-of-
        // default and PR badges still require a branchInfo entry — the
        // disposition can be present without one (default-branch worktree in
        // a fresh repo).
        <div className="ml-6 mb-2 flex items-center gap-1.5 flex-wrap">
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
              <span className="font-mono text-[0.625rem] text-wt-fg-2 cursor-help">
                {aheadBehind(branchInfo.aheadOfMain, branchInfo.behindMain)} vs{' '}
                {defaultBranch}
              </span>
            </Tooltip>
          )}
          {branchInfo?.pr ? (
            <button
              onClick={() => openUrl(branchInfo.pr!.url)}
              className="inline-flex items-center gap-0.5 text-[0.625rem] font-mono text-wt-info hover:underline"
              title={branchInfo.pr.title}
            >
              #{branchInfo.pr.number}
              <ExternalLink className="w-2.5 h-2.5" />
            </button>
          ) : !isOnDefaultBranch && branchInfo && authStatus !== 'valid' && authStatus !== 'checking' ? (
            <Tooltip label="PR status requires GitHub auth">
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('wthq:open-settings'))}
                className="text-[0.5625rem] text-wt-muted hover:text-wt-info transition-colors"
              >
                PR?
              </button>
            </Tooltip>
          ) : null}
        </div>
      )}
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
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-wt-border py-2 mb-0 font-mono text-[0.75rem] text-wt-fg">
        <StatInline label="untracked" value={wt.untrackedCount} />
        <StatInline label="modified" value={wt.modifiedCount} />
        <StatInline label="staged" value={wt.stagedCount} />
        <StatInline label="stashes" value={wt.stashCount} />
        <StatInline label="remote" value={aheadBehind(wt.ahead, wt.behind)} />
      </div>
      <LastCommitFooter lastCommit={wt.lastCommit} />
      <Notepad worktreePath={wt.path} />
      {presence && presence.inactiveSessions.length > 0 && (
        <PastSessionsList worktreePath={wt.path} sessions={presence.inactiveSessions} />
      )}
      </div>
    </motion.div>
    </div>
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
  isDragging,
  animateLayout,
  isOverlay,
}: {
  wt: Worktree;
  onPruneOrphan?: () => void;
  onRemove?: (wt: Worktree) => void;
  isDragging?: boolean;
  animateLayout?: boolean;
  isOverlay?: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition: sortableTransition,
  } = useSortable({ id: wt.path, disabled: isOverlay });

  const sortableStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: sortableTransition ?? undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={sortableStyle}
      {...attributes}
      {...listeners}
      data-dnd-card
      role="group"
    >
    <motion.div
      layout={!!animateLayout && !isOverlay}
      animate={{ opacity: 1 }}
      initial={isOverlay ? false : { opacity: 0, y: 4 }}
      transition={{ duration: 0.15 }}
      className={clsx(
        'rounded-xl border-2 p-5 min-w-[18.75rem]',
        isDragging
          ? 'border-dashed border-wt-info/50 bg-wt-info/5'
          : 'bg-wt-panel border-wt-dirty/70 bg-wt-dirty/5',
        isOverlay && 'shadow-2xl ring-2 ring-wt-info/40 bg-wt-panel',
      )}
    >
      <div className={isDragging ? 'invisible' : undefined}>
      <div className="flex items-start gap-2 mb-3">
        <Tooltip label="Orphaned — git's bookkeeping points at a directory that no longer exists">
          <div className="mt-0.5">
            <AlertTriangle className="w-4 h-4 text-wt-dirty" />
          </div>
        </Tooltip>
        <div className="flex-1 min-w-0">
          {/* Mirror the regular WorktreeCard hierarchy: basename primary,
              branch secondary. For an orphan this is even more load-bearing —
              the directory is gone, so the basename is the user's main cue
              for "which missing folder is this?". */}
          <CopyableTitle path={wt.path} />
          <div
            className="font-mono text-xs text-wt-fg-2 mt-0.5 flex items-center gap-1 min-w-0"
            title={wt.branch}
          >
            <GitBranch className="w-3 h-3 flex-shrink-0" />
            <span className="truncate">{wt.branch}</span>
          </div>
          <div className="font-mono text-[0.6875rem] text-wt-dirty uppercase tracking-wide mt-0.5">
            orphaned worktree
          </div>
        </div>
        {onRemove && (
          <Tooltip label="Remove the worktree entry from git's bookkeeping">
            <button
              onClick={() => onRemove(wt)}
              className="p-1 -mt-0.5 rounded hover:bg-wt-border"
              aria-label="remove orphaned worktree"
            >
              <MoreVertical className="w-4 h-4 text-wt-fg-2" />
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
      </div>
    </motion.div>
    </div>
  );
}

function StatInline({ label, value }: { label: string; value: number | string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-[0.625rem] tracking-tight text-wt-muted font-sans">{label}</span>
      {value}
    </span>
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
        className={`relative inline-flex items-center mt-0.5 ${colorClass} ${
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

// Default-collapsed last-commit footer. Mirrors the chevron-disclosure shape
// of `PastSessionsList` so the two collapsible card sections feel like
// siblings. Collapsed state shows only the relative commit time — that's the
// single highest-signal field for "is this worktree forgotten?" and earns
// its place in the tiny always-visible row. The full SHA, subject, and
// author are tucked behind the disclosure for the rare moments you actually
// want to identify the commit (detached HEAD diagnosis, post-rebase
// orientation, "did my last commit land?").
function LastCommitFooter({ lastCommit }: { lastCommit: LastCommit }) {
  const [open, setOpen] = useState(false);
  const when = relativeTime(lastCommit.date);
  return (
    <div className="border-t border-wt-border pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1 text-[0.6875rem] text-wt-muted hover:text-wt-fg-2 transition-colors"
        aria-expanded={open}
      >
        <ChevronRight
          className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <GitCommit className="w-3 h-3" />
        <span className="uppercase tracking-wide">last commit · {when}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            layout
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden mt-2 text-xs text-wt-fg-2"
          >
            <div className="truncate" title={lastCommit.message}>
              <span className="font-mono text-wt-muted">
                {shortSha(lastCommit.sha)}
              </span>{' '}
              {lastCommit.message || '(no commits)'}
            </div>
            <div className="text-wt-muted mt-1">
              {lastCommit.author ? `${lastCommit.author} · ${when}` : when}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Default-collapsed expandable list of Claude sessions previously opened in
// this worktree. Each row shows the first user prompt (truncated visually
// to fit, with the full ~200-char version on hover), the relative time, and
// a button that copies a `claude --resume <id>` command to the clipboard.
//
// First prompts are loaded lazily on expand and cached in component state:
// they're immutable per session id, so re-fetching on every collapse/expand
// would be wasted work. The undefined/null distinction in the cache map
// separates "not fetched yet" from "fetched, no qualifying prompt found",
// so a session that genuinely has no prompt doesn't keep retrying.
//
// We don't label this list "closed" because we can't *definitively* prove
// any individual session is closed — the running-process detection only
// tells us whether ANY claude is running in the worktree, and we attribute
// it to the most-recent JSONL. Sessions that fall into this list MAY have
// a long-idle process attached that we can't disambiguate.
//
// PROMPT_PREVIEW_MAX_CHARS matches notepadService's AUTOFILL_MAX_CHARS so
// the same first-prompt string powers both surfaces — the inline row uses
// CSS truncation for visual fit, the title attribute carries the full
// fetched value for the hover tooltip.
const PROMPT_PREVIEW_MAX_CHARS = 200;

function PastSessionsList({
  worktreePath,
  sessions,
}: {
  worktreePath: string;
  sessions: ClaudePresence['inactiveSessions'];
}) {
  const [open, setOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // undefined = not yet fetched, null = fetched but no qualifying prompt,
  // string = the fetched prompt. Keeping all three states in one map lets
  // the render decide whether to show a skeleton, a fallback, or the text
  // without firing duplicate IPCs.
  const [prompts, setPrompts] = useState<Map<string, string | null>>(new Map());

  useEffect(() => {
    if (!open) return;
    const missing = sessions.filter((s) => !prompts.has(s.sessionId));
    if (missing.length === 0) return;
    let cancelled = false;
    // Fire all fetches in parallel — bounded by the small number of past
    // sessions per worktree in practice, and the Rust side reads at most
    // 200 lines per JSONL so each call returns near-instantly.
    void Promise.all(
      missing.map(async (s) => {
        const value = await readClaudeSessionFirstPrompt(
          worktreePath,
          s.sessionId,
          PROMPT_PREVIEW_MAX_CHARS,
        );
        return [s.sessionId, value] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setPrompts((prev) => {
        const next = new Map(prev);
        for (const [id, value] of entries) {
          next.set(id, value);
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [open, sessions, worktreePath, prompts]);

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
          {sessions.length} Claude {sessions.length === 1 ? 'session' : 'sessions'}
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
            {sessions.map((s) => {
              const prompt = prompts.get(s.sessionId);
              const promptFetched = prompts.has(s.sessionId);
              // Tooltip label: full prompt if we have one, else fall back
              // to the session id so the hover tooltip is never empty.
              const tooltipLabel = prompt ?? s.sessionId;
              return (
                <li
                  key={s.sessionId}
                  className="flex items-center gap-2 text-[0.6875rem] text-wt-fg-2"
                >
                  <Tooltip label={tooltipLabel} block className="flex-1">
                    <span className="block truncate text-wt-fg-2">
                      {prompt
                        ? prompt
                        : promptFetched
                          ? <span className="text-wt-muted italic">no prompt</span>
                          : <span className="text-wt-muted-2">…</span>}
                    </span>
                  </Tooltip>
                  <span
                    className="flex-none text-wt-muted tabular-nums"
                    title={s.sessionId}
                  >
                    {relativeTime(s.lastActivity)}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopy(s.sessionId)}
                    title="Copy `claude --resume` command"
                    className="flex-none text-wt-muted hover:text-wt-claude-ide transition-colors"
                  >
                    {copiedId === s.sessionId ? (
                      <Check className="w-3 h-3" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                  </button>
                </li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

// Memoized export. Default shallow-prop equality is sufficient because the
// parent passes structurally-shared references (see src/lib/structuralShare.ts):
// a card whose own Worktree/Branch/ClaudePresence/WorktreeConflictSummary
// didn't change gets the exact same prop references across ticks and skips
// render entirely. Without the structural sharing upstream, the shallow
// compare would still see new references each tick and re-render anyway.
export const WorktreeCard = memo(WorktreeCardInner);
