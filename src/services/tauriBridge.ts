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

// Reads the first human-typed prompt from the worktree's oldest Claude
// session JSONL. Used by the notepad autofill on first mount of an empty,
// never-touched notepad. Returns null when there's no Claude session for the
// worktree, no qualifying user record in the first ~200 lines of any
// session, or the bridge isn't available — all benign cases that just leave
// the notepad empty.
export async function readClaudeFirstPrompt(
  worktreePath: string,
  maxChars: number,
): Promise<string | null> {
  try {
    const result = await invoke<string | null>('read_claude_first_prompt', {
      worktreePath,
      maxChars,
    });
    return result ?? null;
  } catch {
    return null;
  }
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

export type ShellOpenAction = 'file_manager' | 'terminal';

// Launch an OS-native app to open the given directory. Fire-and-forget:
// resolves as soon as the subprocess is spawned, not when the target app
// finishes loading. Errors surface only for useful failure modes (path
// gone, no terminal emulator found on Linux) — not for post-launch events.
export async function shellOpen(path: string, action: ShellOpenAction): Promise<void> {
  await invoke<void>('shell_open', { path, action });
}

export async function readPrCacheFile(): Promise<string> {
  try {
    return await invoke<string>('read_pr_cache');
  } catch {
    return '';
  }
}

// Tear down the Rust-side filesystem watcher. Used by the bootstrap effect's
// cleanup so a hot-reload / unmount doesn't leave a watcher firing against
// stale paths. Best-effort: a failed stop is harmless because the next
// `start_watching` call replaces the slot anyway.
export async function stopWatching(): Promise<void> {
  try {
    await invoke<void>('stop_watching');
  } catch {
    /* best-effort */
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
