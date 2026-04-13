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
  resolveMainUpstreams,
  cherryCheck,
  createWorktree,
  _clearBranchAbCacheForTests,
  parseGitVersion,
  setGitVersion,
  supportsWriteTree,
} from './gitService';

vi.mock('./tauriBridge', () => ({
  gitExec: vi.fn(),
  pathExists: vi.fn(),
  ensureDir: vi.fn(),
}));

import { gitExec, ensureDir } from './tauriBridge';

const gitExecMock = gitExec as unknown as ReturnType<typeof vi.fn>;
const ensureDirMock = ensureDir as unknown as ReturnType<typeof vi.fn>;

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

  it('captures the prunable reason when git flags an orphaned worktree', () => {
    // Mixed input: one healthy worktree, one orphaned with a reason. Without
    // the prunable capture the orphan would parse identically to the healthy
    // entry and silently flow into worktreeCore against a missing path.
    const input = `worktree /home/u/repo
HEAD abc123
branch refs/heads/main

worktree /home/u/ghost
HEAD def456
branch refs/heads/feat/gone
prunable gitdir file points to non-existent location
`;
    const out = parseWorktreeList(input);
    expect(out).toEqual([
      { path: '/home/u/repo', head: 'abc123', branch: 'main' },
      {
        path: '/home/u/ghost',
        head: 'def456',
        branch: 'feat/gone',
        prunable: 'gitdir file points to non-existent location',
      },
    ]);
  });

  it('captures a bare prunable line with no reason text', () => {
    // Older git versions sometimes emit `prunable` with no trailing reason.
    // We still want to flag the entry as orphaned rather than dropping the
    // signal entirely.
    const input = `worktree /home/u/ghost
HEAD def456
branch refs/heads/feat/gone
prunable
`;
    const out = parseWorktreeList(input);
    expect(out[0].prunable).toBe('(no reason given)');
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

describe('resolveMainUpstreams', () => {
  beforeEach(() => {
    gitExecMock.mockReset();
  });

  it('includes origin/<default> when the remote-tracking ref exists', async () => {
    // rev-parse --verify --quiet succeeds and prints the SHA.
    gitExecMock.mockResolvedValueOnce({
      stdout: '98a8dcea02f1ec369e93c5a3f7e442562ff3b4d8\n',
      stderr: '',
      code: 0,
    });
    const refs = await resolveMainUpstreams('/repo', 'main');
    expect(refs).toEqual(['main', 'origin/main']);
    expect(gitExecMock.mock.calls[0]?.[1]).toEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/remotes/origin/main',
    ]);
  });

  it('falls back to local-only when origin/<default> does not exist', async () => {
    // rev-parse --verify --quiet exits non-zero with empty stdout; tryRun
    // returns ''. resolveMainUpstreams must not include origin in that case.
    gitExecMock.mockResolvedValueOnce({ stdout: '', stderr: '', code: 1 });
    const refs = await resolveMainUpstreams('/repo', 'trunk');
    expect(refs).toEqual(['trunk']);
  });

  it('treats whitespace-only rev-parse output as "not present"', async () => {
    // Defensive against a theoretically possible whitespace-only response.
    gitExecMock.mockResolvedValueOnce({ stdout: '   \n', stderr: '', code: 0 });
    const refs = await resolveMainUpstreams('/repo', 'main');
    expect(refs).toEqual(['main']);
  });
});

