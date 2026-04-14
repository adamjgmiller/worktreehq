import { useEffect, useState } from 'react';
import { relativeTime } from '../lib/format';

// Shared 1-second tick used by every `useLiveRelativeTime` consumer so the
// many "X ago" labels across the UI re-render together. A naive
// per-instance setInterval would work but schedule N independent timer
// callbacks and N separate React render passes per second once the grid
// and branch table are populated. One shared timer + a Set of subscribers
// keeps the cost flat as the number of call sites grows.
//
// The interval only exists while at least one component is subscribed;
// the last unsubscribe tears it down, so unmounting the last label stops
// the timer. This matters mostly in test environments where stray timers
// leak across runs.
const subscribers = new Set<() => void>();
let intervalId: number | null = null;

function ensureTicking(): void {
  if (intervalId !== null) return;
  intervalId = window.setInterval(() => {
    subscribers.forEach((fn) => fn());
  }, 1000);
}

function stopTickingIfIdle(): void {
  if (intervalId !== null && subscribers.size === 0) {
    window.clearInterval(intervalId);
    intervalId = null;
  }
}

// Subscribe to the shared tick without mapping to a specific timestamp.
// Use this when a component renders multiple `relativeTime()` strings in
// a loop (lists of commits, rows) — calling `useLiveRelativeTime` inside
// `.map()` would violate the Rules of Hooks because the number of hook
// calls would change with the list length. Calling `useLiveTick()` once
// at the top of the component still forces a re-render every second, and
// every inline `relativeTime()` call inside the render naturally picks up
// the fresh `Date.now()`.
export function useLiveTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    subscribers.add(fn);
    ensureTicking();
    return () => {
      subscribers.delete(fn);
      stopTickingIfIdle();
    };
  }, []);
}

// Returns `relativeTime(iso)` and forces a re-render once per second so the
// string ages visibly across unit boundaries (59s → 1m, 59m → 1h) without
// waiting for the next data refresh. `relativeTime` is pure, so we just
// drive React state changes on a shared clock and let the caller's render
// naturally recompute the label with `Date.now()` fresh.
export function useLiveRelativeTime(iso: string): string {
  useLiveTick();
  return relativeTime(iso);
}
