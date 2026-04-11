// Wrapper over the Rust `run_shell_commands` command. Runs a multi-line
// shell script via `/bin/sh -c` in a specified working directory and
// returns stdout/stderr/exit code. Used by the post-create commands hook
// in the Create Worktree flow — the script is whatever the user configured
// (or edited inline), and `cwd` is the newly-created worktree path.
//
// This is deliberately separate from `gitExec` in tauriBridge.ts because
// the two subprocess paths have different environment-scrub rules: git
// needs LC_ALL=C and GIT_TERMINAL_PROMPT=0 for deterministic parsing and
// no credential hangs, while user shell scripts need the user's full env
// (PATH, nvm/asdf shims, direnv vars) to do anything useful.
import { invoke } from './tauriBridge';

export interface ShellExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function runShellCommands(
  cwd: string,
  script: string,
  timeoutSecs?: number,
): Promise<ShellExecResult> {
  return invoke<ShellExecResult>('run_shell_commands', {
    cwd,
    script,
    timeoutSecs: timeoutSecs ?? null,
  });
}
