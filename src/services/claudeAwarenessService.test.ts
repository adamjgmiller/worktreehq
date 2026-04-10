import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./tauriBridge', () => ({
  readClaudeState: vi.fn(),
}));

import {
  encodeProjectDirName,
  joinClaudeState,
  resumeCommand,
  LIVE_WINDOW_MS,
  RECENT_WINDOW_MS,
  fetchClaudePresence,
  _resetClaudePresenceCacheForTests,
} from './claudeAwarenessService';
import { readClaudeState } from './tauriBridge';
import type { ClaudeStateRaw, Worktree } from '../types';

const readClaudeStateMock = readClaudeState as unknown as ReturnType<typeof vi.fn>;

function wt(path: string, branch = 'feat/x'): Worktree {
  return {
    path,
    branch,
    isPrimary: false,
    head: 'abc',
    untrackedCount: 0,
    modifiedCount: 0,
    stagedCount: 0,
    stashCount: 0,
    ahead: 0,
    behind: 0,
    aheadOfMain: 0,
    behindMain: 0,
    hasConflicts: false,
    lastCommit: { sha: 'abc', message: '', date: '', author: '' },
    status: 'clean',
  };
}

describe('encodeProjectDirName', () => {
  it('replaces slashes and dots with dashes', () => {
    expect(encodeProjectDirName('/Users/adam/Projects/canopy')).toBe(
      '-Users-adam-Projects-canopy',
    );
  });
  it('doubles the dash for `/.` (hidden subdirs)', () => {
    expect(
      encodeProjectDirName('/Users/adam/Projects/canopy/.claude/worktrees/feat'),
    ).toBe('-Users-adam-Projects-canopy--claude-worktrees-feat');
  });
});

describe('resumeCommand', () => {
  it('emits a shell-safe cd + claude --resume', () => {
    expect(resumeCommand('/a/b c', 'uuid-1')).toBe("cd '/a/b c' && claude --resume uuid-1");
  });
  it("escapes embedded single quotes", () => {
    expect(resumeCommand("/weird's dir", 'uuid-2')).toBe(
      "cd '/weird'\\''s dir' && claude --resume uuid-2",
    );
  });
});

