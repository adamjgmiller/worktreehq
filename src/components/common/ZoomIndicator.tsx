import { useEffect, useState } from 'react';

// Brief floating zoom-level badge that fades in on every zoom change and
// fades out 1.2s later. Discoverability for the +/-/0 keyboard shortcuts —
// otherwise users press a key, the layout shifts, and they wonder if it was
// supposed to do something more. Showing the actual percentage confirms the
// action and teaches the range simultaneously.
//
// `pulseKey` bumps every time the user changes zoom; the indicator binds to
// it so the same zoom level (e.g. multiple `0` resets) still re-shows.
export function ZoomIndicator({
  zoomLevel,
  pulseKey,
}: {
  zoomLevel: number;
  pulseKey: number;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Skip the very first render — fresh launches shouldn't flash a badge
    // before the user has touched anything.
    if (pulseKey === 0) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 1200);
    return () => clearTimeout(t);
  }, [pulseKey]);

  return (
    <div
      aria-live="polite"
      // Position is fixed in viewport — by design, NOT inside the zoom-scaled
      // root, so the indicator stays the same size at every zoom level. Uses
      // raw px units rather than rem for the same reason.
      className={`fixed bottom-6 right-6 z-50 px-3 py-1.5 rounded-full bg-wt-panel border border-wt-border shadow-lg text-sm font-mono text-neutral-200 transition-opacity duration-200 ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      style={{ fontSize: '13px' }}
    >
      {Math.round(zoomLevel * 100)}%
    </div>
  );
}
