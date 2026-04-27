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
// One of two required signals for `setPrCacheEntry`'s live-transition branch
// (the other is a still-present non-merged prior via `getStale()`). Membership
// alone is insufficient — FIFO eviction can strand the Set entry past the
// cache entry, and a later merged fetch would then spuriously freeze a
// potentially post-merge-advanced headSha. The AND of both signals catches
// the cache-evicted case (no priorInCache) and the rehydrated-open case
// (no Set membership because the rehydrated entry didn't go through
// `setPrCacheEntry`). Not persisted: cold-bootstrap-after-restart must fail
// closed. Cleared in lockstep with `prCache` on auth switch and in test
// teardown.
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
        // Upgrade-compat: pre-fix versions of `expire()` zeroed `at` without
        // snapshotting it onto `expiredAt`, so a disk blob written by those
        // versions can carry `at: 0` for any state. Re-stamp those entries
        // with a synthetic plausible timestamp before insert — old enough
        // that `get()` still misses (forcing refetch), recent enough that
        // STALE_OPEN_PR_MS-based filters treat them as fresh-ish, and crucially
        // non-zero so `schedulePersist` round-trips them to disk instead of
        // dropping them. Applies uniformly to open/closed/merged entries —
        // open ones still get the STALE_OPEN_PR_MS check below against the
        // synthetic stamp (which is half-staleness-window old by construction,
        // so they survive).
        const at = v.at === 0 ? now - Math.floor(STALE_OPEN_PR_MS / 2) : v.at;
        const isOpen = v.pr?.state === 'open';
        if (isOpen && now - at > STALE_OPEN_PR_MS) continue;
        prCache.setWithTimestamp(k, v.pr, at);
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
      // Persist soft-expired entries using their preserved pre-expire
      // timestamp (`expiredAt`). `expire()` zeroes `at` in-memory as a
      // refetch trigger, but snapshots the prior `at` onto `expiredAt` so
      // the entry can still round-trip through disk with a valid timestamp.
      // Without this, a schedulePersist fired while entries are soft-
      // expired (e.g. after invalidatePrCacheForRepo, or an unrelated
      // refetch during the 500ms debounce window) would either drop those
      // entries from disk (breaking mergeTimeHeadSha survival across
      // crash/restart) or persist them as at:0 (breaking STALE_OPEN_PR_MS
      // on rehydrate). A truly uninitialised entry (at=0 and expiredAt=null)
      // is the only case we still skip — it has no real timestamp to write.
      const persistAt = entry.expiredAt ?? entry.at;
      if (persistAt === 0) continue;
      entries[k] = { at: persistAt, pr: entry.value };
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
 *   - We observed this key as non-merged in-process AND the prior entry is
 *     still reachable as non-merged via `getStale()`: freeze from current
 *     `pr.headSha`, set observedLive=true.
 *   - Otherwise (no prior freeze, or the prior entry is missing/merged, or
 *     no in-process live observation): freeze from current `pr.headSha`
 *     (imperfect if the author pushed post-merge before we ever saw this
 *     PR live), set observedLive=false. The `pr-<N>` detector pass
 *     requires observedLive=true to tag, so these cases fail closed.
 *
 * Why BOTH conditions (Set ∩ getStale) gate the live-transition branch:
 *   - The Set alone: an entry observed live and then evicted by FIFO trim
 *     leaves the Set membership behind. A later merged fetch would
 *     spuriously freeze a potentially post-merge-advanced `pr.headSha` and
 *     claim observedLive=true.
 *   - `getStale()` alone (the pre-fix proxy): rehydrated persisted open
 *     entries look identical to live observations. An app restart followed
 *     by a refetch that finds the PR merged would falsely flag
 *     observedLive=true.
 * The AND covers all three cases: cache-evicted live observation, app-
 * restart rehydrate, and genuine in-process transition. The Set is not
 * persisted, so it dies with the process; both are cleared in lockstep on
 * auth switch and in test teardown.
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
    } else if (priorInCache && priorInCache.state !== 'merged' && liveObservations.has(key)) {
      // Witnessed the open→merged transition in-process AND the prior
      // non-merged entry is still in the cache (so we didn't just observe
      // live and then get evicted). Both signals required — see docblock.
      frozen = pr.headSha;
      observedLive = true;
    } else {
      // Cold bootstrap, first post-restart observation with rehydrated
      // prior, or post-eviction refetch: we cannot prove we witnessed
      // the non-merged state in this cache generation, so `pr.headSha`
      // may already be post-merge-advanced. Flag so the detector fails
      // closed on pass 1b.
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
 * side-channel stash for freeze preservation.
 *
 * Soft-expiry also survives app crash between invalidate and refetch:
 * `expire()` snapshots the pre-expire timestamp onto `expiredAt`, and
 * `schedulePersist` writes `expiredAt ?? at`, so expired entries persist
 * to disk with their prior valid timestamp and rehydrate on boot with
 * their merged-PR state (including `mergeTimeHeadSha` +
 * `mergeTimeHeadShaObservedLive`) intact. `expireOpenPrEntries` on the
 * next boot re-marks non-terminal (`open` + `closed`) entries expired so
 * they refetch on the first refresh tick — only `merged` entries, which
 * GitHub disallows reopening, remain warm.
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

/**
 * Soft-expire a specific list of PR cache entries. Used by the background
 * refresh path in `runRefreshOnce` when new `(#N)` PR-tags appear on
 * `origin/<defaultBranch>` — only those PRs need a refetch to flip their
 * cached `state: 'open'` to `'merged'` so squash detection can catch them
 * on the same tick rather than waiting up to the 5-min TTL. Soft-expire
 * (vs hard-delete) preserves `mergeTimeHeadSha` + `observedLive` via
 * `setPrCacheEntry`'s `getStale()` fallback chain.
 */
export function expirePrEntriesByNumbers(
  owner: string,
  repo: string,
  numbers: number[],
): void {
  if (numbers.length === 0) return;
  for (const n of numbers) {
    prCache.expire(cacheKey(owner, repo, n));
  }
  // No schedulePersist: this is called from the background refresh tick,
  // which unconditionally fires schedulePersist shortly afterwards via
  // batchFetchPRs. Adding one here is redundant. Crash-safety is
  // nevertheless intact: `expire()` preserves the pre-expire timestamp on
  // `expiredAt`, and the next persist (ours or an unrelated one during the
  // 500ms debounce) writes it to disk so entries round-trip cleanly.
}

/**
 * Soft-expire every cached PR in a non-terminal state (`open` or `closed`)
 * so the first post-boot refresh refetches them. Called once after
 * `hydratePrCache()` resolves at app boot.
 *
 * Why both `open` and `closed`:
 *   - `open` → might have merged while the app was quit.
 *   - `closed` → GitHub allows reopening a closed PR and then merging it,
 *     so a cached `closed` entry can also become `merged` between sessions.
 * Only `merged` is truly terminal (GitHub disallows reopening a merged PR),
 * so `merged` entries stay warm to avoid wasted network on the first tick —
 * which matters because squash detection's PR-tag pass does a targeted
 * PR lookup per first-parent commit on `main`.
 *
 * Name retained as `expireOpenPrEntries` for caller stability (the hook,
 * tests, and surrounding comments all reference it); "open" here is now
 * historical and means "non-terminal".
 */
export function expireOpenPrEntries(): void {
  // Array.from materialises a snapshot of the entries before the loop so
  // mutation during iteration is impossible. Even so, the mutation below is
  // iterator-safe on its own: TTLCache.expire() only calls `map.set` on an
  // existing key (re-writing the same entry with at=0) — it never inserts
  // or deletes. JS is single-threaded, so there is no concurrent prCache.get
  // race either: every reader that could fire during this loop is on a
  // different turn of the event loop and sees either the pre- or post-expire
  // state cleanly.
  for (const [k, entry] of Array.from(prCache.entries())) {
    const state = entry.value?.state;
    if (state === 'open' || state === 'closed') {
      prCache.expire(k);
    }
  }
  // No schedulePersist: this is called once at boot, and the first refresh
  // tick that follows will flush via batchFetchPRs. Crash-safety is still
  // intact (expire() preserves the pre-expire timestamp on expiredAt, so
  // any later persist round-trips the entry with its real `at`).
}

export function _getPrCacheKeysForTests(): string[] {
  return Array.from(prCache.entries()).map(([k]) => k);
}

/** Test-only: simulate FIFO eviction of a single key by removing it from
 *  prCache without touching liveObservations. Used to exercise the
 *  post-eviction branch of setPrCacheEntry — production code evicts via
 *  TTLCache.trim(), but that drops chunks based on insertion order and is
 *  awkward to reproduce surgically in a unit test. */
export function _simulateCacheEvictionForTests(key: string): boolean {
  return prCache.delete(key);
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

export function invalidateOpenPrListCache(
  owner?: string,
  repo?: string,
  opts?: { hard?: boolean },
): void {
  // Soft-expire the targeted entry by default (vs hard-delete) so
  // `listOpenPRsForBranches`'s catch path can still recover the prior value
  // via `getStale()` on a flaky network. With `delete()`, a single failed
  // refetch right after invalidate would wipe every branch's open-PR data
  // for the tick. The bulk variant (no args) still hard-clears: it's used on
  // auth switch where serving a stale entry from the previous identity would
  // be wrong.
  //
  // `hard: true` forces a delete instead of a soft expire. Callers that have
  // positive proof the cached list is wrong (e.g. a new (#N) commit on main
  // proves the referenced PR is merged, not open) MUST pass this — allowing
  // `getStale()` to serve the pre-merge list back on a transport failure
  // would re-stamp the merged PR as 'open' and defeat squash detection on
  // the current tick.
  if (owner && repo) {
    if (opts?.hard) openPrListCache.delete(openPrListCacheKey(owner, repo));
    else openPrListCache.expire(openPrListCacheKey(owner, repo));
  } else {
    openPrListCache.clear();
  }
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
