import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

// A small hover/focus tooltip with edge-flip placement. Replaces the native
// `title` attribute (which has a ~700ms delay and is easy to miss) and the
// ad-hoc CSS-group tooltip that was hand-rolled in WorktreeCard. Used by every
// non-obvious icon/badge so users can hover any visual without text and learn
// what it means.
//
// Design notes:
//   - Bubble is portaled to document.body and positioned with `position: fixed`
//     in viewport coordinates. This is essential because the WorktreesView
//     scroll container (`flex-1 overflow-auto`) creates a CSS clipping rect
//     for inline-positioned descendants — an absolutely-positioned tooltip
//     inside a card would be sliced by the scroll container's edges. Portaling
//     escapes the clipping ancestor entirely.
//   - The trigger is wrapped in a span (or div in `block` mode). React's
//     synthetic onFocus/onBlur bubble through the wrapper, so keyboard
//     discoverability comes for free without injecting props into the child.
//   - Two-pass positioning: first paint renders the bubble invisible at the
//     fallback location, useLayoutEffect measures it, then state update moves
//     it to the correct spot. useLayoutEffect runs before paint so users
//     never see the flash.
//   - Closes on scroll (capture phase, so it catches inner scroll containers)
//     and resize, because position: fixed doesn't follow the trigger if the
//     user scrolls or resizes while the tooltip is open.

type Side = 'top' | 'bottom';

interface Coords {
  top: number;
  left: number;
  ready: boolean;
}

interface TooltipProps {
  label: ReactNode;
  children: ReactNode;
  // Default side; flips automatically if it would clip.
  side?: Side;
  className?: string;
  // When true, the wrapper is a full-width block instead of inline-flex.
  // Use this when the trigger needs to fill its parent (e.g. a `truncate`
  // div that should ellipsize against the parent's width). Inline-flex
  // wrappers size to their content, which would let `truncate` overflow
  // because there's nothing to constrain it.
  block?: boolean;
}

const VIEWPORT_PAD = 8; // px gap between bubble and viewport edge
const TRIGGER_GAP = 6; // px between trigger and bubble

export function Tooltip({
  label,
  children,
  side = 'top',
  className,
  block = false,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<Coords>({ top: 0, left: 0, ready: false });
  const id = useId();

  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => {
    setOpen(false);
    setCoords({ top: 0, left: 0, ready: false });
  }, []);

  // Position computation runs after the bubble is in the DOM but before paint,
  // so the user never sees the unpositioned first frame.
  useLayoutEffect(() => {
    if (!open) return;
    const wrap = wrapRef.current;
    const bubble = bubbleRef.current;
    if (!wrap || !bubble) return;

    const trigger = wrap.getBoundingClientRect();
    const bRect = bubble.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Vertical: try preferred side; flip if it would clip the viewport.
    let top: number;
    if (side === 'top') {
      const wantTop = trigger.top - bRect.height - TRIGGER_GAP;
      top = wantTop < VIEWPORT_PAD ? trigger.bottom + TRIGGER_GAP : wantTop;
    } else {
      const wantTop = trigger.bottom + TRIGGER_GAP;
      top =
        wantTop + bRect.height > vh - VIEWPORT_PAD
          ? trigger.top - bRect.height - TRIGGER_GAP
          : wantTop;
    }

    // Horizontal: center under trigger, then clamp to viewport.
    const center = trigger.left + trigger.width / 2;
    let left = center - bRect.width / 2;
    if (left < VIEWPORT_PAD) left = VIEWPORT_PAD;
    else if (left + bRect.width > vw - VIEWPORT_PAD) {
      left = vw - bRect.width - VIEWPORT_PAD;
    }

    setCoords({ top, left, ready: true });
  }, [open, side, label]);

  // Close on scroll (capture phase so we catch inner scroll containers, not
  // just window scroll) and on resize. Without this, position: fixed leaves
  // the bubble stranded when the underlying card moves.
  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => hide();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, hide]);

  // `block` mode renders the wrapper as a div so it can fill its parent's
  // width — required for triggers that use `truncate` or otherwise need to
  // span the full row.
  const Wrapper = block ? 'div' : 'span';
  const wrapperClass = block
    ? `relative block min-w-0 ${className ?? ''}`
    : `relative inline-flex items-center ${className ?? ''}`;

  return (
    <Wrapper
      ref={wrapRef as any}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      aria-describedby={open ? id : undefined}
      className={wrapperClass}
    >
      {children}
      {open &&
        createPortal(
          <div
            ref={bubbleRef}
            id={id}
            role="tooltip"
            className="fixed z-50 whitespace-normal break-words bg-wt-panel border border-wt-border rounded px-2 py-1 shadow-lg text-[0.6875rem] leading-snug text-wt-fg pointer-events-none"
            style={{
              top: coords.top,
              left: coords.left,
              opacity: coords.ready ? 1 : 0,
              // Soft cap so a runaway label doesn't produce a viewport-wide
              // tooltip, but never wider than the viewport itself.
              maxWidth: 'min(28rem, calc(100vw - 1rem))',
            }}
          >
            {label}
          </div>,
          document.body,
        )}
    </Wrapper>
  );
}
