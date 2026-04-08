import { gitExec, pathExists } from './tauriBridge';
import type { Worktree, Branch, MainCommit, WorktreeStatus, InProgressOp } from '../types';

async function run(repo: string, args: string[]): Promise<string> {
  const r = await gitExec(repo, args);
  if (r.code !== 0 && r.stderr) {
    throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  }
  return r.stdout;
}

async function tryRun(repo: string, args: string[]): Promise<string> {
  try {
    const r = await gitExec(repo, args);
    return r.code === 0 ? r.stdout : '';
  } catch {
    return '';
  }
}

export async function getDefaultBranch(repo: string): Promise<string> {
  const head = await tryRun(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const m = head.trim().match(/^origin\/(.+)$/);
  if (m) return m[1];
  for (const b of ['main', 'master']) {
    const exists = await tryRun(repo, ['rev-parse', '--verify', b]);
    if (exists.trim()) return b;
  }
  return 'main';
}

export async function getRemoteUrl(repo: string): Promise<{ owner?: string; name?: string }> {
  const url = (await tryRun(repo, ['remote', 'get-url', 'origin'])).trim();
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!m) return {};
  return { owner: m[1], name: m[2] };
}

let cachedUserEmail: { repo: string; email: string } | null = null;
export async function getUserEmail(repo: string): Promise<string> {
  if (cachedUserEmail && cachedUserEmail.repo === repo) return cachedUserEmail.email;
  const out = (await tryRun(repo, ['config', '--get', 'user.email'])).trim();
  cachedUserEmail = { repo, email: out };
  return out;
}

// Parse `git worktree list --porcelain` output
export function parseWorktreeList(text: string): Array<{ path: string; head: string; branch: string }> {
  const blocks = text.split(/\n\n+/).filter(Boolean);
  return blocks.map((b) => {
    const lines = b.split('\n');
    let path = '';
    let head = '';
    let branch = '';
    for (const l of lines) {
      if (l.startsWith('worktree ')) path = l.slice(9);
      else if (l.startsWith('HEAD ')) head = l.slice(5);
      else if (l.startsWith('branch ')) branch = l.slice(7).replace(/^refs\/heads\//, '');
      else if (l === 'detached') branch = '(detached)';
    }
    return { path, head, branch };
  });
}

// Classify a status --porcelain v1 output into split counts.
export function classifyStatusLines(status: string): {
  untracked: number;
  modified: number;
  staged: number;
  conflicts: number;
} {
  let untracked = 0;
  let modified = 0;
  let staged = 0;
  let conflicts = 0;
  for (const line of status.split('\n').filter(Boolean)) {
    const x = line[0];
    const y = line[1];
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
      conflicts++;
      continue;
    }
    if (x === '?' && y === '?') {
      untracked++;
      continue;
    }
    if (x !== ' ' && x !== '?') staged++;
    if (y !== ' ') modified++;
  }
  return { untracked, modified, staged, conflicts };
}

// Marker file → operation. Priority order roughly matches git's own resolution order.
// Takes the absolute path to the worktree's .git dir (resolved once via rev-parse --git-path).
export function detectInProgressFromMarkers(markers: {
  rebaseMerge: boolean;
  rebaseApply: boolean;
  mergeHead: boolean;
  cherryPickHead: boolean;
  revertHead: boolean;
  bisectLog: boolean;
}): InProgressOp | undefined {
  if (markers.rebaseMerge || markers.rebaseApply) return 'rebase';
  if (markers.cherryPickHead) return 'cherry-pick';
  if (markers.revertHead) return 'revert';
  if (markers.mergeHead) return 'merge';
  if (markers.bisectLog) return 'bisect';
  return undefined;
}

// Resolve a $GIT_DIR-relative path inside a worktree. `git rev-parse --git-path`
// handles linked worktrees where .git is a file pointing at .git/worktrees/<name>/.
async function gitPath(worktreePath: string, rel: string): Promise<string> {
  return (await tryRun(worktreePath, ['rev-parse', '--git-path', rel])).trim();
}

// The six markers we care about. `rebase-merge/` and `rebase-apply/` are directories;
// the other four are files (MERGE_HEAD etc. are pseudo-refs but we treat them as files
// so one probe shape handles every case).
const IN_PROGRESS_MARKERS: Array<keyof ReturnType<typeof emptyMarkers>> = [
  'rebaseMerge',
  'rebaseApply',
  'mergeHead',
  'cherryPickHead',
  'revertHead',
  'bisectLog',
];

function emptyMarkers() {
  return {
    rebaseMerge: false,
    rebaseApply: false,
    mergeHead: false,
    cherryPickHead: false,
    revertHead: false,
    bisectLog: false,
  };
}

