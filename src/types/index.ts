export type MergeStatus =
  | 'merged-normally'
  | 'squash-merged'
  | 'direct-merged'
  | 'unmerged'
  | 'empty'
  | 'stale';
export type WorktreeStatus = 'clean' | 'dirty' | 'conflict' | 'diverged';
// How the Worktrees tab orders cards. 'manual' means honor the user's saved
// drag arrangement; every other mode is a recomputed sort.
export type WorktreeSortMode = 'recent' | 'name' | 'status' | 'manual';
export type InProgressOp = 'rebase' | 'merge' | 'cherry-pick' | 'revert' | 'bisect';
export type ChecksStatus = 'success' | 'failure' | 'pending' | 'none';
export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required' | null;

export interface LastCommit {
  sha: string;
  message: string;
  date: string;
  author: string;
}

export interface Worktree {
  path: string;
  branch: string;
  upstream?: string;
  isPrimary: boolean;
  head: string;
  // Split counts: untracked ('?') and modified (tree-vs-index) are tracked separately.
  untrackedCount: number;
  modifiedCount: number;
  stagedCount: number;
  stashCount: number;
  ahead: number;
  behind: number;
  aheadOfMain: number;
  behindMain: number;
  hasConflicts: boolean;
  inProgress?: InProgressOp;
  lastCommit: LastCommit;
  status: WorktreeStatus;
  // Set when `git worktree list --porcelain` reported a `prunable` line for
  // this entry — git's bookkeeping under .git/worktrees/<name>/ still exists
  // but the worktree directory no longer does. The string is git's reason
  // text. UI branches on this to render an orphaned-card variant; all the
  // numeric fields above are forced to 0 because they're meaningless for a
  // ghost.
  prunable?: string;
}

export interface PRInfo {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  mergedAt?: string;
  mergeCommitSha?: string;
  headRef: string;
  headSha?: string | null;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
  url: string;
  isDraft?: boolean;
  mergeable?: boolean | null;
  checksStatus?: ChecksStatus;
  reviewDecision?: ReviewDecision;
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
  authorEmail?: string;
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
  // Absolute cwd paths of every running `claude` process. Lets joinClaudeState
  // distinguish "session is closed" from "session is alive but idle waiting
  // for input". The Rust side always re-reads this regardless of fingerprint
  // match (same as ide_locks). Optional in the type so pure-join tests can
  // construct raw state literals without the field; the Rust command always
  // populates it.
  live_worktree_cwds?: string[];
  // Cheap mtime fingerprint of the dirs we walked. The TS side passes this
  // back on the next call so the Rust side can short-circuit JSONL header
  // reads + lockfile parses when nothing has moved. Optional in the type so
  // pure-join tests can construct raw state literals without the field, but
  // the Rust command always populates it.
  fingerprint?: string;
  // True when `expected_fingerprint` matched the current state. In that case
  // ide_locks/projects are empty and the caller should reuse its cached
  // joined-presence map.
  unchanged?: boolean;
}

// ─── Cross-worktree conflict detection ─────────────────────────────────

export type OverlapSeverity = 'none' | 'clean' | 'conflict';
export type FileSeverity = 'clean' | 'conflict';

export interface ConflictFile {
  path: string;
  severity: FileSeverity;
  conflictMarkers?: string; // raw merge-tree output, only when severity === 'conflict'
}

export interface WorktreePairOverlap {
  branchA: string;
  branchB: string;
  severity: OverlapSeverity; // worst-case across all files
  files: ConflictFile[]; // only populated when severity !== 'none'
}

export interface WorktreeConflictSummary {
  conflictCount: number; // other worktrees with severity === 'conflict'
  cleanOverlapCount: number; // other worktrees with severity === 'clean' only
}

// Joined per-worktree view used by the UI.
export type ClaudePresenceStatus =
  | 'live-ide' // IDE lockfile currently references this worktree
  | 'live' // newest JSONL mtime within LIVE_WINDOW_MS
  | 'idle' // process running in this worktree but JSONL hasn't been touched recently
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
  // Number of distinct Claude agents currently considered live in this
  // worktree. ≥2 means the user has multiple Claude sessions writing to the
  // same worktree at once — they can clobber each other's edits silently and
  // the UI surfaces this as a warning. Counts JSONL sessions within
  // LIVE_WINDOW_MS plus the IDE lock when present (and not already covered
  // by the newest JSONL session).
  liveSessionCount: number;
}
