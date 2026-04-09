import { gitExec, pathExists } from './tauriBridge';
import type { Worktree, Branch, MainCommit, WorktreeStatus, InProgressOp } from '../types';

async function run(repo: string, args: string[]): Promise<string> {
  const r = await gitExec(repo, args);
  // Throw on ANY non-zero exit. Previously we only threw when stderr was
  // populated, which silently masked failures from git commands that exit
  // non-zero with no stderr (e.g. some `branch -d` paths) — destructive ops
  // would appear to succeed when they hadn't.
  if (r.code !== 0) {
    const detail = r.stderr.trim() || r.stdout.trim() || `exited ${r.code}`;
    throw new Error(`git ${args.join(' ')}: ${detail}`);
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
  // Only memoize a successful lookup. If `git config` transiently fails (or
  // user.email genuinely isn't set), retry on the next call rather than
  // caching the empty string and locking the "mine" filter into "no matches"
  // for the rest of the session.
  if (out) cachedUserEmail = { repo, email: out };
  return out;
}

// Parse `git worktree list --porcelain` output. The `prunable` line is git's
// own signal that a worktree's bookkeeping points at a directory that no
// longer exists (typically because the user `rm -rf`d it instead of running
// `git worktree remove`). The reason text follows the keyword. Capture it so
// callers can short-circuit per-worktree probes against a missing path and
// surface the orphan in the UI — without this, an orphaned entry pretends to
// be a tidy worktree because every `tryRun` against the missing path returns
// empty.
export function parseWorktreeList(
  text: string,
): Array<{ path: string; head: string; branch: string; prunable?: string }> {
  const blocks = text.split(/\n\n+/).filter(Boolean);
  return blocks.map((b) => {
    const lines = b.split('\n');
    let path = '';
    let head = '';
    let branch = '';
    let prunable: string | undefined;
    for (const l of lines) {
      if (l.startsWith('worktree ')) path = l.slice(9);
      else if (l.startsWith('HEAD ')) head = l.slice(5);
      else if (l.startsWith('branch ')) branch = l.slice(7).replace(/^refs\/heads\//, '');
      else if (l === 'detached') branch = '(detached)';
      else if (l === 'prunable') prunable = '(no reason given)';
      else if (l.startsWith('prunable ')) prunable = l.slice(9);
    }
    return prunable ? { path, head, branch, prunable } : { path, head, branch };
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

// The six markers we care about. `rebase-merge/` and `rebase-apply/` are
// directories; the other four are files (MERGE_HEAD etc. are pseudo-refs but
// we treat them as files so one probe shape handles every case). All six
// live in the per-worktree git dir — for a linked worktree that's
// .git/worktrees/<name>/, not the common .git/.
type MarkerKey =
  | 'rebaseMerge'
  | 'rebaseApply'
  | 'mergeHead'
  | 'cherryPickHead'
  | 'revertHead'
  | 'bisectLog';

const MARKER_REL_PATH: Record<MarkerKey, string> = {
  rebaseMerge: 'rebase-merge',
  rebaseApply: 'rebase-apply',
  mergeHead: 'MERGE_HEAD',
  cherryPickHead: 'CHERRY_PICK_HEAD',
  revertHead: 'REVERT_HEAD',
  bisectLog: 'BISECT_LOG',
};

function emptyMarkers(): Record<MarkerKey, boolean> {
  return {
    rebaseMerge: false,
    rebaseApply: false,
    mergeHead: false,
    cherryPickHead: false,
    revertHead: false,
    bisectLog: false,
  };
}

async function detectInProgress(worktreePath: string): Promise<InProgressOp | undefined> {
  // One `rev-parse --git-dir` resolves the per-worktree git dir for both
  // primary and linked worktrees (git makes the linked-worktree case work
  // transparently). Previously we shelled out six times — once per marker —
  // with `--git-path <rel>`, which was 6× the subprocess cost for the same
  // answer. Now: one rev-parse + six path stats.
  const gitDir = (
    await tryRun(worktreePath, ['rev-parse', '--path-format=absolute', '--git-dir'])
  ).trim();
  if (!gitDir) return undefined;
  const markers = emptyMarkers();
  const keys = Object.keys(MARKER_REL_PATH) as MarkerKey[];
  const results = await Promise.all(
    keys.map(async (k) => [k, await pathExists(`${gitDir}/${MARKER_REL_PATH[k]}`)] as const),
  );
  for (const [k, v] of results) markers[k] = v;
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

// Sentinel for an orphaned worktree: git's bookkeeping under
// .git/worktrees/<name>/ still references a path that no longer exists. We
// short-circuit every per-worktree probe (status, rev-list, stash list,
// marker scans) because they'd all be operating on a missing directory and
// returning empty strings — which silently paints the card as a tidy
// worktree. The UI branches on `prunable` to render the OrphanedCard variant.
function orphanedWorktree(
  path: string,
  head: string,
  branch: string,
  prunable: string,
): Worktree {
  return {
    path,
    branch: branch || '(detached)',
    isPrimary: false,
    head,
    untrackedCount: 0,
    modifiedCount: 0,
    stagedCount: 0,
    stashCount: 0,
    ahead: 0,
    behind: 0,
    hasConflicts: false,
    lastCommit: { sha: head, message: '', date: '', author: '' },
    status: 'clean',
    prunable,
  };
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
  // Orphaned entries (prunable) skip the probes entirely and return a sentinel
  // immediately — there's no point statting a directory that doesn't exist.
  return Promise.all(
    entries.map(async (e, i) => {
      if (e.prunable) {
        return orphanedWorktree(e.path, e.head, e.branch, e.prunable);
      }
      return worktreeCore(e.path, e.head, e.branch, i === 0);
    }),
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

// Cache of per-branch ahead/behind/merged results, keyed by the tuple of
// `(branch sha, main sha, ref shape)`. The keys are content-addressed, so
// when either sha moves the key changes and we re-compute; when nothing has
// moved between ticks we skip a `rev-list` + `merge-base --is-ancestor`
// subprocess per branch. On a 100-branch repo that's ~200 spawns/tick
// eliminated in the steady state.
//
// No TTL: stale entries are harmless because a stale key only becomes
// reachable again if the branch/main sha actually regresses to the same
// value, in which case the cached answer is still correct. We do cap the
// size to keep long sessions bounded — see trim below.
interface BranchAbCacheEntry {
  aheadOfMain: number;
  behindMain: number;
  merged: boolean;
}
const branchAbCache = new Map<string, BranchAbCacheEntry>();
const BRANCH_AB_CACHE_MAX = 2000;

export function _clearBranchAbCacheForTests(): void {
  branchAbCache.clear();
}

export async function listBranches(repo: string, defaultBranch: string): Promise<Branch[]> {
  // iso8601-strict emits the `T` separator (2026-01-01T00:00:00+00:00). Plain
  // iso8601 uses a space separator that some strict ECMAScript Date parsers
  // reject as NaN — which silently broke `isStale` (the NaN guard returns
  // false, so affected branches never aged into the stale bucket).
  const localRaw = await tryRun(repo, [
    'for-each-ref',
    '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso8601-strict)%09%(upstream:track)%09%(authoremail)',
    'refs/heads',
  ]);
  const remoteRaw = await tryRun(repo, [
    'for-each-ref',
    '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso8601-strict)%09%(authoremail)',
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
    // Only consider origin/* refs. Other remotes (upstream, fork, etc.) would
    // collide on the stripped branch name and silently overwrite each other —
    // and the rest of the app hard-codes `origin` for delete/push paths
    // anyway, so a non-origin entry isn't actionable.
    if (!refShort.startsWith('origin/')) continue;
    const name = refShort.slice('origin/'.length);
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
  // Pick up the default branch's current sha from the ref data we already
  // have. Used as a cache key component — if main moves, every branch's
  // ahead/behind relative to main is potentially stale and must be recomputed.
  const mainSha = branches.get(defaultBranch)?.lastCommitSha ?? '';

  // Build the set of first-parent shas on the default branch. We need this to
  // distinguish "branch tip is just a snapshot of main's history" from "branch
  // was merge-merged into main", because `merge-base --is-ancestor` returns
  // true for BOTH cases and the bare check would mis-tag the former.
  //
  // Concretely, three things make `is-ancestor` return true:
  //   (a) branch tip == main's tip, or sits on main's first-parent line at
  //       some earlier commit (the branch literally has no commits of its own,
  //       so there's nothing to merge — calling it MERGED in the UI is wrong
  //       because the user hasn't done any work on it yet)
  //   (b) branch tip is the second parent of a merge commit on main (a real
  //       merge-merged branch — this IS the case `merged-normally` is for)
  //   (c) branch was squash-merged (squashDetector handles this separately)
  //
  // The set includes case (a) and excludes case (b), so we treat is-ancestor
  // as proof of merge ONLY when the branch tip is NOT in the set. The set is
  // computed once per refresh from a single rev-list call rather than probed
  // per-branch. The first-parent chain is fully determined by main's tip, so
  // the per-branch cache key (which already includes mainSha) stays valid.
  const firstParentRaw = await tryRun(repo, [
    'rev-list',
    defaultBranch,
    '--first-parent',
  ]);
  const mainFirstParentShas = new Set(firstParentRaw.split('\n').filter(Boolean));

  // ahead/behind vs default + merged check, in parallel — cached by
  // (branch sha, main sha, ref) so the steady-state refresh skips the
  // subprocess pair entirely when nothing has moved.
  await Promise.all(
    Array.from(branches.values()).map(async (b) => {
      const ref = b.hasLocal ? b.name : `origin/${b.name}`;
      const key = mainSha ? `${b.lastCommitSha}|${mainSha}|${ref}` : '';
      if (key) {
        const cached = branchAbCache.get(key);
        if (cached) {
          b.aheadOfMain = cached.aheadOfMain;
          b.behindMain = cached.behindMain;
          if (cached.merged) {
            b.mergeStatus = 'merged-normally';
          } else if (cached.aheadOfMain === 0) {
            // Mirror the empty-tag rule applied below to cold computes — the
            // cache stores the raw counts, the empty derivation is stateless.
            b.mergeStatus = 'empty';
          }
          return;
        }
      }
      // Use gitExec directly for both probes so we can distinguish "exit 1 =
      // not an ancestor" (a legitimate answer) from "thrown subprocess error"
      // (transient — e.g. a ref race during rebase). Without this distinction
      // a transient failure would get cached as `{0, 0, false}` and stick to
      // the (sha, sha) key forever. The cherryCache in squashDetector.ts
      // documents the same invariant: don't cache failures, retry next tick.
      const [abResult, mergeResult] = await Promise.all([
        gitExec(repo, [
          'rev-list',
          '--left-right',
          '--count',
          `${defaultBranch}...${ref}`,
        ]).catch(() => null),
        gitExec(repo, ['merge-base', '--is-ancestor', ref, defaultBranch]).catch(
          () => null,
        ),
      ]);
      let aheadOfMain = 0;
      let behindMain = 0;
      const abMatch =
        abResult && abResult.code === 0
          ? abResult.stdout.trim().match(/^(\d+)\s+(\d+)$/)
          : null;
      if (abMatch) {
        behindMain = parseInt(abMatch[1], 10);
        aheadOfMain = parseInt(abMatch[2], 10);
      }
      // `merge-base --is-ancestor` returns 0 (true) or 1 (false). Anything else
      // (or a thrown subprocess error) is "unknown" — leave merged false but
      // don't cache it.
      const mergeBaseSucceeded =
        mergeResult !== null && (mergeResult.code === 0 || mergeResult.code === 1);
      // Only treat is-ancestor as "merged" when the branch tip is NOT itself a
      // first-parent commit on main. See the mainFirstParentShas comment above
      // for the full rationale — without this guard, an empty branch freshly
      // created from main (or a branch that's just lagging behind main on the
      // first-parent line) gets mis-tagged `merged-normally` and renders as
      // MERGED in the WorktreeCard pill before any work has been done on it.
      const merged =
        mergeResult?.code === 0 && !mainFirstParentShas.has(b.lastCommitSha);
      b.aheadOfMain = aheadOfMain;
      b.behindMain = behindMain;
      if (merged) {
        b.mergeStatus = 'merged-normally';
      } else if (aheadOfMain === 0) {
        // Branch has no commits of its own — either pointing exactly at main's
        // tip (just-created via `git worktree add -b`) or lagging behind on
        // main's first-parent line. Either way there is literally nothing to
        // merge, so the bare "unmerged" pill is misleading. Tag it as `empty`
        // so the UI can render a quiet "no work yet" hint instead.
        b.mergeStatus = 'empty';
      }
      // Only cache when both probes returned a usable answer. A partial
      // failure means we may have a stale 0/0/false; serving that from cache
      // would lock it in until the branch sha actually moves.
      if (key && abMatch && mergeBaseSucceeded) {
        // Cheap FIFO trim: if we cross the cap, drop the oldest 25%. Maps
        // preserve insertion order, so slice-from-start is "oldest first".
        if (branchAbCache.size >= BRANCH_AB_CACHE_MAX) {
          const toDrop = Math.floor(BRANCH_AB_CACHE_MAX / 4);
          let i = 0;
          for (const k of branchAbCache.keys()) {
            if (i++ >= toDrop) break;
            branchAbCache.delete(k);
          }
        }
        branchAbCache.set(key, { aheadOfMain, behindMain, merged });
      }
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

export interface MainCommitsResult {
  commits: MainCommit[];
  total: number;
}

// Returns the first-parent history on the default branch (capped at `limit`)
// along with the total commit count. The total is used by the Graph view to
// render "showing N of M" when the history is truncated.
//
// If the log came back with fewer than `limit` rows, `commits.length` IS the
// total — we skip the follow-up `rev-list --count` subprocess entirely in
// that case. For repos with short histories (most of them, most of the time)
// this drops a subprocess per refresh tick.
export async function listMainCommits(
  repo: string,
  defaultBranch: string,
  limit = 200,
): Promise<MainCommitsResult> {
  const raw = await tryRun(repo, [
    'log',
    defaultBranch,
    '--first-parent',
    `-${limit}`,
    '--format=%H%x09%s%x09%cI',
  ]);
  const commits = raw
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
  if (commits.length < limit) {
    return { commits, total: commits.length };
  }
  const countRaw = await tryRun(repo, ['rev-list', '--count', '--first-parent', defaultBranch]);
  const n = parseInt(countRaw.trim(), 10);
  return { commits, total: Number.isFinite(n) ? n : commits.length };
}

// Short-TTL cache. Tags change rarely and only matter for `archive/<branch>`
// detection in squashDetector; a steady-state poll loop shouldn't re-shell
// on every refresh tick. The cache key is the repo path so switching repos trivially
// invalidates. Callers that need guaranteed freshness after a known mutation
// (e.g. after tagging from BranchesView) can call `invalidateTagsCache()`.
interface TagsCacheEntry {
  repo: string;
  tags: string[];
  at: number;
}
let tagsCache: TagsCacheEntry | null = null;
const TAGS_TTL_MS = 30_000;

export function invalidateTagsCache(): void {
  tagsCache = null;
}

export async function listTags(repo: string): Promise<string[]> {
  const now = Date.now();
  if (tagsCache && tagsCache.repo === repo && now - tagsCache.at < TAGS_TTL_MS) {
    return tagsCache.tags;
  }
  const raw = await tryRun(repo, ['tag', '--list']);
  const tags = raw.split('\n').filter(Boolean);
  tagsCache = { repo, tags, at: now };
  return tags;
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
  // A fresh archive tag is load-bearing for the squash-detector's archaeology
  // mapping; invalidate so the next refresh sees it without waiting on TTL.
  invalidateTagsCache();
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

// `git worktree prune` honors gc.worktreePruneExpire (default 3h) and skips
// entries inside that grace window. When the user explicitly clicks
// "prune this orphan" we want the action to actually happen now — passing
// `--expire=now` bypasses the grace period. The default form (no expire)
// stays for the repo-wide menu entry, where the grace period is fine.
export async function pruneWorktrees(
  repo: string,
  opts: { expire?: 'now' } = {},
): Promise<void> {
  const args = ['worktree', 'prune'];
  if (opts.expire === 'now') args.push('--expire=now');
  await run(repo, args);
}

export async function fetchAllPrune(repo: string): Promise<void> {
  await run(repo, ['fetch', '--all', '--prune']);
}

// Fast-forward the currently-checked-out default branch from its upstream.
// Used by the WorktreeCard's inline "Pull" button on the main worktree when
// it's behind origin/main. We use `--ff-only` so the operation refuses to
// merge — if the branch isn't strictly behind (e.g., it diverged between
// the disposition computation and the click) the user gets a clear stderr
// instead of an unexpected merge commit. `run()` (not tryRun) so failures
// surface to the caller for setError().
export async function pullFastForward(worktreePath: string): Promise<void> {
  await run(worktreePath, ['pull', '--ff-only']);
}

// A deterministic single-string fingerprint of every remote ref in the repo,
// used by `runFetchOnce` to skip the chained refresh when `git fetch` didn't
// actually pull anything new. Cheap (one for-each-ref subprocess) and
// stable across runs because we sort by refname. Returns '' on error so the
// caller falls back to "definitely refresh" rather than "definitely skip".
export async function snapshotRemoteRefs(repo: string): Promise<string> {
  return tryRun(repo, [
    'for-each-ref',
    '--sort=refname',
    '--format=%(refname) %(objectname)',
    'refs/remotes',
  ]);
}

// Resolve the set of directories the filesystem watcher should watch for a
// set of worktrees. We deliberately avoid watching worktree roots because
// `notify` with `RecursiveMode::Recursive` on a worktree root fires for every
// change under `node_modules/`, `dist/`, `.next/`, log files, and so on — a
// busy repo produces a continuous stream of refresh events.
//
// The only paths that actually affect anything the app displays live under
// each worktree's per-worktree git dir (HEAD, index, rebase-merge/,
// MERGE_HEAD, …) and the common git dir (refs/heads, refs/remotes, …). We
// use `rev-parse --path-format=absolute --git-dir --git-common-dir` to get
// both in one subprocess call. For the primary worktree these are the same
// path; for linked worktrees they differ.
//
// Returns a deduped list of absolute paths. Best-effort: if rev-parse fails
// for a given worktree it's silently dropped — the polling loop still covers
// that worktree, just without the watcher's immediacy.
export async function resolveWatchDirs(worktreePaths: string[]): Promise<string[]> {
  const out = new Set<string>();
  await Promise.all(
    worktreePaths.map(async (p) => {
      try {
        const r = await gitExec(p, [
          'rev-parse',
          '--path-format=absolute',
          '--git-dir',
          '--git-common-dir',
        ]);
        if (r.code !== 0) return;
        for (const line of r.stdout.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) out.add(trimmed);
        }
      } catch {
        /* best-effort */
      }
    }),
  );
  return Array.from(out);
}
