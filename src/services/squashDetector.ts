import type { Branch, MainCommit, SquashMapping, PRInfo } from '../types';
import { batchFetchPRs } from './githubService';
import { cherryCheck, resolveMainUpstreams } from './gitService';

// Cache cherry-check results by (branch head sha, main head sha). Lives for
// the process lifetime — no TTL needed because the key is content-addressed:
// if either sha moves, the key changes and the entry misses. Saves a
// subprocess spawn per still-unmerged branch on every refresh when nothing
// has changed, which dominates cost on repos with 100+ stale branches.
const cherryCache = new Map<string, boolean>();

// Exported for tests only.
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
