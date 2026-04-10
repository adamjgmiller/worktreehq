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
  invalidatePrCacheForRepo,
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
// Promise mirror of `fetchInFlight` so user-initiated callers that land on a
// background fetch can join it and then chain their own follow-up refresh.
let fetchInFlightPromise: Promise<void> | null = null;

// Single in-flight refresh promise. Callers that land during an active refresh
// await the same work rather than kicking off a second one. Without this the
// fetch ticker (~60s) and poll ticker (~15s) race each other, both hitting every
// store setter and producing UI flicker. Also covers the re-entrancy case where
// refreshOnce is called from both the poll tick and user-triggered paths
// (RepoBar onClick, BranchesView post-delete).
let refreshInFlight: Promise<void> | null = null;
// True when a user-initiated refresh joined an in-flight refresh. The
// in-flight one was started against pre-mutation state (or, during a repo
// switch, against the OLD repo), so a user click after a delete or after
// loadRepoAtPath needs a follow-up run to actually reflect the new state.
// Set inside refreshOnce when dedupe collapses a userInitiated call onto an
// existing in-flight, drained at the end of runRefreshOnce by re-entering
// runRefreshOnce so the user sees fresh data on the same click.
let pendingUserRefresh = false;

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
    setDataRepoPath,
  } = useRepoStore.getState();
  if (!repo) return;
  setLoading(true);
  // Note: do NOT setError(null) here. User-initiated mutations
  // (createWorktree, removeWorktree, prune, etc.) report errors via the
  // store, and clearing on every poll tick made those errors flash and
  // disappear before the user could read them. Errors are now cleared only
  // on a successful refresh (below) or by explicit user dismissal in the
  // banner.
  try {
    // Remote owner/name is resolved once at bootstrap and stashed on
    // `repo`; no per-tick subprocess for it. countMainCommits is folded
    // into listMainCommits (returns `{ commits, total }`). listTags is
    // now short-TTL cached inside gitService.
    const [wts, branches, mainCommitsResult, tags] = await Promise.all([
      listWorktrees(repo.path, repo.defaultBranch),
      listBranches(repo.path, repo.defaultBranch),
      listMainCommits(repo.path, repo.defaultBranch),
      listTags(repo.path),
    ]);
    const { commits: mainCommits, total: mainCommitsTotal } = mainCommitsResult;
    const remote = { owner: repo.owner, name: repo.name };

    // Attach worktree paths to branches. Build new objects rather than
    // mutating the entries returned by listBranches so that any future
    // caching inside gitService can't accidentally leak attached fields
    // across repos or ticks.
    const wtByBranch = new Map(wts.map((w) => [w.branch, w.path]));
    let enrichedBranches = branches.map((b) => {
      const wp = wtByBranch.get(b.name);
      return wp ? { ...b, worktreePath: wp } : b;
    });

    // Attach open PRs to branches. The REST list only populates isDraft; we
    // follow up with a GraphQL batch to fill in checksStatus / reviewDecision /
    // mergeable so the BranchRow indicators work for open PRs too. Skip the
    // call entirely when there's no resolvable GitHub remote — otherwise we'd
    // round-trip a wasted 404 against /repos//pulls every refresh tick on
    // non-github remotes.
    const openPRs =
      remote.owner && remote.name
        ? await listOpenPRsForBranches(remote.owner, remote.name, enrichedBranches.map((b) => b.name))
        : new Map();
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
    enrichedBranches = enrichedBranches.map((b) => {
      const pr = openPRs.get(b.name);
      return pr ? { ...b, pr } : b;
    });

    const detect = await detectSquashMerges({
      repoPath: repo.path,
      defaultBranch: repo.defaultBranch,
      mainCommits,
      branches: enrichedBranches,
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
    // Mark the in-store collections as belonging to this repo path. App.tsx
    // gates the content region on `dataRepoPath === repo.path`, so this is
    // what lifts the shimmer skeleton on first load and after a repo switch.
    // Set ONLY on success (never in finally) — a failed first refresh leaves
    // the gate closed so we keep showing the skeleton + error banner instead
    // of falling back to the empty states, which would lie about the repo's
    // contents.
    setDataRepoPath(repo.path);
    markRefreshed();
    // Clear any prior pipeline error now that this tick succeeded. We don't
    // clear at the START of the tick because user-action errors (set by
    // WorktreesView etc.) need to survive across the next poll.
    setError(null);
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
// Dedupe semantics: when a user-initiated refresh joins an in-flight refresh,
// we DON'T silently merge — the in-flight one was started against pre-mutation
// state and would otherwise leave a freshly-deleted branch on screen for up to
// the next poll interval. Instead we set `pendingUserRefresh` so the in-flight
// run, on completion, kicks off a fresh runRefreshOnce against current state.
// The returned promise resolves only after that follow-up has finished.
export function refreshOnce(opts?: RefreshOptions): Promise<void> {
  const userInitiated = opts?.userInitiated === true;
  if (userInitiated) {
    useRepoStore.getState().setUserRefreshing(true);
  }
  const existing = refreshInFlight;
  if (existing) {
    if (userInitiated) {
      pendingUserRefresh = true;
      // Wait for the in-flight + the pending follow-up to drain before
      // releasing the spinner.
      const wait = existing.then(() => {
        // The in-flight run will have triggered the follow-up by now via
        // its finally hook below. Wait for whichever refresh is still in
        // flight (could be the follow-up).
        const next = refreshInFlight;
        return next ?? Promise.resolve();
      });
      void wait.finally(() => {
        useRepoStore.getState().setUserRefreshing(false);
      });
      return wait;
    }
    return existing;
  }
  const launch = (): Promise<void> => {
    refreshInFlight = runRefreshOnce().finally(() => {
      refreshInFlight = null;
      // If a user-initiated refresh joined while we were running, drain
      // the queue with a single follow-up run. We clear the flag BEFORE
      // launching so a second user click during the follow-up gets its
      // own queue slot.
      if (pendingUserRefresh) {
        pendingUserRefresh = false;
        launch();
      } else if (userInitiated) {
        useRepoStore.getState().setUserRefreshing(false);
      }
    });
    return refreshInFlight;
  };
  return launch();
}

export function startRefreshLoop(): void {
  if (running) return;
  running = true;
  const tick = async () => {
    if (!running) return;
    await refreshOnce();
    // Re-check after the await: stopRefreshLoop() may have fired while
    // refreshOnce was in flight. Without this guard we'd schedule a stray
    // timer past shutdown.
    if (!running) return;
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
// We snapshot `for-each-ref refs/remotes` before and after the fetch. For
// background ticks (no `userInitiated`), if the snapshot is unchanged we
// skip the chained refresh and the open-PR cache invalidation entirely —
// turning a quiet 60s tick from "fetch + ~250 git subprocesses + GraphQL
// batch + Claude scan" into "fetch + 2 for-each-refs". For user-initiated
// fetches we ALWAYS chain a refresh and invalidate the open-PR cache,
// because the user may be trying to surface PR-state changes (close,
// merge-without-merge, draft toggle) that don't move any remote ref. The
// userInitiated flag also propagates to refreshOnce so the spinner animates.
export async function runFetchOnce(opts?: RefreshOptions): Promise<void> {
  const userInitiated = opts?.userInitiated === true;
  if (fetchInFlight) {
    // A user click landing on a background fetch used to be silently
    // dropped — no spinner, no chained refresh. Instead, join the
    // in-flight fetch and then still run a user-initiated refresh so the
    // user's click produces the feedback (and post-fetch refresh) they
    // expect. Background calls during an in-flight fetch remain dropped.
    if (userInitiated && fetchInFlightPromise) {
      await fetchInFlightPromise.catch(() => {});
      await refreshOnce(opts);
    }
    return;
  }
  const { repo, setFetching, setError } = useRepoStore.getState();
  if (!repo) return;
  fetchInFlight = true;
  setFetching(true);
  let fetchFailed = false;
  const body = (async () => {
  try {
    const before = await snapshotRemoteRefs(repo.path);
    try {
      await fetchAllPrune(repo.path);
    } catch (e) {
      // Fetch failed (network, auth, hung subprocess timed out by git_exec,
      // etc.). Surface user-initiated failures via the store error banner —
      // previously the catch swallowed silently with a misleading "logged
      // via refreshOnce" comment, but refreshOnce was inside the try and
      // never reached on a failed fetch. Background tick failures stay
      // quiet (we don't want a spinner-quiet poll loop spamming errors)
      // but log to console so the failure is debuggable.
      fetchFailed = true;
      const msg = e instanceof Error ? e.message : String(e);
      if (userInitiated) {
        setError(`Fetch failed: ${msg}`);
      } else {
        console.warn('[refreshLoop] background fetch failed:', msg);
      }
      // Even on a failed fetch, fall through to refreshOnce so the UI
      // reflects whatever local state we already have. Without this a
      // user click would leave the shimmer in place if the very first
      // refresh of the session also coincided with a network failure.
      if (userInitiated) {
        await refreshOnce(opts);
      }
      return;
    }
    const after = await snapshotRemoteRefs(repo.path);
    const refsChanged = !(before && after && before === after);
    if (!refsChanged && !userInitiated) {
      // Background skip path — local state hasn't changed in any way the
      // pipeline would surface. Don't bump lastRefresh: the polling tick
      // is the source of truth for the "updated X ago" indicator, and
      // bumping it here would lie about a no-op fetch.
      return;
    }
    if (repo.owner && repo.name) {
      invalidateOpenPrListCache(repo.owner, repo.name);
      // For user-initiated fetches, ALSO drop the per-PR detail cache.
      // squashDetector pass 1 reads it via batchFetchPRs and would otherwise
      // serve a freshly-merged PR as `state: 'open'` for up to 5 minutes,
      // defeating the whole point of the user clicking refresh after a
      // merge. Background ticks skip this — they're fine letting the
      // 5-minute TTL roll naturally.
      if (userInitiated) {
        invalidatePrCacheForRepo(repo.owner, repo.name);
      }
    }
    // Fetch changed remote refs on disk (or this is a user-initiated fetch
    // and we want guaranteed visible feedback); trigger a refresh so the UI
    // reflects the new state.
    await refreshOnce(opts);
  } catch (e) {
    // Catches snapshotRemoteRefs failures and any unhandled error from the
    // refresh chain. fetchAllPrune failures are caught above; this path
    // covers everything else.
    if (!fetchFailed) {
      const msg = e instanceof Error ? e.message : String(e);
      if (userInitiated) {
        setError(`Fetch failed: ${msg}`);
      } else {
        console.warn('[refreshLoop] runFetchOnce error:', msg);
      }
    }
  } finally {
    setFetching(false);
    fetchInFlight = false;
    fetchInFlightPromise = null;
  }
  })();
  fetchInFlightPromise = body;
  await body;
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
    // Re-check after the await: stopFetchLoop() may have fired mid-fetch.
    if (!fetchRunning) return;
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

// Test-only: reset all module-level state between tests. Without this, a
// failing test that leaves an unresolved refreshInFlight or a stuck
// pendingUserRefresh poisons every test that follows in the same file.
export function _resetRefreshLoopForTests(): void {
  refreshInFlight = null;
  pendingUserRefresh = false;
  fetchInFlight = false;
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  fetchRunning = false;
  if (fetchTimer) clearTimeout(fetchTimer);
  fetchTimer = null;
}
