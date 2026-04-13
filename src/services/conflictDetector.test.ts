import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectCrossWorktreeConflicts, _clearConflictCacheForTests } from './conflictDetector';
import type { Worktree } from '../types';

vi.mock('./gitService', () => ({
  getChangedFiles: vi.fn(),
  getMergeBase: vi.fn(),
  resolveRef: vi.fn(),
  simulateMerge: vi.fn(),
  supportsWriteTree: vi.fn(),
}));

import { getChangedFiles, getMergeBase, resolveRef, simulateMerge, supportsWriteTree } from './gitService';

const getChangedFilesMock = getChangedFiles as unknown as ReturnType<typeof vi.fn>;
const getMergeBaseMock = getMergeBase as unknown as ReturnType<typeof vi.fn>;
const resolveRefMock = resolveRef as unknown as ReturnType<typeof vi.fn>;
const simulateMergeMock = simulateMerge as unknown as ReturnType<typeof vi.fn>;
const supportsWriteTreeMock = supportsWriteTree as unknown as ReturnType<typeof vi.fn>;

function wt(branch: string, head: string, path?: string): Worktree {
  return {
    path: path ?? `/worktrees/${branch}`,
    branch,
    isPrimary: false,
    head,
    untrackedCount: 0,
    modifiedCount: 0,
    stagedCount: 0,
    stashCount: 0,
    ahead: 0,
    behind: 0,
    aheadOfMain: 1,
    behindMain: 0,
    hasConflicts: false,
    lastCommit: { sha: head, message: '', date: '', author: '' },
    status: 'clean',
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  _clearConflictCacheForTests();
  resolveRefMock.mockResolvedValue('baseline-sha');
});

describe('detectCrossWorktreeConflicts — modern merge-tree path', () => {
  beforeEach(() => {
    supportsWriteTreeMock.mockReturnValue(true);
  });

  it('marks overlap files as conflict when simulateMerge reports conflicts', async () => {
    const worktrees = [wt('feat-a', 'sha-a'), wt('feat-b', 'sha-b')];

    // Both branches touch shared.ts and utils.ts
    getChangedFilesMock.mockImplementation(async (_repo: string, _def: string, branch: string) => {
      if (branch === 'feat-a') return ['shared.ts', 'utils.ts', 'a-only.ts'];
      return ['shared.ts', 'utils.ts', 'b-only.ts'];
    });

    // Modern path: --write-tree reports shared.ts as conflicted
    const infoByFile = new Map([['shared.ts', 'CONFLICT (content): Merge conflict in shared.ts']]);
    simulateMergeMock.mockResolvedValue({
      hasConflicts: true,
      output: '',
      conflictedFiles: ['shared.ts'],
      infoByFile,
    });

    const result = await detectCrossWorktreeConflicts({
      repoPath: '/repo',
      defaultBranch: 'main',
      worktrees,
    });

    expect(result.pairs).toHaveLength(1);
    const pair = result.pairs[0];
    expect(pair.severity).toBe('conflict');

    // shared.ts is in conflictedFiles → conflict; utils.ts is not → clean
    const sharedFile = pair.files.find((f) => f.path === 'shared.ts');
    const utilsFile = pair.files.find((f) => f.path === 'utils.ts');
    expect(sharedFile?.severity).toBe('conflict');
    expect(utilsFile?.severity).toBe('clean');

    // Modern path populates conflictMarkers from infoByFile
    expect(sharedFile?.conflictMarkers).toBe('CONFLICT (content): Merge conflict in shared.ts');
    expect(utilsFile?.conflictMarkers).toBeUndefined();
  });

  it('marks pair as conflict even when conflicted files are outside the overlap set', async () => {
    const worktrees = [wt('feat-a', 'sha-a'), wt('feat-b', 'sha-b')];

    // Overlap is only shared.ts
    getChangedFilesMock.mockImplementation(async (_repo: string, _def: string, branch: string) => {
      if (branch === 'feat-a') return ['shared.ts', 'a-only.ts'];
      return ['shared.ts', 'b-only.ts'];
    });

    // The conflict is in a-only.ts (a rename/delete conflict outside the overlap)
    // but hasConflicts is true because git detected it
    simulateMergeMock.mockResolvedValue({
      hasConflicts: true,
      output: '',
      conflictedFiles: ['a-only.ts'],
      infoByFile: new Map([['a-only.ts', 'CONFLICT (modify/delete): a-only.ts deleted in feat-b and modified in feat-a.']]),
    });

    const result = await detectCrossWorktreeConflicts({
      repoPath: '/repo',
      defaultBranch: 'main',
      worktrees,
    });

    const pair = result.pairs[0];
    // Pair-level severity should be conflict (git said so)
    expect(pair.severity).toBe('conflict');
    // shared.ts isn't in conflictedFiles → clean at the file level
    expect(pair.files.find((f) => f.path === 'shared.ts')?.severity).toBe('clean');
  });

  it('falls back to generic conflictMarkers when infoByFile has no entry for the file', async () => {
    const worktrees = [wt('feat-a', 'sha-a'), wt('feat-b', 'sha-b')];

    getChangedFilesMock.mockImplementation(async () => ['shared.ts']);

    // infoByFile is empty — no message parsed for shared.ts
    simulateMergeMock.mockResolvedValue({
      hasConflicts: true,
      output: '',
      conflictedFiles: ['shared.ts'],
      infoByFile: new Map(),
    });

    const result = await detectCrossWorktreeConflicts({
      repoPath: '/repo',
      defaultBranch: 'main',
      worktrees,
    });

    const sharedFile = result.pairs[0].files.find((f) => f.path === 'shared.ts');
    expect(sharedFile?.severity).toBe('conflict');
    // Should get the generic fallback message
    expect(sharedFile?.conflictMarkers).toBe('Merge conflict in shared.ts');
  });

  it('marks all overlap files as clean when simulateMerge reports no conflicts', async () => {
    const worktrees = [wt('feat-a', 'sha-a'), wt('feat-b', 'sha-b')];

    getChangedFilesMock.mockImplementation(async () => ['shared.ts']);

    simulateMergeMock.mockResolvedValue({
      hasConflicts: false,
      output: '',
      conflictedFiles: [],
      infoByFile: new Map(),
    });

    const result = await detectCrossWorktreeConflicts({
      repoPath: '/repo',
      defaultBranch: 'main',
      worktrees,
    });

    const pair = result.pairs[0];
    expect(pair.severity).toBe('clean');
    expect(pair.files[0].severity).toBe('clean');
  });

  it('does not call getMergeBase on the modern path', async () => {
    const worktrees = [wt('feat-a', 'sha-a'), wt('feat-b', 'sha-b')];

    getChangedFilesMock.mockResolvedValue(['shared.ts']);
    simulateMergeMock.mockResolvedValue({
      hasConflicts: false,
      output: '',
      conflictedFiles: [],
      infoByFile: new Map(),
    });

    await detectCrossWorktreeConflicts({
      repoPath: '/repo',
      defaultBranch: 'main',
      worktrees,
    });

    expect(getMergeBaseMock).not.toHaveBeenCalled();
  });
});

