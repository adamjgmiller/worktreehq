import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseWorktreeList,
  classifyStatusLines,
  detectInProgressFromMarkers,
  archiveTagNameFor,
  stripEmailAngles,
  isAncestor,
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
