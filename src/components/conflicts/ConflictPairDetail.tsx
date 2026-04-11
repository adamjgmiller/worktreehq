import { useState } from 'react';
import { ChevronRight, Circle } from 'lucide-react';
import clsx from 'clsx';
import type { WorktreePairOverlap, ConflictFile } from '../../types';

function severityDot(severity: ConflictFile['severity']) {
  if (severity === 'conflict') {
    return <Circle className="w-2.5 h-2.5 fill-wt-conflict text-wt-conflict flex-shrink-0" />;
  }
  return <Circle className="w-2.5 h-2.5 fill-wt-dirty text-wt-dirty flex-shrink-0" />;
}

function FileRow({ file }: { file: ConflictFile }) {
  const [expanded, setExpanded] = useState(false);
  const hasMarkers = !!file.conflictMarkers;

  return (
    <div className="border-b border-wt-border/40 last:border-b-0">
      <button
        onClick={() => hasMarkers && setExpanded(!expanded)}
        className={clsx(
          'w-full flex items-center gap-2 px-3 py-2 text-left text-sm',
          hasMarkers
            ? 'hover:bg-wt-border/20 cursor-pointer'
            : 'cursor-default',
        )}
        disabled={!hasMarkers}
      >
        {severityDot(file.severity)}
        <span className="font-mono text-xs text-neutral-200 truncate flex-1">
          {file.path}
        </span>
        {hasMarkers && (
          <ChevronRight
            className={clsx(
              'w-3.5 h-3.5 text-neutral-500 transition-transform',
              expanded && 'rotate-90',
            )}
          />
        )}
      </button>
      {expanded && file.conflictMarkers && (
        <pre className="px-4 py-3 mx-3 mb-2 rounded bg-wt-bg text-[0.6875rem] leading-relaxed font-mono text-neutral-300 overflow-x-auto max-h-64 overflow-y-auto border border-wt-border/40">
          {file.conflictMarkers}
        </pre>
      )}
    </div>
  );
}

export function ConflictPairDetail({ pair }: { pair: WorktreePairOverlap }) {
  const conflictFiles = pair.files.filter((f) => f.severity === 'conflict');
  const cleanFiles = pair.files.filter((f) => f.severity === 'clean');

  return (
    <div>
      <div className="mb-4">
        <h3 className="text-sm font-medium text-neutral-100 mb-1">
          <span className="font-mono">{pair.branchA}</span>
          <span className="text-neutral-500 mx-2">vs</span>
          <span className="font-mono">{pair.branchB}</span>
        </h3>
        <p className="text-xs text-neutral-500">
          {pair.files.length} shared file{pair.files.length !== 1 ? 's' : ''}
          {conflictFiles.length > 0 && (
            <span className="text-wt-conflict">
              {' '}&middot; {conflictFiles.length} with conflicts
            </span>
          )}
          {cleanFiles.length > 0 && (
            <span className="text-wt-dirty">
              {' '}&middot; {cleanFiles.length} clean
            </span>
          )}
        </p>
      </div>

      <div className="rounded-lg border border-wt-border overflow-hidden">
        {pair.files.map((file) => (
          <FileRow key={file.path} file={file} />
        ))}
      </div>
    </div>
  );
}
