import type { SquashMapping } from '../../types';
import { shortSha, relativeTime } from '../../lib/format';
import { useLiveTick } from '../../hooks/useLiveRelativeTime';
import { GitCommit, GitBranch, Archive, ArrowRight } from 'lucide-react';
import { Tooltip } from '../common/Tooltip';

export function SquashDetail({ mapping }: { mapping: SquashMapping }) {
  // Single tick drives both the top-level squashDate label and the
  // per-row `relativeTime(c.date)` in the original-commits list.
  useLiveTick();
  return (
    <div className="p-6">
      <div className="text-xs text-wt-muted uppercase tracking-wide mb-2">Squash archaeology</div>
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Tooltip label="The squash commit that landed on the default branch">
          <Badge
            icon={<GitCommit className="w-3.5 h-3.5" />}
            label={`main ${shortSha(mapping.squashCommitSha)}`}
          />
        </Tooltip>
        <ArrowRight className="w-4 h-4 text-wt-muted" />
        <Tooltip label="The pull request whose merge produced this squash commit">
          <Badge
            icon={<Archive className="w-3.5 h-3.5" />}
            label={`PR #${mapping.prNumber}`}
            color="info"
          />
        </Tooltip>
        <ArrowRight className="w-4 h-4 text-wt-muted" />
        <Tooltip label="The source branch the PR was opened from (now safe to delete)">
          <Badge
            icon={<GitBranch className="w-3.5 h-3.5" />}
            label={mapping.sourceBranch}
            color="squash"
          />
        </Tooltip>
        {mapping.archiveTag && (
          <>
            <ArrowRight className="w-4 h-4 text-wt-muted" />
            <Tooltip label="An archive/* tag preserving the original commits before the squash">
              <Badge
                icon={<Archive className="w-3.5 h-3.5" />}
                label={mapping.archiveTag}
                color="dirty"
              />
            </Tooltip>
          </>
        )}
      </div>

      <div className="text-sm text-wt-fg-2 mb-2 font-mono">{mapping.squashSubject}</div>
      <div className="text-xs text-wt-muted mb-6">{relativeTime(mapping.squashDate)}</div>

      <div className="text-xs text-wt-muted uppercase tracking-wide mb-2">Original commits</div>
      {mapping.originalCommits && mapping.originalCommits.length > 0 ? (
        <ul className="space-y-1.5 font-mono text-xs">
          {mapping.originalCommits.map((c) => (
            <li key={c.sha} className="flex gap-3">
              <span className="text-wt-muted">{shortSha(c.sha)}</span>
              <span className="text-wt-fg-2 truncate">{c.message}</span>
              <span className="ml-auto text-wt-muted">{relativeTime(c.date)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-xs text-wt-muted">
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
          : 'border-wt-border text-wt-fg-2';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border font-mono text-xs ${cls}`}>
      {icon}
      {label}
    </span>
  );
}