describe('listMainCommits', () => {
  beforeEach(() => {
    gitExecMock.mockReset();
  });

  it('skips the count subprocess when the log returned fewer than `limit` rows', async () => {
    // 1. resolveMainUpstreams → rev-parse (origin exists)
    gitExecMock.mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', code: 0 });
    // 2. the log itself
    gitExecMock.mockResolvedValueOnce({
      stdout: 'abc\tone\t2026-01-01T00:00:00Z\ndef\ttwo (#42)\t2026-01-02T00:00:00Z\n',
      stderr: '',
      code: 0,
    });
    const out = await listMainCommits('/repo', 'main', 200);
    expect(out.commits).toHaveLength(2);
    expect(out.commits[1].prNumber).toBe(42);
    expect(out.total).toBe(2);
    // Two git invocations: rev-parse + log. No follow-up rev-list.
    expect(gitExecMock).toHaveBeenCalledTimes(2);
    // The log walked BOTH refs.
    expect(gitExecMock.mock.calls[1]?.[1]).toEqual([
      'log',
      'main',
      'origin/main',
      '--first-parent',
      '-200',
      '--format=%H%x09%s%x09%cI',
    ]);
  });

  it('issues a count subprocess only when the log saturates `limit`', async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `sha${i}\tmsg\t2026-01-01T00:00:00Z`).join('\n');
    // 1. rev-parse — origin exists
    gitExecMock.mockResolvedValueOnce({ stdout: 'sha\n', stderr: '', code: 0 });
    // 2. log
    gitExecMock.mockResolvedValueOnce({ stdout: lines, stderr: '', code: 0 });
    // 3. count — must be against the same ref set the log walked
    gitExecMock.mockResolvedValueOnce({ stdout: '999\n', stderr: '', code: 0 });
    const out = await listMainCommits('/repo', 'main', 5);
    expect(out.commits).toHaveLength(5);
    expect(out.total).toBe(999);
    expect(gitExecMock).toHaveBeenCalledTimes(3);
    expect(gitExecMock.mock.calls[2]?.[1]).toEqual([
      'rev-list',
      '--count',
      '--first-parent',
      'main',
      'origin/main',
    ]);
  });

  it('walks local-only when origin/<default> does not exist', async () => {
    // rev-parse exits non-zero → tryRun returns ''
    gitExecMock.mockResolvedValueOnce({ stdout: '', stderr: '', code: 1 });
    gitExecMock.mockResolvedValueOnce({
      stdout: 'abc\tone\t2026-01-01T00:00:00Z\n',
      stderr: '',
      code: 0,
    });
    const out = await listMainCommits('/repo', 'main', 200);
    expect(out.commits).toHaveLength(1);
    // The log walked ONLY local main — no origin/main in the args.
    expect(gitExecMock.mock.calls[1]?.[1]).toEqual([
      'log',
      'main',
      '--first-parent',
      '-200',
      '--format=%H%x09%s%x09%cI',
    ]);
  });
});

