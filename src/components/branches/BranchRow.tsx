import clsx from 'clsx';
import type { Branch } from '../../types';
import { mergeStatusClass, mergeStatusLabel } from '../../lib/colors';
import { relativeTime, aheadBehind, shortSha } from '../../lib/format';
import { HardDrive, Cloud, Briefcase, ExternalLink } from 'lucide-react';

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
          <a
            href={branch.pr.url}
            target="_blank"
            rel="noreferrer"
            className="text-wt-info hover:underline inline-flex items-center gap-1"
          >
            #{branch.pr.number}
            <ExternalLink className="w-3 h-3" />
          </a>
        ) : (
          <span className="text-neutral-600">—</span>
        )}
      </td>
      <td className="px-3 py-3 text-xs text-neutral-500">{relativeTime(branch.lastCommitDate)}</td>
    </tr>
  );
}