const MARKER_REL_PATH: Record<keyof ReturnType<typeof emptyMarkers>, string> = {
  rebaseMerge: 'rebase-merge',
  rebaseApply: 'rebase-apply',
  mergeHead: 'MERGE_HEAD',
  cherryPickHead: 'CHERRY_PICK_HEAD',
  revertHead: 'REVERT_HEAD',
  bisectLog: 'BISECT_LOG',
};

async function detectInProgress(worktreePath: string): Promise<InProgressOp | undefined> {
  const entries = await Promise.all(
    IN_PROGRESS_MARKERS.map(async (key) => {
      const abs = await gitPath(worktreePath, MARKER_REL_PATH[key]);
      if (!abs) return [key, false] as const;
      const exists = await pathExists(abs);
      return [key, exists] as const;
    }),
  );
  const markers = emptyMarkers();
  for (const [k, v] of entries) markers[k] = v;
  return detectInProgressFromMarkers(markers);
}

// `git stash list` always reports the repo-wide stash list, so counting raw lines
// would give every linked worktree the same total. Each stash entry carries a
// `WIP on <branch>:` (auto) or `On <branch>:` (manual) header naming the branch
// that was checked out when the stash was created — that's our per-worktree key.
// Exported so tests can exercise the parser without mocking the subprocess.
export function parseStashBranches(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    // stash@{0}: WIP on feat/login: abc1234 subject
    // stash@{1}: On main: manual message
    const m = line.match(/^stash@\{\d+\}:\s+(?:WIP on|On)\s+([^:]+):/);
    if (m) out.push(m[1]);
  }
  return out;
}

async function stashCount(worktreePath: string, branch: string): Promise<number> {
  // Detached worktrees have no branch to match against; a global count would be
  // misleading for them too, so report 0.
  if (!branch || branch === '(detached)') return 0;
  const raw = await tryRun(worktreePath, ['stash', 'list']);
  if (!raw.trim()) return 0;
  return parseStashBranches(raw).filter((b) => b === branch).length;
}

