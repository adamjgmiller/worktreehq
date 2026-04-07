export type MergeStatus = 'merged-normally' | 'squash-merged' | 'unmerged' | 'stale';
export type WorktreeStatus = 'clean' | 'dirty' | 'conflict' | 'diverged';

export interface LastCommit {
  sha: string;
  message: string;
  date: string;
  author: string;
}

export interface Worktree {
  path: string;
  branch: string;
  isPrimary: boolean;
  head: string;
  uncommittedCount: number;
  stagedCount: number;
  ahead: number;
  behind: number;
  hasConflicts: boolean;
  lastCommit: LastCommit;
  status: WorktreeStatus;
}

export interface PRInfo {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  mergedAt?: string;
  mergeCommitSha?: string;
  headRef: string;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
  url: string;
}

export interface Branch {
  name: string;
  hasLocal: boolean;
  hasRemote: boolean;
  lastCommitDate: string;
  lastCommitSha: string;
  aheadOfMain: number;
  behindMain: number;
  mergeStatus: MergeStatus;
  pr?: PRInfo;
  worktreePath?: string;
  upstreamGone?: boolean;
}

export interface SquashMapping {
  squashCommitSha: string;
  squashSubject: string;
  squashDate: string;
  prNumber: number;
  sourceBranch: string;
  archiveTag?: string;
  originalCommits?: Array<{ sha: string; message: string; date: string }>;
}

export interface MainCommit {
  sha: string;
  subject: string;
  date: string;
  prNumber?: number;
}

export interface RepoState {
  path: string;
  owner?: string;
  name?: string;
  defaultBranch: string;
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
  code: number;
}
