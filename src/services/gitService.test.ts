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
