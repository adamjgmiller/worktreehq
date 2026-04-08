import { describe, it, expect } from 'vitest';
import {
  encodeProjectDirName,
  joinClaudeState,
  resumeCommand,
  LIVE_WINDOW_MS,
  RECENT_WINDOW_MS,
} from './claudeAwarenessService';
import type { ClaudeStateRaw, Worktree } from '../types';

function wt(path: string, branch = 'feat/x'): Worktree {
  return {
    path,
    branch,
    isPrimary: false,
    head: 'abc',
    uncommittedCount: 0,
    stagedCount: 0,
    ahead: 0,
    behind: 0,
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
