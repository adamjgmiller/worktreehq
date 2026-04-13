import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * Shared dialog/modal wrapper. Handles:
 * - Fixed overlay backdrop with click-to-dismiss
 * - Escape key to dismiss (blocked when `disabled`)
 * - ARIA dialog attributes
 * - Consistent panel styling
 *
 * Focus management is left to consumers — destructive dialogs should focus
 * Cancel via a local ref, creation dialogs can use autoFocus on an input.
 */
export function Dialog({
  open = true,
  onClose,
  disabled = false,
  width = 'w-[560px]',
  ariaLabelledBy,
  className,
  children,
}: {
  open?: boolean;
  onClose: () => void;
  /** When true, backdrop click and Escape are blocked (e.g. during submit). */
  disabled?: boolean;
  /** Tailwind width class for the panel. Defaults to `w-[560px]`. */
  width?: string;
  ariaLabelledBy?: string;
  /** Extra classes appended to the panel div. */
  className?: string;
  children: ReactNode;
}) {
  // Escape-to-close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !disabled) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, disabled]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby={ariaLabelledBy}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !disabled) onClose();
      }}
    >
      <div
        className={`bg-wt-panel border border-wt-border rounded-xl p-6 ${width}${className ? ` ${className}` : ''}`}
      >
        {children}
      </div>
    </div>
  );
}

/** Standard dialog header with title, optional icon, and close button. */
export function DialogHeader({
  title,
  icon,
  titleId,
  onClose,
  disabled,
  titleClassName,
}: {
  title: string;
  icon?: ReactNode;
  titleId?: string;
  onClose: () => void;
  disabled?: boolean;
  titleClassName?: string;
}) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className={`flex items-center gap-2 ${titleClassName ?? ''}`}>
        {icon}
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
      </div>
      <button onClick={onClose} disabled={disabled} aria-label="close">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

/** Standard dialog footer with right-aligned action buttons. */
export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="flex justify-end gap-2">{children}</div>;
}
