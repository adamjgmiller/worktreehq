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

// Flat shape returned by `list_notepads`. Mirrors the Rust NotepadListEntry.
export type NotepadListEntry = {
  path: string;
  content: string;
  touched: boolean;
};

/**
 * Returns every notepad entry on disk, sorted by path. The Worktree Archive
 * view filters this client-side against the live worktree list and the
 * current repo's path prefix to surface notes whose worktrees no longer
 * exist.
 *
 * Falls back to the in-memory store when running outside Tauri so the unit
 * tests and dev preview don't have to mock the IPC layer.
 */
export async function listNotepads(): Promise<NotepadListEntry[]> {
  if (!isTauri()) {
    return Array.from(memoryStore.entries())
      .map(([path, e]) => ({ path, content: e.content, touched: e.touched }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  try {
    return await invoke<NotepadListEntry[]>('list_notepads');
  } catch {
    // Empty list is the safe fallback: an archive view that can't reach the
    // backend just shows "nothing archived" rather than an error toast.
    return [];
  }
}

/**
 * Permanently removes a notepad entry from the on-disk store. Used by the
 * Worktree Archive's "delete" action when the user wants to clear out an
 * orphaned note. Throws on failure so the caller can surface the error in
 * the UI — unlike the read paths, this is destructive and silent failure
 * would be a footgun.
 */
export async function deleteNotepad(worktreePath: string): Promise<void> {
  if (!isTauri()) {
    memoryStore.delete(worktreePath);
    return;
  }
  await invoke<void>('delete_notepad', { worktreePath });
}

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
