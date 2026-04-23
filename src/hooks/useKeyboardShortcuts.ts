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

// <input> types that do not accept text entry and thus have no native Cmd+A
// "select all text" action. Used to narrow the Cmd+A guard without losing
// the bulk-select shortcut when focus is on a row checkbox.
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

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

      // Narrower than `inEditable`: only text-entry controls where Cmd/Ctrl+A
      // has a native "select all text" action. Excludes <select> and non-text
      // <input> types (checkbox/radio/etc.) so Cmd+A on a focused row
      // checkbox still triggers the bulk-select action.
      const inTextEntry =
        !!target &&
        (target.tagName === 'TEXTAREA' ||
          (target as HTMLElement).isContentEditable ||
          (target.tagName === 'INPUT' &&
            !NON_TEXT_INPUT_TYPES.has(
              ((target as HTMLInputElement).type || 'text').toLowerCase(),
            )));

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
        // Worktrees tab: same shape — search clears first, then selection.
        // Skip when any modal dialog is open: the shared Dialog wrapper
        // handles its own Escape, and dispatching here on top of that would
        // close the modal AND clear search/selection behind it on a single
        // keypress. We detect via the ARIA selector the shared Dialog sets
        // (`role="dialog" aria-modal="true"`); only actual modal dialogs
        // match, so this won't suppress the escape on tooltips/menus.
        if (tab === 'worktrees') {
          if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
          window.dispatchEvent(new CustomEvent('wthq:worktrees-escape'));
          return;
        }
        return;
      }

      // ── Modifier-prefixed shortcuts (fire even in editable fields unless noted) ──

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

      // Cmd/Ctrl+A — select all (Branches and Worktrees tabs only). Skipped
      // when focus is in a text-entry control so the native "select all text"
      // action in search bars, the notepad, settings fields, and typed-delete
      // confirmations still works.
      if (
        mod &&
        e.key === 'a' &&
        !e.shiftKey &&
        !e.altKey &&
        !inTextEntry &&
        tab === 'branches'
      ) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('wthq:toggle-all-branches'));
        return;
      }
      if (
        mod &&
        e.key === 'a' &&
        !e.shiftKey &&
        !e.altKey &&
        !inTextEntry &&
        tab === 'worktrees'
      ) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('wthq:toggle-all-worktrees'));
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

      // / — focus the search input. Stays on the current tab when it has
      // its own search (Worktrees); otherwise jumps to Branches as the
      // historical default.
      if (e.key === '/' && !mod && !e.altKey) {
        e.preventDefault();
        if (tab === 'worktrees') {
          requestAnimationFrame(() => {
            document.getElementById('worktree-search-input')?.focus();
          });
        } else {
          setTab('branches');
          requestAnimationFrame(() => {
            document.getElementById('branch-search-input')?.focus();
          });
        }
        return;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, setTab, settingsOpen, setSettingsOpen, helpOpen, setHelpOpen]);
}
