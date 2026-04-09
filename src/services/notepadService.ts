// Per-worktree notepad persistence. Backed by Tauri commands that read/write
// ~/.config/worktreehq/notepads.json. Falls back to an in-memory map when
// running in the browser stub or unit tests so callers don't have to branch.
import { invoke, isTauri, readClaudeFirstPrompt } from './tauriBridge';

// In the non-Tauri fallback the memory store has to track BOTH content and
// the touched flag — otherwise the autofill path can't honor "never refill
// after manual clear" in dev/test runs. Same shape as the Rust struct.
type MemoryEntry = { content: string; touched: boolean };
const memoryStore = new Map<string, MemoryEntry>();

export async function readNotepad(worktreePath: string): Promise<string> {
  if (!isTauri()) {
    return memoryStore.get(worktreePath)?.content ?? '';
  }
  try {
    return await invoke<string>('read_notepad', { worktreePath });
  } catch {
    return '';
  }
}

export async function writeNotepad(worktreePath: string, content: string): Promise<void> {
  if (!isTauri()) {
    // Always mark touched on any write — including clearing to empty —
    // mirroring the Rust write_notepad behavior. This is what locks out
    // re-autofill after a user manually empties their notepad.
    memoryStore.set(worktreePath, { content, touched: true });
    return;
  }
  await invoke<void>('write_notepad', { worktreePath, content });
}

// Has this notepad ever been written to (autofill, manual edit, or manual
// clear)? The autofill path uses this to skip worktrees the user has already
// interacted with — even ones whose current content happens to be empty
// (e.g. the user typed something then deleted it).
export async function isNotepadTouched(worktreePath: string): Promise<boolean> {
  if (!isTauri()) {
    return memoryStore.get(worktreePath)?.touched ?? false;
  }
  try {
    return await invoke<boolean>('is_notepad_touched', { worktreePath });
  } catch {
    // Conservative on error: pretend it's touched so we don't accidentally
    // overwrite anything if the backend is in a weird state. The notepad
    // just stays empty in that case.
    return true;
  }
}

// Maximum length the notepad will ever be autofilled to. Tuned to fit a few
// lines in the existing 3-row textarea — long enough to be a useful hint of
// what the worktree was opened for, short enough not to wall-of-text the
// card.
export const AUTOFILL_MAX_CHARS = 200;

/**
 * Compute the autofill seed for an empty notepad, or null if it shouldn't
 * be autofilled. A seed is returned only when:
 *   - the notepad has never been touched (read or write), AND
 *   - the worktree has a Claude Code session with a qualifying first prompt.
 *
 * Pure-ish: only does reads, no writes. The caller is responsible for
 * persisting the seed via `writeNotepad` (which sets touched=true), and for
 * re-checking its own race guards before applying the value to the UI.
 */
export async function computeNotepadAutofill(
  worktreePath: string,
): Promise<string | null> {
  if (await isNotepadTouched(worktreePath)) {
    return null;
  }
  return await readClaudeFirstPrompt(worktreePath, AUTOFILL_MAX_CHARS);
}

// Test seam: clear the in-memory store between tests so the touched-flag
// state doesn't bleed across cases.
export function _resetNotepadMemoryStoreForTests(): void {
  memoryStore.clear();
}
