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
export class TTLCache<K, V> {
  private map = new Map<K, { value: V; at: number }>();
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

  /** Get a value if present and not expired. Returns undefined on miss. */
  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.ttlMs !== null && Date.now() - entry.at > this.ttlMs) {
      this.map.delete(key);
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
    this.map.set(key, { value, at: Date.now() });
    this.trim();
  }

  /** Store a value with an explicit timestamp (for hydration from disk). */
  setWithTimestamp(key: K, value: V, at: number): void {
    this.map.set(key, { value, at });
    // Skip trim on hydration — caller can trim once after bulk load.
  }

  /** Get the raw entry including timestamp (for persistence). */
  getRaw(key: K): { value: V; at: number } | undefined {
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
  entries(): IterableIterator<[K, { value: V; at: number }]> {
    return this.map.entries();
  }

  /** FIFO trim: drop the oldest `trimFraction` when over maxSize. */
  trim(): void {
    if (this.maxSize === null || this.map.size <= this.maxSize) return;
    const toDrop = Math.max(1, Math.floor(this.maxSize * this.trimFraction));
    let i = 0;
    for (const key of this.map.keys()) {
      if (i++ >= toDrop) break;
      this.map.delete(key);
    }
  }
}
