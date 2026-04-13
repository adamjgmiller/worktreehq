import { gitExec, pathExists, ensureDir } from './tauriBridge';
import type { Worktree, Branch, MainCommit, WorktreeStatus, InProgressOp } from '../types';
import { TTLCache } from './cacheUtils';

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

/** Probe whether the `git` binary is reachable on PATH. Returns the version
 *  string (e.g. "git version 2.43.0") on success, or null if git can't be
 *  spawned. Uses tryRun so a spawn failure (binary missing) is caught
 *  gracefully rather than surfacing as an unhandled bridge error. */
export async function checkGitAvailable(repo: string): Promise<string | null> {
  const out = await tryRun(repo, ['--version']);
  return out.startsWith('git version') ? out.trim() : null;
}

// ─── Git version detection ───────────────────────────────────────────────
// Parsed once at bootstrap via setGitVersion(). Used by simulateMerge() to
// decide between the old three-argument `merge-tree` form and the modern
// `--write-tree` form (git 2.38+), which properly detects delete/modify,
// binary, rename/delete, and submodule conflicts via exit code.

let gitMajorMinor: [number, number] = [0, 0];

/** Parse "git version X.Y.Z" into [major, minor]. Returns [0, 0] on failure. */
export function parseGitVersion(versionString: string): [number, number] {
  const m = versionString.match(/(\d+)\.(\d+)/);
  if (!m) return [0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

/** Store the parsed git version for the lifetime of the process. Called once
 *  at bootstrap by useRepoBootstrap after checkGitAvailable(). */
export function setGitVersion(versionString: string): void {
  gitMajorMinor = parseGitVersion(versionString);
}

/** True when the installed git supports `merge-tree --write-tree` (>= 2.38). */
export function supportsWriteTree(): boolean {
  const [major, minor] = gitMajorMinor;
  return major > 2 || (major === 2 && minor >= 38);
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
    aheadOfMain: 0,
    behindMain: 0,
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
  defaultBranch: string,
): Promise<Worktree> {
  const [status, ab, abMain, upstreamRaw, logLine, stashes, inProgress] = await Promise.all([
    tryRun(path, ['status', '--porcelain=v1']),
    tryRun(path, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
    tryRun(path, ['rev-list', '--left-right', '--count', `origin/${defaultBranch}...HEAD`]),
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

  let aheadOfMain = 0;
  let behindMain = 0;
  const abmMain = abMain.trim().match(/^(\d+)\s+(\d+)$/);
  if (abmMain) {
    behindMain = parseInt(abmMain[1], 10);
    aheadOfMain = parseInt(abmMain[2], 10);
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
    aheadOfMain,
    behindMain,
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

export async function listWorktrees(repo: string, defaultBranch: string): Promise<Worktree[]> {
  // Read path: use tryRun so a transient failure on one poll tick doesn't
  // blank the entire worktrees tab via a thrown pipeline error. An empty
  // result degrades gracefully to "no worktrees" for the tick; the next
  // poll will recover.
  const raw = await tryRun(repo, ['worktree', 'list', '--porcelain']);
  const entries = parseWorktreeList(raw);
  // Parallel across worktrees; each call internally parallelizes its per-worktree probes.
  // Orphaned entries (prunable) skip the probes entirely and return a sentinel
  // immediately — there's no point statting a directory that doesn't exist.
  return Promise.all(
    entries.map(async (e, i) => {
      if (e.prunable) {
        return orphanedWorktree(e.path, e.head, e.branch, e.prunable);
      }
      return worktreeCore(e.path, e.head, e.branch, i === 0, defaultBranch);
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
  directMerged?: boolean;
}
const branchAbCache = new TTLCache<string, BranchAbCacheEntry>({ maxSize: 2000 });

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
  // Prefer `origin/<defaultBranch>` as the comparison ref for ahead/behind
  // and merge-base — local main can be stale because the refresh loop fetches
  // but never fast-forwards it. Extract the origin SHA from the remote refs
  // we already fetched (no extra subprocess). Fall back to local when no
  // remote tracking ref exists (fresh repo, no remote configured).
  let originMainSha = '';
  for (const line of remoteRaw.split('\n').filter(Boolean)) {
    const [refShort, sha] = line.split('\t');
    if (refShort === `origin/${defaultBranch}`) {
      originMainSha = sha || '';
      break;
    }
  }
  const mainRef = originMainSha ? `origin/${defaultBranch}` : defaultBranch;
  const mainSha = originMainSha || (branches.get(defaultBranch)?.lastCommitSha ?? '');

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
    mainRef,
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
          } else if (cached.directMerged) {
            b.mergeStatus = 'direct-merged';
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
          `${mainRef}...${ref}`,
        ]).catch(() => null),
        gitExec(repo, ['merge-base', '--is-ancestor', ref, mainRef]).catch(
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
      } else if (abMatch && aheadOfMain === 0) {
        // Branch has no commits of its own — either pointing exactly at main's
        // tip (just-created via `git worktree add -b`) or lagging behind on
        // main's first-parent line. Either way there is literally nothing to
        // merge, so the bare "unmerged" pill is misleading. Tag it as `empty`
        // so the UI can render a quiet "no work yet" hint instead.
        //
        // Guard on `abMatch`: when the rev-list command fails (caught by
        // .catch → null), aheadOfMain stays at its default 0 and the branch
        // would be mis-tagged as empty instead of staying `unmerged`.
        b.mergeStatus = 'empty';
      }
      // Reflog check: if the branch is tagged `empty` but the reflog shows
      // a `commit:` action, the user made real commits that ended up on
      // main (e.g., pushed directly without a PR). Upgrade to
      // `direct-merged` so the UI says "your work landed" instead of "no
      // work here". Only local branches have a meaningful reflog.
      let directMerged = false;
      if (b.mergeStatus === 'empty' && b.hasLocal) {
        const reflogResult = await gitExec(repo, [
          'reflog', 'show', '--format=%gs', b.name,
        ]).catch(() => null);
        if (reflogResult && reflogResult.code === 0) {
          const hasCommits = reflogResult.stdout.trim().split('\n')
            .some((line) => line.startsWith('commit'));
          if (hasCommits) {
            b.mergeStatus = 'direct-merged';
            directMerged = true;
          }
        }
      }
      // Only cache when both probes returned a usable answer. A partial
      // failure means we may have a stale 0/0/false; serving that from cache
      // would lock it in until the branch sha actually moves.
      if (key && abMatch && mergeBaseSucceeded) {
        branchAbCache.set(key, { aheadOfMain, behindMain, merged, directMerged });
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
  // Walk first-parent history of both local `<defaultBranch>` AND
  // `origin/<defaultBranch>` when the remote-tracking ref exists. `git log`
  // dedupes across multiple tips by SHA, so passing both is free when
  // they're on the same trunk (the common case) and correct when they
  // diverge. See `resolveMainUpstreams` for the full motivation.
  const refs = await resolveMainUpstreams(repo, defaultBranch);
  const raw = await tryRun(repo, [
    'log',
    ...refs,
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
  // Count against the same ref set so the "total" matches the union we
  // just walked. `rev-list --count` accepts multiple tips and returns the
  // count of the union (dedup'd by SHA) — the same shape `git log` used.
  const countRaw = await tryRun(repo, [
    'rev-list',
    '--count',
    '--first-parent',
    ...refs,
  ]);
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

// Build the list of refs that collectively represent "main's history" for
// squash-merge detection. When the remote-tracking `origin/<defaultBranch>`
// exists, we include it alongside the local branch — the refresh loop keeps
// origin/main fresh via `git fetch` but never advances local main, so right
// after a PR is squash-merged on GitHub the squash commit lives on
// origin/main only. Walking local main alone would silently miss it and
// leave every downstream branch tagged "unmerged" until the user manually
// `git pull`s. Passing both refs to `git log`/`git cherry` is cheap and
// correct — git dedupes by SHA, and the commits overlap entirely when
// local is up to date.
//
// Returns `[defaultBranch]` alone when origin/<defaultBranch> doesn't
// exist (fresh repo, no remote, or a different remote name) — callers are
// guaranteed to get at least one ref back.
export async function resolveMainUpstreams(
  repo: string,
  defaultBranch: string,
): Promise<string[]> {
  const refs = [defaultBranch];
  // --verify --quiet: prints the SHA on success, nothing on failure.
  // tryRun returns '' on any non-zero exit, so an empty trim means the ref
  // doesn't exist and we stick with just local.
  const verify = await tryRun(repo, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${defaultBranch}`,
  ]);
  if (verify.trim()) refs.push(`origin/${defaultBranch}`);
  return refs;
}

// Run `git cherry` against each upstream ref and decide whether every commit
// on `branchRef` is patch-equivalent to something on at least one upstream.
//
// `git cherry <upstream> <head>` emits one line per commit in
// `<head>`..`<upstream>..<head>` (commits in head but not upstream), prefixed
// with `-` when an equivalent patch-id exists upstream and `+` when it
// doesn't. A branch is squash-merged when every commit has at least one `-`
// across the upstream set.
//
// Why we union across upstreams instead of just picking the "ahead-most"
// one: when local main has diverged commits (user committed locally but
// hasn't pushed), neither local nor origin is a strict superset — we need
// both to get full coverage. Union by SHA is the only correct answer.
export async function cherryCheck(
  repo: string,
  upstreams: string[],
  branchRef: string,
): Promise<boolean> {
  if (upstreams.length === 0) return false;
  // Per-branch-commit: SHA → has a `-` mark in at least one run.
  // We track the full set of SHAs seen across all runs too, because cherry
  // may list slightly different sets per upstream (a commit that's an
  // ancestor of origin/main won't appear in `cherry origin/main branch`
  // even though it would in `cherry local branch`).
  const presentShas = new Set<string>();
  const allBranchShas = new Set<string>();
  for (const upstream of upstreams) {
    // Use `run` (throws on non-zero) rather than `tryRun`: squashDetector
    // has a try/catch around this call specifically to avoid caching
    // transient failures. If we swallowed the error here and returned
    // `false`, that catch would be dead code and a one-off `git cherry`
    // failure would get cached as "not squash-merged" until the SHAs
    // moved — exactly the flicker mode CLAUDE.md warns about.
    const raw = await run(repo, ['cherry', upstream, branchRef]);
    for (const line of raw.split('\n')) {
      if (!line) continue;
      // Format: `<sign> <sha>` (sign is `+` or `-`, then a space, then the
      // full 40-char SHA). No `-v`, so no subject suffix.
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx < 0) continue;
      const sign = line.slice(0, spaceIdx);
      const sha = line.slice(spaceIdx + 1).trim();
      if (!sha) continue;
      allBranchShas.add(sha);
      if (sign === '-') presentShas.add(sha);
    }
  }
  if (allBranchShas.size === 0) return false;
  for (const sha of allBranchShas) {
    if (!presentShas.has(sha)) return false;
  }
  return true;
}

export async function deleteLocalBranch(repo: string, name: string, force = false): Promise<void> {
  await run(repo, ['branch', force ? '-D' : '-d', name]);
}

export async function deleteRemoteBranch(repo: string, remote: string, name: string): Promise<void> {
  await run(repo, ['push', remote, '--delete', name]);
}

export async function pushNewBranch(repo: string, branch: string): Promise<void> {
  await run(repo, ['push', '-u', 'origin', branch]);
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
  // `git worktree add <path>` creates the leaf directory but NOT intermediate
  // parents. With the new default of `<repo>/.claude/worktrees/<branch>`, a
  // brand-new clone won't have `.claude/worktrees/` yet, so pre-create it.
  // No-op when the parent already exists.
  const parent = parentDir(path);
  if (parent) await ensureDir(parent);

  const args = ['worktree', 'add'];
  if (newBranch) args.push('-b', branch);
  args.push(path);
  if (!newBranch) args.push(branch);
  await run(repo, args);
}

// Last path-separator split. Handles both `/` and `\` so we don't assume a
// posix-only environment, even though the rest of the app is macOS-first.
// Returns empty string for bare names (no parent to create).
function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : '';
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

// ─── Cross-worktree conflict detection helpers ─────────────────────────

/** Files changed on `branch` relative to its merge-base with `defaultBranch`. */
export async function getChangedFiles(
  repo: string,
  defaultBranch: string,
  branch: string,
): Promise<string[]> {
  // Three-dot diff: files changed on branch since it diverged from defaultBranch.
  // tryRun so a transient failure degrades to "no files" for one tick.
  // --no-renames decomposes renames into delete+add so both the old and new
  // paths appear in the file set. Without this, git's rename detection shows
  // only the new name, and a rename/modify conflict (branch A renames foo→bar,
  // branch B modifies foo) would have no file overlap — the pair would be
  // skipped by Phase 2's prefilter before simulateMerge could detect it.
  const out = await tryRun(repo, ['diff', '--no-renames', '--name-only', `origin/${defaultBranch}...${branch}`]);
  return out.split('\n').filter(Boolean);
}

/**
 * Resolve a ref (branch, tag, remote ref, SHA) to its full commit SHA.
 * Returns empty string if the ref can't be resolved (missing remote ref,
 * unreachable object, etc.) so callers can degrade gracefully.
 */
export async function resolveRef(repo: string, ref: string): Promise<string> {
  return (await tryRun(repo, ['rev-parse', '--verify', ref])).trim();
}

/** Common ancestor of two refs. Returns empty string on failure. */
export async function getMergeBase(
  repo: string,
  refA: string,
  refB: string,
): Promise<string> {
  return (await tryRun(repo, ['merge-base', refA, refB])).trim();
}

export interface MergeSimResult {
  hasConflicts: boolean;
  /** Raw stdout — populated on the legacy path for `parseMergeTreeOutput`;
   *  empty on the modern `--write-tree` path (not needed). */
  output: string;
  /** File paths git reports as conflicted. Populated only on the modern
   *  `--write-tree --name-only` path; empty on the legacy path (callers
   *  fall back to `parseMergeTreeOutput` + `<<<<<<<` marker parsing). */
  conflictedFiles: string[];
  /** Per-file informational messages from git merge-tree (modern path only).
   *  Contains lines like "CONFLICT (content): Merge conflict in file.txt"
   *  that the UI can show as conflict descriptions. Keyed by file path. */
  infoByFile: Map<string, string>;
}

/**
 * Best-effort parser for git merge-tree informational messages. Extracts file
 * paths from known message formats and maps them to their full message text.
 *
 * Git explicitly states these messages are "not designed to be machine
 * parseable", so this is inherently best-effort. The `conflictedFiles` list
 * from `--name-only` is the authoritative source; `infoByFile` is decoration
 * for the ConflictPairDetail UI. Files that don't match any pattern get the
 * generic fallback in the conflict detector.
 */
export function parseConflictMessages(messageSection: string): Map<string, string> {
  const infoByFile = new Map<string, string>();
  if (!messageSection) return infoByFile;

  for (const line of messageSection.split('\n').filter((l) => l.trim())) {
    let filePath: string | undefined;

    // 1. Auto-merging: "Auto-merging path/to/file.txt"
    const autoMatch = line.match(/^Auto-merging\s+(.+)$/);
    if (autoMatch) {
      filePath = autoMatch[1].trim();
    }

    // 2. modify/delete: "CONFLICT (modify/delete): <file> deleted in <ref> ..."
    //    The filename comes FIRST, before "deleted in" / "modified in".
    //    Use (.+?) (not \S+) so paths with spaces are captured fully.
    if (!filePath) {
      const modDelMatch = line.match(
        /^CONFLICT\s+\((?:modify\/delete|delete\/modify)\):\s+(.+?)\s+(?:deleted|modified)\s+in\s+/,
      );
      if (modDelMatch) filePath = modDelMatch[1];
    }

    // 3. rename/delete and rename/rename: "CONFLICT (rename/delete): <old> renamed ..."
    //    Use (.+?) anchored on " renamed" so spaced paths work.
    if (!filePath) {
      const renameMatch = line.match(/^CONFLICT\s+\(rename\/\w+\):\s+(.+?)\s+renamed\s+/);
      if (renameMatch) filePath = renameMatch[1];
    }

    // 4. content, binary, submodule: "CONFLICT (<type>): Merge conflict in <file>"
    if (!filePath) {
      const contentMatch = line.match(
        /^CONFLICT\s+\([^)]+\):.*\bMerge conflict in\s+(.+?)\.?\s*$/,
      );
      if (contentMatch) filePath = contentMatch[1].trim();
    }

    // 5. Generic fallback: first path-looking token (contains / or .)
    if (!filePath) {
      const genericMatch = line.match(/^CONFLICT\s+\([^)]+\):\s+(\S+)/);
      if (genericMatch && (genericMatch[1].includes('/') || genericMatch[1].includes('.'))) {
        filePath = genericMatch[1];
      }
    }

    if (filePath) {
      // Accumulate all messages for a given file (there can be multiple,
      // e.g. Auto-merging + CONFLICT for the same file).
      const existing = infoByFile.get(filePath);
      infoByFile.set(filePath, existing ? existing + '\n' + line : line);
    }
  }
  return infoByFile;
}

/**
 * Simulate a three-way merge without touching the worktree or index.
 *
 * Two paths depending on installed git version (set at bootstrap via
 * `setGitVersion`):
 *
 * **Modern (git >= 2.38):** `merge-tree --write-tree --name-only`
 *   - Exit 0 = clean, exit 1 = conflicts
 *   - `conflictedFiles` contains the list of conflicted paths
 *   - `infoByFile` maps file paths to their informational messages
 *     (e.g. "CONFLICT (content): Merge conflict in file.txt")
 *   - Detects ALL conflict types (delete/modify, binary, rename/delete,
 *     submodule, file-mode) — not just textual `<<<<<<<` conflicts
 *   - Computes merge-base internally; `mergeBase` param is ignored
 *
 * **Legacy (git < 2.38):** three-argument `merge-tree <base> <A> <B>`
 *   - Always exits 0 regardless of conflicts
 *   - Callers must parse `output` for `<<<<<<<` markers
 *   - `conflictedFiles` is empty; `mergeBase` param is required
 */
export async function simulateMerge(
  repo: string,
  mergeBase: string,
  refA: string,
  refB: string,
): Promise<MergeSimResult> {
  try {
    if (supportsWriteTree()) {
      // --name-only gives us file names; we omit --no-messages so that
      // informational lines (CONFLICT, Auto-merging) are included after
      // the file list. These messages let the UI show conflict details
      // without needing a second merge-tree invocation.
      const r = await gitExec(repo, [
        'merge-tree', '--write-tree', '--name-only',
        refA, refB,
      ]);
      // Exit 0 = clean, exit 1 = conflicts. Anything else is an error
      // (e.g. unrelated histories, missing ref) — treat as no-conflict
      // and let the caller degrade gracefully.
      //
      // Output format (with --name-only, without --no-messages):
      //   <tree-sha>\n
      //   <conflicted-file-1>\n     ← only when exit 1
      //   <conflicted-file-2>\n
      //   \n                        ← blank line separator
      //   Auto-merging file.txt\n   ← informational messages
      //   CONFLICT (content): Merge conflict in file.txt\n
      const raw = r.stdout;
      const sectionSplit = raw.indexOf('\n\n');
      const fileSection = sectionSplit !== -1 ? raw.slice(0, sectionSplit) : raw;
      const messageSection = sectionSplit !== -1 ? raw.slice(sectionSplit + 2) : '';

      const fileLines = fileSection.split('\n');
      // First line is always the tree SHA; remaining lines are conflicted
      // file paths (only present when exit code is 1).
      const conflictedFiles = fileLines.slice(1).map((l) => l.trim()).filter(Boolean);

      const infoByFile = parseConflictMessages(messageSection);

      return { hasConflicts: r.code === 1, output: '', conflictedFiles, infoByFile };
    }
    // Legacy path: three-argument form always exits 0, so hasConflicts is
    // always false here. Callers must parse `output` for `<<<<<<<` markers.
    const r = await gitExec(repo, ['merge-tree', mergeBase, refA, refB]);
    return { hasConflicts: false, output: r.stdout, conflictedFiles: [], infoByFile: new Map() };
  } catch {
    return { hasConflicts: false, output: '', conflictedFiles: [], infoByFile: new Map() };
  }
}