describe('cherryCheck', () => {
  beforeEach(() => {
    gitExecMock.mockReset();
  });

  it('returns true when every branch commit is patch-present in the single upstream', async () => {
    // `git cherry main feat/x` output: two commits, both marked `-` (present).
    gitExecMock.mockResolvedValueOnce({
      stdout: '- aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n- bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n',
      stderr: '',
      code: 0,
    });
    await expect(cherryCheck('/repo', ['main'], 'feat/x')).resolves.toBe(true);
    expect(gitExecMock.mock.calls[0]?.[1]).toEqual(['cherry', 'main', 'feat/x']);
  });

  it('returns false when any branch commit is marked + (not present)', async () => {
    gitExecMock.mockResolvedValueOnce({
      stdout: '- aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n+ bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n',
      stderr: '',
      code: 0,
    });
    await expect(cherryCheck('/repo', ['main'], 'feat/x')).resolves.toBe(false);
  });

  it('returns false on empty cherry output (nothing to check)', async () => {
    gitExecMock.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });
    await expect(cherryCheck('/repo', ['main'], 'feat/x')).resolves.toBe(false);
  });

  it('unions patch-presence across multiple upstreams — local misses, origin catches', async () => {
    // This is the regression case the whole PR exists for: local main is
    // stale (doesn't have the squash commit), so `cherry main` marks every
    // branch commit as `+`. origin/main has the squash commit, so
    // `cherry origin/main` marks the same commits as `-`. The union must
    // decide the branch IS merged.
    gitExecMock.mockResolvedValueOnce({
      // cherry main feat/x — nothing patch-present on stale local main
      stdout: '+ aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n+ bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n',
      stderr: '',
      code: 0,
    });
    gitExecMock.mockResolvedValueOnce({
      // cherry origin/main feat/x — both commits are patch-present
      stdout: '- aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n- bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n',
      stderr: '',
      code: 0,
    });
    await expect(cherryCheck('/repo', ['main', 'origin/main'], 'feat/x')).resolves.toBe(true);
    expect(gitExecMock).toHaveBeenCalledTimes(2);
  });

  it('returns false when a commit is absent from ALL upstreams in the union', async () => {
    // Same SHAs in both runs. A is marked `-` in origin only; B is marked
    // `+` in both. The union still can't account for B → not merged.
    gitExecMock.mockResolvedValueOnce({
      stdout: '+ aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n+ bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n',
      stderr: '',
      code: 0,
    });
    gitExecMock.mockResolvedValueOnce({
      stdout: '- aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n+ bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n',
      stderr: '',
      code: 0,
    });
    await expect(cherryCheck('/repo', ['main', 'origin/main'], 'feat/x')).resolves.toBe(false);
  });

  it('handles divergent cherry output (different SHAs per upstream) via the union', async () => {
    // Edge case: a commit that's ancestor of origin/main won't show up in
    // `cherry origin/main branch` at all (it's no longer in the range), but
    // will show up in `cherry local_main branch` (still in range, marked `-`).
    // Using the union of SHAs across runs, every commit listed in either run
    // must have at least one `-` mark — still correctly decides "merged".
    gitExecMock.mockResolvedValueOnce({
      stdout: '- aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n- bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n',
      stderr: '',
      code: 0,
    });
    // origin/main range omits `a` entirely (ancestor already), lists only `b`.
    gitExecMock.mockResolvedValueOnce({
      stdout: '- bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n',
      stderr: '',
      code: 0,
    });
    await expect(cherryCheck('/repo', ['main', 'origin/main'], 'feat/x')).resolves.toBe(true);
  });

  it('returns false when given an empty upstream list (defensive)', async () => {
    await expect(cherryCheck('/repo', [], 'feat/x')).resolves.toBe(false);
    expect(gitExecMock).not.toHaveBeenCalled();
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
    // Second call still issues 2 for-each-ref calls plus the first-parent
    // rev-list (none of those three are cached here — only per-branch
    // ahead/behind+ancestor are). So the diff is exactly 3, with zero
    // per-branch subprocess work.
    expect(callsAfterSecond - callsAfterFirst).toBe(3);
  });

  it('does NOT cache transient subprocess failures', async () => {
    // First call: rev-list for feat/a throws (transient ref race during
    // rebase). main's probes succeed normally. The fix gates cache writes
    // on both probes returning a usable answer, so feat/a stays uncached
    // while main does get cached.
    //
    // Without the fix, feat/a would be cached as { aheadOfMain: 0,
    // behindMain: 0, merged: false } and that bogus answer would stick
    // until either sha actually moved.
    let revListThrowsForNextFeatA = true;
    gitExecMock.mockImplementation(async (_repo: string, args: string[]) => {
      if (args[0] === 'for-each-ref' && args.includes('refs/heads')) {
        return {
          stdout:
            'main\tmainsha\t2026-01-01 00:00:00 +0000\t\t<u@x.com>\n' +
            'feat/a\tshaA\t2026-01-01 00:00:00 +0000\t\t<u@x.com>',
          stderr: '',
          code: 0,
        };
      }
      if (args[0] === 'for-each-ref' && args.includes('refs/remotes')) {
        return { stdout: '', stderr: '', code: 0 };
      }
      if (args[0] === 'rev-list') {
        // Only the first feat/a rev-list throws; main's rev-list and the
        // second-call feat/a rev-list both succeed.
        const isFeatA = args[args.length - 1].includes('feat/a');
        if (isFeatA && revListThrowsForNextFeatA) {
          revListThrowsForNextFeatA = false;
          throw new Error('object not found');
        }
        return { stdout: '0\t3\n', stderr: '', code: 0 };
      }
      if (args[0] === 'merge-base') {
        return { stdout: '', stderr: '', code: 1 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    await listBranches('/repo', 'main');
    const callsAfterFirst = gitExecMock.mock.calls.length;

    // Second call with the same shas. main's per-branch probes were cached
    // on the first call (succeeded), so they don't re-run. feat/a's per-branch
    // probes were NOT cached (rev-list threw), so they DO re-run. The diff
    // should be exactly: 2 for-each-ref + 1 first-parent rev-list + 2 per-branch
    // for feat/a = 5.
    //
    // If failures WERE cached (the bug this test guards against), feat/a
    // would also be served from cache and the diff would be just 3.
    await listBranches('/repo', 'main');
    const callsAfterSecond = gitExecMock.mock.calls.length;

    expect(callsAfterSecond - callsAfterFirst).toBe(5);

    // Sanity: confirm one of the new calls is the feat/a rev-list retry.
    const featARevListCalls = gitExecMock.mock.calls.filter(
      (c) => c[1][0] === 'rev-list' && c[1][c[1].length - 1].includes('feat/a'),
    );
    expect(featARevListCalls.length).toBeGreaterThanOrEqual(2);
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

  // Regression for the "MERGED on a brand-new empty branch" bug. Before the
  // first fix (c93793c), listBranches would call `merge-base --is-ancestor
  // branch main`, see exit 0, and tag the branch `merged-normally`. But that
  // exit code is also returned when the branch tip is itself a commit on
  // main's first-parent line — true for any branch that was just created
  // from main and hasn't received any commits yet. That fix gated
  // `merged-normally` on the branch tip NOT being in main's first-parent
  // set, downgrading these branches to `unmerged`.
  //
  // The follow-up (this assertion) goes one step further: a brand-new branch
  // pointing at main's tip has zero commits of its own, so `unmerged` is
  // also misleading — there's nothing to merge. We tag these as `'empty'`
  // and the WorktreeCard renders a quiet slate "no work yet" pill.
  it('does not mark a branch as merged when its tip sits on main first-parent', async () => {
    // feat/empty has the same sha as main (e.g. just created via
    // `git worktree add ../bug-fix -b feat/empty main`). feat/real has
    // committed work, sits off main's first-parent line, AND is an ancestor
    // of main (i.e. it was merge-merged for real).
    gitExecMock.mockImplementation(async (_repo: string, args: string[]) => {
      if (args[0] === 'for-each-ref' && args.includes('refs/heads')) {
        return {
          stdout:
            'main\tmainsha\t2026-01-01T00:00:00+00:00\t\t<u@x.com>\n' +
            'feat/empty\tmainsha\t2026-01-01T00:00:00+00:00\t\t<u@x.com>\n' +
            'feat/real\trealsha\t2026-01-01T00:00:00+00:00\t\t<u@x.com>',
          stderr: '',
          code: 0,
        };
      }
      if (args[0] === 'for-each-ref' && args.includes('refs/remotes')) {
        return { stdout: '', stderr: '', code: 0 };
      }
      // The new first-parent rev-list call: `rev-list main --first-parent`.
      // No --left-right, no --count — just the bare ref. mainsha is the only
      // first-parent commit; realsha was brought in via a merge so it is NOT
      // in this set even though it IS an ancestor of main.
      if (
        args[0] === 'rev-list' &&
        args[1] === 'main' &&
        args.includes('--first-parent') &&
        !args.includes('--count') &&
        !args.includes('--left-right')
      ) {
        return { stdout: 'mainsha\nprevsha\nolder\n', stderr: '', code: 0 };
      }
      if (args[0] === 'rev-list') {
        // Per-branch ahead/behind probe. Both branches have 0 ahead — the
        // empty one trivially, the real one because all its commits already
        // landed on main via the merge.
        return { stdout: '0\t0\n', stderr: '', code: 0 };
      }
      if (args[0] === 'merge-base') {
        // Both feat/empty and feat/real are ancestors of main; the bug was
        // treating both as merged. With the fix, feat/empty is excluded
        // because its tip (mainsha) is in main's first-parent set.
        return { stdout: '', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await listBranches('/repo', 'main');
    const empty = result.find((b) => b.name === 'feat/empty');
    const real = result.find((b) => b.name === 'feat/real');
    expect(empty?.mergeStatus).toBe('empty');
    expect(real?.mergeStatus).toBe('merged-normally');
  });

  // Regression: when the per-branch rev-list fails (caught by .catch → null),
  // aheadOfMain stays at its default 0. Without the guard, the downstream
  // `else if (aheadOfMain === 0)` fires and tags the branch as `empty` — even
  // though we have no data to support that. The branch should stay `unmerged`.
  it('does not mis-tag a branch as empty when rev-list fails', async () => {
    gitExecMock.mockImplementation(async (_repo: string, args: string[]) => {
      if (args[0] === 'for-each-ref' && args.includes('refs/heads')) {
        return {
          stdout: 'main\tmainsha\t2026-01-01T00:00:00+00:00\t\t<u@x.com>\n' +
            'feat/x\tsha-x\t2026-01-01T00:00:00+00:00\t\t<u@x.com>',
          stderr: '',
          code: 0,
        };
      }
      if (args[0] === 'for-each-ref' && args.includes('refs/remotes')) {
        return { stdout: '', stderr: '', code: 0 };
      }
      if (
        args[0] === 'rev-list' &&
        args.includes('--first-parent') &&
        !args.includes('--count')
      ) {
        return { stdout: 'mainsha\n', stderr: '', code: 0 };
      }
      // Per-branch rev-list THROWS for feat/x (simulating a transient
      // failure like a ref race during rebase).
      if (args[0] === 'rev-list') {
        throw new Error('object not found');
      }
      // merge-base also fails.
      if (args[0] === 'merge-base') {
        throw new Error('object not found');
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await listBranches('/repo', 'main');
    const branch = result.find((b) => b.name === 'feat/x');
    // Should stay at the default `unmerged`, NOT be mis-tagged as `empty`.
    expect(branch?.mergeStatus).toBe('unmerged');
  });
});

describe('createWorktree', () => {
  beforeEach(() => {
    gitExecMock.mockReset();
    ensureDirMock.mockReset();
  });

  it('creates the parent directory before running git worktree add', async () => {
    // The whole point of ensureDir here: `.claude/worktrees/` won't exist on
    // a fresh clone, and git worktree add only makes the leaf. Order matters
    // too — if the git command runs first it fails with "No such file or
    // directory" before we ever get to mkdir.
    ensureDirMock.mockResolvedValue(undefined);
    gitExecMock.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await createWorktree('/repo', '/repo/.claude/worktrees/feat-x', 'feat-x', true);

    expect(ensureDirMock).toHaveBeenCalledWith('/repo/.claude/worktrees');
    expect(gitExecMock).toHaveBeenCalledWith('/repo', [
      'worktree',
      'add',
      '-b',
      'feat-x',
      '/repo/.claude/worktrees/feat-x',
    ]);
    // Order: ensureDir before git worktree add.
    const ensureOrder = ensureDirMock.mock.invocationCallOrder[0];
    const gitOrder = gitExecMock.mock.invocationCallOrder[0];
    expect(ensureOrder).toBeLessThan(gitOrder);
  });

  it('passes branch as starting-point argument when reusing an existing branch', async () => {
    ensureDirMock.mockResolvedValue(undefined);
    gitExecMock.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await createWorktree('/repo', '/tmp/wt', 'main', false);

    expect(gitExecMock).toHaveBeenCalledWith('/repo', [
      'worktree',
      'add',
      '/tmp/wt',
      'main',
    ]);
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

describe('parseGitVersion', () => {
  it('parses standard version string', () => {
    expect(parseGitVersion('git version 2.53.0')).toEqual([2, 53]);
  });
  it('parses older version', () => {
    expect(parseGitVersion('git version 2.37.1')).toEqual([2, 37]);
  });
  it('parses major version 1', () => {
    expect(parseGitVersion('git version 1.8.0')).toEqual([1, 8]);
  });
  it('handles Apple git variant', () => {
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)')).toEqual([2, 39]);
  });
  it('returns [0, 0] for garbage', () => {
    expect(parseGitVersion('not a version')).toEqual([0, 0]);
  });
  it('returns [0, 0] for empty string', () => {
    expect(parseGitVersion('')).toEqual([0, 0]);
  });
});

describe('supportsWriteTree', () => {
  beforeEach(() => {
    setGitVersion(''); // Reset to [0, 0]
  });

  it('returns true for git >= 2.38', () => {
    setGitVersion('git version 2.38.0');
    expect(supportsWriteTree()).toBe(true);
    setGitVersion('git version 2.53.0');
    expect(supportsWriteTree()).toBe(true);
  });
  it('returns true for git 3.x', () => {
    setGitVersion('git version 3.0.0');
    expect(supportsWriteTree()).toBe(true);
  });
  it('returns false for git < 2.38', () => {
    setGitVersion('git version 2.37.1');
    expect(supportsWriteTree()).toBe(false);
  });
  it('returns false for unset version', () => {
    setGitVersion('');
    expect(supportsWriteTree()).toBe(false);
  });
});