describe('detectCrossWorktreeConflicts — legacy merge-tree path', () => {
  beforeEach(() => {
    supportsWriteTreeMock.mockReturnValue(false);
  });

  it('calls getMergeBase and uses parseMergeTreeOutput for legacy detection', async () => {
    const worktrees = [wt('feat-a', 'sha-a'), wt('feat-b', 'sha-b')];

    getChangedFilesMock.mockResolvedValue(['shared.ts']);
    getMergeBaseMock.mockResolvedValue('base-sha');

    // Legacy simulateMerge returns raw merge-tree output with markers
    simulateMergeMock.mockResolvedValue({
      hasConflicts: false,
      output: [
        'changed in both',
        '  base   100644 aaa shared.ts',
        '  our    100644 bbb shared.ts',
        '  their  100644 ccc shared.ts',
        '<<<<<<< .our',
        'line from A',
        '=======',
        'line from B',
        '>>>>>>> .their',
      ].join('\n'),
      conflictedFiles: [],
      infoByFile: new Map(),
    });

    const result = await detectCrossWorktreeConflicts({
      repoPath: '/repo',
      defaultBranch: 'main',
      worktrees,
    });

    expect(getMergeBaseMock).toHaveBeenCalled();
    const pair = result.pairs[0];
    expect(pair.severity).toBe('conflict');
    expect(pair.files.find((f) => f.path === 'shared.ts')?.severity).toBe('conflict');
    // Legacy path populates conflictMarkers
    expect(pair.files.find((f) => f.path === 'shared.ts')?.conflictMarkers).toContain('<<<<<<<');
  });
});

describe('detectCrossWorktreeConflicts — skips non-candidates', () => {
  beforeEach(() => {
    supportsWriteTreeMock.mockReturnValue(true);
  });

  it('returns empty result for fewer than 2 candidates', async () => {
    const worktrees = [wt('feat-a', 'sha-a')];

    const result = await detectCrossWorktreeConflicts({
      repoPath: '/repo',
      defaultBranch: 'main',
      worktrees,
    });

    expect(result.pairs).toHaveLength(0);
    expect(result.summaryByPath.size).toBe(0);
  });

  it('skips primary worktree', async () => {
    const primary: Worktree = { ...wt('main', 'sha-main'), isPrimary: true };
    const worktrees = [primary, wt('feat-a', 'sha-a')];

    const result = await detectCrossWorktreeConflicts({
      repoPath: '/repo',
      defaultBranch: 'main',
      worktrees,
    });

    expect(result.pairs).toHaveLength(0);
  });
});
