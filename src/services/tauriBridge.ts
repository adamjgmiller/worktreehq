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

/**
 * Read-modify-write the app config with a partial update.
 *
 * This centralizes the pattern that was duplicated across 6+ files:
 * read the full config, spread the update fields, write back. The spread
 * preserves fields this caller doesn't own (github_token, auth_method,
 * zoom_level, etc.) so concurrent writers don't clobber each other's data.
 */
export async function updateConfig(fields: Record<string, unknown>): Promise<void> {
  const cfg = await invoke<Record<string, unknown>>('read_config');
  await invoke('write_config', { cfg: { ...cfg, ...fields } });
}

// ── gh CLI bridge ──────────────────────────────────────────────────────

export interface GhExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function ghExec(args: string[]): Promise<GhExecResult> {
  return invoke<GhExecResult>('gh_exec', { args });
}

// ── git auth method bridge ─────────────────────────────────────────────
// Tells the Rust git_exec command which auth method is active so it can
// inject the right credential.helper for git fetch/push. Must be called
// whenever the auth method changes (bootstrap + Settings save).

export async function setGitAuthMethod(method: string, token?: string): Promise<void> {
  try {
    await invoke<void>('set_git_auth_method', { method, token: token ?? null });
  } catch {
    /* best-effort: non-Tauri env or bridge unavailable */
  }
}

// ── OS keychain bridge ─────────────────────────────────────────────────

export async function keychainStore(key: string, value: string): Promise<void> {
  await invoke<void>('keychain_store', { key, value });
}

export async function keychainRead(key: string): Promise<string | null> {
  return invoke<string | null>('keychain_read', { key });
}

export async function keychainDelete(key: string): Promise<void> {
  await invoke<void>('keychain_delete', { key });
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

// Reads the first human-typed prompt from one specific session JSONL,
// identified by worktree path + session id. Used by the past-sessions list
// in the worktree card to label each row with what the user originally
// asked Claude. Same null-on-error contract as readClaudeFirstPrompt — a
// failure here just means the row falls back to the relative time and the
// short session id, never an error toast.
export async function readClaudeSessionFirstPrompt(
  worktreePath: string,
  sessionId: string,
  maxChars: number,
): Promise<string | null> {
  try {
    const result = await invoke<string | null>('read_claude_session_first_prompt', {
      worktreePath,
      sessionId,
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

// `mkdir -p` for the frontend. Used by createWorktree to make the parent
// directory (e.g. `<repo>/.claude/worktrees/`) exist before `git worktree
// add`, since git only creates the leaf. Throws on failure — the caller
// needs to know so the subsequent git command doesn't fail with a cryptic
// "No such file or directory" stderr.
export async function ensureDir(path: string): Promise<void> {
  await invoke<void>('ensure_dir', { path });
}

export type ShellOpenAction = 'file_manager' | 'terminal';

// Launch an OS-native app to open the given directory. Fire-and-forget:
// resolves as soon as the subprocess is spawned, not when the target app
// finishes loading. Errors surface only for useful failure modes (path
// gone, no terminal emulator found on Linux) — not for post-launch events.
export async function shellOpen(path: string, action: ShellOpenAction): Promise<void> {
  await invoke<void>('shell_open', { path, action });
}

// Open a URL in the user's default browser via the OS launcher.
// Falls back to window.open() outside Tauri (dev server, tests).
export async function openUrl(url: string): Promise<void> {
  try {
    await invoke<void>('shell_open', { path: url, action: 'url' });
  } catch {
    window.open(url, '_blank', 'noopener');
  }
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
