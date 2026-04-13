import clsx from 'clsx';
import type { Branch, ChecksStatus, ReviewDecision } from '../../types';
import type { GithubAuthStatus } from '../../store/useRepoStore';
import { mergeStatusClass, mergeStatusLabel, mergeStatusTooltip } from '../../lib/colors';
import { relativeTime, aheadBehind, shortSha } from '../../lib/format';
import {
  HardDrive,
  Cloud,
  Briefcase,
  ExternalLink,
  Check,
  X as XIcon,
  Clock,
  MessageSquare,
  ThumbsUp,
} from 'lucide-react';
import { Tooltip } from '../common/Tooltip';

const checksStyles: Record<Exclude<ChecksStatus, 'none'>, { cls: string; label: string }> = {
  success: { cls: 'text-wt-clean', label: 'checks passing' },
  failure: { cls: 'text-wt-conflict', label: 'checks failing' },
  pending: { cls: 'text-wt-dirty', label: 'checks pending' },
};

function ChecksDot({ status }: { status: ChecksStatus }) {
  if (!status || status === 'none') return null;
  const s = checksStyles[status];
  return (
    <Tooltip label={s.label}>
      <span className={clsx('inline-block w-2 h-2 rounded-full', {
        'bg-wt-clean': status === 'success',
        'bg-wt-conflict': status === 'failure',
        'bg-wt-dirty': status === 'pending',
      })} />
    </Tooltip>
  );
}

function ReviewIcon({ decision }: { decision: ReviewDecision }) {
  if (!decision) return null;
  if (decision === 'approved') {
    return (
      <Tooltip label="PR approved">
        <span className="text-wt-clean inline-flex">
          <ThumbsUp className="w-3 h-3" />
        </span>
      </Tooltip>
    );
  }
  if (decision === 'changes_requested') {
    return (
      <Tooltip label="Changes requested by reviewer">
        <span className="text-wt-conflict inline-flex">
          <MessageSquare className="w-3 h-3" />
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip label="Review required — no review yet">
      <span className="text-wt-muted inline-flex">
        <Clock className="w-3 h-3" />
      </span>
    </Tooltip>
  );
}

function openSettings() {
  window.dispatchEvent(new CustomEvent('wthq:open-settings'));
}

export function BranchRow({
  branch,
  selected,
  onToggle,
  authStatus,
}: {
  branch: Branch;
  selected: boolean;
  onToggle: () => void;
  authStatus: GithubAuthStatus;
}) {
  const authUnavailable = authStatus !== 'valid' && authStatus !== 'checking';
  return (
    <tr className="border-b border-wt-border hover:bg-wt-panel/60">
      <td className="px-3 py-3">
        <input type="checkbox" checked={selected} onChange={onToggle} />
      </td>
      <td className="px-3 py-3 font-mono text-sm text-wt-fg">
        <div className="flex items-center gap-2">
          <span>{branch.name}</span>
          {branch.worktreePath && (
            <Tooltip
              label={
                <span>
                  Branch is checked out in a worktree:
                  <br />
                  <span className="font-mono">{branch.worktreePath}</span>
                </span>
              }
            >
              <span className="text-wt-info inline-flex">
                <Briefcase className="w-3.5 h-3.5" />
              </span>
            </Tooltip>
          )}
          {branch.mergeStatus === 'empty' && (
            <Tooltip label="Not checked out in any worktree — probably abandoned">
              <span className="text-wt-muted-2 text-[0.5625rem] font-mono">no worktree</span>
            </Tooltip>
          )}
        </div>
        <div className="text-[0.625rem] text-wt-muted font-mono">{shortSha(branch.lastCommitSha)}</div>
      </td>
      <td className="px-3 py-3">
        <div className="flex gap-1 text-[0.625rem] font-mono">
          {branch.hasLocal && (
            <Tooltip label="A local ref for this branch exists in this clone">
              <span className="px-1.5 py-0.5 border border-wt-border rounded flex items-center gap-1">
                <HardDrive className="w-3 h-3" /> local
              </span>
            </Tooltip>
          )}
          {branch.hasRemote && (
            <Tooltip label="A remote ref for this branch exists on origin">
              <span className="px-1.5 py-0.5 border border-wt-border rounded flex items-center gap-1">
                <Cloud className="w-3 h-3" /> remote
              </span>
            </Tooltip>
          )}
          {branch.upstreamGone && (
            <Tooltip label="Local branch tracks an upstream that no longer exists on origin">
              <span className="px-1.5 py-0.5 border border-wt-conflict/50 text-wt-conflict rounded">
                gone
              </span>
            </Tooltip>
          )}
        </div>
      </td>
      <td className="px-3 py-3">
        {(() => {
          const tooltip = mergeStatusTooltip(branch.mergeStatus);
          const pill = (
            <span
              className={clsx(
                'px-2 py-0.5 text-[0.625rem] font-mono border rounded',
                mergeStatusClass(branch.mergeStatus),
              )}
            >
              {mergeStatusLabel(branch.mergeStatus)}
            </span>
          );
          return tooltip ? <Tooltip label={tooltip}>{pill}</Tooltip> : pill;
        })()}
      </td>
      <td className="px-3 py-3 font-mono text-xs text-wt-fg-2">
        {aheadBehind(branch.aheadOfMain, branch.behindMain)}
      </td>
      <td className="px-3 py-3 text-xs">
        {branch.pr ? (
          <div className="flex items-center gap-2">
            <a
              href={branch.pr.url}
              target="_blank"
              rel="noreferrer"
              className="text-wt-info hover:underline inline-flex items-center gap-1"
            >
              #{branch.pr.number}
              <ExternalLink className="w-3 h-3" />
            </a>
            {branch.pr.isDraft && (
              <Tooltip label="Draft PR — not yet ready for review">
                <span className="px-1.5 py-0.5 text-[0.5625rem] font-mono border border-wt-border text-wt-fg-2 rounded uppercase">
                  draft
                </span>
              </Tooltip>
            )}
            <ChecksDot status={branch.pr.checksStatus ?? 'none'} />
            <ReviewIcon decision={branch.pr.reviewDecision ?? null} />
            {branch.pr.mergeable === false && (
              <Tooltip label="PR has merge conflicts with the base branch">
                <span className="text-wt-conflict inline-flex">
                  <XIcon className="w-3 h-3" />
                </span>
              </Tooltip>
            )}
            {branch.pr.mergeable === true && !branch.pr.isDraft && (
              <Tooltip label="PR is mergeable — no conflicts with base">
                <span className="text-wt-clean inline-flex">
                  <Check className="w-3 h-3" />
                </span>
              </Tooltip>
            )}
          </div>
        ) : authUnavailable ? (
          <Tooltip label="PR status requires GitHub auth">
            <button
              onClick={openSettings}
              className="text-wt-muted hover:text-wt-info text-[0.625rem] transition-colors"
            >
              set up auth
            </button>
          </Tooltip>
        ) : (
          <span className="text-wt-muted">—</span>
        )}
      </td>
      <td className="px-3 py-3 text-xs text-wt-muted">{relativeTime(branch.lastCommitDate)}</td>
    </tr>
  );
}
