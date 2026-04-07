import { AlertTriangle } from 'lucide-react';

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div className="flex items-start gap-3 p-4 rounded-lg border border-wt-conflict/50 bg-wt-conflict/10 text-wt-conflict">
      <AlertTriangle className="w-5 h-5 mt-0.5 flex-shrink-0" />
      <div className="flex-1 font-mono text-sm">{message}</div>
      {onDismiss && (
        <button onClick={onDismiss} className="text-xs underline hover:no-underline">
          dismiss
        </button>
      )}
    </div>
  );
}
