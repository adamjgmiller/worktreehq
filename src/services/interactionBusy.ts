// Tracks whether the user is actively interacting with the UI (scrolling or
// dragging/pointer-down). Refresh pipelines consult this before committing
// their results to the store so the render wave never lands in the same
// frame as a scroll event.
//
// Bypass semantics: user-initiated refreshes (button click, post-mutation)
// pass through immediately — they should feel instant regardless of whether
// the user also happens to be scrolling. Only background ticks defer.
//
// Starvation guard: if the user interacts continuously, we still commit
// after MAX_DEFER_MS so data can't go indefinitely stale.

const SCROLL_IDLE_MS = 150;
const MAX_DEFER_MS = 1500;

let busyUntil = 0;
let waiters: Array<() => void> = [];

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function bumpInteraction(idleMs: number = SCROLL_IDLE_MS): void {
  busyUntil = now() + idleMs;
}

export function isInteracting(): boolean {
  return now() < busyUntil;
}

// Await a quiet period: resolves as soon as the user stops interacting, or
// MAX_DEFER_MS has elapsed since the caller started waiting — whichever
// comes first.
export function waitForInteractionIdle(): Promise<void> {
  if (!isInteracting()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const start = now();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const idx = waiters.indexOf(tick);
      if (idx !== -1) waiters.splice(idx, 1);
      resolve();
    };
    const tick = () => {
      if (!isInteracting()) {
        finish();
        return;
      }
      if (now() - start >= MAX_DEFER_MS) {
        finish();
        return;
      }
      scheduleNextCheck();
    };
    const scheduleNextCheck = () => {
      const remainingIdle = Math.max(16, busyUntil - now() + 8);
      const remainingCap = Math.max(16, start + MAX_DEFER_MS - now());
      setTimeout(tick, Math.min(remainingIdle, remainingCap));
    };
    waiters.push(tick);
    scheduleNextCheck();
  });
}

// Wire DOM listeners that bump the busy timer. Call once from WorktreesView
// (or wherever the scroll container mounts) so the service doesn't need to
// reach into React internals. Returns a cleanup function.
export function attachInteractionListeners(
  scrollContainer: HTMLElement,
): () => void {
  const onScroll = () => bumpInteraction();
  const onPointerDown = () => bumpInteraction(400);
  const onPointerUp = () => bumpInteraction();
  // Passive listeners — we never preventDefault, and passive lets the
  // browser skip waiting for JS before scrolling.
  scrollContainer.addEventListener('scroll', onScroll, { passive: true });
  scrollContainer.addEventListener('pointerdown', onPointerDown, { passive: true });
  scrollContainer.addEventListener('pointerup', onPointerUp, { passive: true });
  return () => {
    scrollContainer.removeEventListener('scroll', onScroll);
    scrollContainer.removeEventListener('pointerdown', onPointerDown);
    scrollContainer.removeEventListener('pointerup', onPointerUp);
  };
}

// Test-only: reset module state so a failing test doesn't poison others.
export function _resetInteractionBusyForTests(): void {
  busyUntil = 0;
  waiters = [];
}
