import { Octokit } from '@octokit/rest';
import type { PRInfo, ChecksStatus, ReviewDecision } from '../types';
import { readPrCacheFile, writePrCacheFile } from './tauriBridge';

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

// Persist in a shape we can round-trip as JSON. Map → plain object on write, and
// back on read.
interface PersistedCache {
  version: 1;
  entries: Record<string, CacheEntry>;
}

let hydrated = false;
let persistDebounce: ReturnType<typeof setTimeout> | null = null;

// Entries older than this for OPEN PRs are dropped on hydration — their
// checks/reviews/mergeable fields may have drifted on GitHub while the app
// was closed. Merged PRs are kept forever because their fields are immutable.
const STALE_OPEN_PR_MS = 7 * 24 * 60 * 60 * 1000;

// One-time load from disk. Callers can await this at startup, but we also lazy-load
// on the first cache hit so tests that never initialize don't hang.
export async function hydratePrCache(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  const raw = await readPrCacheFile();
  if (!raw) return;
  try {
    const parsed: PersistedCache = JSON.parse(raw);
    if (parsed.version !== 1 || !parsed.entries) return;
    const now = Date.now();
    for (const [k, v] of Object.entries(parsed.entries)) {
      // Drop stale open-PR entries on hydration. Merged PRs are kept forever
      // since their fields don't change once merged; treating them as fresh
      // lets a long-idle laptop reopen the app with its cache intact.
      const isOpen = v.pr?.state === 'open';
      if (isOpen && now - v.at > STALE_OPEN_PR_MS) continue;
      prCache.set(k, v);
    }
  } catch {
    /* corrupt cache: ignore and start fresh */
  }
}

function schedulePersist() {
  if (persistDebounce) clearTimeout(persistDebounce);
  persistDebounce = setTimeout(() => {
    const entries: Record<string, CacheEntry> = {};
    for (const [k, v] of prCache.entries()) entries[k] = v;
    const payload: PersistedCache = { version: 1, entries };
    void writePrCacheFile(JSON.stringify(payload));
  }, 500);
}

function cacheKey(owner: string, repo: string, n: number) {
  return `${owner}/${repo}#${n}`;
}

export function _clearPrCacheForTests() {
  prCache.clear();
  hydrated = false;
}

// Test-only: snapshot the in-memory cache keys. Used to verify hydration
// behavior without going through getPR, which applies its own TTL on top.
export function _getPrCacheKeysForTests(): string[] {
  return Array.from(prCache.keys());
}

// Kept as the single-PR fallback for cache misses outside the batch path.
export async function getPR(owner: string, repo: string, number: number): Promise<PRInfo | null> {
  if (!hydrated) await hydratePrCache();
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
      isDraft: data.draft ?? false,
      mergeable: data.mergeable ?? null,
    };
    prCache.set(key, { at: Date.now(), pr });
    schedulePersist();
    return pr;
  } catch (e: any) {
    // Only negative-cache the definitive "PR doesn't exist" case (404). For
    // 401/403/network/5xx, leave the cache untouched so a transient hiccup
    // doesn't wipe PR data for the next 5 minutes (and worse, persist that
    // null entry to disk).
    if (e?.status === 404) {
      prCache.set(key, { at: Date.now(), pr: null });
      schedulePersist();
    }
    return null;
  }
}

// Chunk size for GraphQL alias batching. GitHub's GraphQL API has a 500-point
// complexity limit and a practical query-size ceiling; keeping chunks at 50
// leaves plenty of headroom on repos with hundreds of open PRs.
const BATCH_CHUNK_SIZE = 50;

async function runBatchChunk(
  owner: string,
  repo: string,
  chunk: number[],
): Promise<Map<number, PRInfo>> {
  const out = new Map<number, PRInfo>();
  if (chunk.length === 0) return out;

  const aliased = chunk
    .map(
      (n) => `p${n}: pullRequest(number: ${n}) {
        number
        title
        state
        merged
        mergedAt
        mergeCommit { oid }
        headRefName
        url
        isDraft
        mergeable
        reviewDecision
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup { state }
            }
          }
        }
      }`,
    )
    .join('\n');

  const query = `query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      ${aliased}
    }
  }`;

  try {
    const data: any = await octokit!.graphql(query, { owner, repo });
    const repoNode = data?.repository ?? {};
    for (const n of chunk) {
      const node = repoNode[`p${n}`];
      if (!node) {
        prCache.set(cacheKey(owner, repo, n), { at: Date.now(), pr: null });
        continue;
      }
      const pr = graphqlNodeToPRInfo(node);
      out.set(n, pr);
      prCache.set(cacheKey(owner, repo, n), { at: Date.now(), pr });
    }
  } catch {
    // On failure, leave cache untouched so REST fallback can retry on subsequent calls.
  }
  return out;
}

