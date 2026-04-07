// Per-worktree notepad persistence. Backed by Tauri commands that read/write
// ~/.config/worktreehq/notepads.json. Falls back to an in-memory map when
// running in the browser stub or unit tests so callers don't have to branch.
import { invoke, isTauri } from './tauriBridge';

const memoryStore = new Map<string, string>();

export async function readNotepad(worktreePath: string): Promise<string> {
  if (!isTauri()) {
    return memoryStore.get(worktreePath) ?? '';
  }
  try {
    return await invoke<string>('read_notepad', { worktreePath });
  } catch {
    return '';
  }
}

export async function writeNotepad(worktreePath: string, content: string): Promise<void> {
  if (!isTauri()) {
    if (content) memoryStore.set(worktreePath, content);
    else memoryStore.delete(worktreePath);
    return;
  }
  await invoke<void>('write_notepad', { worktreePath, content });
}
