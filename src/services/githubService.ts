import type { PRInfo } from '../types';
import type { GithubTransport } from './githubTransport';
import { OctokitTransport } from './octokitTransport';
import { GhCliTransport } from './ghCliTransport';
import { readPrCacheFile, writePrCacheFile, ghExec } from './tauriBridge';

// Re-export mapping helpers so existing test imports still resolve.
export { mapChecksStatus, mapReviewDecision, mapMergeable } from './githubApiMapping';

// ── Auth method + transport state ──────────────────────────────────────

export type AuthMethod = 'gh-cli' | 'pat' | 'none';

let transport: GithubTransport | null = null;
let currentAuthMethod: AuthMethod = 'none';
// Kept for the PAT path: the OctokitTransport needs the raw token for its
// Octokit constructor, and hasGithubAuth() gates the "no auth" short-circuit
// in batchFetchPRs / listOpenPRsForBranches.
let currentToken = '';

export function getAuthMethod(): AuthMethod {
  return currentAuthMethod;
}

/** Detect whether `gh` CLI is installed and authenticated. */
export async function detectGhCli(): Promise<boolean> {
  try {
    const result = await ghExec(['auth', 'status', '--hostname', 'github.com']);
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Initialize the GitHub service. Accepts two call signatures:
 *   - `initGithub(method, token?)` — new method-based init
 *   - `initGithub(token)` — legacy string-only form (tests, backward compat)
 *
 * The legacy form maps non-empty string → 'pat', empty string → 'none'.
 */
export function initGithub(methodOrToken: AuthMethod | string, token?: string): void {
  let method: AuthMethod;
  let effectiveToken: string;

  // Distinguish: AuthMethod values are 'gh-cli' | 'pat' | 'none'.
  // Legacy callers pass a token string like 'test-token' or ''.
  if (methodOrToken === 'gh-cli' || methodOrToken === 'pat' || methodOrToken === 'none') {
    method = methodOrToken;
    effectiveToken = method === 'pat' ? (token ?? '') : '';
  } else {
    // Legacy string form
    effectiveToken = methodOrToken;
    method = effectiveToken ? 'pat' : 'none';
  }

  const prevToken = currentToken;
  currentAuthMethod = method;
  currentToken = effectiveToken;

  switch (method) {
    case 'gh-cli':
      transport = new GhCliTransport();
      break;
    case 'pat':
      transport = new OctokitTransport(currentToken);
      break;
    case 'none':
      transport = null;
      break;
  }

  // If the effective auth posture changed, drop the in-memory PR cache.
  if (prevToken !== currentToken || (method === 'gh-cli' && prevToken !== '')) {
    prCache.clear();
  }
}

export function hasGithubAuth(): boolean {
  return currentAuthMethod !== 'none';
}

// ── Token validation ───────────────────────────────────────────────────

export async function validateToken(): Promise<'missing' | 'valid' | 'invalid'> {
  if (!transport) return 'missing';
  return transport.validateAuth();
}

// ── PR cache ───────────────────────────────────────────────────────────

interface CacheEntry {
  at: number;
  pr: PRInfo | null;
}
const prCache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000;

interface PersistedCache {
  version: 1;
  entries: Record<string, CacheEntry>;
}

let hydratePromise: Promise<void> | null = null;
let persistDebounce: ReturnType<typeof setTimeout> | null = null;

const STALE_OPEN_PR_MS = 7 * 24 * 60 * 60 * 1000;

export function hydratePrCache(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    let raw: string | null = null;
    try {
      raw = await readPrCacheFile();
    } catch (e) {
      console.warn('[githubService] hydratePrCache read failed:', e);
      hydratePromise = null;
      return;
    }
    if (!raw) return;
    try {
      const parsed: PersistedCache = JSON.parse(raw);
      if (parsed.version !== 1 || !parsed.entries) return;
      const now = Date.now();
      for (const [k, v] of Object.entries(parsed.entries)) {
        const isOpen = v.pr?.state === 'open';
        if (isOpen && now - v.at > STALE_OPEN_PR_MS) continue;
        prCache.set(k, v);
      }
    } catch {
      /* corrupt cache: ignore and start fresh */
    }
  })();
  return hydratePromise;
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
  hydratePromise = null;
}

export function invalidatePrCacheForRepo(owner: string, repo: string): void {
  const prefix = `${owner}/${repo}#`;
  let removed = 0;
  for (const k of Array.from(prCache.keys())) {
    if (k.startsWith(prefix)) {
      prCache.delete(k);
      removed++;
    }
  }
  if (removed > 0) schedulePersist();
}

export function _getPrCacheKeysForTests(): string[] {
  return Array.from(prCache.keys());
}

// ── Single PR fetch ────────────────────────────────────────────────────

export async function getPR(owner: string, repo: string, number: number): Promise<PRInfo | null> {
  await hydratePrCache();
  const key = cacheKey(owner, repo, number);
  const hit = prCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.pr;
  if (!transport) return null;
  try {
    const pr = await transport.getPullRequest(owner, repo, number);
    prCache.set(key, { at: Date.now(), pr });
    schedulePersist();
    return pr;
  } catch (e: any) {
    // Only negative-cache the definitive 404 case. For auth/rate-limit/network
    // errors, leave cache untouched so a transient hiccup doesn't wipe data.
    if (e?.status === 404) {
      prCache.set(key, { at: Date.now(), pr: null });
      schedulePersist();
    }
    return null;
  }
}

// ── Batch PR fetch (GraphQL) ───────────────────────────────────────────

const BATCH_CHUNK_SIZE = 50;

export async function batchFetchPRs(
  owner: string,
  repo: string,
  numbers: number[],
): Promise<Map<number, PRInfo>> {
  await hydratePrCache();
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
  if (toFetch.length === 0 || !transport || currentAuthMethod === 'none') return out;

  for (let i = 0; i < toFetch.length; i += BATCH_CHUNK_SIZE) {
    const chunk = toFetch.slice(i, i + BATCH_CHUNK_SIZE);
    const chunkOut = await transport.batchGetPullRequests(owner, repo, chunk);
    for (const [n, pr] of chunkOut) {
      out.set(n, pr);
      prCache.set(cacheKey(owner, repo, n), { at: Date.now(), pr });
    }
    // Negative-cache any numbers that were requested but not returned.
    for (const n of chunk) {
      if (!chunkOut.has(n)) {
        prCache.set(cacheKey(owner, repo, n), { at: Date.now(), pr: null });
      }
    }
  }
  schedulePersist();
  return out;
}

// ── Open PR list ───────────────────────────────────────────────────────

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

export async function listOpenPRsForBranches(
  owner: string,
  repo: string,
  branchNames: string[],
): Promise<Map<string, PRInfo>> {
  const out = new Map<string, PRInfo>();
  if (!transport || !owner || !repo || branchNames.length === 0) return out;
  const wanted = new Set(branchNames);

  const key = openPrListCacheKey(owner, repo);
  const now = Date.now();
  const hit = openPrListCache.get(key);
  let prs: OpenPrListEntry[];
  if (hit && now - hit.at < OPEN_PR_LIST_TTL_MS) {
    prs = hit.prs;
  } else {
    try {
      prs = await transport.listOpenPullRequests(owner, repo);
      openPrListCache.set(key, { at: now, prs });
    } catch (e: any) {
      console.warn('[github] listOpenPRsForBranches failed', e?.status, e?.message);
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
