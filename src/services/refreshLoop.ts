import { useRepoStore } from '../store/useRepoStore';
import {
  listWorktrees,
  listBranches,
  listMainCommits,
  listTags,
  fetchAllPrune,
  snapshotRemoteRefs,
} from './gitService';
import { detectSquashMerges } from './squashDetector';
import {
  batchFetchPRs,
  invalidateOpenPrListCache,
  listOpenPRsForBranches,
} from './githubService';
import { fetchClaudePresence } from './claudeAwarenessService';

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

let fetchRunning = false;
let fetchTimer: ReturnType<typeof setTimeout> | null = null;
// Prevents overlapping fetches — if a fetch is still in flight when the tick fires,
// we just skip this round rather than queue up work.
let fetchInFlight = false;

// Single in-flight refresh promise. Callers that land during an active refresh
// await the same work rather than kicking off a second one. Without this the
// fetch ticker (~60s) and poll ticker (~5s) race each other, both hitting every
// store setter and producing UI flicker. Also covers the re-entrancy case where
// refreshOnce is called from both the poll tick and user-triggered paths
// (RepoBar onClick, BranchesView post-delete).
let refreshInFlight: Promise<void> | null = null;

export interface RefreshOptions {
  // When true, flips the store `userRefreshing` flag so the RepoBar spinner
  // animates. Background ticks leave it false so the spinner doesn't spin
  // on every heartbeat — the user only sees it when they asked for a refresh.
  userInitiated?: boolean;
}

async function runRefreshOnce(): Promise<void> {
  const {
    repo,
    setWorktrees,
    setBranches,
    setMainCommits,
    setSquashMappings,
    setClaudePresence,
    setError,
    markRefreshed,
    setLoading,
  } = useRepoStore.getState();
  if (!repo) return;
  setLoading(true);
  setError(null);
  try {
    // Remote owner/name is resolved once at bootstrap and stashed on
    // `repo`; no per-tick subprocess for it. countMainCommits is folded
    // into listMainCommits (returns `{ commits, total }`). listTags is
    // now short-TTL cached inside gitService.
    const [wts, branches, mainCommitsResult, tags] = await Promise.all([
      listWorktrees(repo.path),
      listBranches(repo.path, repo.defaultBranch),
      listMainCommits(repo.path, repo.defaultBranch),
      listTags(repo.path),
    ]);
    const { commits: mainCommits, total: mainCommitsTotal } = mainCommitsResult;
    const remote = { owner: repo.owner, name: repo.name };

    // Attach worktree paths to branches
    const wtByBranch = new Map(wts.map((w) => [w.branch, w.path]));
    for (const b of branches) {
      const wp = wtByBranch.get(b.name);
      if (wp) b.worktreePath = wp;
    }

    // Attach open PRs to branches. The REST list only populates isDraft; we
    // follow up with a GraphQL batch to fill in checksStatus / reviewDecision /
    // mergeable so the BranchRow indicators work for open PRs too.
    const openPRs = await listOpenPRsForBranches(
      remote.owner ?? '',
      remote.name ?? '',
      branches.map((b) => b.name),
    );
    if (remote.owner && remote.name && openPRs.size > 0) {
      const numbers = Array.from(openPRs.values()).map((pr) => pr.number);
      const enriched = await batchFetchPRs(remote.owner, remote.name, numbers);
      for (const [branchName, rest] of openPRs) {
        const full = enriched.get(rest.number);
        if (full) {
          // GraphQL `state` is "open" here by design (we only queried numbers from
          // the open list), but keep the REST-side state to be safe.
          openPRs.set(branchName, { ...full, state: rest.state });
        }
      }
    }
    for (const b of branches) {
      const pr = openPRs.get(b.name);
      if (pr) b.pr = pr;
    }

    const detect = await detectSquashMerges({
      repoPath: repo.path,
      defaultBranch: repo.defaultBranch,
      mainCommits,
      branches,
      tags,
      owner: remote.owner,
      name: remote.name,
    });

    // Claude Code awareness: fetch after we have worktrees so we can join
    // by path. Runs against the same refresh tick so UI stays in sync.
    // Failures degrade to an empty map via fetchClaudePresence's try/catch.
    const presence = await fetchClaudePresence(wts);

    setWorktrees(wts);
    setBranches(detect.updatedBranches);
    setMainCommits(mainCommits, mainCommitsTotal);
    setSquashMappings(detect.mappings);
    setClaudePresence(presence);
    markRefreshed();
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  } finally {
    setLoading(false);
  }
}

