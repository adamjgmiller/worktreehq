import { Inbox } from 'lucide-react';

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center p-12 text-neutral-500">
      <Inbox className="w-10 h-10 mb-3" />
      <div className="text-lg font-medium text-neutral-300">{title}</div>
      {hint && <div className="text-sm mt-1">{hint}</div>}
    </div>
  );
}
