import { describe, it, expect, vi, afterEach } from 'vitest';
import { relativeTime } from './format';

describe('relativeTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for deltas under 3 seconds', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const twoSecondsAgo = new Date(now.getTime() - 2000).toISOString();
    expect(relativeTime(twoSecondsAgo)).toBe('just now');
  });

  it('falls through to formatDistanceToNowStrict once past the threshold', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tenSecondsAgo = new Date(now.getTime() - 10_000).toISOString();
    expect(relativeTime(tenSecondsAgo)).toMatch(/10 seconds ago/);
  });

  it('handles clock-skew (future timestamp) by falling through, not "just now"', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const oneSecondInFuture = new Date(now.getTime() + 1000).toISOString();
    expect(relativeTime(oneSecondInFuture)).not.toBe('just now');
  });

  it('returns em dash for empty input', () => {
    expect(relativeTime('')).toBe('—');
  });
});
