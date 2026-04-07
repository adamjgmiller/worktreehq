import { Octokit } from '@octokit/rest';
import type { PRInfo } from '../types';

let octokit: Octokit | null = null;
let currentToken = '';

export function initGithub(token: string) {
  currentToken = token;
  octokit = token ? new Octokit({ auth: token }) : new Octokit();
}

export function hasGithubAuth(): boolean {
  return !!currentToken;
}

interface CacheEntry {
  at: number;
  pr: PRInfo | null;
}
const prCache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000;

function cacheKey(owner: string, repo: string, n: number) {
  return `${owner}/${repo}#${n}`;
}

export async function getPR(owner: string, repo: string, number: number): Promise<PRInfo | null> {
  const key = cacheKey(owner, repo, number);
  const hit = prCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.pr;
  if (!octokit) initGithub('');
  try {
    const { data } = await octokit!.pulls.get({ owner, repo, pull_number: number });
    const pr: PRInfo = {
      number: data.number,
      title: data.title,
      state: data.merged ? 'merged' : (data.state as 'open' | 'closed'),
      mergedAt: data.merged_at ?? undefined,
      mergeCommitSha: data.merge_commit_sha ?? undefined,
      headRef: data.head.ref,
      url: data.html_url,
      // GitHub API doesn't directly return merge method on pulls.get;
      // infer from squash detection at the caller level.
    };
    prCache.set(key, { at: Date.now(), pr });
    return pr;
  } catch (e) {
    prCache.set(key, { at: Date.now(), pr: null });
    return null;
  }
}

export async function listOpenPRsForBranches(
  owner: string,
  repo: string,
  branchNames: string[],
): Promise<Map<string, PRInfo>> {
  const out = new Map<string, PRInfo>();
  if (!octokit || branchNames.length === 0) return out;
  try {
    const { data } = await octokit.pulls.list({ owner, repo, state: 'open', per_page: 100 });
    for (const p of data) {
      if (branchNames.includes(p.head.ref)) {
        out.set(p.head.ref, {
          number: p.number,
          title: p.title,
          state: 'open',
          headRef: p.head.ref,
          url: p.html_url,
        });
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}
