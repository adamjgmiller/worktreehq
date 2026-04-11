import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';
import { bootstrapThemeSync } from './hooks/useTheme';
import { useRepoStore } from './store/useRepoStore';

// Dev-only store exposure for Playwright visual validation. Gated on
// import.meta.env.DEV so production builds don't leak store internals. Used
// to inject fake worktree/branch data while previewing light-mode styling
// outside the Tauri runtime (where gitService calls all fail).
if (import.meta.env.DEV) {
  (window as unknown as { __WT_STORE__: typeof useRepoStore }).__WT_STORE__ =
    useRepoStore;
}

// Apply the last-seen theme class synchronously before React mounts so
// the initial paint doesn't flash the wrong theme. The persisted config
// hydrates moments later via useRepoBootstrap and takes over from there.
bootstrapThemeSync();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
