import type { PRInfo } from '../types';
import type { GithubTransport } from './githubTransport';
import { OctokitTransport } from './octokitTransport';
import { GhCliTransport } from './ghCliTransport';
import { readPrCacheFile, writePrCacheFile, ghExec } from './tauriBridge';
import { TTLCache } from './cacheUtils';

// Re-export mapping helpers so existing test imports still resolve.
export { mapChecksStatus, mapReviewDecision, mapMergeable } from './githubApiMapping';

// ── Auth method + transport state ──────────────────────────────────────

export type AuthMethod = 'gh-cli' | 'pat' | 'none';

let transport: GithubTransport | null = null;
let currentAuthMethod: AuthMethod = 'none';
// Kept for the PAT path: the OctokitTransport needs the raw token for its
// Octokit constructor.
let currentToken = '';

/** Detect whether `gh` CLI is installed and authenticated.
 *  Races the actual `gh auth status` call against a 3-second timeout so a
 *  hung `gh` process doesn't block the bootstrap critical path. */
export async function detectGhCli(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('gh cli detection timed out')), 3000);
    });
    const result = await Promise.race([
      ghExec(['auth', 'status', '--hostname', 'github.com']),
      timeout,
    ]);
    return result.code === 0;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
  const prevMethod = currentAuthMethod;
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

  // If the effective auth posture changed, drop both in-memory caches.
  // Covers: token swap (PAT→PAT), method switch (gh-cli→none, pat→gh-cli),
  // and re-init of gh-cli with a previously active PAT. The open-PR list
  // cache must be cleared alongside the per-PR cache — otherwise switching
  // from 'none' to an authenticated method serves a stale (empty) open-PR
  // list for up to 60 seconds.
  if (prevToken !== currentToken || prevMethod !== method) {
    prCache.clear();
    openPrListCache.clear();
    liveObservations.clear();
  }
}

// ── Token validation ───────────────────────────────────────────────────

/** Delegates to the active transport. Returns 'valid' (not 'invalid')
 *  on inconclusive network errors to avoid a misleading auth-failure
 *  pill during transient outages (e.g. airport wifi). */
export async function validateToken(): Promise<'missing' | 'valid' | 'invalid'> {
  if (!transport) return 'missing';
  return transport.validateAuth();
}

// ── PR cache ───────────────────────────────────────────────────────────

// maxSize caps memory growth now that invalidation is soft-mark-stale
// (expired entries stay in the map so `getStale()` can preserve the
// `mergeTimeHeadSha` freeze across refetches). The FIFO trim drops the
// oldest 25% when the cap is hit. 500 entries ≈ the largest real-world
// PR-count-times-repo-count we'd expect on one machine.
const prCache = new TTLCache<string, PRInfo | null>({
  ttlMs: 5 * 60 * 1000,
  maxSize: 500,
});

interface PersistedCacheEntry {
  at: number;
  pr: PRInfo | null;
}
interface PersistedCache {
  version: 1;
  entries: Record<string, PersistedCacheEntry>;
}

let hydratePromise: Promise<void> | null = null;
let persistDebounce: ReturnType<typeof setTimeout> | null = null;

// Keys observed with state !== 'merged' during the current process lifetime.
// Gates `setPrCacheEntry`'s live-transition branch — the prior proxy of
// `priorInCache.state !== 'merged'` misfired after app restart because
// `hydratePrCache` rehydrates persisted open entries that look identical to
// live observations. Not persisted: cold-bootstrap-after-restart must fail
// closed (observedLive=false, pass 1b refuses to tag). Cleared in lockstep
// with `prCache` on auth switch and in test teardown.
const liveObservations = new Set<string>();

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
        prCache.setWithTimestamp(k, v.pr, v.at);
      }
      // setWithTimestamp intentionally skips the FIFO trim (cacheUtils.ts:57)
      // so callers can bulk-load without per-entry overhead. Trim once here
      // to enforce `maxSize` from the moment the cache becomes usable.
      prCache.trim();
    } catch {
      /* corrupt cache: ignore and start fresh */
    }
  })();
  return hydratePromise;
}

