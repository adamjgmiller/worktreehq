import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseWorktreeList,
  classifyStatusLines,
  detectInProgressFromMarkers,
  archiveTagNameFor,
  stripEmailAngles,
  isAncestor,
  parseStashBranches,
  resolveWatchDirs,
  listMainCommits,
  listTags,
  invalidateTagsCache,
  listBranches,
  _clearBranchAbCacheForTests,
} from './gitService';

vi.mock('./tauriBridge', () => ({
  gitExec: vi.fn(),
  pathExists: vi.fn(),
}));

import { gitExec } from './tauriBridge';

const gitExecMock = gitExec as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  gitExecMock.mockReset();
});

describe('parseWorktreeList', () => {
  it('parses porcelain output', () => {
    const input = `worktree /home/u/repo
HEAD abc123
branch refs/heads/main

worktree /home/u/repo-wt2
HEAD def456
branch refs/heads/feat/foo

worktree /home/u/repo-wt3
HEAD 000111
detached
`;
    const out = parseWorktreeList(input);
    expect(out).toEqual([
      { path: '/home/u/repo', head: 'abc123', branch: 'main' },
      { path: '/home/u/repo-wt2', head: 'def456', branch: 'feat/foo' },
      { path: '/home/u/repo-wt3', head: '000111', branch: '(detached)' },
    ]);
  });
});

describe('classifyStatusLines', () => {
  it('splits untracked (??) from modified (tree) and tracks staged separately', () => {
    const status = [
      '?? newfile.txt', // untracked
      ' M tracked.txt', // modified worktree
      'M  staged.txt', // staged
      'MM both.txt', // staged + modified
    ].join('\n');
    expect(classifyStatusLines(status)).toEqual({
      untracked: 1,
      modified: 2,
      staged: 2,
      conflicts: 0,
    });
  });
  it('counts conflicts from UU / AA / DD', () => {
    const status = ['UU a', 'AA b', 'DD c', 'M  safe'].join('\n');
    expect(classifyStatusLines(status)).toEqual({
      untracked: 0,
      modified: 0,
      staged: 1,
      conflicts: 3,
    });
  });
  it('handles empty input', () => {
    expect(classifyStatusLines('')).toEqual({
      untracked: 0,
      modified: 0,
      staged: 0,
      conflicts: 0,
    });
  });
});

describe('detectInProgressFromMarkers', () => {
  const none = {
    rebaseMerge: false,
    rebaseApply: false,
    mergeHead: false,
    cherryPickHead: false,
    revertHead: false,
    bisectLog: false,
  };
  it('rebase trumps merge-head (git writes both during interactive rebase)', () => {
    expect(
      detectInProgressFromMarkers({ ...none, rebaseMerge: true, mergeHead: true }),
    ).toBe('rebase');
  });
  it('cherry-pick over merge', () => {
    expect(
      detectInProgressFromMarkers({ ...none, cherryPickHead: true, mergeHead: true }),
    ).toBe('cherry-pick');
  });
  it('bisect only when nothing else is active', () => {
    expect(detectInProgressFromMarkers({ ...none, bisectLog: true })).toBe('bisect');
  });
  it('undefined for a clean worktree', () => {
    expect(detectInProgressFromMarkers(none)).toBeUndefined();
  });
});

describe('archiveTagNameFor', () => {
  it('prefixes archive/ to any branch name, nested or not', () => {
    expect(archiveTagNameFor('feat/login')).toBe('archive/feat/login');
    expect(archiveTagNameFor('fix')).toBe('archive/fix');
  });
});

describe('stripEmailAngles', () => {
  it('unwraps <name@example.com>', () => {
    expect(stripEmailAngles('<a@b.com>')).toBe('a@b.com');
  });
  it('returns bare strings untouched', () => {
    expect(stripEmailAngles('a@b.com')).toBe('a@b.com');
  });
  it('handles empty and undefined', () => {
    expect(stripEmailAngles('')).toBeUndefined();
    expect(stripEmailAngles(undefined)).toBeUndefined();
    expect(stripEmailAngles('   ')).toBeUndefined();
  });
});

