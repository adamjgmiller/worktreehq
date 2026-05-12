import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRepoStore } from '../../store/useRepoStore';
import { FilterBar } from './FilterBar';
import { BranchTable } from './BranchTable';
import { BulkActionBar } from './BulkActionBar';
import { ConfirmDeleteDialog, type DeleteMode } from './ConfirmDeleteDialog';
import {
  ForceDeleteRejectedDialog,
  type RejectedDelete,
  type RejectReason,
} from './ForceDeleteRejectedDialog';
import { applyPreset, filterMine, searchBranches, type FilterPreset } from '../../lib/filters';
import {
  deleteLocalBranch,
  deleteRemoteBranch,
  tagBranch,
  archiveTagNameFor,
  getUserEmail,
  resolveCommitSha,
} from '../../services/gitService';
import { refreshOnce } from '../../services/refreshLoop';
import { EmptyState } from '../common/EmptyState';

// Shared idempotent archive-tag helper. Resolves `sourceRef` to a SHA, creates
// `tagName` pointing at it, and treats an "already exists" failure as success
// IFF the existing tag points at the same SHA (the interrupted-retry case).
// Different SHA = abort and push a clear error; verification failure = abort.
// Caller-visible result: `ok` is true on success (new tag OR same-SHA reuse),
// false on any failure that should block a subsequent destructive action.
//
// Used by:
//   - performDelete's local-archive path (capture branch tip, delete, tag SHA)
//   - performDelete's remote-only archive path (tag origin/<branch>)
//   - performForceDelete's archive-and-delete path (local tip + origin tip)
//
// Why the `failureSuffix` parameter: the hasLocal local-archive path runs
// AFTER the local branch is deleted, so its error wording is about preserving
// the deleted tip; the remote-only / origin-tip paths run BEFORE the remote
// delete, so their wording must say "remote branch was NOT deleted". One
// helper, two suffixes.
async function ensureArchiveTag(
  repoPath: string,
  sourceRef: string,
  tagName: string,
  branchDisplayName: string,
  errors: string[],
  infos: string[],
  opts: {
    // Human-readable suffix for error messages (e.g. "remote branch was NOT
    // deleted" pre-delete, or "use `git tag <new-name> <sha>` to preserve
    // the deleted tip" post-delete). Always appended verbatim.
    failureSuffix: string;
    // Optional: source description used in user-facing errors so they read
    // naturally (e.g. "branch", "remote branch"). Defaults to "ref".
    sourceLabel?: string;
  },
): Promise<{ ok: boolean; sha?: string }> {
  const sourceLabel = opts.sourceLabel ?? 'ref';
  let sha: string;
  try {
    sha = await resolveCommitSha(repoPath, sourceRef);
  } catch (e: any) {
    errors.push(
      `${branchDisplayName}: could not read the latest commit for archiving ${sourceLabel} — ${e?.message ?? e}. Try refreshing the branch list and retrying; ${opts.failureSuffix}`,
    );
    return { ok: false };
  }
  try {
    await tagBranch(repoPath, sha, tagName);
    return { ok: true, sha };
  } catch (tagErr: any) {
    const tagMsg = String(tagErr?.message ?? tagErr);
    if (!/already exists/.test(tagMsg)) {
      errors.push(`${branchDisplayName}: ${tagMsg}; ${opts.failureSuffix}`);
      return { ok: false };
    }
    try {
      const existingTagSha = await resolveCommitSha(repoPath, tagName);
      if (existingTagSha === sha) {
        infos.push(
          `${branchDisplayName}: archive tag ${tagName} already existed at this tip — reused`,
        );
        return { ok: true, sha };
      }
      errors.push(
        `${branchDisplayName}: an archive tag for this branch already exists at a different commit (existing=${existingTagSha.slice(0, 7)}, wanted=${sha.slice(0, 7)}) — rename the existing tag manually or use \`git tag <new-name> ${sha.slice(0, 7)}\` to preserve this tip; ${opts.failureSuffix}`,
      );
      return { ok: false };
    } catch (cmpErr: any) {
      errors.push(
        `${branchDisplayName}: archive tag ${tagName} verification failed (${cmpErr?.message ?? cmpErr}); ${opts.failureSuffix}`,
      );
      return { ok: false };
    }
  }
}

