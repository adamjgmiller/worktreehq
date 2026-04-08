import type { Branch } from '../../types';
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
  const allSelected = branches.length > 0 && branches.every((b) => selection.has(b.name));
  return (
    <div className="overflow-auto">
      <table className="w-full text-left">
        <thead className="text-[0.625rem] uppercase tracking-wide text-neutral-500 bg-wt-bg sticky top-0">
          <tr>
            <th className="px-3 py-2 w-10">
              <input type="checkbox" checked={allSelected} onChange={onToggleAll} />
            </th>
            <th className="px-3 py-2">Branch</th>
            <th className="px-3 py-2">Where</th>
            <th className="px-3 py-2">Merge status</th>
            <th className="px-3 py-2">Vs main</th>
            <th className="px-3 py-2">PR</th>
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
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
