import { describe, it, expect } from 'vitest';
import { parsePrNumberFromSubject, isStale } from './squashDetector';
import type { Branch } from '../types';

describe('parsePrNumberFromSubject', () => {
  it('extracts PR number from trailing (#N)', () => {
    expect(parsePrNumberFromSubject('Fix foo (#149)')).toBe(149);
    expect(parsePrNumberFromSubject('chore: update deps (#2)  ')).toBe(2);
  });
  it('returns undefined for no match', () => {
    expect(parsePrNumberFromSubject('Fix foo')).toBeUndefined();
    expect(parsePrNumberFromSubject('(#12) mid')).toBeUndefined();
  });
});

describe('isStale', () => {
  const base: Branch = {
    name: 'x',
    hasLocal: true,
    hasRemote: false,
    lastCommitDate: '',
    lastCommitSha: 'abc',
    aheadOfMain: 1,
    behindMain: 0,
    mergeStatus: 'unmerged',
  };
  it('true for unmerged older than 30 days', () => {
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    expect(isStale({ ...base, lastCommitDate: old })).toBe(true);
  });
  it('false for recent', () => {
    const recent = new Date(Date.now() - 5 * 86400_000).toISOString();
    expect(isStale({ ...base, lastCommitDate: recent })).toBe(false);
  });
  it('false if already merged', () => {
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    expect(isStale({ ...base, lastCommitDate: old, mergeStatus: 'merged-normally' })).toBe(false);
  });
});
