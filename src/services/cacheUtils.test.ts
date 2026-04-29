import { describe, it, expect, vi, afterEach } from 'vitest';
import { TTLCache } from './cacheUtils';

afterEach(() => {
  vi.useRealTimers();
});

describe('TTLCache.expire()', () => {
  describe('on TTL-null (content-addressed) caches', () => {
    // Regression: prior to the `entry.at === 0` guard in get(), expire() was a
    // silent no-op on TTL-null caches because the natural-expiry comparison
    // short-circuits when ttlMs is null. Caches like cherryCache / branchAbCache
    // / mergeBaseCache / changedFilesCache fall in this bucket.
    it('makes subsequent get() calls return undefined', () => {
      const cache = new TTLCache<string, number>();
      cache.set('k', 42);
      expect(cache.get('k')).toBe(42);
      const ok = cache.expire('k');
      expect(ok).toBe(true);
      expect(cache.get('k')).toBeUndefined();
    });

    it('still allows getStale() to return the prior value', () => {
      const cache = new TTLCache<string, number>();
      cache.set('k', 42);
      cache.expire('k');
      expect(cache.getStale('k')).toBe(42);
    });

    it('makes has() return false after expire()', () => {
      const cache = new TTLCache<string, number>();
      cache.set('k', 42);
      expect(cache.has('k')).toBe(true);
      cache.expire('k');
      expect(cache.has('k')).toBe(false);
    });
  });

  describe('on TTL-set caches', () => {
    it('makes subsequent get() calls return undefined', () => {
      const cache = new TTLCache<string, number>({ ttlMs: 60_000 });
      cache.set('k', 42);
      expect(cache.get('k')).toBe(42);
      cache.expire('k');
      expect(cache.get('k')).toBeUndefined();
    });

    it('still allows getStale() to return the prior value', () => {
      const cache = new TTLCache<string, number>({ ttlMs: 60_000 });
      cache.set('k', 42);
      cache.expire('k');
      expect(cache.getStale('k')).toBe(42);
    });

    it('naturally-expired entries (without explicit expire()) also miss', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const cache = new TTLCache<string, number>({ ttlMs: 60_000 });
      cache.set('k', 42);
      expect(cache.get('k')).toBe(42);
      vi.advanceTimersByTime(60_001);
      expect(cache.get('k')).toBeUndefined();
      // getStale still returns the value.
      expect(cache.getStale('k')).toBe(42);
    });

    it('makes has() return false after expire()', () => {
      const cache = new TTLCache<string, number>({ ttlMs: 60_000 });
      cache.set('k', 42);
      cache.expire('k');
      expect(cache.has('k')).toBe(false);
    });
  });

  describe('expiredAt preservation across re-expire (persist round-trip)', () => {
    it('snapshots the pre-expire timestamp into expiredAt on first expire()', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const cache = new TTLCache<string, number>({ ttlMs: 60_000 });
      cache.set('k', 42);
      const setAt = cache.getRaw('k')!.at;
      expect(setAt).toBeGreaterThan(0);
      cache.expire('k');
      const raw = cache.getRaw('k')!;
      expect(raw.at).toBe(0);
      expect(raw.expiredAt).toBe(setAt);
    });

    it('keeps the original expiredAt when expire() is called again on a soft-expired entry', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const cache = new TTLCache<string, number>({ ttlMs: 60_000 });
      cache.set('k', 42);
      const originalAt = cache.getRaw('k')!.at;
      cache.expire('k');
      // Advance time and re-expire — expiredAt must keep the original value,
      // not collapse to 0.
      vi.advanceTimersByTime(120_000);
      cache.expire('k');
      const raw = cache.getRaw('k')!;
      expect(raw.at).toBe(0);
      expect(raw.expiredAt).toBe(originalAt);
    });
  });

  describe('setWithTimestamp interaction with the at===0 guard', () => {
    // The new guard checks `entry.at === 0` strictly. setWithTimestamp(k, v, t)
    // with a real prior timestamp during hydration must not be misread as
    // soft-expired.
    it('hydrated entries with a real timestamp are visible via get()', () => {
      const cache = new TTLCache<string, number>({ ttlMs: 60 * 60_000 });
      const realPriorTimestamp = Date.now() - 1000;
      cache.setWithTimestamp('k', 42, realPriorTimestamp);
      expect(cache.get('k')).toBe(42);
    });

    it('hydrated entries persisted as at:0 (soft-expired on disk) miss on get() but stale-recover via getStale()', () => {
      // This mirrors the real persist/rehydrate flow: an entry that was
      // soft-expired before persist gets rehydrated as at:0 and must remain
      // soft-expired on get().
      const cache = new TTLCache<string, number>({ ttlMs: 60_000 });
      cache.setWithTimestamp('k', 42, 0);
      expect(cache.get('k')).toBeUndefined();
      expect(cache.getStale('k')).toBe(42);
    });
  });

  describe('non-existent keys', () => {
    it('expire() on a missing key returns false', () => {
      const cache = new TTLCache<string, number>();
      expect(cache.expire('missing')).toBe(false);
    });
  });
});
