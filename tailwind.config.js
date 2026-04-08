/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      colors: {
        wt: {
          bg: '#0a0a0b',
          panel: '#111114',
          border: '#1f1f24',
          muted: '#6b7280',
          clean: '#10b981',
          dirty: '#f59e0b',
          conflict: '#ef4444',
          info: '#3b82f6',
          squash: '#a855f7',
          // Slate. Used as the worktree-card border when the working tree is
          // clean but the branch hasn't yet landed in main (normal OR squash
          // merge). Deliberately quiet — green is reserved for "actually
          // merged", so a dashboard scan immediately reveals what's safe to
          // delete vs what's still parked in flight. See worktreeStatusClass
          // in src/lib/colors.ts for the layered priority.
          active: '#64748b',
          // Claude Code awareness badge colors. Two live variants so we can
          // distinguish IDE-attached from CLI-only sessions at a glance.
          'claude-ide': '#38bdf8', // sky — IDE-attached live session
          'claude-live': '#10b981', // emerald — CLI live session (matches clean)
          'claude-recent': '#eab308', // amber — active within last 10 min
          'claude-dormant': '#52525b', // zinc — has history, nothing recent
          // True orange — distinct from `dirty` amber and `conflict` red.
          // Used to warn when ≥2 Claudes are live in the same worktree, since
          // they can clobber each other's edits without realizing.
          'claude-conflict': '#f97316',
        },
      },
    },
  },
  plugins: [],
};
