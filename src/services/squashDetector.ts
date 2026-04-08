import type { Branch, MainCommit, SquashMapping, PRInfo } from '../types';
import { batchFetchPRs } from './githubService';
import { cherryCheck } from './gitService';

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
      if (match && match.mergeStatus === 'unmerged' && isLikelySquash) {
        match.mergeStatus = 'squash-merged';
        match.pr = pr;
      } else if (match) {
        match.pr = pr;
      }
      prByBranch.set(sourceBranch, pr);
    }
  }

  // Fallback: cherry-based patch-id check for remaining unmerged
  for (const b of branchIndex.values()) {
    if (b.mergeStatus !== 'unmerged') continue;
    if (b.aheadOfMain === 0) continue;
    try {
      const ref = b.hasLocal ? b.name : `origin/${b.name}`;
      const squashed = await cherryCheck(input.repoPath, input.defaultBranch, ref);
      if (squashed) b.mergeStatus = 'squash-merged';
    } catch {
      /* ignore */
    }
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
