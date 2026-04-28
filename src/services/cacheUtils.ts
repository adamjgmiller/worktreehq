/**
 * Generic in-memory cache with optional TTL and optional max-size FIFO eviction.
 *
 * Two usage patterns:
 *   - TTL-based: `new TTLCache({ ttlMs: 5 * 60_000 })` — entries expire after
 *     a time window. Used for GitHub API responses that go stale.
 *   - Content-addressed: `new TTLCache({ maxSize: 2000 })` — no TTL, but
 *     capped size with FIFO trim. Used for SHA-keyed git data that
 *     self-invalidates when a branch tip moves.
 */
export interface TTLCacheEntry<V> {
  value: V;
  /** Current timestamp. Zero means soft-expired (see `expire()`); `get()`
   *  treats this as a miss regardless of whether the cache has a TTL. */
  at: number;
  /** When `expire()` zeros `at`, the prior `at` is snapshotted here so
   *  persistence layers can still write a real timestamp to disk. Null on
   *  any entry that has not been soft-expired. Reset to null whenever the
   *  entry is re-written via `set()` / `setWithTimestamp()`. */
  expiredAt: number | null;
}

export class TTLCache<K, V> {
  private map = new Map<K, TTLCacheEntry<V>>();
  private readonly ttlMs: number | null;
  private readonly maxSize: number | null;
  private readonly trimFraction: number;

  constructor(opts: { ttlMs?: number; maxSize?: number; trimFraction?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? null;
    this.maxSize = opts.maxSize ?? null;
    // When the cache exceeds maxSize, drop this fraction of the oldest entries.
    // Default 25% keeps amortised cost low while freeing meaningful space.
    this.trimFraction = opts.trimFraction ?? 0.25;
  }

  /** Get a value if present and not expired. Returns undefined on miss.
   *  Expired entries are NOT deleted — they remain accessible via `getStale()`
   *  for stale-while-revalidate fallbacks. Cleanup happens via `set()` (which
   *  triggers FIFO trim) and `clear()`.
   *
   *  Soft-expired entries (`at: 0`, set by `expire()`) miss uniformly,
   *  regardless of whether this cache has a TTL configured. Without this
   *  guard, `expire()` would be a silent no-op on TTL-null content-addressed
   *  caches because the natural-expiry comparison short-circuits when
   *  `ttlMs === null`. */
  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.at === 0) return undefined;
    if (this.ttlMs !== null && Date.now() - entry.at > this.ttlMs) {
      return undefined;
    }
    return entry.value;
  }

  /** Get a value even if expired (for stale-while-revalidate fallbacks). */
  getStale(key: K): V | undefined {
    return this.map.get(key)?.value;
  }

  /** Check whether a non-expired entry exists. */
  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  /** Store a value with the current timestamp. Triggers FIFO trim if needed. */
  set(key: K, value: V): void {
    this.map.set(key, { value, at: Date.now(), expiredAt: null });
    this.trim();
  }

  /** Store a value with an explicit timestamp (for hydration from disk). */
  setWithTimestamp(key: K, value: V, at: number): void {
    this.map.set(key, { value, at, expiredAt: null });
    // Skip trim on hydration — caller can trim once after bulk load.
  }

  /** Force TTL expiry on an entry without removing it — subsequent `get()`
   *  calls return undefined (triggering refetch), but `getStale()` still
   *  returns the prior value. Used for soft-invalidation where the caller
   *  wants to trigger a refetch while preserving state for stale-while-
   *  revalidate paths. No-op when the key is not present.
   *
   *  Works uniformly on TTL-set and TTL-null (content-addressed) caches:
   *  `get()` checks `entry.at === 0` before the TTL comparison, so the
   *  soft-expire sentinel takes effect even when `ttlMs` is null. Without
   *  that guard, `expire()` would silently fail on caches like
   *  `cherryCache` / `branchAbCache` / `mergeBaseCache` / `changedFilesCache`
   *  because the natural-expiry check would short-circuit and `get()` would
   *  return the stored value as if fresh.
   *
   *  The prior `at` is snapshotted onto `expiredAt` so persistence layers can
   *  still write a real timestamp to disk — otherwise a soft-expired entry
   *  would round-trip through persist/rehydrate as `at: 0`, which breaks
   *  staleness checks on rehydrate (e.g. STALE_OPEN_PR_MS comparisons that
   *  treat `at: 0` as infinitely old) and loses the entry's valid history.
   *  Re-calling `expire()` on an already-soft-expired entry is a no-op for
   *  `expiredAt` (we keep the original pre-expire timestamp, not zero). */
  expire(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    // Preserve the pre-expire timestamp. If already soft-expired (at=0), keep
    // the existing expiredAt — don't overwrite the real pre-expire time with
    // zero.
    const preservedAt = entry.at === 0 ? entry.expiredAt : entry.at;
    this.map.set(key, { value: entry.value, at: 0, expiredAt: preservedAt });
    return true;
  }

  /** Get the raw entry including timestamp (for persistence). */
  getRaw(key: K): TTLCacheEntry<V> | undefined {
    return this.map.get(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /** Delete all entries whose key matches the predicate. */
  deleteWhere(pred: (key: K) => boolean): number {
    let removed = 0;
    for (const key of Array.from(this.map.keys())) {
      if (pred(key)) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  /** Iterate all entries (for persistence serialization). */
  entries(): IterableIterator<[K, TTLCacheEntry<V>]> {
    return this.map.entries();
  }

  /** FIFO trim: drop the oldest entries until size <= maxSize, in
   *  chunks of `trimFraction` of the cap. Normal `set()` overshoots by 1
   *  and exits after one chunk (amortising the delete loop cost); bulk
   *  loaders that push size well above the cap keep chunking until under. */
  trim(): void {
    if (this.maxSize === null) return;
    const chunk = Math.max(1, Math.floor(this.maxSize * this.trimFraction));
    while (this.map.size > this.maxSize) {
      let i = 0;
      for (const key of this.map.keys()) {
        if (i++ >= chunk) break;
        this.map.delete(key);
      }
    }
  }
}