describe('joinClaudeState', () => {
  const NOW = 1_700_000_000_000;
  const worktreePath = '/Users/adam/Projects/canopy';
  const dirName = encodeProjectDirName(worktreePath);

  it('returns status=none for worktrees with no project dir', () => {
    const raw: ClaudeStateRaw = { ide_locks: [], projects: [] };
    const result = joinClaudeState(raw, [wt(worktreePath)], NOW);
    const presence = result.get(worktreePath)!;
    expect(presence.status).toBe('none');
    expect(presence.inactiveSessions).toEqual([]);
  });

  it('marks status=live when newest JSONL is within LIVE_WINDOW', () => {
    const raw: ClaudeStateRaw = {
      ide_locks: [],
      projects: [
        {
          dir_name: dirName,
          worktree_path: worktreePath,
          sessions: [
            { session_id: 'active', mtime_ms: NOW - 5_000 },
            { session_id: 'old', mtime_ms: NOW - 3 * RECENT_WINDOW_MS },
          ],
        },
      ],
    };
    const presence = joinClaudeState(raw, [wt(worktreePath)], NOW).get(worktreePath)!;
    expect(presence.status).toBe('live');
    expect(presence.activeSessionId).toBe('active');
    expect(presence.inactiveSessions.map((s) => s.sessionId)).toEqual(['old']);
  });

  it('marks status=recent when within RECENT_WINDOW but past LIVE_WINDOW', () => {
    const raw: ClaudeStateRaw = {
      ide_locks: [],
      projects: [
        {
          dir_name: dirName,
          worktree_path: worktreePath,
          sessions: [{ session_id: 's1', mtime_ms: NOW - LIVE_WINDOW_MS - 1_000 }],
        },
      ],
    };
    const presence = joinClaudeState(raw, [wt(worktreePath)], NOW).get(worktreePath)!;
    expect(presence.status).toBe('recent');
    // Not live → session goes into closed list so user can resume it
    expect(presence.activeSessionId).toBeUndefined();
    expect(presence.inactiveSessions).toHaveLength(1);
  });

  it('marks status=dormant past RECENT_WINDOW and puts all sessions in closed list', () => {
    const raw: ClaudeStateRaw = {
      ide_locks: [],
      projects: [
        {
          dir_name: dirName,
          worktree_path: worktreePath,
          sessions: [
            { session_id: 'a', mtime_ms: NOW - RECENT_WINDOW_MS - 1_000 },
            { session_id: 'b', mtime_ms: NOW - RECENT_WINDOW_MS - 60_000 },
          ],
        },
      ],
    };
    const presence = joinClaudeState(raw, [wt(worktreePath)], NOW).get(worktreePath)!;
    expect(presence.status).toBe('dormant');
    expect(presence.activeSessionId).toBeUndefined();
    expect(presence.inactiveSessions.map((s) => s.sessionId)).toEqual(['a', 'b']);
  });

  it('upgrades to live-ide when a lockfile references the worktree path', () => {
    const raw: ClaudeStateRaw = {
      ide_locks: [
        {
          pid: 4242,
          ide_name: 'Cursor',
          workspace_folders: [worktreePath],
        },
      ],
      projects: [
        {
          dir_name: dirName,
          worktree_path: worktreePath,
          // Even with a stale JSONL, the lockfile wins
          sessions: [{ session_id: 'only', mtime_ms: NOW - 10 * RECENT_WINDOW_MS }],
        },
      ],
    };
    const presence = joinClaudeState(raw, [wt(worktreePath)], NOW).get(worktreePath)!;
    expect(presence.status).toBe('live-ide');
    expect(presence.ideName).toBe('Cursor');
    expect(presence.pid).toBe(4242);
    expect(presence.activeSessionId).toBe('only');
    expect(presence.inactiveSessions).toEqual([]);
  });

  it('prefers authoritative worktree_path over directory-name lookup', () => {
    // Two worktrees whose encoded dirnames collide. The encoding substitutes
    // both `/` and `.` with `-`, so `/a/b` and `/a.b` both become `-a-b`.
    // The authoritative worktree_path in the JSONL should disambiguate.
    const a: Worktree = wt('/Users/adam/foo/bar');
    const b: Worktree = wt('/Users/adam/foo.bar');
    expect(encodeProjectDirName(a.path)).toBe(encodeProjectDirName(b.path));
    const raw: ClaudeStateRaw = {
      ide_locks: [],
      projects: [
        {
          dir_name: encodeProjectDirName(a.path),
          worktree_path: a.path, // authoritative: belongs to `a`
          sessions: [{ session_id: 's', mtime_ms: NOW - 1000 }],
        },
      ],
    };
    const result = joinClaudeState(raw, [a, b], NOW);
    expect(result.get(a.path)!.status).toBe('live');
    expect(result.get(b.path)!.status).toBe('none');
  });

  describe('liveSessionCount (multi-Claude warning)', () => {
    it('is 0 for status=none', () => {
      const presence = joinClaudeState(
        { ide_locks: [], projects: [] },
        [wt(worktreePath)],
        NOW,
      ).get(worktreePath)!;
      expect(presence.liveSessionCount).toBe(0);
    });

    it('is 1 when one session is within the live window', () => {
      const raw: ClaudeStateRaw = {
        ide_locks: [],
        projects: [
          {
            dir_name: dirName,
            worktree_path: worktreePath,
            sessions: [
              { session_id: 'a', mtime_ms: NOW - 5_000 },
              { session_id: 'b', mtime_ms: NOW - 3 * RECENT_WINDOW_MS },
            ],
          },
        ],
      };
      const presence = joinClaudeState(raw, [wt(worktreePath)], NOW).get(worktreePath)!;
      expect(presence.liveSessionCount).toBe(1);
    });

    it('is 2 when two sessions are both within the live window', () => {
      const raw: ClaudeStateRaw = {
        ide_locks: [],
        projects: [
          {
            dir_name: dirName,
            worktree_path: worktreePath,
            sessions: [
              { session_id: 'a', mtime_ms: NOW - 5_000 },
              { session_id: 'b', mtime_ms: NOW - 30_000 },
              { session_id: 'old', mtime_ms: NOW - 2 * RECENT_WINDOW_MS },
            ],
          },
        ],
      };
      const presence = joinClaudeState(raw, [wt(worktreePath)], NOW).get(worktreePath)!;
      expect(presence.liveSessionCount).toBe(2);
      expect(presence.status).toBe('live');
    });

    it('counts an IDE lock as a separate live agent only when newest JSONL is stale', () => {
      // Lock present + newest JSONL also within live window → don't double-count
      // (the IDE writes its own JSONL, so the newest session IS the IDE).
      const overlapping: ClaudeStateRaw = {
        ide_locks: [{ pid: 1, ide_name: 'Cursor', workspace_folders: [worktreePath] }],
        projects: [
          {
            dir_name: dirName,
            worktree_path: worktreePath,
            sessions: [{ session_id: 'a', mtime_ms: NOW - 5_000 }],
          },
        ],
      };
      const overlappingPresence = joinClaudeState(
        overlapping,
        [wt(worktreePath)],
        NOW,
      ).get(worktreePath)!;
      expect(overlappingPresence.liveSessionCount).toBe(1);

      // Lock present + newest JSONL outside live window → IDE counts as 1
      // separate live agent (the user just opened the IDE; no flush yet).
      const distinct: ClaudeStateRaw = {
        ide_locks: [{ pid: 1, ide_name: 'Cursor', workspace_folders: [worktreePath] }],
        projects: [
          {
            dir_name: dirName,
            worktree_path: worktreePath,
            sessions: [{ session_id: 'a', mtime_ms: NOW - LIVE_WINDOW_MS - 5_000 }],
          },
        ],
      };
      const distinctPresence = joinClaudeState(
        distinct,
        [wt(worktreePath)],
        NOW,
      ).get(worktreePath)!;
      expect(distinctPresence.liveSessionCount).toBe(1);
      expect(distinctPresence.status).toBe('live-ide');
    });

    it('counts an IDE lock as 1 when no project dir exists at all', () => {
      // Mid-startup edge case: lock acquired before any JSONL is flushed.
      const raw: ClaudeStateRaw = {
        ide_locks: [{ pid: 1, ide_name: 'Cursor', workspace_folders: [worktreePath] }],
        projects: [],
      };
      const presence = joinClaudeState(raw, [wt(worktreePath)], NOW).get(worktreePath)!;
      expect(presence.liveSessionCount).toBe(1);
      expect(presence.status).toBe('live-ide');
    });
  });

  describe('idle promotion via live_worktree_cwds', () => {
    it('keeps status=live when JSONL is fresh AND a process is running', () => {
      // Process detection should not downgrade a live JSONL: a fresh mtime
      // already proves the session is live, and the process is just confirming.
      const raw: ClaudeStateRaw = {
        ide_locks: [],
        projects: [
          {
            dir_name: dirName,
            worktree_path: worktreePath,
            sessions: [{ session_id: 's', mtime_ms: NOW - 5_000 }],
          },
        ],
        live_worktree_cwds: [worktreePath],
      };
      const presence = joinClaudeState(raw, [wt(worktreePath)], NOW).get(worktreePath)!;
      expect(presence.status).toBe('live');
    });

    it('promotes recent → idle when a process is running', () => {
      // Newest JSONL is 90s old (past LIVE_WINDOW_MS but inside RECENT_WINDOW_MS).
      // Without process detection this would be `recent` and the session would
      // be in inactiveSessions. With process detection it should be `idle` and
      // the session is the activeSessionId (NOT in the past list).
      const raw: ClaudeStateRaw = {
        ide_locks: [],
        projects: [
          {
            dir_name: dirName,
            worktree_path: worktreePath,
            sessions: [{ session_id: 'idling', mtime_ms: NOW - 90_000 }],
          },
        ],
        live_worktree_cwds: [worktreePath],
      };
      const presence = joinClaudeState(raw, [wt(worktreePath)], NOW).get(worktreePath)!;
      expect(presence.status).toBe('idle');
      expect(presence.activeSessionId).toBe('idling');
      expect(presence.inactiveSessions).toEqual([]);
    });

    it('promotes dormant → idle when a process is running', () => {
      // Even a JSONL outside the RECENT_WINDOW_MS gets promoted: the running
      // process is the authoritative signal, not the file mtime.
      const raw: ClaudeStateRaw = {
        ide_locks: [],
        projects: [
          {
            dir_name: dirName,
            worktree_path: worktreePath,
            sessions: [
              { session_id: 'idling', mtime_ms: NOW - 2 * RECENT_WINDOW_MS },
              { session_id: 'older', mtime_ms: NOW - 3 * RECENT_WINDOW_MS },
            ],
          },
        ],
        live_worktree_cwds: [worktreePath],
      };
      const presence = joinClaudeState(raw, [wt(worktreePath)], NOW).get(worktreePath)!;
      expect(presence.status).toBe('idle');
      expect(presence.activeSessionId).toBe('idling');
      // The older session is still surfaced as past — we only promote one.
      expect(presence.inactiveSessions.map((s) => s.sessionId)).toEqual(['older']);
    });

    it('leaves status=recent when no process is running', () => {
      // Sanity check: without the live_worktree_cwds entry, the existing
      // recent/dormant behavior is preserved exactly.
      const raw: ClaudeStateRaw = {
        ide_locks: [],
        projects: [
          {
            dir_name: dirName,
            worktree_path: worktreePath,
            sessions: [{ session_id: 's', mtime_ms: NOW - 90_000 }],
          },
        ],
      };
      const presence = joinClaudeState(raw, [wt(worktreePath)], NOW).get(worktreePath)!;
      expect(presence.status).toBe('recent');
      expect(presence.activeSessionId).toBeUndefined();
      expect(presence.inactiveSessions).toHaveLength(1);
    });

    it('does NOT promote when process is running but no project dir exists', () => {
      // Edge case: a `claude` process is running in a worktree that has no
      // project dir (e.g. brand-new worktree, no flush yet). We can't
      // attribute the process to any session, so we don't fabricate one —
      // status stays `none` rather than fake-claiming `idle`.
      const raw: ClaudeStateRaw = {
        ide_locks: [],
        projects: [],
        live_worktree_cwds: [worktreePath],
      };
      const presence = joinClaudeState(raw, [wt(worktreePath)], NOW).get(worktreePath)!;
      expect(presence.status).toBe('none');
      expect(presence.activeSessionId).toBeUndefined();
    });

    it('counts the running process as 1 live agent for the multi-Claude warning', () => {
      // When idle, the process counts as 1 live agent. If a second process
      // were running in the same worktree we'd see 2 live agents — though
      // we'd typically see that via the JSONL mtime path first. The
      // important property: idle alone reports liveSessionCount === 1 so
      // the badge isn't blank.
      const raw: ClaudeStateRaw = {
        ide_locks: [],
        projects: [
          {
            dir_name: dirName,
            worktree_path: worktreePath,
            sessions: [{ session_id: 's', mtime_ms: NOW - 90_000 }],
          },
        ],
        live_worktree_cwds: [worktreePath],
      };
      const presence = joinClaudeState(raw, [wt(worktreePath)], NOW).get(worktreePath)!;
      expect(presence.liveSessionCount).toBe(1);
    });

    it('IDE lock still wins over idle (lock is the strongest signal)', () => {
      // If the IDE lock is present, the user is actively in the IDE and
      // we should keep `live-ide`. The idle promotion is only for the
      // path where there's no lock.
      const raw: ClaudeStateRaw = {
        ide_locks: [{ pid: 1, ide_name: 'Cursor', workspace_folders: [worktreePath] }],
        projects: [
          {
            dir_name: dirName,
            worktree_path: worktreePath,
            sessions: [{ session_id: 's', mtime_ms: NOW - 90_000 }],
          },
        ],
        live_worktree_cwds: [worktreePath],
      };
      const presence = joinClaudeState(raw, [wt(worktreePath)], NOW).get(worktreePath)!;
      expect(presence.status).toBe('live-ide');
    });
  });

  it('inactive sessions are emitted newest-first regardless of input order', () => {
    const raw: ClaudeStateRaw = {
      ide_locks: [],
      projects: [
        {
          dir_name: dirName,
          worktree_path: worktreePath,
          sessions: [
            { session_id: 'old', mtime_ms: NOW - RECENT_WINDOW_MS - 60_000 },
            { session_id: 'older', mtime_ms: NOW - RECENT_WINDOW_MS - 120_000 },
            { session_id: 'oldest', mtime_ms: NOW - RECENT_WINDOW_MS - 180_000 },
          ],
        },
      ],
    };
    const presence = joinClaudeState(raw, [wt(worktreePath)], NOW).get(worktreePath)!;
    expect(presence.inactiveSessions.map((s) => s.sessionId)).toEqual([
      'old',
      'older',
      'oldest',
    ]);
  });
});

