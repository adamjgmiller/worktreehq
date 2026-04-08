import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock tauriBridge before importing the service so the module closes over the
// mocked `invoke`/`isTauri`. Each test re-configures the mocks as needed.
vi.mock('./tauriBridge', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

import { readNotepad, writeNotepad } from './notepadService';
import { invoke, isTauri } from './tauriBridge';

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
const isTauriMock = isTauri as unknown as ReturnType<typeof vi.fn>;

// The service's memoryStore is module-level and persists across tests. Use a
// unique worktree path per test to avoid contamination rather than trying to
// reset the module.
let pathCounter = 0;
const uniquePath = () => `/test/wt-${++pathCounter}`;

beforeEach(() => {
  invokeMock.mockReset();
  isTauriMock.mockReset();
  isTauriMock.mockReturnValue(false);
});

describe('readNotepad: in-memory fallback (non-Tauri)', () => {
  it('returns empty string when no prior write exists', async () => {
    const p = uniquePath();
    expect(await readNotepad(p)).toBe('');
  });

  it('returns the value most recently written via writeNotepad', async () => {
    const p = uniquePath();
    await writeNotepad(p, 'hello');
    expect(await readNotepad(p)).toBe('hello');
  });
});

describe('writeNotepad: in-memory fallback (non-Tauri)', () => {
  it('writing empty string deletes the entry from memory store', async () => {
    const p = uniquePath();
    await writeNotepad(p, 'hello');
    expect(await readNotepad(p)).toBe('hello');
    await writeNotepad(p, '');
    expect(await readNotepad(p)).toBe('');
  });
});

describe('readNotepad: Tauri invoke routing', () => {
  it('routes to the read_notepad invoke when running under Tauri', async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValueOnce('contents from disk');
    const p = uniquePath();
    const result = await readNotepad(p);
    expect(result).toBe('contents from disk');
    expect(invokeMock).toHaveBeenCalledWith('read_notepad', { worktreePath: p });
  });

  it('swallows invoke failures and returns empty string', async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockRejectedValueOnce(new Error('backend busy'));
    const result = await readNotepad(uniquePath());
    expect(result).toBe('');
  });
});

describe('writeNotepad: Tauri invoke routing', () => {
  it('routes to the write_notepad invoke and propagates errors', async () => {
    isTauriMock.mockReturnValue(true);
    const boom = new Error('disk full');
    invokeMock.mockRejectedValueOnce(boom);
    await expect(writeNotepad(uniquePath(), 'doomed')).rejects.toThrow('disk full');
    expect(invokeMock).toHaveBeenCalledWith(
      'write_notepad',
      expect.objectContaining({ content: 'doomed' }),
    );
  });
});
