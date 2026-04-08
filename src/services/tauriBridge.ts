// Thin wrapper over Tauri invoke that falls back to a browser stub for dev/tests.
import type { ClaudeStateRaw, GitExecResult } from '../types';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let invokeImpl: InvokeFn | null = null;

async function getInvoke(): Promise<InvokeFn> {
  if (invokeImpl) return invokeImpl;
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - optional at runtime
    const mod = await import('@tauri-apps/api/core');
    invokeImpl = mod.invoke as InvokeFn;
  } catch {
    invokeImpl = async () => {
      throw new Error('Tauri runtime unavailable');
    };
  }
  return invokeImpl;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const fn = await getInvoke();
  return fn<T>(cmd, args);
}

export async function gitExec(repoPath: string, args: string[]): Promise<GitExecResult> {
  return invoke<GitExecResult>('git_exec', { repoPath, args });
}

export async function readClaudeState(
  expectedFingerprint?: string,
): Promise<ClaudeStateRaw> {
  return invoke<ClaudeStateRaw>('read_claude_state', {
    expectedFingerprint: expectedFingerprint ?? null,
  });
}

// Plain filesystem existence check. Used to probe in-progress-operation marker files
// (MERGE_HEAD, rebase-merge/, …) and the on-disk PR cache file.
export async function pathExists(path: string): Promise<boolean> {
  try {
    return await invoke<boolean>('path_exists', { path });
  } catch {
    return false;
  }
}

export async function readPrCacheFile(): Promise<string> {
  try {
    return await invoke<string>('read_pr_cache');
  } catch {
    return '';
  }
}

export async function writePrCacheFile(content: string): Promise<void> {
  try {
    await invoke<void>('write_pr_cache', { content });
  } catch {
    /* best-effort: a failed persist shouldn't break the app */
  }
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as any);
}
