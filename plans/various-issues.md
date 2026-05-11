---
branch: various-issues
base: main
started: 2026-05-11
---

# various-issues — bundled small fixes

## Goal

Sweep three small, independent backlog items into one PR plus close three
already-fixed issues as housekeeping.

## In this bundle

- **#143 / #140** (dup) — Drop stale line-number refs in `refreshLoop.ts`
  error-policy comment; switch to symbol-only references.
- **#125** — Add a11y label/aria-describedby wiring to
  `RemoveWorktreeDialog` (full) and `BulkRemoveWorktreesDialog` (hazard
  linkage only — label is already wired).
- **#108** — Add a three-state select-all checkbox to the Worktrees
  filter bar; mirrors Cmd+A semantics via existing `toggleAll()`.

## Close as already fixed (no code)

- **#132** — fixed by PR #134 / commit `20daee0`.
- **#138** — addressed by commit `a098391`.
- **#139** — fixed by PR #133 / commit `ee09f02`.

## Linked artifacts

- Detailed implementation plan: `~/.claude/plans/enchanted-napping-plum.md`
  (harness session plan; same content as the approved plan above).
