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

// ─── Claude Code awareness ──────────────────────────────────────────────────
// Raw shape returned by the `read_claude_state` Tauri command. Mirror of the
// Rust ClaudeState struct. Fields are snake_case to match Rust serde defaults
// (same convention as AppConfig in useRepoBootstrap). Timestamps are
// unix-epoch milliseconds.
export interface ClaudeIdeLockRaw {
  pid: number;
  ide_name?: string;
  workspace_folders: string[];
}

export interface ClaudeProjectSessionRaw {
  session_id: string;
  mtime_ms: number;
}

export interface ClaudeProjectDirRaw {
  dir_name: string;
  worktree_path?: string;
  sessions: ClaudeProjectSessionRaw[];
}

export interface ClaudeStateRaw {
  ide_locks: ClaudeIdeLockRaw[];
  projects: ClaudeProjectDirRaw[];
}

// Joined per-worktree view used by the UI.
export type ClaudePresenceStatus =
  | 'live-ide' // IDE lockfile currently references this worktree
  | 'live' // newest JSONL mtime within LIVE_WINDOW_MS
  | 'recent' // newest JSONL mtime within RECENT_WINDOW_MS
  | 'dormant' // has sessions but none are recent
  | 'none'; // no project dir at all

export interface ClaudeSession {
  sessionId: string;
  lastActivity: string; // ISO
}

export interface ClaudePresence {
  status: ClaudePresenceStatus;
  ideName?: string;
  pid?: number;
  lastActivity?: string; // ISO of newest session, if any
  activeSessionId?: string; // sessionId of the currently-live session, if any
  inactiveSessions: ClaudeSession[]; // closed sessions, newest-first
}