describe('fetchClaudePresence fingerprint cache', () => {
  beforeEach(() => {
    _resetClaudePresenceCacheForTests();
    readClaudeStateMock.mockReset();
  });

  const wtPath = '/Users/adam/proj';
  const dirName = encodeProjectDirName(wtPath);
  const worktrees = [wt(wtPath)];

  function buildRaw(opts: { fingerprint: string; mtime: number }): ClaudeStateRaw {
    return {
      ide_locks: [],
      projects: [
        {
          dir_name: dirName,
          worktree_path: wtPath,
          sessions: [{ session_id: 's', mtime_ms: opts.mtime }],
        },
      ],
      fingerprint: opts.fingerprint,
      unchanged: false,
    };
  }

  it('passes the previous fingerprint back to readClaudeState on subsequent calls', async () => {
    readClaudeStateMock.mockResolvedValueOnce(
      buildRaw({ fingerprint: 'fp-1', mtime: Date.now() }),
    );
    readClaudeStateMock.mockResolvedValueOnce({
      ide_locks: [],
      projects: [],
      fingerprint: 'fp-1',
      unchanged: true,
    });

    await fetchClaudePresence(worktrees);
    await fetchClaudePresence(worktrees);

    expect(readClaudeStateMock).toHaveBeenCalledTimes(2);
    // First call: no expected fingerprint (cold cache).
    expect(readClaudeStateMock.mock.calls[0]?.[0]).toBeUndefined();
    // Second call: passes the prior fingerprint.
    expect(readClaudeStateMock.mock.calls[1]?.[0]).toBe('fp-1');
  });

  it('re-joins from cached raw on unchanged so status fields reflect current time', async () => {
    // Session mtime old enough that it's `live` at first call but should be
    // `recent` once wall-clock advances past LIVE_WINDOW_MS (60s). The
    // advance must stay under CLAUDE_FORCE_REFRESH_MS (30s) so the cache
    // path actually engages — otherwise the force-refresh would kick us out
    // and we'd be testing the cold path instead.
    const t0 = 1_000_000_000_000;
    const mtime = t0 - 50_000; // age 50s when first joined → live (≤ 60s)
    vi.useFakeTimers();
    try {
      vi.setSystemTime(t0);
      readClaudeStateMock.mockResolvedValueOnce(
        buildRaw({ fingerprint: 'fp-1', mtime }),
      );
      const first = await fetchClaudePresence(worktrees);
      expect(first.get(wtPath)?.status).toBe('live');

      // Advance 15s (within force-refresh window). True age now 65s, past
      // LIVE_WINDOW_MS=60s. The cache hit (unchanged=true) should re-join
      // the cached raw against the new wall clock and report `recent`, not
      // the stale `live` from the first call's joined map.
      vi.setSystemTime(t0 + 15_000);
      readClaudeStateMock.mockResolvedValueOnce({
        ide_locks: [],
        projects: [],
        fingerprint: 'fp-1',
        unchanged: true,
      });
      const second = await fetchClaudePresence(worktrees);
      expect(second.get(wtPath)?.status).toBe('recent');
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses fresh live_worktree_cwds from the unchanged response (exited-process detection)', async () => {
    const t0 = 2_000_000_000_000;
    // Pick a JSONL mtime that's outside LIVE_WINDOW_MS but inside
    // RECENT_WINDOW_MS. With the cwd present we expect `idle`; without it,
    // `recent`. The test confirms the cached projects data combines with the
    // FRESH cwd list rather than the cached one — same fix shape as the
    // existing crashed-IDE test.
    const mtime = t0 - 90_000;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(t0);
      readClaudeStateMock.mockResolvedValueOnce({
        ide_locks: [],
        projects: [
          {
            dir_name: dirName,
            worktree_path: wtPath,
            sessions: [{ session_id: 's', mtime_ms: mtime }],
          },
        ],
        live_worktree_cwds: [wtPath],
        fingerprint: 'fp-1',
        unchanged: false,
      });
      const first = await fetchClaudePresence(worktrees);
      expect(first.get(wtPath)?.status).toBe('idle');

      // Second call: Rust short-circuits projects but reports the process is
      // gone. The TS side must use the fresh empty cwd list, dropping idle
      // back to recent.
      readClaudeStateMock.mockResolvedValueOnce({
        ide_locks: [],
        projects: [],
        live_worktree_cwds: [],
        fingerprint: 'fp-1',
        unchanged: true,
      });
      const second = await fetchClaudePresence(worktrees);
      expect(second.get(wtPath)?.status).toBe('recent');
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses fresh ide_locks from the unchanged response (crashed-IDE detection)', async () => {
    const mtime = Date.now();
    // First call: a session with status=live, plus an IDE lock pointing at it.
    readClaudeStateMock.mockResolvedValueOnce({
      ide_locks: [
        { pid: 4242, ide_name: 'Cursor', workspace_folders: [wtPath] },
      ],
      projects: [
        {
          dir_name: dirName,
          worktree_path: wtPath,
          sessions: [{ session_id: 's', mtime_ms: mtime }],
        },
      ],
      fingerprint: 'fp-1',
      unchanged: false,
    });
    const first = await fetchClaudePresence(worktrees);
    expect(first.get(wtPath)?.status).toBe('live-ide');

    // Second call: Rust short-circuits projects but reports the IDE lock has
    // disappeared (the editor crashed and pid_is_alive filtered it out).
    // The TS side must use the fresh empty ide_locks rather than the cached
    // ones, so status drops back to `live` (no IDE lock).
    readClaudeStateMock.mockResolvedValueOnce({
      ide_locks: [],
      projects: [],
      fingerprint: 'fp-1',
      unchanged: true,
    });
    const second = await fetchClaudePresence(worktrees);
    expect(second.get(wtPath)?.status).toBe('live');
  });

  it('re-joins when Rust returns a different fingerprint', async () => {
    const mtime = Date.now();
    readClaudeStateMock.mockResolvedValueOnce(buildRaw({ fingerprint: 'fp-1', mtime }));
    readClaudeStateMock.mockResolvedValueOnce(
      buildRaw({ fingerprint: 'fp-2', mtime: mtime + 5_000 }),
    );

    const first = await fetchClaudePresence(worktrees);
    const second = await fetchClaudePresence(worktrees);

    // Different `raw` means a fresh join — different Map references.
    expect(second).not.toBe(first);
  });

  it('does not pass expected fingerprint when the worktree set has changed', async () => {
    const mtime = Date.now();
    readClaudeStateMock.mockResolvedValueOnce(buildRaw({ fingerprint: 'fp-1', mtime }));
    readClaudeStateMock.mockResolvedValueOnce(buildRaw({ fingerprint: 'fp-1', mtime }));

    await fetchClaudePresence([wt('/path/a')]);
    await fetchClaudePresence([wt('/path/b')]);

    // Second call's worktree set differs → expected should be undefined so
    // Rust always does the full read regardless of fingerprint match.
    expect(readClaudeStateMock.mock.calls[1]?.[0]).toBeUndefined();
  });

  it('returns an empty map and does not poison the cache on bridge failure', async () => {
    readClaudeStateMock.mockRejectedValueOnce(new Error('bridge down'));
    const result = await fetchClaudePresence(worktrees);
    expect(result.size).toBe(0);

    // Next call should still cold-start (no expected fingerprint passed).
    readClaudeStateMock.mockResolvedValueOnce(buildRaw({ fingerprint: 'fp-1', mtime: Date.now() }));
    await fetchClaudePresence(worktrees);
    expect(readClaudeStateMock.mock.calls[1]?.[0]).toBeUndefined();
  });
});

