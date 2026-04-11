import { useEffect, useState } from 'react';
import { Tabs, type TabKey } from './components/Tabs';
import { RepoBar } from './components/RepoBar';
import { WorktreesView } from './components/worktrees/WorktreesView';
import { ConflictsView } from './components/conflicts/ConflictsView';
import { BranchesView } from './components/branches/BranchesView';
import { SquashView } from './components/squash/SquashView';
import { GraphView } from './components/graph/GraphView';
import { WorktreeArchiveView } from './components/archive/WorktreeArchiveView';
import { ErrorBanner } from './components/common/ErrorBanner';
import { ContentSkeleton } from './components/common/ContentSkeleton';
import { SettingsModal } from './components/common/SettingsModal';
import { ZoomIndicator } from './components/common/ZoomIndicator';
import { ShortcutHelpOverlay } from './components/common/ShortcutHelpOverlay';
import {
  useRepoStore,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
} from './store/useRepoStore';
import { useRepoBootstrap } from './hooks/useRepoBootstrap';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useTheme } from './hooks/useTheme';
import { pickAndLoadRepo } from './services/repoSelect';
import { invoke } from './services/tauriBridge';

// Persist zoom to config.toml so it survives restarts. Best-effort: a failed
// write doesn't roll back the in-memory zoom — the keystroke still feels
// responsive and the next save will retry. We read+merge the existing config
// (rather than reconstructing it from store state) because the github_token
// is not held in the Zustand store, only the boolean `githubTokenSet`. A
// fresh write_config without merging would silently wipe the user's token.
async function persistZoom(level: number) {
  try {
    const cfg = await invoke<Record<string, unknown>>('read_config');
    await invoke('write_config', {
      cfg: { ...cfg, zoom_level: level },
    });
  } catch {
    /* zoom is a UX nicety; persistence failure shouldn't disrupt anything */
  }
}