function schedulePersist() {
  if (persistDebounce) clearTimeout(persistDebounce);
  persistDebounce = setTimeout(() => {
    const entries: Record<string, PersistedCacheEntry> = {};
    for (const [k, entry] of prCache.entries()) {
      entries[k] = { at: entry.at, pr: entry.value };
    }
    const payload: PersistedCache = { version: 1, entries };
    void writePrCacheFile(JSON.stringify(payload));
  }, 500);
}

function cacheKey(owner: string, repo: string, n: number) {
  return `${owner}/${repo}#${n}`;
}

/**
 * Cache a freshly-fetched PR while preserving `mergeTimeHeadSha` across
 * updates. Use this instead of `prCache.set()` for positive cache writes.
 *
 * Rationale: `pr.headSha` from GitHub is the LIVE head-ref tip. For merged
 * PRs, the author (or automation) can push commits after the merge, which
 * advances `headSha` past the merged content. The supplementary `pr-<N>`
 * detector pass needs a stable "head at merge time" anchor — otherwise a
 * user with a local `pr-N` following those post-merge commits would get
 * their unmerged work silently classified squash-merged.
 *
 * Freeze strategy and observed-live flag:
 *   - Prior cache entry has a freeze (live or bootstrapped): preserve both
 *     the frozen SHA and the observed-live flag.
 *   - We observed this key as non-merged in-process (tracked via the
 *     module-local `liveObservations` Set): freeze from current
 *     `pr.headSha`, set observedLive=true.
 *   - Otherwise (no prior freeze AND no in-process live observation — cold
 *     bootstrap, or first post-restart fetch with only a rehydrated prior):
 *     freeze from current `pr.headSha` (imperfect if the author pushed
 *     post-merge before we ever saw this PR live), set observedLive=false.
 *     The `pr-<N>` detector pass requires observedLive=true to tag, so
 *     cold bootstraps fail closed there.
 *
 * Why the in-memory Set instead of `priorInCache.state !== 'merged'`:
 * rehydrated persisted open entries look identical to live observations
 * under that proxy, so an app restart followed by a refetch that finds the
 * PR merged would falsely flag observedLive=true. The Set is not persisted,
 * so it dies with the process and the first post-restart observation falls
 * through to the cold-bootstrap branch.
 *
 * Cross-invalidation preservation is handled by `invalidatePrCacheForRepo`
 * soft-expiring entries rather than deleting them — `prCache.getStale()`
 * still returns the prior state via the first branch here.
 */
function setPrCacheEntry(key: string, pr: PRInfo | null): PRInfo | null {
  if (pr && pr.state !== 'merged') {
    liveObservations.add(key);
  }
  if (pr && pr.state === 'merged') {
    const priorInCache = prCache.getStale(key);
    let frozen: string | null | undefined;
    let observedLive: boolean;
    if (priorInCache?.mergeTimeHeadSha) {
      // Prior freeze wins — preserves across refetch and across soft-
      // invalidation (entry still accessible via getStale even when
      // `get()` returns undefined after `expire`).
      frozen = priorInCache.mergeTimeHeadSha;
      observedLive = priorInCache.mergeTimeHeadShaObservedLive ?? false;
    } else if (liveObservations.has(key)) {
      // Witnessed the open→merged transition in-process: we saw this key
      // as non-merged earlier in this session, so `pr.headSha` is the
      // actual merge-time tip.
      frozen = pr.headSha;
      observedLive = true;
    } else {
      // Cold bootstrap OR first post-restart observation: no in-process
      // witness of a non-merged state, so `pr.headSha` may already be
      // post-merge-advanced. Flag so the detector fails closed on pass 1b.
      frozen = pr.headSha;
      observedLive = false;
    }
    pr = { ...pr, mergeTimeHeadSha: frozen, mergeTimeHeadShaObservedLive: observedLive };
  }
  prCache.set(key, pr);
  return pr;
}

export function _clearPrCacheForTests() {
  prCache.clear();
  liveObservations.clear();
  hydratePromise = null;
}

