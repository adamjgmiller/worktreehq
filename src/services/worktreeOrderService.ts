import { invoke } from './tauriBridge';

export async function readWorktreeOrder(repoPath: string): Promise<string[]> {
  return invoke<string[]>('read_worktree_order', { repoPath });
}

export async function writeWorktreeOrder(
  repoPath: string,
  order: string[],
): Promise<void> {
  await invoke('write_worktree_order', { repoPath, order });
}
