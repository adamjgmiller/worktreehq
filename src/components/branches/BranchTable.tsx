import type { Branch } from '../../types';
import { useRepoStore } from '../../store/useRepoStore';
import { useLiveTick } from '../../hooks/useLiveRelativeTime';
import { BranchRow } from './BranchRow';

export function BranchTable({
  branches,
  selection,
  onToggle,
  onToggleAll,
}: {
  branches: Branch[];
  selection: Set<string>;
  onToggle: (name: string) => void;
  onToggleAll: () => void;
}) {
  const authStatus = useRepoStore((s) => s.githubAuthStatus);
  // Subscribe to the shared 1-second tick once at the table level so the
  // `relativeTime(...)` calls inside each BranchRow pick up fresh Date.now()
  // on every tick. Calling the hook inside BranchRow would instead schedule
  // one React setState per row per tick — on a repo with a large branch
  // list, that's N independent re-renders per second while idle.
  useLiveTick();
  const authUnavailable = authStatus !== 'valid' && authStatus !== 'checking';
  const allSelected = branches.length > 0 && branches.every((b) => selection.has(b.name));
  return (
    <div className="overflow-auto">
      <table className="w-full text-left">
        <thead className="text-[0.625rem] uppercase tracking-wide text-wt-muted bg-wt-bg sticky top-0">
          <tr>
            <th className="px-3 py-2 w-10">
              <input type="checkbox" checked={allSelected} onChange={onToggleAll} />
            </th>
            <th className="px-3 py-2">Branch</th>
            <th className="px-3 py-2">Where</th>
            <th className="px-3 py-2">Merge status</th>
            <th className="px-3 py-2">Vs main</th>
            <th className="px-3 py-2">
              PR
              {authUnavailable && (
                <span className="ml-1 normal-case tracking-normal text-wt-dirty font-normal">
                  (no auth)
                </span>
              )}
            </th>
            <th className="px-3 py-2">Last commit</th>
          </tr>
        </thead>
        <tbody>
          {branches.map((b) => (
            <BranchRow
              key={b.name}
              branch={b}
              selected={selection.has(b.name)}
              onToggle={() => onToggle(b.name)}
              authStatus={authStatus}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
