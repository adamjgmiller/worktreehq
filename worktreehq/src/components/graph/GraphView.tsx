import { useRepoStore } from '../../store/useRepoStore';
import { shortSha, relativeTime } from '../../lib/format';
import { EmptyState } from '../common/EmptyState';
import type { Branch } from '../../types';

function branchColor(b: Branch): string {
  switch (b.mergeStatus) {
    case 'squash-merged':
      return '#a855f7';
    case 'merged-normally':
      return '#3b82f6';
    case 'stale':
      return '#f59e0b';
    case 'unmerged':
    default:
      return '#10b981';
  }
}

export function GraphView() {
  const commits = useRepoStore((s) => s.mainCommits);
  const mappings = useRepoStore((s) => s.squashMappings);
  const branches = useRepoStore((s) => s.branches);
  const bySha = new Map(mappings.map((m) => [m.squashCommitSha, m]));
  const branchByName = new Map(branches.map((b) => [b.name, b]));

  if (commits.length === 0) {
    return <EmptyState title="No main history" />;
  }

  const lineX = 60;
  const topPad = 40;
  const rowH = 48;
  const height = topPad + commits.length * rowH + 20;

  return (
    <div className="p-6 overflow-auto h-full">
      <div className="text-xs text-neutral-500 uppercase tracking-wide mb-3">
        main (first-parent) · {commits.length} commits
      </div>
      <svg width="100%" height={height} className="font-mono">
        <line x1={lineX} y1={topPad} x2={lineX} y2={height - 20} stroke="#3f3f46" strokeWidth={2} />
        {commits.map((c, i) => {
          const y = topPad + i * rowH;
          const mapping = bySha.get(c.sha);
          const branch = mapping ? branchByName.get(mapping.sourceBranch) : undefined;
          const color = branch ? branchColor(branch) : mapping ? '#a855f7' : '#e5e7eb';
          return (
            <g key={c.sha}>
              <circle cx={lineX} cy={y} r={6} fill={color} stroke="#0a0a0b" strokeWidth={2} />
              {mapping && (
                <>
                  <line x1={lineX} y1={y} x2={lineX + 40} y2={y} stroke={color} strokeWidth={1.5} strokeDasharray="3 3" />
                  <circle cx={lineX + 44} cy={y} r={4} fill={color} />
                </>
              )}
              <text x={lineX + (mapping ? 60 : 20)} y={y + 4} fill="#e5e7eb" fontSize="12">
                <tspan fill="#71717a">{shortSha(c.sha)}</tspan>
                <tspan dx="8">{c.subject.length > 70 ? c.subject.slice(0, 70) + '…' : c.subject}</tspan>
              </text>
              <text x={lineX + (mapping ? 60 : 20)} y={y + 18} fill="#52525b" fontSize="10">
                {mapping ? `← ${mapping.sourceBranch} (PR #${mapping.prNumber}) · ` : ''}
                {relativeTime(c.date)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mt-6 flex gap-4 text-xs">
        <Legend color="#10b981" label="unmerged / active" />
        <Legend color="#a855f7" label="squash-merged" />
        <Legend color="#3b82f6" label="merged normally" />
        <Legend color="#f59e0b" label="stale" />
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-neutral-400">
      <span className="w-3 h-3 rounded-full" style={{ background: color }} />
      {label}
    </div>
  );
}
