import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock tauriBridge before importing the service so the module closes over the
// mocked `invoke`/`isTauri`/`readClaudeFirstPrompt`. Each test re-configures
// the mocks as needed.
vi.mock('./tauriBridge', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
  readClaudeFirstPrompt: vi.fn(),
}));

import {
  computeNotepadAutofill,
  isNotepadTouched,
  readNotepad,
  writeNotepad,
  _resetNotepadMemoryStoreForTests,
} from './notepadService';
import { invoke, isTauri, readClaudeFirstPrompt } from './tauriBridge';

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
const isTauriMock = isTauri as unknown as ReturnType<typeof vi.fn>;
const readClaudeFirstPromptMock = readClaudeFirstPrompt as unknown as ReturnType<typeof vi.fn>;

// The service's memoryStore is module-level. Reset it between tests so the
// touched-flag state from one case doesn't bleed into another. We still use
// unique paths per test as belt-and-suspenders against ordering surprises.
let pathCounter = 0;
const uniquePath = () => `/test/wt-${++pathCounter}`;

beforeEach(() => {
  invokeMock.mockReset();
  isTauriMock.mockReset();
  readClaudeFirstPromptMock.mockReset();
  isTauriMock.mockReturnValue(false);
  _resetNotepadMemoryStoreForTests();
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
  it('writing empty string still reads back as empty', async () => {
    // Behavior changed in the autofill release: writing "" no longer
    // removes the entry — it sets content="" with touched=true. The
    // user-visible read result is still empty, so this is a contract-
    // preserving change. The visible difference is in isNotepadTouched
    // (covered by its own test below).
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

describe('isNotepadTouched: in-memory fallback', () => {
  it('returns false for a path that has never been written', async () => {
    expect(await isNotepadTouched(uniquePath())).toBe(false);
  });

  it('returns true after any write — including empty content', async () => {
    // The whole point of the touched flag: clearing the notepad to empty
    // still counts as user interaction and should lock out autofill.
    const p = uniquePath();
    await writeNotepad(p, 'something');
    expect(await isNotepadTouched(p)).toBe(true);
    await writeNotepad(p, '');
    expect(await isNotepadTouched(p)).toBe(true);
  });
});

describe('isNotepadTouched: Tauri invoke routing', () => {
  it('routes to the is_notepad_touched invoke', async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValueOnce(true);
    const p = uniquePath();
    expect(await isNotepadTouched(p)).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('is_notepad_touched', { worktreePath: p });
  });

  it('returns true (conservative) on backend error so autofill is suppressed', async () => {
    // If the backend is in a weird state we don't want to risk overwriting
    // user notes via autofill. Treat-as-touched on error errs on the side
    // of "do nothing" rather than "maybe clobber".
    isTauriMock.mockReturnValue(true);
    invokeMock.mockRejectedValueOnce(new Error('backend down'));
    expect(await isNotepadTouched(uniquePath())).toBe(true);
  });
});

describe('computeNotepadAutofill', () => {
  it('returns null when the notepad has been touched', async () => {
    // Touched-but-empty is the case this whole feature was designed to
    // handle correctly: a user who cleared their note must not get it
    // re-autofilled. Verifies the touched check fires before the (more
    // expensive) Claude prompt fetch.
    const p = uniquePath();
    await writeNotepad(p, '');
    readClaudeFirstPromptMock.mockResolvedValueOnce('this should never be returned');
    expect(await computeNotepadAutofill(p)).toBeNull();
    expect(readClaudeFirstPromptMock).not.toHaveBeenCalled();
  });

  it('returns the Claude first prompt when untouched and a prompt exists', async () => {
    const p = uniquePath();
    readClaudeFirstPromptMock.mockResolvedValueOnce('what would it take to autofill');
    expect(await computeNotepadAutofill(p)).toBe('what would it take to autofill');
    expect(readClaudeFirstPromptMock).toHaveBeenCalledWith(p, 200);
  });

  it('returns null when untouched but Claude has no prompt for this worktree', async () => {
    // The touched flag is NOT set in this case — we want to retry on the
    // next mount in case the user has since started a Claude session here.
    const p = uniquePath();
    readClaudeFirstPromptMock.mockResolvedValueOnce(null);
    expect(await computeNotepadAutofill(p)).toBeNull();
    expect(await isNotepadTouched(p)).toBe(false);
  });
});
