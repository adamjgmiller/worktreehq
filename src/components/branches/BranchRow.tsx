import clsx from 'clsx';
import type { Branch, ChecksStatus, ReviewDecision } from '../../types';
import { mergeStatusClass, mergeStatusLabel } from '../../lib/colors';
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

const checksStyles: Record<Exclude<ChecksStatus, 'none'>, { cls: string; label: string }> = {
  success: { cls: 'text-wt-clean', label: 'checks passing' },
  failure: { cls: 'text-wt-conflict', label: 'checks failing' },
  pending: { cls: 'text-wt-dirty', label: 'checks pending' },
};

function ChecksDot({ status }: { status: ChecksStatus }) {
  if (!status || status === 'none') return null;
  const s = checksStyles[status];
  return (
    <span title={s.label} className={clsx('inline-block w-2 h-2 rounded-full', {
      'bg-wt-clean': status === 'success',
      'bg-wt-conflict': status === 'failure',
      'bg-wt-dirty': status === 'pending',
    })} />
  );
}

function ReviewIcon({ decision }: { decision: ReviewDecision }) {
  if (!decision) return null;
  if (decision === 'approved') {
    return (
      <span title="approved" className="text-wt-clean">
        <ThumbsUp className="w-3 h-3" />
      </span>
    );
  }
  if (decision === 'changes_requested') {
    return (
      <span title="changes requested" className="text-wt-conflict">
        <MessageSquare className="w-3 h-3" />
      </span>
    );
  }
  return (
    <span title="review required" className="text-neutral-500">
      <Clock className="w-3 h-3" />
    </span>
  );
}

export function BranchRow({
  branch,
  selected,
  onToggle,
}: {
  branch: Branch;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <tr className="border-b border-wt-border hover:bg-wt-panel/60">
      <td className="px-3 py-3">
        <input type="checkbox" checked={selected} onChange={onToggle} />
      </td>
      <td className="px-3 py-3 font-mono text-sm text-neutral-100">
        <div className="flex items-center gap-2">
          <span>{branch.name}</span>
          {branch.worktreePath && (
            <span title={branch.worktreePath} className="text-wt-info">
              <Briefcase className="w-3.5 h-3.5" />
            </span>
          )}
        </div>
        <div className="text-[10px] text-neutral-600 font-mono">{shortSha(branch.lastCommitSha)}</div>
      </td>
      <td className="px-3 py-3">
        <div className="flex gap-1 text-[10px] font-mono">
          {branch.hasLocal && (
            <span className="px-1.5 py-0.5 border border-wt-border rounded flex items-center gap-1">
              <HardDrive className="w-3 h-3" /> local
            </span>
          )}
          {branch.hasRemote && (
            <span className="px-1.5 py-0.5 border border-wt-border rounded flex items-center gap-1">
              <Cloud className="w-3 h-3" /> remote
            </span>
          )}
          {branch.upstreamGone && (
            <span className="px-1.5 py-0.5 border border-wt-conflict/50 text-wt-conflict rounded">
              gone
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-3">
        <span
          className={clsx(
            'px-2 py-0.5 text-[10px] font-mono border rounded',
            mergeStatusClass(branch.mergeStatus),
          )}
        >
          {mergeStatusLabel(branch.mergeStatus)}
        </span>
      </td>
      <td className="px-3 py-3 font-mono text-xs text-neutral-400">
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
              <span
                title="draft"
                className="px-1.5 py-0.5 text-[9px] font-mono border border-neutral-600 text-neutral-400 rounded uppercase"
              >
                draft
              </span>
            )}
            <ChecksDot status={branch.pr.checksStatus ?? 'none'} />
            <ReviewIcon decision={branch.pr.reviewDecision ?? null} />
            {branch.pr.mergeable === false && (
              <span title="conflicts with base" className="text-wt-conflict">
                <XIcon className="w-3 h-3" />
              </span>
            )}
            {branch.pr.mergeable === true && !branch.pr.isDraft && (
              <span title="mergeable" className="text-wt-clean">
                <Check className="w-3 h-3" />
              </span>
            )}
          </div>
        ) : (
          <span className="text-neutral-600">—</span>
        )}
      </td>
      <td className="px-3 py-3 text-xs text-neutral-500">{relativeTime(branch.lastCommitDate)}</td>
    </tr>
  );
}
