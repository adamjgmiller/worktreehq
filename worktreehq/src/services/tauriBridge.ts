// Thin wrapper over Tauri invoke that falls back to a browser stub for dev/tests.
import type { GitExecResult } from '../types';

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

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as any);
}
