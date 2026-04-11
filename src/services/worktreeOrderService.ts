import { invoke } from './tauriBridge';
import type { WorktreeSortMode } from '../types';

export async function readWorktreeOrder(repoPath: string): Promise<string[]> {
  return invoke<string[]>('read_worktree_order', { repoPath });
}

export async function writeWorktreeOrder(
  repoPath: string,
  order: string[],
): Promise<void> {
  await invoke('write_worktree_order', { repoPath, order });
}

// Returns null when no mode has ever been persisted for this repo, so the
// caller can apply a first-run default (including the "legacy manual order"
// migration rule — see useRepoBootstrap).
export async function readWorktreeSortMode(
  repoPath: string,
): Promise<WorktreeSortMode | null> {
  const raw = await invoke<string | null>('read_worktree_sort_mode', {
    repoPath,
  });
  if (raw === null) return null;
  if (raw === 'recent' || raw === 'name' || raw === 'status' || raw === 'manual') {
    return raw;
  }
  // Unknown mode in the persisted file — treat as unset so the caller falls
  // back to the default. Safer than crashing on a future/older schema.
  return null;
}

export async function writeWorktreeSortMode(
  repoPath: string,
  mode: WorktreeSortMode,
): Promise<void> {
  await invoke('write_worktree_sort_mode', { repoPath, mode });
}
