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
        // Every wt-* token resolves to a CSS variable defined in
        // src/styles/globals.css. The `rgb(var(--token) / <alpha-value>)`
        // shape is load-bearing: it's what lets opacity modifiers like
        // bg-wt-info/20 still work with a CSS-variable-backed color. The
        // variables themselves are stored as space-separated RGB triples
        // (e.g. `59 130 246`) so this expansion produces valid CSS.
        // Theme swap happens by toggling the `.dark` class on <html>; the
        // 300+ existing bg-wt-*/text-wt-*/border-wt-* sites re-resolve
        // automatically with no call-site changes. See useTheme.ts for
        // the class-toggle and persistence wiring.
        wt: {
          bg: 'rgb(var(--wt-bg) / <alpha-value>)',
          panel: 'rgb(var(--wt-panel) / <alpha-value>)',
          border: 'rgb(var(--wt-border) / <alpha-value>)',
          // Text hierarchy. `fg` is primary body text, `fg-2` is secondary,
          // `muted` is tertiary/label. Replaces the old hardcoded
          // text-neutral-{100,200,300,400,500,600} calls which don't
          // auto-swap when the theme changes.
          fg: 'rgb(var(--wt-fg) / <alpha-value>)',
          'fg-2': 'rgb(var(--wt-fg-2) / <alpha-value>)',
          muted: 'rgb(var(--wt-muted) / <alpha-value>)',
          // Status tokens. Dark mode uses the saturated Tailwind 500-level
          // shades (#10b981, #f59e0b, etc.); light mode darkens each one
          // ~1 shade so they clear WCAG AA on a white background. See
          // globals.css :root vs html.dark for the exact values.
          clean: 'rgb(var(--wt-clean) / <alpha-value>)',
          dirty: 'rgb(var(--wt-dirty) / <alpha-value>)',
          conflict: 'rgb(var(--wt-conflict) / <alpha-value>)',
          info: 'rgb(var(--wt-info) / <alpha-value>)',
          squash: 'rgb(var(--wt-squash) / <alpha-value>)',
          // Slate. Used as the worktree-card border when the working tree is
          // clean but the branch hasn't yet landed in main (normal OR squash
          // merge). Deliberately quiet — green is reserved for "actually
          // merged", so a dashboard scan immediately reveals what's safe to
          // delete vs what's still parked in flight. See worktreeStatusClass
          // in src/lib/colors.ts for the layered priority.
          active: 'rgb(var(--wt-active) / <alpha-value>)',
          // Claude Code awareness badge colors. Two live variants so we can
          // distinguish IDE-attached from CLI-only sessions at a glance.
          'claude-ide': 'rgb(var(--wt-claude-ide) / <alpha-value>)',
          'claude-live': 'rgb(var(--wt-claude-live) / <alpha-value>)',
          'claude-recent': 'rgb(var(--wt-claude-recent) / <alpha-value>)',
          'claude-dormant': 'rgb(var(--wt-claude-dormant) / <alpha-value>)',
          // True orange — distinct from `dirty` amber and `conflict` red.
          // Used to warn when ≥2 Claudes are live in the same worktree, since
          // they can clobber each other's edits without realizing.
          'claude-conflict': 'rgb(var(--wt-claude-conflict) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
};
