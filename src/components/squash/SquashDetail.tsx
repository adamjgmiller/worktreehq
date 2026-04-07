import type { SquashMapping } from '../../types';
import { shortSha, relativeTime } from '../../lib/format';
import { GitCommit, GitBranch, Archive, ArrowRight } from 'lucide-react';

export function SquashDetail({ mapping }: { mapping: SquashMapping }) {
  return (
    <div className="p-6">
      <div className="text-xs text-neutral-500 uppercase tracking-wide mb-2">Squash archaeology</div>
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Badge icon={<GitCommit className="w-3.5 h-3.5" />} label={`main ${shortSha(mapping.squashCommitSha)}`} />
        <ArrowRight className="w-4 h-4 text-neutral-600" />
        <Badge icon={<Archive className="w-3.5 h-3.5" />} label={`PR #${mapping.prNumber}`} color="info" />
        <ArrowRight className="w-4 h-4 text-neutral-600" />
        <Badge icon={<GitBranch className="w-3.5 h-3.5" />} label={mapping.sourceBranch} color="squash" />
        {mapping.archiveTag && (
          <>
            <ArrowRight className="w-4 h-4 text-neutral-600" />
            <Badge icon={<Archive className="w-3.5 h-3.5" />} label={mapping.archiveTag} color="dirty" />
          </>
        )}
      </div>

      <div className="text-sm text-neutral-300 mb-2 font-mono">{mapping.squashSubject}</div>
      <div className="text-xs text-neutral-500 mb-6">{relativeTime(mapping.squashDate)}</div>

      <div className="text-xs text-neutral-500 uppercase tracking-wide mb-2">Original commits</div>
      {mapping.originalCommits && mapping.originalCommits.length > 0 ? (
        <ul className="space-y-1.5 font-mono text-xs">
          {mapping.originalCommits.map((c) => (
            <li key={c.sha} className="flex gap-3">
              <span className="text-neutral-600">{shortSha(c.sha)}</span>
              <span className="text-neutral-300 truncate">{c.message}</span>
              <span className="ml-auto text-neutral-600">{relativeTime(c.date)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-xs text-neutral-500">
          {mapping.archiveTag
            ? 'Tag exists but no commits resolvable.'
            : 'Branch deleted, no archive tag found — 0 commits resolvable.'}
        </div>
      )}
    </div>
  );
}

function Badge({
  icon,
  label,
  color = 'default',
}: {
  icon: React.ReactNode;
  label: string;
  color?: 'default' | 'info' | 'squash' | 'dirty';
}) {
  const cls =
    color === 'info'
      ? 'border-wt-info/50 text-wt-info bg-wt-info/10'
      : color === 'squash'
        ? 'border-wt-squash/50 text-wt-squash bg-wt-squash/10'
        : color === 'dirty'
          ? 'border-wt-dirty/50 text-wt-dirty bg-wt-dirty/10'
          : 'border-wt-border text-neutral-300';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border font-mono text-xs ${cls}`}>
      {icon}
      {label}
    </span>
  );
}