// Public entry point. If a refresh is already running, await its completion
// instead of launching a parallel one. Callers that want the RepoBar spinner
// to animate (button clicks, post-mutation refreshes) pass
// `{ userInitiated: true }`; the automatic poll tick + watcher events do not.
//
// Note: if a user-initiated refresh lands on top of an in-flight background
// refresh, we still flip the userRefreshing flag for the duration so the
// click has a visible effect.
export function refreshOnce(opts?: RefreshOptions): Promise<void> {
  const userInitiated = opts?.userInitiated === true;
  if (userInitiated) {
    useRepoStore.getState().setUserRefreshing(true);
  }
  const existing = refreshInFlight;
  if (existing) {
    if (userInitiated) {
      void existing.finally(() => {
        useRepoStore.getState().setUserRefreshing(false);
      });
    }
    return existing;
  }
  refreshInFlight = runRefreshOnce().finally(() => {
    refreshInFlight = null;
    if (userInitiated) {
      useRepoStore.getState().setUserRefreshing(false);
    }
  });
  return refreshInFlight;
}

export function startRefreshLoop(): void {
  if (running) return;
  running = true;
  const tick = async () => {
    if (!running) return;
    await refreshOnce();
    const { refreshIntervalMs } = useRepoStore.getState();
    timer = setTimeout(tick, refreshIntervalMs);
  };
  tick();
}

export function stopRefreshLoop(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

// Run a single fetch + refresh now, flipping the store's `fetching` flag so the
// RepoBar can show an indicator. Safe to call while a fetch is already in flight —
// subsequent concurrent calls are dropped.
//
// We snapshot `for-each-ref refs/remotes` before and after the fetch and
// only chain a full refresh if the remote ref set actually changed. On a
// quiet repo this turns the 60s fetch tick from "git fetch + ~250 git
// subprocesses + GraphQL batch + Claude scan" into just "git fetch + 2
// for-each-refs". When refs *did* change we also invalidate the open-PR
// list cache so the chained refresh sees newly-pushed branches.
export async function runFetchOnce(): Promise<void> {
  if (fetchInFlight) return;
  const { repo, setFetching, markRefreshed } = useRepoStore.getState();
  if (!repo) return;
  fetchInFlight = true;
  setFetching(true);
  try {
    const before = await snapshotRemoteRefs(repo.path);
    await fetchAllPrune(repo.path);
    const after = await snapshotRemoteRefs(repo.path);
    if (before && after && before === after) {
      // No remote refs moved — nothing the rest of the pipeline could
      // surface that the prior tick didn't already. Just bump lastRefresh
      // so the "updated X ago" indicator stays current.
      markRefreshed();
      return;
    }
    if (repo.owner && repo.name) {
      invalidateOpenPrListCache(repo.owner, repo.name);
    }
    // Fetch changed remote refs on disk; trigger a tick so the UI reflects it.
    await refreshOnce();
  } catch {
    /* best-effort: a failing fetch is logged via refreshOnce's own error path */
  } finally {
    setFetching(false);
    fetchInFlight = false;
  }
}

export function startFetchLoop(): void {
  if (fetchRunning) return;
  fetchRunning = true;
  const tick = async () => {
    if (!fetchRunning) return;
    const { fetchIntervalMs } = useRepoStore.getState();
    if (fetchIntervalMs > 0) {
      await runFetchOnce();
    }
    // Re-read after awaiting in case the user toggled the interval mid-flight.
    // When disabled we still poll once a minute so flipping it back on without
    // restarting the app just works.
    const { fetchIntervalMs: next } = useRepoStore.getState();
    const delay = next > 0 ? next : 60_000;
    fetchTimer = setTimeout(tick, delay);
  };
  tick();
}

export function stopFetchLoop(): void {
  fetchRunning = false;
  if (fetchTimer) clearTimeout(fetchTimer);
  fetchTimer = null;
}
