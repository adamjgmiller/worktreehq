import type { Branch, MainCommit, SquashMapping, PRInfo } from '../types';
import { batchFetchPRs } from './githubService';
import { cherryCheck, resolveMainUpstreams } from './gitService';
import { TTLCache } from './cacheUtils';

// Cache cherry-check results by (branch head sha, main head sha). Lives for
// the process lifetime — no TTL needed because the key is content-addressed:
// if either sha moves, the key changes and the entry misses. Saves a
// subprocess spawn per still-unmerged branch on every refresh when nothing
// has changed, which dominates cost on repos with 100+ stale branches.
const cherryCache = new TTLCache<string, boolean>();

export function _clearCherryCacheForTests() {
  cherryCache.clear();
}

export interface DetectInput {
  repoPath: string;
  defaultBranch: string;
  mainCommits: MainCommit[];
  branches: Branch[];
  tags: string[];
  owner?: string;
  name?: string;
}

export interface DetectResult {
  mappings: SquashMapping[];
  prByBranch: Map<string, PRInfo>;
  updatedBranches: Branch[];
}

// Matches `(#123)` possibly trailing whitespace; exported for tests.
export function parsePrNumberFromSubject(subject: string): number | undefined {
  const m = subject.match(/\(#(\d+)\)\s*$/);
  return m ? parseInt(m[1], 10) : undefined;
}

export function isStale(b: Branch, now = Date.now()): boolean {
  if (b.mergeStatus !== 'unmerged') return false;
  if (!b.lastCommitDate) return false;
  const t = new Date(b.lastCommitDate).getTime();
  if (Number.isNaN(t)) return false;
  const days = (now - t) / (1000 * 60 * 60 * 24);
  return days >= 30;
}

export async function detectSquashMerges(input: DetectInput): Promise<DetectResult> {
  const { mainCommits, branches, tags, owner, name } = input;
  const mappings: SquashMapping[] = [];
  const prByBranch = new Map<string, PRInfo>();
  const branchIndex = new Map<string, Branch>();
  for (const b of branches) branchIndex.set(b.name, { ...b });

  if (owner && name) {
    // Collect every PR number referenced by a (#N) tag on main, batch-fetch them in
    // a single GraphQL call, then attribute each main commit to its PR.
    const prNumbers: number[] = [];
    for (const c of mainCommits) {
      if (c.prNumber) prNumbers.push(c.prNumber);
    }
    const prMap = await batchFetchPRs(owner, name, prNumbers);

    for (const c of mainCommits) {
      if (!c.prNumber) continue;
      const pr = prMap.get(c.prNumber);
      if (!pr) continue;
      // GitHub populates merge_commit_sha for all three merge strategies (merge,
      // squash, rebase). The disambiguating signal is that only squash and merge
      // produce a commit whose first-parent on main EQUALS merge_commit_sha — a
      // rebase-merge replays the branch's commits inline, so merge_commit_sha
      // points at the tip of the replayed run, not at a first-parent commit. We
      // walked `git log main --first-parent` to get `c.sha`, so matching it to
      // pr.mergeCommitSha catches squash-merged PRs (and harmlessly also catches
      // merge-commit PRs, which pass pr.state === 'merged' anyway).
      const isLikelySquash = pr.state === 'merged' && pr.mergeCommitSha === c.sha;
      const sourceBranch = pr.headRef;
      const archiveTag = tags.includes(`archive/${sourceBranch}`) ? `archive/${sourceBranch}` : undefined;
      mappings.push({
        squashCommitSha: c.sha,
        squashSubject: c.subject,
        squashDate: c.date,
        prNumber: pr.number,
        sourceBranch,
        archiveTag,
      });
      const match = branchIndex.get(sourceBranch);
      // Guard: don't tag a branch as squash-merged when it carries an open PR.
      // A merged PR from a previous iteration of the same branch name (common
      // in fork workflows) would otherwise clobber the live open-PR state and
      // show a misleading "MERGED (SQUASH)" pill while the user is still
      // actively working through the PR.
      const hasOpenPR = match?.pr?.state === 'open';
      // Guard: don't tag an `empty` branch (aheadOfMain === 0) as squash-merged
      // based solely on a branch-name match against a historical PR. A branch
      // with zero commits of its own cannot currently contain whatever was
      // merged — any match is a name collision with a previously merged-and-
      // deleted branch that the user has since recreated for unrelated work.
      // `empty` branches still appear in the "safe to delete" filter via the
      // no-worktree + >1 day rule, so bulk cleanup is unaffected.
      if (match && match.mergeStatus === 'unmerged' && isLikelySquash && !hasOpenPR) {
        match.mergeStatus = 'squash-merged';
        // Only attach the historical merged PR when the branch doesn't
        // already carry an open PR from refreshLoop's listOpenPRsForBranches
        // pass — otherwise we'd clobber checksStatus / reviewDecision /
        // mergeable on a live open PR with stale merged-PR data.
        if (!match.pr || match.pr.state !== 'open') {
          match.pr = pr;
        }
      } else if (match && match.mergeStatus !== 'empty') {
        if (!match.pr || match.pr.state !== 'open') {
          match.pr = pr;
        }
      }
      prByBranch.set(sourceBranch, pr);
    }

    // Supplementary pass for the narrow `pr-<N>` fallback name.
    //
    // `gh pr checkout N` normally names the local branch after the PR's
    // `HeadRefName` (e.g. `patch-2`, `feature/multi-users`) — the common
    // case is already covered by pass 1 above, which matches on
    // `pr.headRef === sourceBranch`. gh only falls back to `pr-<N>` in a
    // narrow cross-repo case where the head ref name would collide (most
    // notably when a fork's head ref equals the target repo's default
    // branch). Pass 1 can't catch that fallback because `pr.headRef` on
    // GitHub is still the fork's branch name, not `pr-<N>` — so match it
    // here by local name. Re-uses the already-fetched prMap, so no extra
    // network I/O.
    //
    // Guards:
    //   - `mainShaSet` mirrors pass 1's `isLikelySquash` — only tag when the
    //     PR's merge commit actually appears on main's first-parent history.
    //   - `mergeTimeHeadSha` pins the tag to *merge-time content* equality:
    //     the local ref must still point at the PR's head commit AS IT
    //     EXISTED WHEN MERGED, not the PR's current live head. GitHub's
    //     `pr.headSha` advances if the author pushes commits after merge,
    //     so using it directly would let post-merge pushes silently
    //     classify a `pr-<N>` branch (with matching live tip) as
    //     squash-merged even though the new commits aren't on main.
    //     `githubService.setPrCacheEntry` freezes this on first
    //     merged-state observation. `mergeTimeHeadSha` is optional on
    //     PRInfo (cache entries from before this field existed lack it)
    //     so the guard fails closed — no mergeTimeHeadSha means we refuse
    //     to tag, and the first cache refresh will bootstrap it.
    //   - `mergeTimeHeadShaObservedLive` distinguishes freezes captured
    //     from a non-merged → merged transition this code witnessed
    //     (trusted) from cold-bootstrap freezes taken from live
    //     `pr.headSha` on first-ever observation of an already-merged PR
    //     (untrusted — the live head may already be post-merge-advanced).
    //     Fail closed when false: pre-existing merged PRs seen for the
    //     first time on this install fall through to the cherry-check
    //     pass or stay `unmerged`.
    const mainShaSet = new Set(mainCommits.map((c) => c.sha));
    for (const b of branchIndex.values()) {
      if (b.mergeStatus !== 'unmerged') continue;
      // Only consider local pr-<N> refs: the `gh pr checkout N` flow this
      // pass is compensating for creates a local ref. Remote-only `origin/pr-N`
      // names are rare but possible and the headSha/mainSha guards would still
      // let them through without this gate.
      if (!b.hasLocal) continue;
      const m = b.name.match(/^pr-(\d+)$/);
      if (!m) continue;
      const pr = prMap.get(parseInt(m[1], 10));
      if (!pr) continue;
      if (pr.state !== 'merged' || !pr.mergeCommitSha) continue;
      if (!mainShaSet.has(pr.mergeCommitSha)) continue;
      if (!pr.mergeTimeHeadSha || !pr.mergeTimeHeadShaObservedLive) continue;
      if (b.lastCommitSha !== pr.mergeTimeHeadSha) continue;
      if (b.pr?.state === 'open') continue;
      b.mergeStatus = 'squash-merged';
      // Attach the merged PR. The open-PR guard above already skipped any
      // branch that currently carries an open PR, so we won't clobber a live
      // one. A closed or merged PR already on `b` (e.g. from the on-disk PR
      // cache of a prior run) may be overwritten by the freshly-fetched
      // prMap entry — benign because both describe the same terminal PR
      // state but sourced from the newer fetch.
      b.pr = pr;
      // Intentionally not emitting a new SquashMapping: the archaeology view
      // represents the PR merge event (one per PR), not the local ref. Pass 1
      // already emitted the mapping keyed at pr.headRef.
      //
      // Back-patch the pass-1 mapping's archiveTag for the `pr-<N>` alias
      // case. `archiveTagNameFor(b.name)` creates `archive/pr-<N>` when the
      // user archive-and-deletes this branch, not `archive/<pr.headRef>` that
      // pass 1 looks for. Without this, Squash Archaeology shows "no archive
      // tag found" even though the tag exists. Prefer the canonical
      // `archive/<pr.headRef>` when pass 1 already found one; only fill in the
      // alias name when the canonical slot is empty.
      const aliasTag = `archive/${b.name}`;
      if (tags.includes(aliasTag)) {
        const mapping = mappings.find((mm) => mm.prNumber === pr.number);
        if (mapping && !mapping.archiveTag) {
          mapping.archiveTag = aliasTag;
        }
      }
    }
  }

  // Fallback: cherry-based patch-id check for remaining unmerged. Parallelized
  // because each cherry-check is independent and subprocess-bound, and cached
  // by (branch sha, main sha) so steady-state refreshes skip the subprocess
  // entirely when nothing has moved.
  // Exclude branches that carry an open PR — their patches may be on main
  // via a different PR (or a cherry-pick), and the cherry-check can't tell
  // the difference from a genuine squash merge. Tagging them squash-merged
  // would show a misleading pill while the user's PR is still in flight.
  // When the PR is finally merged, the PR-tag pass (above) catches it on
  // the next refresh without needing the cherry fallback.
  const cherryCandidates = Array.from(branchIndex.values()).filter(
    (b) => b.mergeStatus === 'unmerged' && b.aheadOfMain > 0 && b.pr?.state !== 'open',
  );
  // Resolve the main-history ref set ONCE per run rather than per branch.
  // This is the set that `cherryCheck` unions its patch-id check against;
  // it includes `origin/<defaultBranch>` when that remote-tracking ref
  // exists, which is how squash commits merged on GitHub get detected
  // before the user has fast-forwarded their local main.
  const upstreams =
    cherryCandidates.length > 0
      ? await resolveMainUpstreams(input.repoPath, input.defaultBranch)
      : [input.defaultBranch];
  const mainSha = mainCommits[0]?.sha ?? '';
  const cherryResults = await Promise.all(
    cherryCandidates.map(async (b) => {
      const key = `${b.name}@${b.lastCommitSha}|${mainSha}`;
      const cached = cherryCache.get(key);
      if (cached !== undefined) return [b, cached] as const;
      try {
        const ref = b.hasLocal ? b.name : `origin/${b.name}`;
        const squashed = await cherryCheck(input.repoPath, upstreams, ref);
        cherryCache.set(key, squashed);
        return [b, squashed] as const;
      } catch {
        // Don't cache failures — they may be transient (e.g. a ref race during
        // rebase). Retry on the next refresh.
        return [b, false] as const;
      }
    }),
  );
  for (const [b, squashed] of cherryResults) {
    if (squashed) b.mergeStatus = 'squash-merged';
  }

  // Stale rule
  const now = Date.now();
  for (const b of branchIndex.values()) {
    if (isStale(b, now)) b.mergeStatus = 'stale';
  }

  return {
    mappings,
    prByBranch,
    updatedBranches: Array.from(branchIndex.values()),
  };
}
