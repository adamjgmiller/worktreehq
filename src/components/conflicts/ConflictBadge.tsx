import { Swords } from 'lucide-react';
import { Tooltip } from '../common/Tooltip';

export function ConflictBadge({
  conflictCount,
  cleanOverlapCount,
}: {
  conflictCount: number;
  cleanOverlapCount: number;
}) {
  if (conflictCount === 0 && cleanOverlapCount === 0) return null;

  const hasConflicts = conflictCount > 0;
  const label = hasConflicts
    ? `${conflictCount} worktree${conflictCount !== 1 ? 's' : ''} with merge conflicts`
    : `${cleanOverlapCount} worktree${cleanOverlapCount !== 1 ? 's' : ''} editing same files (clean merge)`;

  return (
    <Tooltip label={label}>
      <span
        className={`inline-flex items-center mt-0.5 ${
          hasConflicts ? 'text-wt-conflict' : 'text-wt-dirty'
        }`}
      >
        <Swords className="w-4 h-4" />
        {hasConflicts && (
          <span className="ml-0.5 text-[0.625rem] font-bold leading-none">
            {conflictCount}
          </span>
        )}
      </span>
    </Tooltip>
  );
}
