import { useState } from 'react';
import { useRepoStore } from '../../store/useRepoStore';
import { SquashDetail } from './SquashDetail';
import { relativeTime, shortSha } from '../../lib/format';
import { EmptyState } from '../common/EmptyState';
import { Archive } from 'lucide-react';

export function SquashView() {
  const commits = useRepoStore((s) => s.mainCommits);
  const mappings = useRepoStore((s) => s.squashMappings);
  const tokenSet = useRepoStore((s) => s.githubTokenSet);
  const [selected, setSelected] = useState<string | null>(null);
  const mapBySha = new Map(mappings.map((m) => [m.squashCommitSha, m]));

  if (commits.length === 0) {
    return <EmptyState title="No main history yet" />;
  }
  const detail = selected ? mapBySha.get(selected) : null;

  return (
    <div className="flex h-full flex-col">
      {!tokenSet && (
        <div className="px-4 py-2 bg-wt-dirty/10 border-b border-wt-dirty/40 text-xs text-wt-dirty">
          No GitHub token configured — squash archaeology relies on PR metadata
          and will be empty for every commit. Add a token in Settings to enable
          squash detection.
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
      <div className="w-1/2 overflow-auto border-r border-wt-border">
        {commits.map((c) => {
          const m = mapBySha.get(c.sha);
          const active = selected === c.sha;
          return (
            <button
              key={c.sha}
              onClick={() => setSelected(c.sha)}
              className={`w-full text-left px-4 py-3 border-b border-wt-border hover:bg-wt-panel/60 ${
                active ? 'bg-wt-panel' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-neutral-500">{shortSha(c.sha)}</span>
                {m && (
                  <span className="flex items-center gap-1 text-[0.625rem] text-wt-squash">
                    <Archive className="w-3 h-3" /> squash
                  </span>
                )}
                {c.prNumber && (
                  <span className="text-[0.625rem] text-wt-info font-mono">#{c.prNumber}</span>
                )}
              </div>
              <div className="text-sm text-neutral-200 truncate">{c.subject}</div>
              <div className="text-[0.625rem] text-neutral-600">{relativeTime(c.date)}</div>
            </button>
          );
        })}
      </div>
      <div className="flex-1 overflow-auto">
        {detail ? (
          <SquashDetail mapping={detail} />
        ) : (
          <EmptyState title="Select a commit" hint="Click a squash commit to see archaeology." />
        )}
      </div>
      </div>
    </div>
  );
}