describe('parseStashBranches', () => {
  it('extracts branches from WIP stash entries', () => {
    const raw = [
      'stash@{0}: WIP on feat/login: abc1234 fix nav',
      'stash@{1}: WIP on main: deadbee readme',
      'stash@{2}: WIP on feat/login: beefcafe spinner',
    ].join('\n');
    expect(parseStashBranches(raw)).toEqual(['feat/login', 'main', 'feat/login']);
  });
  it('handles manual "On <branch>:" stashes', () => {
    const raw = [
      'stash@{0}: On feat/x: my manual stash',
      'stash@{1}: WIP on feat/x: abc message',
    ].join('\n');
    expect(parseStashBranches(raw)).toEqual(['feat/x', 'feat/x']);
  });
  it('returns empty for empty or malformed input', () => {
    expect(parseStashBranches('')).toEqual([]);
    expect(parseStashBranches('\n\n')).toEqual([]);
    expect(parseStashBranches('garbage line')).toEqual([]);
  });
  it('handles branch names with slashes', () => {
    expect(
      parseStashBranches('stash@{0}: WIP on fix/auth/token-refresh: 123 msg'),
    ).toEqual(['fix/auth/token-refresh']);
  });
});

describe('resolveWatchDirs', () => {
  it('dedupes git-dir + git-common-dir across multiple worktrees', async () => {
    // Primary worktree: both dirs are the same `.git/`. Linked worktree:
    // git-dir differs (points at .git/worktrees/<name>/) but common-dir is
    // the same as the primary. Expect 2 unique dirs in output.
    gitExecMock.mockImplementation(async (repo: string) => {
      if (repo === '/repo/primary') {
        return {
          stdout: '/repo/primary/.git\n/repo/primary/.git\n',
          stderr: '',
          code: 0,
        };
      }
      if (repo === '/repo/linked') {
        return {
          stdout: '/repo/primary/.git/worktrees/linked\n/repo/primary/.git\n',
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '', stderr: '', code: 1 };
    });

    const out = await resolveWatchDirs(['/repo/primary', '/repo/linked']);
    expect(out.sort()).toEqual(
      ['/repo/primary/.git', '/repo/primary/.git/worktrees/linked'].sort(),
    );
  });

  it('silently drops worktrees where rev-parse fails', async () => {
    gitExecMock.mockImplementation(async (repo: string) => {
      if (repo === '/repo/ok') {
        return { stdout: '/repo/ok/.git\n/repo/ok/.git\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: 'bad', code: 1 };
    });
    const out = await resolveWatchDirs(['/repo/ok', '/repo/broken']);
    expect(out).toEqual(['/repo/ok/.git']);
  });

  it('handles a rejecting gitExec without throwing', async () => {
    gitExecMock.mockRejectedValue(new Error('boom'));
    await expect(resolveWatchDirs(['/repo/a'])).resolves.toEqual([]);
  });
});

describe('listMainCommits', () => {
  beforeEach(() => {
    gitExecMock.mockReset();
  });

  it('skips the count subprocess when the log returned fewer than `limit` rows', async () => {
    gitExecMock.mockResolvedValueOnce({
      stdout: 'abc\tone\t2026-01-01T00:00:00Z\ndef\ttwo (#42)\t2026-01-02T00:00:00Z\n',
      stderr: '',
      code: 0,
    });
    const out = await listMainCommits('/repo', 'main', 200);
    expect(out.commits).toHaveLength(2);
    expect(out.commits[1].prNumber).toBe(42);
    expect(out.total).toBe(2);
    // Only one git invocation: the log. No follow-up rev-list.
    expect(gitExecMock).toHaveBeenCalledTimes(1);
  });

  it('issues a count subprocess only when the log saturates `limit`', async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `sha${i}\tmsg\t2026-01-01T00:00:00Z`).join('\n');
    gitExecMock.mockResolvedValueOnce({ stdout: lines, stderr: '', code: 0 });
    gitExecMock.mockResolvedValueOnce({ stdout: '999\n', stderr: '', code: 0 });
    const out = await listMainCommits('/repo', 'main', 5);
    expect(out.commits).toHaveLength(5);
    expect(out.total).toBe(999);
    expect(gitExecMock).toHaveBeenCalledTimes(2);
    expect(gitExecMock.mock.calls[1]?.[1]).toEqual([
      'rev-list',
      '--count',
      '--first-parent',
      'main',
    ]);
  });
});

describe('listTags caching', () => {
  beforeEach(() => {
    invalidateTagsCache();
    gitExecMock.mockReset();
  });

  it('serves a second call from cache within the TTL', async () => {
    gitExecMock.mockResolvedValue({ stdout: 'v1\nv2\n', stderr: '', code: 0 });
    const a = await listTags('/repo');
    const b = await listTags('/repo');
    expect(a).toEqual(['v1', 'v2']);
    expect(b).toEqual(['v1', 'v2']);
    expect(gitExecMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after invalidation', async () => {
    gitExecMock.mockResolvedValueOnce({ stdout: 'v1\n', stderr: '', code: 0 });
    gitExecMock.mockResolvedValueOnce({ stdout: 'v1\nv2\n', stderr: '', code: 0 });
    await listTags('/repo');
    invalidateTagsCache();
    const out = await listTags('/repo');
    expect(out).toEqual(['v1', 'v2']);
    expect(gitExecMock).toHaveBeenCalledTimes(2);
  });

  it('re-fetches when the repo path changes', async () => {
    gitExecMock.mockResolvedValueOnce({ stdout: 'v1\n', stderr: '', code: 0 });
    gitExecMock.mockResolvedValueOnce({ stdout: 'other\n', stderr: '', code: 0 });
    await listTags('/repo/a');
    const out = await listTags('/repo/b');
    expect(out).toEqual(['other']);
    expect(gitExecMock).toHaveBeenCalledTimes(2);
  });
});

describe('listBranches sha-cache', () => {
  beforeEach(() => {
    _clearBranchAbCacheForTests();
    gitExecMock.mockReset();
  });

  // Helper: build a deterministic gitExec mock that mimics the subprocess
  // shapes listBranches expects (for-each-ref local + remote, then per-branch
  // rev-list + merge-base for each branch).
  function setupMocks(localShas: Record<string, string>) {
    const localOut = Object.entries(localShas)
      .map(([name, sha]) => `${name}\t${sha}\t2026-01-01 00:00:00 +0000\t\t<u@x.com>`)
      .join('\n');
    let perBranchCallIdx = 0;
    gitExecMock.mockImplementation(async (_repo: string, args: string[]) => {
      if (args[0] === 'for-each-ref' && args.includes('refs/heads')) {
        return { stdout: localOut, stderr: '', code: 0 };
      }
      if (args[0] === 'for-each-ref' && args.includes('refs/remotes')) {
        return { stdout: '', stderr: '', code: 0 };
      }
      if (args[0] === 'rev-list') {
        return { stdout: '0\t3\n', stderr: '', code: 0 };
      }
      if (args[0] === 'merge-base') {
        // Alternate between merged/unmerged just to exercise both paths.
        const merged = perBranchCallIdx++ % 2 === 0;
        return { stdout: '', stderr: '', code: merged ? 0 : 1 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });
  }

  it('serves a second call from cache when no shas have moved', async () => {
    setupMocks({ main: 'mainsha', 'feat/a': 'shaA', 'feat/b': 'shaB' });
    await listBranches('/repo', 'main');
    const callsAfterFirst = gitExecMock.mock.calls.length;
    await listBranches('/repo', 'main');
    const callsAfterSecond = gitExecMock.mock.calls.length;
    // Second call still issues 2 for-each-ref calls (those aren't cached
    // here — only per-branch ahead/behind+ancestor are). So the diff is
    // exactly 2, with zero per-branch subprocess work.
    expect(callsAfterSecond - callsAfterFirst).toBe(2);
  });

  it('re-runs per-branch subprocesses when the branch sha moves', async () => {
    setupMocks({ main: 'mainsha', 'feat/a': 'shaA' });
    await listBranches('/repo', 'main');
    const initialCalls = gitExecMock.mock.calls.length;
    // Move feat/a to a new sha — cache key changes, recompute expected.
    setupMocks({ main: 'mainsha', 'feat/a': 'shaA2' });
    await listBranches('/repo', 'main');
    // 2 for-each-ref + 2 per-branch (rev-list + merge-base for the moved branch).
    // main itself also gets a per-branch pair, but main and main share the same key
    // across both calls, so main's second call hits the cache.
    expect(gitExecMock.mock.calls.length - initialCalls).toBeGreaterThanOrEqual(4);
  });
});

describe('isAncestor', () => {
  it('returns true when git exits 0 (branch is ancestor)', async () => {
    gitExecMock.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    await expect(isAncestor('/repo', 'feat/x', 'main')).resolves.toBe(true);
    expect(gitExecMock).toHaveBeenCalledWith('/repo', [
      'merge-base',
      '--is-ancestor',
      'feat/x',
      'main',
    ]);
  });
  it('returns false when git exits 1 (not an ancestor)', async () => {
    gitExecMock.mockResolvedValue({ stdout: '', stderr: '', code: 1 });
    await expect(isAncestor('/repo', 'feat/x', 'main')).resolves.toBe(false);
  });
  it('returns false on git_exec rejection', async () => {
    gitExecMock.mockRejectedValue(new Error('boom'));
    await expect(isAncestor('/repo', 'feat/x', 'main')).resolves.toBe(false);
  });
});
