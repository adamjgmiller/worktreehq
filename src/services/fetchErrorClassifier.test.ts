import { describe, it, expect } from 'vitest';
import { classifyFetchError, formatClassifiedError } from './fetchErrorClassifier';

describe('classifyFetchError', () => {
  it('classifies SSH publickey denials', () => {
    const stderr =
      'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.';
    const result = classifyFetchError(stderr);
    expect(result.category).toBe('ssh-auth-failed');
    expect(result.hint).toMatch(/SSH key/i);
    expect(result.raw).toBe(stderr);
  });

  it('classifies host-key verification failures as ssh-auth-failed', () => {
    const stderr = 'Host key verification failed.\nfatal: Could not read from remote repository.';
    expect(classifyFetchError(stderr).category).toBe('ssh-auth-failed');
  });

  it('classifies HTTPS authentication failures', () => {
    const stderr = "fatal: Authentication failed for 'https://github.com/foo/bar.git/'";
    const result = classifyFetchError(stderr);
    expect(result.category).toBe('https-auth-failed');
    expect(result.hint).toMatch(/HTTPS credentials/i);
  });

  it('classifies the password-auth-removed notice as https-auth-failed', () => {
    const stderr =
      'remote: Support for password authentication was removed on August 13, 2021.\nremote: Please see https://docs.github.com/...';
    expect(classifyFetchError(stderr).category).toBe('https-auth-failed');
  });

  it('classifies DNS resolution failures as network-unreachable', () => {
    const stderr = "fatal: unable to access 'https://github.com/': Could not resolve host: github.com";
    expect(classifyFetchError(stderr).category).toBe('network-unreachable');
  });

  it('classifies SSH connection timeouts as network-unreachable', () => {
    const stderr = 'ssh: connect to host github.com port 22: Connection timed out';
    expect(classifyFetchError(stderr).category).toBe('network-unreachable');
  });

  it('classifies clean repo-not-found errors', () => {
    // Isolated — when a repo-not-found response doesn't also include the
    // generic "Could not read from remote repository" string.
    const stderr = 'ERROR: Repository not found.';
    expect(classifyFetchError(stderr).category).toBe('repo-not-found');
  });

  it('prefers auth over repo-not-found when both strings appear', () => {
    // A private-repo 404 through SSH typically shows both. The user's real
    // fix is auth (their key isn't authorized for the repo), so we prefer
    // the auth category. Regression guard: if patterns are reordered, this
    // test will fail.
    const stderr =
      'ERROR: Repository not found.\nfatal: Could not read from remote repository.';
    expect(classifyFetchError(stderr).category).toBe('ssh-auth-failed');
  });

  it('returns unknown for unmatched stderr', () => {
    const stderr = 'fatal: index file corrupted';
    const result = classifyFetchError(stderr);
    expect(result.category).toBe('unknown');
    expect(result.hint).toBe('');
    expect(result.raw).toBe(stderr);
  });

  it('is case-insensitive on pattern matching', () => {
    const stderr = 'permission DENIED (publickey)';
    expect(classifyFetchError(stderr).category).toBe('ssh-auth-failed');
  });
});

describe('formatClassifiedError', () => {
  it('prefixes the hint before the raw message for classified errors', () => {
    const result = formatClassifiedError({
      category: 'ssh-auth-failed',
      hint: 'SSH key hint.',
      raw: 'git stderr text',
    });
    expect(result).toBe('SSH key hint.\n\ngit stderr text');
  });

  it('returns the raw message alone for unclassified errors', () => {
    const result = formatClassifiedError({
      category: 'unknown',
      hint: '',
      raw: 'git stderr text',
    });
    expect(result).toBe('git stderr text');
  });
});
