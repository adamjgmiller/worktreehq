import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./tauriBridge', () => ({
  invoke: vi.fn(),
}));

import { runShellCommands } from './shellService';
import { invoke } from './tauriBridge';

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeMock.mockReset();
});

describe('runShellCommands', () => {
  it('forwards cwd, script, and a null timeout by default', async () => {
    invokeMock.mockResolvedValueOnce({ stdout: 'ok', stderr: '', code: 0 });
    const result = await runShellCommands('/tmp/wt', 'echo hi');
    expect(result).toEqual({ stdout: 'ok', stderr: '', code: 0 });
    expect(invokeMock).toHaveBeenCalledWith('run_shell_commands', {
      cwd: '/tmp/wt',
      script: 'echo hi',
      timeoutSecs: null,
    });
  });

  it('passes an explicit timeout when provided', async () => {
    invokeMock.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });
    await runShellCommands('/tmp/wt', 'sleep 1', 30);
    expect(invokeMock).toHaveBeenCalledWith('run_shell_commands', {
      cwd: '/tmp/wt',
      script: 'sleep 1',
      timeoutSecs: 30,
    });
  });

  it('propagates non-zero exit codes as a normal result (no throw)', async () => {
    invokeMock.mockResolvedValueOnce({ stdout: '', stderr: 'boom', code: 1 });
    const result = await runShellCommands('/tmp/wt', 'false');
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('boom');
  });

  it('propagates invoke errors (e.g. timeout) as thrown', async () => {
    invokeMock.mockRejectedValueOnce(new Error('timed out after 600s'));
    await expect(runShellCommands('/tmp/wt', 'sleep 999')).rejects.toThrow(
      /timed out/,
    );
  });
});