/**
 * Soft-invalidate all cache entries for a repo: force TTL expiry so
 * subsequent `get()` calls return undefined (triggering a refetch), but
 * keep the entry values reachable via `getStale()` so `setPrCacheEntry`'s
 * fallback chain can preserve `mergeTimeHeadSha` + `observedLive` across
 * the refetch. Replaces a prior hard-delete design that required a
 * side-channel stash for freeze preservation; soft-expiry also survives
 * app crash between invalidate and refetch because expired entries still
 * persist to disk and rehydrate on boot.
 */
export function invalidatePrCacheForRepo(owner: string, repo: string): void {
  const prefix = `${owner}/${repo}#`;
  let expired = 0;
  for (const [k] of Array.from(prCache.entries())) {
    if (!k.startsWith(prefix)) continue;
    if (prCache.expire(k)) expired++;
  }
  if (expired > 0) schedulePersist();
}

export function _getPrCacheKeysForTests(): string[] {
  return Array.from(prCache.entries()).map(([k]) => k);
}

// ── Single PR fetch ────────────────────────────────────────────────────

export async function getPR(owner: string, repo: string, number: number): Promise<PRInfo | null> {
  await hydratePrCache();
  const key = cacheKey(owner, repo, number);
  const cached = prCache.get(key);
  if (cached !== undefined) return cached;
  if (!transport) return null;
  try {
    const pr = await transport.getPullRequest(owner, repo, number);
    const stored = setPrCacheEntry(key, pr);
    schedulePersist();
    return stored;
  } catch {
    // Both transports return null (not throw) for 404s, so they are
    // negative-cached in the try block above. Any error reaching here is
    // an auth/rate-limit/network failure — leave cache untouched so a
    // transient hiccup doesn't wipe data.
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
    const cached = prCache.get(key);
    if (cached !== undefined) {
      if (cached) out.set(n, cached);
    } else {
      toFetch.push(n);
    }
  }
  if (toFetch.length === 0 || !transport || currentAuthMethod === 'none') return out;

  for (let i = 0; i < toFetch.length; i += BATCH_CHUNK_SIZE) {
    const chunk = toFetch.slice(i, i + BATCH_CHUNK_SIZE);
    try {
      const chunkOut = await transport.batchGetPullRequests(owner, repo, chunk);
      for (const [n, pr] of chunkOut) {
        // setPrCacheEntry returns the stored PRInfo (with mergeTimeHeadSha
        // merged in for merged PRs), so callers see the same shape the
        // cache will return next time.
        const stored = setPrCacheEntry(cacheKey(owner, repo, n), pr);
        if (stored) out.set(n, stored);
      }
      // Negative-cache only after a successful fetch — a missing key means the
      // API confirmed the PR doesn't exist, not that the request failed.
      for (const n of chunk) {
        if (!chunkOut.has(n)) {
          prCache.set(cacheKey(owner, repo, n), null);
        }
      }
    } catch (e: any) {
      console.warn('[githubService] batch PR fetch failed, skipping negative-cache:', e?.message);
    }
  }
  schedulePersist();
  return out;
}

// ── Open PR list ───────────────────────────────────────────────────────

type OpenPrListEntry = Omit<PRInfo, 'state'>;
const openPrListCache = new TTLCache<string, OpenPrListEntry[]>({ ttlMs: 60_000 });

function openPrListCacheKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

export function invalidateOpenPrListCache(owner?: string, repo?: string): void {
  if (owner && repo) openPrListCache.delete(openPrListCacheKey(owner, repo));
  else openPrListCache.clear();
}

export function _getOpenPrListCacheKeysForTests(): string[] {
  return Array.from(openPrListCache.entries()).map(([k]) => k);
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
  let prs: OpenPrListEntry[] | undefined = openPrListCache.get(key);
  if (!prs) {
    try {
      prs = await transport.listOpenPullRequests(owner, repo);
      openPrListCache.set(key, prs);
    } catch (e: any) {
      console.warn('[github] listOpenPRsForBranches failed', e?.status, e?.message);
      prs = openPrListCache.getStale(key) ?? [];
    }
  }

  for (const p of prs) {
    if (wanted.has(p.headRef)) {
      out.set(p.headRef, { ...p, state: 'open' });
    }
  }
  return out;
}