async function worktreeCore(
  path: string,
  head: string,
  branch: string,
  isPrimary: boolean,
): Promise<Worktree> {
  const [status, ab, upstreamRaw, logLine, stashes, inProgress] = await Promise.all([
    tryRun(path, ['status', '--porcelain=v1']),
    tryRun(path, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
    tryRun(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    tryRun(path, ['log', '-1', '--format=%H%x09%s%x09%cI%x09%an']),
    stashCount(path, branch),
    detectInProgress(path),
  ]);

  const { untracked, modified, staged, conflicts } = classifyStatusLines(status);
  const uncommitted = untracked + modified;

  let ahead = 0;
  let behind = 0;
  const abm = ab.trim().match(/^(\d+)\s+(\d+)$/);
  if (abm) {
    behind = parseInt(abm[1], 10);
    ahead = parseInt(abm[2], 10);
  }

  const upstream = upstreamRaw.trim() || undefined;

  const [sha, message, date, author] = logLine.trim().split('\t');

  let wtStatus: WorktreeStatus = 'clean';
  if (conflicts > 0) wtStatus = 'conflict';
  else if (ahead > 0 && behind > 0) wtStatus = 'diverged';
  else if (uncommitted > 0 || staged > 0) wtStatus = 'dirty';

  return {
    path,
    branch: branch || '(detached)',
    upstream,
    isPrimary,
    head,
    untrackedCount: untracked,
    modifiedCount: modified,
    uncommittedCount: uncommitted,
    stagedCount: staged,
    stashCount: stashes,
    ahead,
    behind,
    hasConflicts: conflicts > 0,
    inProgress,
    lastCommit: {
      sha: sha || head,
      message: message || '',
      date: date || '',
      author: author || '',
    },
    status: wtStatus,
  };
}

export async function listWorktrees(repo: string): Promise<Worktree[]> {
  const raw = await run(repo, ['worktree', 'list', '--porcelain']);
  const entries = parseWorktreeList(raw);
  // Parallel across worktrees; each call internally parallelizes its per-worktree probes.
  return Promise.all(
    entries.map((e, i) => worktreeCore(e.path, e.head, e.branch, i === 0)),
  );
}

// Resolve merged-normally by checking `merge-base --is-ancestor`'s exit code directly.
// tryRun swallows the code; use raw gitExec here.
export async function isAncestor(repo: string, ref: string, base: string): Promise<boolean> {
  try {
    const r = await gitExec(repo, ['merge-base', '--is-ancestor', ref, base]);
    return r.code === 0;
  } catch {
    return false;
  }
}

export async function listBranches(repo: string, defaultBranch: string): Promise<Branch[]> {
  const localRaw = await tryRun(repo, [
    'for-each-ref',
    '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso8601)%09%(upstream:track)%09%(authoremail)',
    'refs/heads',
  ]);
  const remoteRaw = await tryRun(repo, [
    'for-each-ref',
    '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso8601)%09%(authoremail)',
    'refs/remotes',
  ]);
  const branches = new Map<string, Branch>();
  for (const line of localRaw.split('\n').filter(Boolean)) {
    const [name, sha, date, track, email] = line.split('\t');
    if (!name) continue;
    branches.set(name, {
      name,
      hasLocal: true,
      hasRemote: false,
      lastCommitDate: date || '',
      lastCommitSha: sha || '',
      aheadOfMain: 0,
      behindMain: 0,
      mergeStatus: 'unmerged',
      upstreamGone: track?.includes('gone') ?? false,
      authorEmail: stripEmailAngles(email),
    });
  }
  for (const line of remoteRaw.split('\n').filter(Boolean)) {
    const [refShort, sha, date, email] = line.split('\t');
    if (!refShort || refShort.endsWith('/HEAD')) continue;
    const name = refShort.replace(/^[^/]+\//, '');
    const existing = branches.get(name);
    if (existing) {
      existing.hasRemote = true;
      if (!existing.authorEmail) existing.authorEmail = stripEmailAngles(email);
    } else {
      branches.set(name, {
        name,
        hasLocal: false,
        hasRemote: true,
        lastCommitDate: date || '',
        lastCommitSha: sha || '',
        aheadOfMain: 0,
        behindMain: 0,
        mergeStatus: 'unmerged',
        authorEmail: stripEmailAngles(email),
      });
    }
  }
  // ahead/behind vs default + merged check, in parallel.
  await Promise.all(
    Array.from(branches.values()).map(async (b) => {
      const ref = b.hasLocal ? b.name : `origin/${b.name}`;
      const [abOut, merged] = await Promise.all([
        tryRun(repo, ['rev-list', '--left-right', '--count', `${defaultBranch}...${ref}`]),
        isAncestor(repo, ref, defaultBranch),
      ]);
      const m = abOut.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) {
        b.behindMain = parseInt(m[1], 10);
        b.aheadOfMain = parseInt(m[2], 10);
      }
      if (merged) b.mergeStatus = 'merged-normally';
    }),
  );
  return Array.from(branches.values()).filter((b) => b.name !== defaultBranch);
}

// for-each-ref %(authoremail) returns `<you@example.com>`; strip the angle brackets.
export function stripEmailAngles(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const m = trimmed.match(/^<(.+)>$/);
  return m ? m[1] : trimmed;
}

export async function listMainCommits(repo: string, defaultBranch: string, limit = 200): Promise<MainCommit[]> {
  const raw = await tryRun(repo, [
    'log',
    defaultBranch,
    '--first-parent',
    `-${limit}`,
    '--format=%H%x09%s%x09%cI',
  ]);
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, subject, date] = l.split('\t');
      const m = subject?.match(/\(#(\d+)\)\s*$/);
      return {
        sha,
        subject: subject || '',
        date: date || '',
        prNumber: m ? parseInt(m[1], 10) : undefined,
      };
    });
}

// Total first-parent commit count on the default branch. Used alongside
// listMainCommits so the Graph view can surface "showing N of M" when the
// history is truncated to the fetch cap.
export async function countMainCommits(repo: string, defaultBranch: string): Promise<number> {
  const raw = await tryRun(repo, ['rev-list', '--count', '--first-parent', defaultBranch]);
  const n = parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

export async function listTags(repo: string): Promise<string[]> {
  const raw = await tryRun(repo, ['tag', '--list']);
  return raw.split('\n').filter(Boolean);
}

export async function cherryCheck(repo: string, defaultBranch: string, branchRef: string): Promise<boolean> {
  const raw = await tryRun(repo, ['cherry', defaultBranch, branchRef]);
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((l) => l.startsWith('-'));
}

export async function deleteLocalBranch(repo: string, name: string, force = false): Promise<void> {
  await run(repo, ['branch', force ? '-D' : '-d', name]);
}

export async function deleteRemoteBranch(repo: string, remote: string, name: string): Promise<void> {
  await run(repo, ['push', remote, '--delete', name]);
}

// Create a local tag pointing at the tip of a branch (used by the archive-and-delete flow).
export function archiveTagNameFor(branch: string): string {
  return `archive/${branch}`;
}

export async function tagBranch(repo: string, branch: string, tagName: string): Promise<void> {
  await run(repo, ['tag', tagName, branch]);
}

// Worktree admin (create / remove / prune). All destructive — use run() so failures surface.
export async function createWorktree(
  repo: string,
  path: string,
  branch: string,
  newBranch: boolean,
): Promise<void> {
  const args = ['worktree', 'add'];
  if (newBranch) args.push('-b', branch);
  args.push(path);
  if (!newBranch) args.push(branch);
  await run(repo, args);
}

export async function removeWorktree(repo: string, path: string, force = false): Promise<void> {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(path);
  await run(repo, args);
}

export async function pruneWorktrees(repo: string): Promise<void> {
  await run(repo, ['worktree', 'prune']);
}

export async function fetchAllPrune(repo: string): Promise<void> {
  await run(repo, ['fetch', '--all', '--prune']);
}
