import type { TabKey } from '../Tabs';

// Shimmer skeleton shown in the App.tsx content region while the current
// repo's first refresh hasn't landed (or after a repo switch, before the
// new repo's data arrives). The layouts deliberately mirror each tab's
// real DOM so the skeleton dissolves into actual content rather than
// jumping. The repo bar and tabs stay live above this so the user keeps
// the "which repo am I loading" context.
//
// Variants are picked by `tab` so that flipping tabs during the load
// keeps the skeleton coherent with whichever view is about to mount.
export function ContentSkeleton({ tab }: { tab: TabKey }) {
  switch (tab) {
    case 'worktrees':
      return <WorktreesSkeleton />;
    case 'branches':
      return <BranchesSkeleton />;
    case 'squash':
      return <SquashSkeleton />;
    case 'conflicts':
      return <ConflictsSkeleton />;
    case 'graph':
      return <GraphSkeleton />;
    default:
      return <WorktreesSkeleton />;
  }
}

// A single shimmering rectangle. Uses a gradient sweep over a base panel
// color rather than animate-pulse so the motion reads as "loading" rather
// than "broken". `relative overflow-hidden` clips the absolute child sweep
// to the block's rounded corners.
function Skel({ className = '' }: { className?: string }) {
  return (
    <div className={`relative overflow-hidden rounded bg-wt-panel ${className}`}>
      <div
        aria-hidden
        className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/5 to-transparent"
      />
    </div>
  );
}

// Mirrors WorktreesView: top button row, then a 20rem-track auto-fit grid
// of cards. Each placeholder card matches the rough information density of
// the real WorktreeCard (header, status pills, body lines, footer) so the
// pixel hand-off is as smooth as possible.
function WorktreesSkeleton() {
  // Six placeholders comfortably fill the typical viewport without scrolling.
  // The actual count doesn't matter — they're decorative — but six avoids a
  // sparse feel on widescreen monitors.
  const placeholders = Array.from({ length: 6 });
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-6 pt-4">
        <Skel className="h-7 w-32" />
      </div>
      <div className="flex-1 overflow-hidden">
        <div className="p-6 grid grid-cols-[repeat(auto-fit,minmax(20rem,1fr))] gap-5">
          {placeholders.map((_, i) => (
            <div
              key={i}
              className="rounded-lg border border-wt-border bg-wt-panel/40 p-4 space-y-3"
            >
              <div className="flex items-center justify-between">
                <Skel className="h-4 w-40" />
                <Skel className="h-3 w-12" />
              </div>
              <div className="flex items-center gap-2">
                <Skel className="h-5 w-16" />
                <Skel className="h-5 w-20" />
              </div>
              <Skel className="h-3 w-full" />
              <Skel className="h-3 w-5/6" />
              <Skel className="h-3 w-2/3" />
              <div className="flex items-center justify-between pt-2">
                <Skel className="h-3 w-24" />
                <Skel className="h-3 w-10" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Mirrors BranchesView: a top filter bar then a wide table. The header row
// matches the real <thead> column count so the visual rhythm of the rows
// settles in the same place once data lands.
function BranchesSkeleton() {
  const rows = Array.from({ length: 12 });
  return (
    <div className="flex flex-col h-full">
      {/* FilterBar stand-in */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-wt-border">
        <Skel className="h-7 w-20" />
        <Skel className="h-7 w-20" />
        <Skel className="h-7 w-20" />
        <Skel className="h-7 w-20" />
        <div className="flex-1" />
        <Skel className="h-7 w-48" />
      </div>
      <div className="flex-1 overflow-hidden">
        <div className="px-3 py-2 grid grid-cols-[2.5rem_2fr_1fr_1.5fr_1fr_1fr_1fr] gap-3 text-[0.625rem] uppercase tracking-wide text-wt-muted">
          <div />
          <div>Branch</div>
          <div>Where</div>
          <div>Merge status</div>
          <div>Vs main</div>
          <div>PR</div>
          <div>Last commit</div>
        </div>
        {rows.map((_, i) => (
          <div
            key={i}
            className="px-3 py-2.5 grid grid-cols-[2.5rem_2fr_1fr_1.5fr_1fr_1fr_1fr] gap-3 items-center border-b border-wt-border/60"
          >
            <Skel className="h-4 w-4" />
            <Skel className="h-3 w-4/5" />
            <Skel className="h-3 w-1/2" />
            <Skel className="h-3 w-3/5" />
            <Skel className="h-3 w-2/5" />
            <Skel className="h-3 w-2/3" />
            <Skel className="h-3 w-3/4" />
          </div>
        ))}
      </div>
    </div>
  );
}

// Mirrors SquashView's split pane: left list of commits, right detail pane.
// We don't bother shimmering the right pane content (it's empty in the real
// view until the user clicks something) — just leave it neutral.
function SquashSkeleton() {
  const items = Array.from({ length: 14 });
  return (
    <div className="flex h-full">
      <div className="w-1/2 overflow-hidden border-r border-wt-border">
        {items.map((_, i) => (
          <div key={i} className="px-4 py-3 border-b border-wt-border space-y-2">
            <div className="flex items-center gap-2">
              <Skel className="h-3 w-12" />
              <Skel className="h-3 w-14" />
              <Skel className="h-3 w-10" />
            </div>
            <Skel className="h-3 w-4/5" />
            <Skel className="h-2 w-20" />
          </div>
        ))}
      </div>
      <div className="flex-1" />
    </div>
  );
}

// Mirrors ConflictsView's split pane: left matrix, right detail.
function ConflictsSkeleton() {
  return (
    <div className="flex h-full">
      <div className="w-1/2 overflow-hidden border-r border-wt-border p-4">
        <Skel className="h-4 w-48 mb-4" />
        <div className="grid grid-cols-4 gap-2">
          {Array.from({ length: 16 }).map((_, i) => (
            <Skel key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
      <div className="flex-1 p-4">
        <Skel className="h-4 w-32 mb-3" />
        <Skel className="h-3 w-full mb-2" />
        <Skel className="h-3 w-5/6 mb-2" />
        <Skel className="h-3 w-2/3" />
      </div>
    </div>
  );
}

// Mirrors GraphView's first-parent commit line. We render plain divs rather
// than an SVG since the goal is just "something is being drawn here" — the
// real view paints in a single tick once data lands.
function GraphSkeleton() {
  const rows = Array.from({ length: 14 });
  return (
    <div className="p-6 h-full">
      <Skel className="h-3 w-72 mb-4" />
      <div className="relative pl-16">
        <div className="absolute left-[3.75rem] top-2 bottom-2 w-0.5 bg-wt-border" />
        {rows.map((_, i) => (
          <div key={i} className="relative flex items-center h-12 gap-4">
            <div className="absolute left-[-0.375rem] w-3 h-3 rounded-full bg-wt-panel border-2 border-wt-bg" />
            <div className="flex-1 space-y-1.5 pl-2">
              <Skel className="h-3 w-3/4" />
              <Skel className="h-2 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