export default function App() {
  const [tab, setTab] = useState<TabKey>('worktrees');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const repo = useRepoStore((s) => s.repo);
  const error = useRepoStore((s) => s.error);
  const tokenSet = useRepoStore((s) => s.githubTokenSet);
  const dataRepoPath = useRepoStore((s) => s.dataRepoPath);
  const setError = useRepoStore((s) => s.setError);
  const zoomLevel = useRepoStore((s) => s.zoomLevel);
  const setZoomLevel = useRepoStore((s) => s.setZoomLevel);
  // Indicator pulse: bumped on every successful zoom change so the
  // ZoomIndicator can re-show itself. Starts at 0 so the indicator skips
  // its first render (no flash on launch).
  const [zoomTick, setZoomTick] = useState(0);
  useRepoBootstrap();
  useTheme();
  useKeyboardShortcuts({
    tab,
    setTab,
    settingsOpen,
    setSettingsOpen,
    helpOpen,
    setHelpOpen,
  });

  // Global zoom keyboard shortcuts. Cmd/Ctrl + +/-/0 are the universal
  // browser-style bindings; we also accept the bare keys (when no input is
  // focused) as a power-user affordance. Range and step come from the store.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Bail if the user is typing in a text field — bare +/- should not zoom
      // while editing a notepad or token input. Modifier-prefixed shortcuts
      // are still honored everywhere.
      const target = e.target as HTMLElement | null;
      const inEditable =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          (target as HTMLElement).isContentEditable);
      const mod = e.metaKey || e.ctrlKey;

      // `=` is the unshifted key on the `+` button on US keyboards. Honor
      // both `+` and `=` so the shortcut works whether or not the user is
      // also pressing Shift.
      const isPlus = e.key === '+' || e.key === '=';
      const isMinus = e.key === '-' || e.key === '_';
      const isZero = e.key === '0';

      // Only act on the relevant keys to avoid intercepting other shortcuts.
      if (!isPlus && !isMinus && !isZero) return;
      // Bare keys are blocked when typing; modifier-prefixed are not.
      if (!mod && inEditable) return;
      // Ignore Cmd+0 etc. with extra modifiers we don't intend (Shift+Cmd+0 etc.)
      if (e.altKey) return;

      const current = useRepoStore.getState().zoomLevel;
      let next = current;
      if (isPlus) next = Math.min(ZOOM_MAX, current + ZOOM_STEP);
      else if (isMinus) next = Math.max(ZOOM_MIN, current - ZOOM_STEP);
      else if (isZero) next = ZOOM_DEFAULT;

      if (next === current) {
        // Hit the rail — still preventDefault so the browser/Tauri doesn't
        // also try to zoom the WebView itself.
        e.preventDefault();
        return;
      }
      e.preventDefault();
      setZoomLevel(next);
      setZoomTick((t) => t + 1);
      void persistZoom(useRepoStore.getState().zoomLevel);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setZoomLevel]);

  // Apply zoom by mutating the root <html> font-size. This is the load-bearing
  // detail: rem units in CSS are relative to the ROOT element (`<html>`), not
  // to whatever ancestor you set font-size on. An earlier attempt set font-size
  // on the App root div and only un-classed text scaled — every Tailwind
  // text-sm/text-xs/etc. kept computing against html (16px) and stayed put.
  // Setting documentElement.style.fontSize is what actually moves the rem
  // baseline so the whole rem-based UI scales together.
  useEffect(() => {
    document.documentElement.style.fontSize = `${zoomLevel * 16}px`;
  }, [zoomLevel]);

  // When the bootstrap can't resolve a repo (last_repo_path moved/deleted)
  // there's no in-app way to recover without editing config.toml. Show a
  // dedicated picker affordance alongside the error banner.
  const showRepoPicker = !repo && !!error;

  // Content region gating. `dataReady` is the only honest answer to "is the
  // store's data coherent with the current repo?" — set inside refreshLoop
  // only on a successful pipeline. The view tree is rendered ONLY when this
  // is true; everything else falls back to the shimmer or to nothing.
  //
  // Skeleton is suppressed when the picker is up so the recovery affordance
  // gets the floor instead of competing with a loading state for a repo
  // that doesn't exist yet.
  //
  // The token banner is also gated on dataReady so it doesn't pop above the
  // shimmer during the loading window — for users without a token it should
  // appear once content is visible, not while content is still painting.
  const dataReady = !!repo && dataRepoPath === repo.path;
  const showContentSkeleton = !dataReady && !showRepoPicker;

  return (
    <div className="h-screen flex flex-col bg-wt-bg text-wt-fg">
      <RepoBar onSettings={() => setSettingsOpen(true)} />
      <Tabs value={tab} onChange={setTab} />
      {error && (
        <div className="p-4 space-y-2">
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
          {showRepoPicker && (
            <div className="text-xs text-wt-fg-2">
              <button
                onClick={() => void pickAndLoadRepo()}
                className="px-3 py-1.5 bg-wt-info/20 border border-wt-info/50 text-wt-info rounded hover:bg-wt-info/30"
              >
                Pick a repository…
              </button>
              <span className="ml-3">
                Choose another git repository to load.
              </span>
            </div>
          )}
        </div>
      )}
      {dataReady && !tokenSet && !error && (
        <div className="px-6 pt-4 text-xs text-wt-dirty">
          No GitHub token configured — squash-merge detection from PRs will be limited.{' '}
          <button onClick={() => setSettingsOpen(true)} className="underline">
            Set one
          </button>
          .
        </div>
      )}
      <div
        id={`panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        className="flex-1 overflow-clip"
      >
        {dataReady ? (
          <>
            {tab === 'worktrees' && <WorktreesView />}
            {tab === 'conflicts' && <ConflictsView />}
            {tab === 'branches' && <BranchesView />}
            {tab === 'squash' && <SquashView />}
            {tab === 'graph' && <GraphView />}
            {tab === 'archive' && <WorktreeArchiveView />}
          </>
        ) : showContentSkeleton ? (
          <ContentSkeleton tab={tab} />
        ) : null}
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ZoomIndicator zoomLevel={zoomLevel} pulseKey={zoomTick} />
      <button
        onClick={() => setHelpOpen(true)}
        className="fixed bottom-4 right-6 z-10 flex items-center gap-1.5 text-[11px] text-wt-muted hover:text-wt-fg-2 transition-colors"
        style={{ fontSize: '11px' }}
      >
        <kbd className="px-1 py-0.5 rounded border border-wt-border/60 bg-wt-border/50 text-wt-muted font-mono text-[10px] leading-none">?</kbd>
        shortcuts
      </button>
      <ShortcutHelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