// Batch PR fetch via GraphQL. Splits large requests into CHUNK_SIZE-sized
// groups and issues them sequentially (not in parallel — GitHub rate-limiting
// is expensive to hit, and for steady-state refreshes most chunks are cached).
// Returns a Map keyed by PR number. Missing PRs (404, bad token) are absent
// from the map. Cached hits are served from the in-memory cache and removed
// from the outbound query.
export async function batchFetchPRs(
  owner: string,
  repo: string,
  numbers: number[],
): Promise<Map<number, PRInfo>> {
  if (!hydrated) await hydratePrCache();
  const out = new Map<number, PRInfo>();
  const unique = Array.from(new Set(numbers));
  const toFetch: number[] = [];
  for (const n of unique) {
    const key = cacheKey(owner, repo, n);
    const hit = prCache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) {
      if (hit.pr) out.set(n, hit.pr);
    } else {
      toFetch.push(n);
    }
  }
  if (!octokit) initGithub('');
  if (toFetch.length === 0 || !currentToken) return out;

  for (let i = 0; i < toFetch.length; i += BATCH_CHUNK_SIZE) {
    const chunk = toFetch.slice(i, i + BATCH_CHUNK_SIZE);
    const chunkOut = await runBatchChunk(owner, repo, chunk);
    for (const [n, pr] of chunkOut) out.set(n, pr);
  }
  schedulePersist();
  return out;
}

function graphqlNodeToPRInfo(node: any): PRInfo {
  // `state` is OPEN/CLOSED/MERGED in GraphQL; align with REST shape.
  let state: PRInfo['state'];
  if (node.merged) state = 'merged';
  else if (node.state === 'OPEN') state = 'open';
  else state = 'closed';

  const rollup: string | undefined = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  const checksStatus: ChecksStatus = mapChecksStatus(rollup);

  const reviewDecision: ReviewDecision = mapReviewDecision(node.reviewDecision);

  return {
    number: node.number,
    title: node.title ?? '',
    state,
    mergedAt: node.mergedAt ?? undefined,
    mergeCommitSha: node.mergeCommit?.oid ?? undefined,
    headRef: node.headRefName,
    url: node.url,
    isDraft: !!node.isDraft,
    mergeable: mapMergeable(node.mergeable),
    checksStatus,
    reviewDecision,
  };
}

export function mapChecksStatus(rollup: string | undefined | null): ChecksStatus {
  switch (rollup) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'none';
  }
}

export function mapReviewDecision(decision: string | undefined | null): ReviewDecision {
  switch (decision) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'REVIEW_REQUIRED':
      return 'review_required';
    default:
      return null;
  }
}

// GraphQL mergeable is MERGEABLE / CONFLICTING / UNKNOWN.
export function mapMergeable(m: string | undefined | null): boolean | null {
  if (m === 'MERGEABLE') return true;
  if (m === 'CONFLICTING') return false;
  return null;
}

// TTL cache for the paginated open-PR list. Without this, the 5s refresh
// loop fully re-paginated `pulls.list` every tick — on a repo with hundreds
// of open PRs that's hundreds of REST calls per minute against the token's
// 5,000/hr budget. The cache stores the *unfiltered* list (every open PR for
// the repo, regardless of branch set) so callers with different branch sets
// can share the same entry. The fetch loop calls `invalidateOpenPrListCache`
// after a successful `git fetch --all --prune` so newly-pushed branches show
// up promptly.
type OpenPrListEntry = Omit<PRInfo, 'state'>;
interface OpenPrListCacheEntry {
  at: number;
  prs: OpenPrListEntry[];
}
const openPrListCache = new Map<string, OpenPrListCacheEntry>();
const OPEN_PR_LIST_TTL_MS = 60_000;

function openPrListCacheKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

export function invalidateOpenPrListCache(owner?: string, repo?: string): void {
  if (owner && repo) openPrListCache.delete(openPrListCacheKey(owner, repo));
  else openPrListCache.clear();
}

export function _getOpenPrListCacheKeysForTests(): string[] {
  return Array.from(openPrListCache.keys());
}

// Paginate every open PR so large repos aren't capped at 100. Caches the
// unfiltered result for OPEN_PR_LIST_TTL_MS — see the cache notes above.
export async function listOpenPRsForBranches(
  owner: string,
  repo: string,
  branchNames: string[],
): Promise<Map<string, PRInfo>> {
  const out = new Map<string, PRInfo>();
  if (!octokit || branchNames.length === 0) return out;
  const wanted = new Set(branchNames);

  const key = openPrListCacheKey(owner, repo);
  const now = Date.now();
  const hit = openPrListCache.get(key);
  let prs: OpenPrListEntry[];
  if (hit && now - hit.at < OPEN_PR_LIST_TTL_MS) {
    prs = hit.prs;
  } else {
    try {
      const all = await octokit.paginate(octokit.pulls.list, {
        owner,
        repo,
        state: 'open',
        per_page: 100,
      });
      prs = all.map((p) => ({
        number: p.number,
        title: p.title,
        headRef: p.head.ref,
        url: p.html_url,
        isDraft: p.draft ?? false,
      }));
      openPrListCache.set(key, { at: now, prs });
    } catch {
      // On failure, fall back to whatever stale entry we have rather than
      // dropping PR info on transient network errors.
      prs = hit?.prs ?? [];
    }
  }

  for (const p of prs) {
    if (wanted.has(p.headRef)) {
      out.set(p.headRef, { ...p, state: 'open' });
    }
  }
  return out;
}