export function BranchesView() {
  const branches = useRepoStore((s) => s.branches);
  const repo = useRepoStore((s) => s.repo);
  const [preset, setPreset] = useState<FilterPreset>('all');
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<DeleteMode | null>(null);
  const [userEmail, setUserEmail] = useState<string | undefined>(undefined);
  // Local error slot — setError on the store gets clobbered by refreshOnce's `setError(null)`,
  // so bulk-delete errors need their own home where refreshes don't touch them.
  const [deleteErrors, setDeleteErrors] = useState<string[]>([]);
  // Separate neutral-styled channel for idempotent-success notes (e.g. "archive
  // tag already existed at this tip — reused"). Kept distinct from
  // `deleteErrors` so a green/info banner doesn't imply failure.
  const [deleteInfo, setDeleteInfo] = useState<string[]>([]);
  const [rejected, setRejected] = useState<RejectedDelete[] | null>(null);
  // In-flight guard for performDelete and performForceDelete. Both are
  // bound to dialogs whose primary buttons used to remain clickable while the
  // async work was running, so a double-click could fire two parallel delete
  // loops against the same selection. The dialogs read this prop to disable
  // their controls and flip the title to "Deleting…".
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    (async () => {
      const email = await getUserEmail(repo.path);
      if (!cancelled) setUserEmail(email);
    })();
    return () => {
      cancelled = true;
    };
  }, [repo]);

  const filtered = useMemo(() => {
    let result = applyPreset(branches, preset, { defaultBranch: repo?.defaultBranch });
    if (mine) result = filterMine(result, userEmail);
    return searchBranches(result, search);
  }, [branches, preset, mine, search, userEmail, repo?.defaultBranch]);
  const selectedBranches = filtered.filter((b) => selection.has(b.name));

  const toggle = (name: string) =>
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  // Scoped union/diff semantics: toggleAll only adds-or-removes the CURRENTLY
  // FILTERED branches, so previously-selected branches that fall outside the
  // current filter view are preserved across the toggle. A wholesale replace
  // (the prior `new Set(filtered.map(...))`) would silently drop those
  // out-of-filter selections, contradicting the (n/m) counter shown in the
  // header (which is scoped to the filter intersection). When every filtered
  // branch is already in `prev`, this becomes "clear visible"; otherwise it's
  // "fill visible". Mirrors the local `toggle` helper's additive
  // `new Set(prev)` pattern (and WorktreesView's `toggleRange`, the
  // parallel shift-click range writer there).
  const toggleAll = useCallback(() => {
    setSelection((prev) => {
      if (filtered.length === 0) return prev;
      const allFilteredSelected = filtered.every((b) => prev.has(b.name));
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const b of filtered) next.delete(b.name);
      } else {
        for (const b of filtered) next.add(b.name);
      }
      return next;
    });
  }, [filtered]);

  // Listen for global keyboard shortcuts dispatched by useKeyboardShortcuts.
  useEffect(() => {
    const onToggleAll = () => toggleAll();
    const onEscape = () => {
      if (search) {
        setSearch('');
      } else if (selection.size > 0) {
        setSelection(new Set());
      }
    };
    window.addEventListener('wthq:toggle-all-branches', onToggleAll);
    window.addEventListener('wthq:branches-escape', onEscape);
    return () => {
      window.removeEventListener('wthq:toggle-all-branches', onToggleAll);
      window.removeEventListener('wthq:branches-escape', onEscape);
    };
  }, [toggleAll, search, selection.size]);

  async function performDelete(mode: DeleteMode) {
    if (!repo || deleting) return;
    setDeleting(true);
    // Clear any stale error pile from a previous run before adding new ones —
    // otherwise a successful retry of a failed batch leaves the old errors
    // visible above the fresh result and the user can't tell what came from
    // which run.
    setDeleteErrors([]);
    setDeleteInfo([]);
    const rejectedItems: RejectedDelete[] = [];
    const errors: string[] = [];
    const infos: string[] = [];
    const deletesLocal = mode !== 'remote';
    const deletesRemote = mode !== 'local';

    try {
      for (const b of selectedBranches) {
        let localDeferredToForce = false;
        // Track the SHA we successfully archived from the LOCAL tip (if any),
        // so the post-local origin-tip archive step below can detect a
        // divergent origin and tag it under a distinct name. Stays undefined
        // when no local archive happened (mode != archive-and-delete, or no
        // hasLocal, or the local archive failed and we `continue`'d).
        let localArchivedSha: string | undefined;
        try {
          if (deletesLocal && b.hasLocal) {
            // Capture-then-delete-then-tag: resolve the branch tip SHA BEFORE
            // `git -d` so we can create archive/<name> AFTER the delete
            // succeeds, pointing at the captured SHA.
            //
            // Why not tag first: if `-d` is refused (detector-vs-git
            // disagreement — e.g. a `merged-normally` branch whose local main
            // hasn't been fast-forwarded to the merge commit yet — routes to
            // the 'other' cohort in the force dialog), and the user cancels
            // that dialog, a pre-created archive tag would be orphaned
            // against a still-live branch.
            //
            // Delete-then-tag keeps archive-tag creation on the `-d`-
            // succeeded path only. Refused items flow into
            // performForceDelete, which does its own tag-then-force-delete
            // arc with idempotent "tag already exists at same SHA" handling.
            //
            // Only merged-normally / direct-merged pre-resolve the SHA here:
            //   - squash-merged: `git -d` ALWAYS refuses → tag handled by
            //     performForceDelete.
            //   - unmerged / stale under archive-and-delete: likewise routes
            //     to the force dialog; performForceDelete tags those too.
            const shouldArchive =
              mode === 'archive-and-delete' &&
              (b.mergeStatus === 'merged-normally' || b.mergeStatus === 'direct-merged');
            const archiveSha = shouldArchive
              ? await resolveCommitSha(repo.path, b.name)
              : undefined;
            try {
              // Never auto-force: git -d refuses unmerged branches and that's a feature.
              // "not fully merged" rejections route to ForceDeleteRejectedDialog,
              // which tiers the force-delete confirmation by cohort — squash-merged
              // rejects are click-to-confirm (detector is the safety check), while
              // unmerged and 'other' (detector-vs-git disagreement) cohorts require
              // typing. Any OTHER -d failure (branch currently checked out, invalid
              // ref, permission errors) goes to the banner — `-D` wouldn't fix those
              // and the prompt would lie. LC_ALL=C in git_exec keeps the stderr
              // string stable English.
              await deleteLocalBranch(repo.path, b.name, false);
              if (archiveSha) {
                // Tag the captured SHA (not the branch name — the ref is
                // gone now). `tagBranch` passes its 2nd arg straight to
                // `git tag <name> <commit-ish>`, and a SHA is a commit-ish.
                //
                // Idempotent tag-already-exists handling lives in
                // `ensureArchiveTag` (above). Because the local ref is already
                // gone at this point, the SHA we pass in (archiveSha, captured
                // pre-delete) IS the source — there's no separate ref to
                // resolve. We bypass the helper's resolve step by passing the
                // SHA directly as the source ref (a SHA is a valid commit-ish
                // for `git rev-parse`).
                const tagName = archiveTagNameFor(b.name);
                // failureSuffix branches on b.hasRemote because the local
                // ref has ALREADY been deleted at this point: for a
                // hasRemote branch the user-visible recovery info is "we
                // didn't proceed to delete the remote either", but for a
                // local-only branch there is no remote to mention, and
                // claiming `remote branch was NOT deleted` would be a lie.
                const result = await ensureArchiveTag(
                  repo.path,
                  archiveSha,
                  tagName,
                  b.name,
                  errors,
                  infos,
                  {
                    failureSuffix: b.hasRemote
                      ? 'the local branch was deleted; remote branch was NOT deleted'
                      : 'the local branch was deleted',
                    sourceLabel: 'branch tip',
                  },
                );
                if (!result.ok) {
                  // Archive preservation could not be proven. Abort before
                  // the remote delete — if we can't vouch for the archive,
                  // we can't destroy the last remote reference either.
                  continue;
                }
                localArchivedSha = result.sha;
              }
            } catch (e: any) {
              const msg = String(e?.message ?? e);
              if (/is not fully merged/.test(msg)) {
                const reason: RejectReason =
                  b.mergeStatus === 'squash-merged'
                    ? 'squash-merged'
                    : b.mergeStatus === 'unmerged' || b.mergeStatus === 'stale'
                      ? 'unmerged'
                      : 'other';
                rejectedItems.push({ branch: b, mode, reason });
                localDeferredToForce = true;
              } else {
                errors.push(`${b.name}: ${msg}`);
                continue;
              }
            }
          }
          // Remote-only archive intent: when the user picked archive-and-delete
          // on a branch with no local ref, the local block above no-op'd (its
          // outer gate is `b.hasLocal`), which previously meant the archive tag
          // was silently dropped and the remote was deleted unarchived (#121).
          // Honor the explicit archive intent by tagging from origin/<branch>
          // before the remote delete. The remote-tracking ref is guaranteed to
          // exist whenever `b.hasRemote === true` in the app's branch model.
          // Mirrors the idempotent "already exists" handling from the hasLocal
          // path. The lag risk (origin/<branch> last-fetched tip behind the
          // live remote) is the same pattern the rest of the destructive flow
          // already handles, per the issue's recommendation. Gating the
          // remote delete on archive success preserves the same "if we can't
          // archive, we don't destroy the last reference" property.
          let remoteArchiveOk = true;
          if (mode === 'archive-and-delete' && !b.hasLocal && b.hasRemote) {
            // Use the fully-qualified `refs/remotes/origin/<name>` form so
            // we never collide with a same-named tag or local branch in
            // git's ref-disambiguation rules.
            const remoteRef = `refs/remotes/origin/${b.name}`;
            const tagName = archiveTagNameFor(b.name);
            const result = await ensureArchiveTag(
              repo.path,
              remoteRef,
              tagName,
              b.name,
              errors,
              infos,
              {
                failureSuffix: 'remote branch was NOT deleted',
                sourceLabel: 'remote branch',
              },
            );
            remoteArchiveOk = result.ok;
          }
          // Divergent-origin-tip archive: when both a local AND a remote
          // exist for an archive-and-delete, the local tip may not match
          // origin/<branch>'s tip (e.g. a force-push by a teammate, or a
          // local rebase the user hasn't pushed). The remote delete below
          // would destroy commits the primary archive doesn't cover, so we
          // archive the origin SHA under a SHA-suffixed name when it
          // doesn't match `localArchivedSha`.
          //
          // The gate runs for EVERY archive-and-delete with hasLocal AND
          // hasRemote whose local `-d` SUCCEEDED — not only when
          // `localArchivedSha` was set. For `empty` / `other` mergeStatus
          // branches that succeed at `-d`, `shouldArchive` is false so the
          // local-archive step is skipped and `localArchivedSha` stays
          // undefined; but the LOCAL ref has still been destroyed (line
          // above) AND the remote may carry commits diverged from main.
          // Comparing `originSha !== localArchivedSha` correctly returns
          // true when `localArchivedSha` is undefined, so origin gets
          // archived under a distinct tag whenever the primary archive
          // doesn't already cover it. The convergent-tips case (origin ===
          // local) AND the case where no local archive ran AND origin
          // happens to equal some other-known SHA still go through the
          // helper's idempotent "tag already exists at same SHA" path on
          // retry.
          //
          // `!localDeferredToForce` is load-bearing: when `-d` is refused
          // (squash-merged always; merged-normally/direct-merged in the
          // 'other' detector-vs-git cohort), the catch above pushes the
          // branch onto `rejectedItems` and execution falls through. In
          // that case `performForceDelete` will create its own primary
          // archive tag AND its own divergent-origin tag after the user
          // confirms the force-delete dialog. Running this block now would
          // create an orphan `archive/<name>-origin-<sha7>` tag against
          // a still-live branch that the user might cancel out of —
          // duplicating performForceDelete's tag (harmless on confirm,
          // idempotent via the helper) but polluting the user's tag
          // namespace on cancel with archives they didn't authorize.
          if (
            mode === 'archive-and-delete' &&
            b.hasLocal &&
            b.hasRemote &&
            !localDeferredToForce
          ) {
            const remoteRef = `refs/remotes/origin/${b.name}`;
            try {
              const originSha = await resolveCommitSha(repo.path, remoteRef);
              if (originSha !== localArchivedSha) {
                const originTagName = `${archiveTagNameFor(b.name)}-origin-${originSha.slice(0, 7)}`;
                const result = await ensureArchiveTag(
                  repo.path,
                  originSha,
                  originTagName,
                  b.name,
                  errors,
                  infos,
                  {
                    failureSuffix: 'remote branch was NOT deleted',
                    sourceLabel: 'remote branch tip',
                  },
                );
                if (!result.ok) {
                  remoteArchiveOk = false;
                }
              }
            } catch (e: any) {
              errors.push(
                `${b.name}: could not read the latest commit for archiving remote branch tip — ${e?.message ?? e}. Try refreshing the branch list and retrying; remote branch was NOT deleted`,
              );
              remoteArchiveOk = false;
            }
          }
          // Remote-delete gate: skip the remote delete when EITHER
          //   - the local delete was deferred to the force-delete dialog
          //     (localDeferredToForce === true) — performForceDelete will
          //     re-issue the remote delete on confirm via `wantsRemote`,
          //     and deleting it here would strand the local ref if the
          //     user cancels the force dialog
          //   - the remote-only archive OR divergent-origin archive failed
          //     (remoteArchiveOk === false) — destroying the last reference
          //     to commits we couldn't archive violates the "if we can't
          //     vouch for the archive, we don't destroy the last reference"
          //     property documented on the local-archive path above.
          if (deletesRemote && b.hasRemote && !localDeferredToForce && remoteArchiveOk) {
            await deleteRemoteBranch(repo.path, 'origin', b.name);
          }
        } catch (e: any) {
          errors.push(`${b.name}: ${e?.message ?? e}`);
        }
      }

      setSelection(new Set());
      setConfirm(null);
      setDeleteErrors(errors);
      setDeleteInfo(infos);
      if (rejectedItems.length > 0) {
        setRejected(rejectedItems);
      }
      await refreshOnce({ userInitiated: true });
    } finally {
      setDeleting(false);
    }
  }

  async function performForceDelete() {
    if (!repo || !rejected || deleting) return;
    setDeleting(true);
    // Intentionally do NOT clear deleteErrors / deleteInfo at entry: this is a
    // CONTINUATION of the batch started by performDelete, not a fresh run.
    // performDelete may have set non-rejection errors (e.g. branch currently
    // checked out, permission denied) that were stashed to the banner just
    // before the force-delete dialog opened; those errors belong to siblings
    // of the rejected items and must survive the force-delete cycle.
    // Append-only via the functional-update form at the end of this function
    // is how both banners accumulate correctly across the perform→force arc.
    try {
      const errors: string[] = [];
      const infos: string[] = [];
      for (const item of rejected) {
        // Track whether the origin-tip archive (when needed) succeeded.
        // Gates the remote delete below so we never destroy commits we
        // couldn't preserve in an archive tag. Stays `true` when no
        // origin-tip archive was needed (origin === local tip, or
        // mode !== archive-and-delete, or no remote).
        let originArchiveOk = true;
        try {
          if (item.branch.hasLocal) {
            // Tag FIRST, still — just moved here from performDelete so the tag
            // only lands when the user actually confirms the force-delete.
            // Covers every deferred archive-and-delete item regardless of
            // mergeStatus (squash-merged, unmerged, stale, other), so the
            // user's archive intent is honored even for unmerged/stale
            // branches. Idempotent "tag already exists at same SHA" handling
            // lives in `ensureArchiveTag` (above the BranchesView function).
            // LC_ALL=C in git_exec keeps the stderr string stable English so
            // the regex inside the helper matches reliably.
            if (item.mode === 'archive-and-delete') {
              const tagName = archiveTagNameFor(item.branch.name);
              const result = await ensureArchiveTag(
                repo.path,
                item.branch.name,
                tagName,
                item.branch.name,
                errors,
                infos,
                {
                  failureSuffix: 'aborting force-delete to avoid losing commits',
                  sourceLabel: 'branch tip',
                },
              );
              if (!result.ok) {
                continue;
              }
              // Divergent-origin-tip archive: if the local tip and origin
              // tip disagree (force-push by a teammate, or a local rebase
              // not yet pushed), the single archive tag above only covers
              // the local SHA. The remote delete below would destroy
              // commits reachable only via origin/<branch>. Tag origin's
              // SHA under a distinct SHA-suffixed name so it can't collide
              // with the primary archive tag, then gate the remote delete
              // on this succeeding too.
              if (item.branch.hasRemote && result.sha !== undefined) {
                const remoteRef = `refs/remotes/origin/${item.branch.name}`;
                try {
                  const originSha = await resolveCommitSha(repo.path, remoteRef);
                  if (originSha !== result.sha) {
                    const originTagName = `${tagName}-origin-${originSha.slice(0, 7)}`;
                    const originResult = await ensureArchiveTag(
                      repo.path,
                      originSha,
                      originTagName,
                      item.branch.name,
                      errors,
                      infos,
                      {
                        // Origin archive failure here gates BOTH the local
                        // force-delete and the remote delete below, so the
                        // suffix accurately names both. Without this gate
                        // the local would still force-delete and the user
                        // would see only "remote branch was NOT deleted",
                        // which under-reports what just happened.
                        failureSuffix:
                          'neither the local nor remote branch was deleted — retry once the origin tip can be archived',
                        sourceLabel: 'remote branch tip',
                      },
                    );
                    if (!originResult.ok) {
                      originArchiveOk = false;
                    }
                  }
                } catch (e: any) {
                  errors.push(
                    `${item.branch.name}: could not read the latest commit for archiving remote branch tip — ${e?.message ?? e}. Try refreshing the branch list and retrying; neither the local nor remote branch was deleted`,
                  );
                  originArchiveOk = false;
                }
              }
            }
            // Gate the local force-delete on originArchiveOk: when the
            // user picks archive-and-delete and we couldn't archive the
            // origin tip, force-deleting the local now would still leave
            // origin's diverged commits reachable from `refs/remotes/origin/<name>`
            // (since we also skip the remote delete below) — but the
            // local archive tag created above only covers the local SHA.
            // If origin gets pruned later, those commits become
            // unreachable. Preserving the local ref lets the user retry
            // archive-and-delete once the origin-archive issue is resolved.
            // For modes other than archive-and-delete, `originArchiveOk`
            // stays at its `true` default (the divergent-origin block is
            // gated on `item.mode === 'archive-and-delete'`), so the local
            // force-delete proceeds unchanged.
            if (originArchiveOk) {
              await deleteLocalBranch(repo.path, item.branch.name, true);
            }
          }
          // Honor the original mode: if the user picked `both` or `archive-and-delete`,
          // their confirmation covered the remote ref too, so remove it now that the
          // local force-delete succeeded — but only if any origin-tip archive
          // step (above) succeeded. originArchiveOk stays `true` when no
          // origin-tip archive was needed.
          const wantsRemote = item.mode === 'both' || item.mode === 'archive-and-delete';
          if (wantsRemote && item.branch.hasRemote && originArchiveOk) {
            await deleteRemoteBranch(repo.path, 'origin', item.branch.name);
          }
        } catch (e: any) {
          errors.push(`${item.branch.name}: ${e?.message ?? e}`);
        }
      }
      setRejected(null);
      if (errors.length > 0) {
        setDeleteErrors((prev) => [...prev, ...errors]);
      }
      if (infos.length > 0) {
        setDeleteInfo((prev) => [...prev, ...infos]);
      }
      await refreshOnce({ userInitiated: true });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <FilterBar value={preset} onChange={setPreset} mine={mine} onMineChange={setMine} search={search} onSearch={setSearch} />
      {deleteErrors.length > 0 && (
        <div role="alert" aria-live="assertive" className="px-4 py-2 bg-wt-conflict/10 border-b border-wt-conflict/40 text-xs text-wt-conflict font-mono flex items-start gap-3">
          <div className="flex-1 whitespace-pre-wrap">{deleteErrors.join('\n')}</div>
          <button
            onClick={() => setDeleteErrors([])}
            className="text-wt-fg-2 hover:text-wt-fg"
            aria-label="dismiss errors"
          >
            ×
          </button>
        </div>
      )}
      {deleteInfo.length > 0 && (
        <div role="status" aria-live="polite" className="px-4 py-2 bg-wt-info/10 border-b border-wt-info/40 text-xs text-wt-info font-mono flex items-start gap-3">
          <div className="flex-1 whitespace-pre-wrap">{deleteInfo.join('\n')}</div>
          <button
            onClick={() => setDeleteInfo([])}
            className="text-wt-fg-2 hover:text-wt-fg"
            aria-label="dismiss info"
          >
            ×
          </button>
        </div>
      )}
      {filtered.length === 0 ? (
        <EmptyState title="No branches match" hint="Try a different filter." />
      ) : (
        <div className="flex-1 overflow-auto">
          <BranchTable
            branches={filtered}
            selection={selection}
            onToggle={toggle}
            onToggleAll={toggleAll}
          />
        </div>
      )}
      {/* Count is the filter ∩ selection size (matches `selectedBranches`,
          which is what the confirm dialog and the delete loop both consume).
          Reading the raw `selection.size` here would over-report when
          `toggleAll`'s scoped union/diff semantics have preserved
          out-of-filter selections — the user would see "5 selected" but the
          dialog would only list 3, and only 3 would actually get deleted.
          Mirrors WorktreesView's `selectedActionable.length` shape. */}
      <BulkActionBar count={selectedBranches.length} onAction={(m) => setConfirm(m)} />
      {confirm && (
        <ConfirmDeleteDialog
          branches={selectedBranches}
          mode={confirm}
          submitting={deleting}
          onCancel={() => setConfirm(null)}
          onConfirm={() => performDelete(confirm)}
        />
      )}
      {rejected && rejected.length > 0 && repo && (
        <ForceDeleteRejectedDialog
          rejected={rejected}
          submitting={deleting}
          onCancel={() => setRejected(null)}
          onConfirm={performForceDelete}
        />
      )}
    </div>
  );
}
