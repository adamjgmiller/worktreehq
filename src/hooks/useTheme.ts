import { useEffect } from 'react';
import { useRepoStore } from '../store/useRepoStore';
import { invoke } from '../services/tauriBridge';

export type ThemePreference = 'light' | 'dark' | 'system';

// The concrete theme we end up rendering, after resolving "system" against
// the OS `prefers-color-scheme`. This is what actually gets toggled on
// <html> via the `.light` class. Dark is the app default and lives on
// `:root` directly, so the dark path is a no-op / class-removal.
export type ResolvedTheme = 'light' | 'dark';

// Media query handle for `prefers-color-scheme: dark`. Lives at module
// scope so the same MediaQueryList instance is reused across mounts and
// the `change` listener can be added/removed idempotently.
const prefersDarkMql =
  typeof window !== 'undefined' && 'matchMedia' in window
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === 'system') {
    return prefersDarkMql?.matches ? 'dark' : 'light';
  }
  return pref;
}

// localStorage key for the last-applied resolved theme. We cache the
// resolved value (not the preference) so bootstrapThemeSync can read a
// single value and apply it with zero logic — the FOUC-free path must
// not wait on matchMedia or config.toml.
const LAST_THEME_KEY = 'wt-last-theme';

// Synchronous initial preference used to SEED the Zustand store before
// React mounts. Must return the same value as bootstrapThemeSync would
// apply to the DOM, otherwise useTheme's first-render effect will
// clobber bootstrapThemeSync's class toggle and the reloaded app
// flashes back to the default. Gets called twice on cold start (once
// for the DOM, once for the store) — it's a cheap sync read, not a race.
export function initialThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(LAST_THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* fall through to the default */
  }
  return 'dark';
}

// Apply a resolved theme to the DOM by toggling the `.light` class on
// <html>. Every wt-* Tailwind utility resolves its color via CSS
// variables — `:root` holds the dark defaults and `html.light`
// overrides them with light values (see src/styles/globals.css). A
// single class flip re-themes the entire app in one paint.
export function applyTheme(resolved: ResolvedTheme) {
  const root = document.documentElement;
  if (resolved === 'light') {
    root.classList.add('light');
  } else {
    root.classList.remove('light');
  }
  try {
    localStorage.setItem(LAST_THEME_KEY, resolved);
  } catch {
    /* storage may be disabled; theme still applies for this session */
  }
}

// Called synchronously from main.tsx BEFORE React mounts to avoid FOUC.
// Reads the last-applied resolved theme from localStorage; on a truly
// first launch (storage empty) we fall through to the app-wide default
// of dark. The async config hydration in useRepoBootstrap may override
// this moments later — that's fine, any mismatch is limited to the
// difference between "what the user last saw" and "what's persisted",
// which is only visible on the very first launch after an explicit
// theme change from another session.
export function bootstrapThemeSync() {
  try {
    const stored = localStorage.getItem(LAST_THEME_KEY);
    if (stored === 'dark' || stored === 'light') {
      applyTheme(stored);
      return;
    }
  } catch {
    /* fall through to the default */
  }
  applyTheme('dark');
}

// Hook that subscribes to the store's theme preference and keeps
// <html class="light"> in sync with it. Also listens for OS-level
// prefers-color-scheme changes so a user who has explicitly chosen
// "system" gets a live swap when they flip their OS appearance
// without relaunching. The store default is "dark", not "system" —
// first-launch users see dark regardless of OS preference.
export function useTheme() {
  const themePreference = useRepoStore((s) => s.themePreference);
  useEffect(() => {
    applyTheme(resolveTheme(themePreference));
  }, [themePreference]);
  useEffect(() => {
    if (!prefersDarkMql) return;
    const onChange = () => {
      // Only react when the user is on "system". A hard "light" or
      // "dark" preference must not be overridden by an OS flip.
      const pref = useRepoStore.getState().themePreference;
      if (pref === 'system') applyTheme(resolveTheme(pref));
    };
    prefersDarkMql.addEventListener('change', onChange);
    return () => prefersDarkMql.removeEventListener('change', onChange);
  }, []);
}

// Persist the chosen preference to config.toml. Merges against the current
// on-disk config so this write doesn't clobber `github_token` (which lives
// in the config file but not in the Zustand store — see persistZoom in
// App.tsx for the same merge pattern and rationale).
export async function persistThemePreference(pref: ThemePreference) {
  try {
    const cfg = await invoke<Record<string, unknown>>('read_config');
    await invoke('write_config', { cfg: { ...cfg, theme: pref } });
  } catch {
    /* theme is a UX nicety; persistence failure shouldn't disrupt the UI */
  }
}
