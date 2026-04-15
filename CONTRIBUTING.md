# Contributing to WorktreeHQ

Thanks for your interest! WorktreeHQ is a small, opinionated project. The bar for PRs is "the tests pass, the change is focused, and [`CLAUDE.md`](./CLAUDE.md) still describes reality after your change."

## Contributor License Agreement (CLA)

Before your first contribution can be merged, you'll need to sign our
[Contributor License Agreement](CLA.md). This is a one-time process —
a bot will prompt you on your first pull request.

**Why do we have a CLA?** This project is licensed under PolyForm Shield, and
the CLA ensures that we retain the flexibility to adjust the license in the
future — for example, to make it more permissive. Without a CLA, every
contributor would need to individually consent to any license change, which
becomes impractical as the project grows.

You retain copyright over your contributions. The CLA grants a broad license
to the project maintainer, but does not transfer ownership.

## Dev loop

```bash
npm install
npm run tauri dev          # full app (spawns Vite + native window)
npm test                   # vitest, one-shot
npm run test:watch         # vitest watch mode
npm run build              # tsc --noEmit + vite build
cd src-tauri && cargo check   # faster than `tauri build` for Rust-side validation
```

Run a single test file: `npx vitest run src/services/squashDetector.test.ts`
Run a single test by name: `npx vitest run -t 'extracts PR number'`

See the [README install section](./README.md#install) for platform prerequisites (Node, Rust, and the Tauri WebView dependencies for your OS).

## Architecture — read this before adding features

Before touching anything non-trivial, read [`CLAUDE.md`](./CLAUDE.md). The load-bearing decisions:

- **One Rust command, all git logic in TypeScript.** New git operations go in `src/services/gitService.ts`, *not* in new Rust commands. The Rust side only handles things `git` can't do (filesystem watching, config persistence, notepad atomic writes, Claude state polling, etc.).
- **Single Zustand store.** State lives in `src/store/useRepoStore.ts`; components subscribe via selectors. No router — tabs are local component state in `App.tsx`.
- **Frontend tests mock at the service layer**, not at `invoke`. See `src/services/squashDetector.test.ts` for the pattern; the `tauriBridge.ts` shim makes service-level tests run without spinning up the Rust backend.
- **`tryRun` vs `run`** in `gitService.ts` is deliberate: read paths use `tryRun` (returns empty string on failure) so a single failing command doesn't blank the UI; destructive ops use `run` (throws on non-zero exit) so failures surface to the user.

## Code style

- TypeScript everywhere on the frontend; canonical types live in `src/types/index.ts`. Match those when adding fields.
- Tailwind with `wt-`-prefixed custom tokens defined in `tailwind.config.js`. Use those (`wt-bg`, `wt-dirty`, etc.) instead of raw color classes so the dark theme stays consistent.
- Destructive UI dialogs (`ConfirmDeleteDialog`, `RemoveWorktreeDialog`, `ForceDeleteRejectedDialog`) follow a shared shape: Escape closes, backdrop click closes, focus lands on Cancel. Typed "delete" confirmation is tiered by blast radius: local-only branch deletes (`git -d`, safe) and clean-worktree removals without any branch cleanup are click-to-confirm; remote-touching, force-delete-of-local-branch, or dirty-worktree force-remove operations require typing "delete". New destructive flows should match.
- When adding a new Rust command, register it in **both** `src-tauri/src/commands/mod.rs` and the `invoke_handler![]` macro in `src-tauri/src/lib.rs`, and add a TS wrapper in `tauriBridge.ts` or the relevant service.

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/) with a scope. Examples from recent history:

- `feat(repo-switcher): recent-repos dropdown in RepoBar`
- `fix(branches): don't tag empty/lagging branches as merged`
- `feat(worktrees): composite branch disposition pill + pull-main action`
- `docs: refresh CLAUDE.md to reflect codebase review conventions`

Common scopes: `worktrees`, `branches`, `squash`, `graph`, `repo`, `refresh`, `settings`, `freshness`, `rust`, `ui`, `bootstrap`.

## Pull requests

- Keep PRs focused — one feature or fix per PR.
- Run `npm test` and `npm run build` (plus `cargo check` if you touched Rust) before opening.
- A short description of *why* (not just *what*) makes review much faster.
- If your change alters architecture or conventions, update `CLAUDE.md` in the same PR.

## Filing issues

Please include:

- Your OS + version
- WorktreeHQ commit hash (`git rev-parse HEAD`)
- Whether you have a GitHub token configured (squash-merge detection silently does nothing without one)
- Steps to reproduce + what you expected vs. what happened
- Any relevant terminal output from `npm run tauri dev` (errors there won't show in the app window)

## Reporting security issues

**Do not file public issues for security bugs.** See [`SECURITY.md`](./SECURITY.md) for the private reporting process.

## Code of conduct

This project follows the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md). Be kind.

## License

This project is licensed under the [PolyForm Shield License 1.0.0](./LICENSE.md). By contributing, you agree to the terms of the [CLA](./CLA.md).
