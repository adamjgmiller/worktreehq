import { Inbox } from 'lucide-react';

export function EmptyState({ title, hint, children }: { title: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center p-12 text-wt-muted">
      <Inbox className="w-10 h-10 mb-3" />
      <div className="text-lg font-medium text-wt-fg-2">{title}</div>
      {hint && <div className="text-sm mt-1">{hint}</div>}
      {children}
    </div>
  );
}
