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
          // Claude Code awareness badge colors. Two live variants so we can
          // distinguish IDE-attached from CLI-only sessions at a glance.
          'claude-ide': '#38bdf8', // sky — IDE-attached live session
          'claude-live': '#10b981', // emerald — CLI live session (matches clean)
          'claude-recent': '#eab308', // amber — active within last 10 min
          'claude-dormant': '#52525b', // zinc — has history, nothing recent
        },
      },
    },
  },
  plugins: [],
};
