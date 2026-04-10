import { useEffect } from 'react';
import type { TabKey } from '../components/Tabs';
import { runFetchOnce } from '../services/refreshLoop';
import { loadRepoAtPath } from '../services/repoSelect';
import { useRepoStore } from '../store/useRepoStore';

// Ordered to match the visual tab layout: core (1-3), auxiliary (4-6).
const TAB_BY_NUMBER: Record<string, TabKey> = {
  '1': 'worktrees',
  '2': 'conflicts',
  '3': 'branches',
  '4': 'squash',
  '5': 'graph',
  '6': 'archive',
};

interface Params {
  tab: TabKey;
  setTab: (t: TabKey) => void;
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;
  helpOpen: boolean;
  setHelpOpen: (v: boolean) => void;
}

export function useKeyboardShortcuts({
  tab,
  setTab,
  settingsOpen,
  setSettingsOpen,
  helpOpen,
  setHelpOpen,
}: Params): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          (target as HTMLElement).isContentEditable);

      const mod = e.metaKey || e.ctrlKey;

      // ── Escape ──────────────────────────────────────────────────
      // Priority: help overlay > modals (own handlers) > branches clear.
      // We only handle help-overlay and branches-tab-clear here; modal
      // Escape is handled by each modal's own listener.
      if (e.key === 'Escape') {
        if (helpOpen) {
          e.preventDefault();
          setHelpOpen(false);
          return;
        }
        // If any modal is open, let the modal's own handler handle it.
        if (settingsOpen) return;
        // Branches tab: clear search then selection.
        if (tab === 'branches') {
          window.dispatchEvent(new CustomEvent('wthq:branches-escape'));
          return;
        }
        return;
      }

      // ── Modifier-prefixed shortcuts (fire even in editable fields) ──

      // Cmd/Ctrl+R — refresh (suppress webview reload)
      if (mod && e.key === 'r' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const s = useRepoStore.getState();
        if (!s.fetching && !s.userRefreshing) {
          void runFetchOnce({ userInitiated: true });
        }
        return;
      }

      // Cmd/Ctrl+, — open settings (macOS convention)
      if (mod && e.key === ',' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }

      // Cmd/Ctrl+A — select all branches (only on Branches tab)
      if (mod && e.key === 'a' && !e.shiftKey && !e.altKey && tab === 'branches') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('wthq:toggle-all-branches'));
        return;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab — cycle recent repos
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        const s = useRepoStore.getState();
        if (s.recentRepoPaths.length < 2) return;
        if (s.fetching || s.userRefreshing) return;
        const idx = e.shiftKey
          ? s.recentRepoPaths.length - 1
          : 1;
        void loadRepoAtPath(s.recentRepoPaths[idx]);
        return;
      }

      // ── Bare-key shortcuts (suppressed in editable fields) ─────
      if (inEditable) return;

      // Also suppress bare keys when any modal or the help overlay is open,
      // so stray keypresses don't switch tabs behind a dialog.
      if (settingsOpen || helpOpen) return;

      // 1-6 — tab switching
      if (TAB_BY_NUMBER[e.key] && !mod && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setTab(TAB_BY_NUMBER[e.key]);
        return;
      }

      // , — open settings
      if (e.key === ',' && !mod && !e.altKey) {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }

      // ? — toggle help overlay
      if (e.key === '?' && !mod && !e.altKey) {
        e.preventDefault();
        setHelpOpen(!helpOpen);
        return;
      }

      // N — new worktree (switch to Worktrees tab + open dialog)
      if (e.key === 'N' || (e.key === 'n' && !mod && !e.altKey)) {
        e.preventDefault();
        setTab('worktrees');
        // Defer so WorktreesView is mounted before it receives the event.
        requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent('wthq:create-worktree'));
        });
        return;
      }

      // / — focus branch search (switch to Branches tab if needed)
      if (e.key === '/' && !mod && !e.altKey) {
        e.preventDefault();
        setTab('branches');
        requestAnimationFrame(() => {
          document
            .getElementById('branch-search-input')
            ?.focus();
        });
        return;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, setTab, settingsOpen, setSettingsOpen, helpOpen, setHelpOpen]);
}
