/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      // Shimmer keyframe used by ContentSkeleton's loading placeholders. A
      // moving gradient sweep across each block (rather than the simple
      // animate-pulse) reads as "data is on its way here" instead of "this
      // empty box is the final state". Speed and easing tuned to feel
      // unobtrusive on a dashboard.
      keyframes: {
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.8s ease-in-out infinite',
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
