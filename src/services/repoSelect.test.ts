import { describe, it, expect } from 'vitest';
import { bumpRecent, RECENT_REPOS_MAX } from './repoSelect';

// `bumpRecent` is the only piece of repoSelect that's pure and worth unit
// testing in isolation — the rest is IPC orchestration that's better
// covered end-to-end. The three behaviors below are the load-bearing
// invariants of the MRU list:
//   1. dedupe — opening the same repo twice doesn't grow the list
//   2. bump   — any open moves the path to position 0
//   3. cap    — list never grows past RECENT_REPOS_MAX
describe('bumpRecent', () => {
  it('prepends a new path to an empty list', () => {
    expect(bumpRecent([], '/a')).toEqual(['/a']);
  });

  it('moves an existing path to the head without duplicating', () => {
    expect(bumpRecent(['/a', '/b', '/c'], '/c')).toEqual(['/c', '/a', '/b']);
  });

  it('leaves a head re-open as a no-op (same head)', () => {
    expect(bumpRecent(['/a', '/b'], '/a')).toEqual(['/a', '/b']);
  });

  it('does not mutate the input array', () => {
    const input = ['/a', '/b'];
    const out = bumpRecent(input, '/c');
    expect(input).toEqual(['/a', '/b']);
    expect(out).toEqual(['/c', '/a', '/b']);
  });

  it(`caps the list at RECENT_REPOS_MAX (${RECENT_REPOS_MAX}) entries`, () => {
    const long = Array.from({ length: RECENT_REPOS_MAX }, (_, i) => `/p${i}`);
    const out = bumpRecent(long, '/new');
    expect(out).toHaveLength(RECENT_REPOS_MAX);
    expect(out[0]).toBe('/new');
    // The previously-last entry should have been dropped to make room.
    expect(out).not.toContain(`/p${RECENT_REPOS_MAX - 1}`);
  });

  it('treats paths case-sensitively (does not silently merge distinct entries)', () => {
    // We deliberately don't lowercase: macOS HFS+ is case-insensitive but
    // git treats paths case-sensitively, and silently merging would risk
    // dropping a real entry that just differs in case.
    expect(bumpRecent(['/Foo'], '/foo')).toEqual(['/foo', '/Foo']);
  });
});
