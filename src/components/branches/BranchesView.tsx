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
  const toggleAll = useCallback(() => {
    setSelection((prev) => {
      if (filtered.every((b) => prev.has(b.name))) return new Set();
      return new Set(filtered.map((b) => b.name));
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
                // Idempotent tag-already-exists handling: mirrors the same
                // shape performForceDelete uses. If the tag name is already
                // taken (e.g. branch-name reuse after a prior archive+delete,
                // or an interrupted retry), compare the existing tag's commit
                // to `archiveSha` (the tip we captured before deleting). Same
                // SHA = the earlier archive already covers this state; surface
                // as info. Different SHA = the old archive points elsewhere,
                // and the branch is already gone, so the new tip is now only
                // reachable via reflog — push a clear error naming both short
                // SHAs so the user can recover with `git tag` manually.
                const tagName = archiveTagNameFor(b.name);
                try {
                  await tagBranch(repo.path, archiveSha, tagName);
                } catch (tagErr: any) {
                  const tagMsg = String(tagErr?.message ?? tagErr);
                  if (!/already exists/.test(tagMsg)) {
                    errors.push(`${b.name}: ${tagMsg}`);
                    continue;
                  }
                  try {
                    const existingTagSha = await resolveCommitSha(repo.path, tagName);
                    if (existingTagSha === archiveSha) {
                      infos.push(
                        `${b.name}: archive tag ${tagName} already existed at this tip — reused`,
                      );
                    } else {
                      // Archive preservation could not be proven (tag points
                      // elsewhere). Abort before the remote delete — if we
                      // can't vouch for the archive, we can't destroy the
                      // last remote reference either. `continue` skips the
                      // outer-loop remote-delete step below.
                      errors.push(
                        `${b.name}: branch deleted but archive tag ${tagName} already exists at a different commit (existing=${existingTagSha.slice(0, 7)}, wanted=${archiveSha.slice(0, 7)}) — use \`git tag <new-name> ${archiveSha.slice(0, 7)}\` to preserve the deleted tip; remote ref was NOT deleted`,
                      );
                      continue;
                    }
                  } catch (cmpErr: any) {
                    // Same rationale as the SHA-mismatch branch above: if we
                    // can't verify the existing tag at all, we can't prove
                    // archive preservation, so don't proceed to remote delete.
                    errors.push(
                      `${b.name}: branch deleted but archive tag ${tagName} verification failed (${cmpErr?.message ?? cmpErr}); remote ref was NOT deleted`,
                    );
                    continue;
                  }
                }
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
          // When the local delete was deferred to the force-delete dialog
          // (`localDeferredToForce === true`), we also defer the remote delete to
          // performForceDelete. Deleting the remote here would leave the local ref
          // stranded if the user cancels the force dialog; the remote is re-issued
          // on confirm via `wantsRemote` in performForceDelete.
          if (deletesRemote && b.hasRemote && !localDeferredToForce) {
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
        try {
          if (item.branch.hasLocal) {
            // Tag FIRST, still — just moved here from performDelete so the tag
            // only lands when the user actually confirms the force-delete.
            // Covers every deferred archive-and-delete item regardless of
            // mergeStatus (squash-merged, unmerged, stale, other), so the
            // user's archive intent is honored even for unmerged/stale
            // branches. A pre-existing archive tag is ONLY treated as
            // "archive intent already satisfied" when it points at the same
            // commit as the current branch tip — the interrupted-retry case
            // (same branch, same tip, tag already created before we crashed).
            // If the existing tag points at a DIFFERENT commit (branch name
            // reused after a prior archive, or a manually-created tag), we
            // abort this item with a clear error rather than force-deleting
            // commits with no archive ref pointing at them. Any OTHER
            // tag-creation failure (permissions, corrupted refs) also aborts
            // via `continue` so we don't silently delete commits the user
            // wanted preserved. LC_ALL=C in git_exec keeps the stderr string
            // stable English.
            if (item.mode === 'archive-and-delete') {
              const tagName = archiveTagNameFor(item.branch.name);
              try {
                await tagBranch(repo.path, item.branch.name, tagName);
              } catch (e: any) {
                const msg = String(e?.message ?? e);
                if (!/already exists/.test(msg)) {
                  errors.push(`${item.branch.name}: ${msg}`);
                  continue;
                }
                // "already exists" — verify the existing tag points at the
                // same commit as the branch tip before swallowing. If we
                // can't resolve either ref, abort (resolveCommitSha throws).
                try {
                  const [tagSha, branchSha] = await Promise.all([
                    resolveCommitSha(repo.path, tagName),
                    resolveCommitSha(repo.path, item.branch.name),
                  ]);
                  if (tagSha !== branchSha) {
                    errors.push(
                      `${item.branch.name}: archive tag ${tagName} already exists but points to a different commit (tag=${tagSha.slice(0, 7)}, branch=${branchSha.slice(0, 7)}); aborting force-delete to avoid losing commits`,
                    );
                    continue;
                  }
                  // Same SHA — a prior interrupted retry already created this
                  // tag. Surface it as an info note so the user can see their
                  // earlier archive was preserved rather than silently assumed.
                  infos.push(`${item.branch.name}: archive tag ${tagName} already existed at this tip — reused`);
                } catch (cmpErr: any) {
                  errors.push(`${item.branch.name}: ${cmpErr?.message ?? cmpErr}`);
                  continue;
                }
              }
            }
            await deleteLocalBranch(repo.path, item.branch.name, true);
          }
          // Honor the original mode: if the user picked `both` or `archive-and-delete`,
          // their confirmation covered the remote ref too, so remove it now that the
          // local force-delete succeeded.
          const wantsRemote = item.mode === 'both' || item.mode === 'archive-and-delete';
          if (wantsRemote && item.branch.hasRemote) {
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
      <BulkActionBar count={selection.size} onAction={(m) => setConfirm(m)} />
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
