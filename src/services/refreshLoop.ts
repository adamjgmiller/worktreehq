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
import { detectCrossWorktreeConflicts, type ConflictDetectResult } from './conflictDetector';
import { classifyFetchError, formatClassifiedError } from './fetchErrorClassifier';
import { worktreeHasActivity } from '../lib/branchDisposition';
import {
  reconcileWorktrees,
  reconcileBranches,
  reconcileClaudePresence,
  reconcileConflictSummary,
} from '../lib/structuralShare';
import type { Branch, MergeStatus, RepoState } from '../types';

// Statuses whose detection depends on subprocesses or external data that
// can transiently fail. A single cache miss, failed re-fetch, or subprocess
// error would bounce these back to unmerged, so the ratchet preserves them
// when the branch SHA hasn't moved.
const RATCHETED_STATUSES: ReadonlySet<MergeStatus> = new Set([
  'squash-merged',
  'merged-normally',
  'direct-merged',
]);

// Apply a one-way ratchet: if the previous tick resolved a branch to a
// non-trivial status and its SHA hasn't changed, keep the previous status
// rather than trusting a potentially degraded fresh detection.
//
// Three layers of protection:
//
// 1. Detection-dependent statuses (squash-merged, merged-normally,
//    direct-merged): always ratcheted. These depend on the GitHub API,
//    git merge-base, or git reflog subprocesses, and a single failed
//    probe would otherwise bounce them back to unmerged.
//
// 2. `empty` status: always ratcheted against regression to unmerged.
//    `empty` depends on a successful `git rev-list` subprocess (the result
//    must have a parseable `abMatch`); when the subprocess transiently
//    fails, `abMatch` is null and the status falls through to `unmerged`
//    even though `aheadOfMain` defaults to 0. The dirty-worktree demotion
//    (empty→unmerged for branches with uncommitted work) is applied in a
//    separate post-ratchet step so the ratchet can protect empty
//    unconditionally.
//
// 3. `stale`: NOT ratcheted. Stale is derived from `unmerged` + age, and
//    the age check is pure arithmetic on the commit date — no subprocess
//    can fail. Transitions like `stale→empty` (main fast-forwards past
//    the branch) are legitimate and should not be blocked.
function ratchetBranchStatuses(prev: Branch[], next: Branch[]): Branch[] {
  if (prev.length === 0) return next;
  const prevByName = new Map(prev.map((b) => [b.name, b]));
  let changed = false;
  const out = next.map((b) => {
    const old = prevByName.get(b.name);
    if (!old) return b;
    // SHA moved — the branch has new commits; trust the fresh detection.
    if (old.lastCommitSha !== b.lastCommitSha) return b;
    // API-dependent statuses: always ratchet against regression.
    if (RATCHETED_STATUSES.has(old.mergeStatus) && !RATCHETED_STATUSES.has(b.mergeStatus)) {
      changed = true;
      return { ...b, mergeStatus: old.mergeStatus };
    }
    // Empty: always ratchet against regression to unmerged. The
    // activity-based demotion runs after ratcheting (post-ratchet step in
    // runRefreshOnce) so it can override when warranted.
    if (old.mergeStatus === 'empty' && b.mergeStatus === 'unmerged') {
      changed = true;
      return { ...b, mergeStatus: 'empty' as const };
    }
    return b;
  });
  return changed ? out : next;
}

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
// Same as pendingUserRefresh but for background callers (e.g. the fetch
// loop's chained refresh). At startup, fetchAllPrune often completes while
// the first refreshOnce is still in flight — the chained refreshOnce was
// silently deduped into the stale first run, so squash-merged branches
// showed as "unmerged" until the next 15s poll tick. This flag ensures a
// follow-up run so the fresh remote refs are actually picked up.
let pendingBackgroundRefresh = false;

// Spinner ownership is a refcount rather than a boolean. Two rapid user
// clicks inside one fetch window both want to own the `userRefreshing`
// flag; with a naive setUserRefreshing(true)/(false) pair per caller, the
// first caller's `finally` would flip the flag OFF while the second caller
// is still running — flickering the grid's grey-out overlay mid-click. Any
// path that claims the spinner calls `holdSpinner()` and every path that
// releases calls `releaseSpinner()` in its finally; the store flag only
// actually flips when the refcount transitions between 0 and >0. This
// also makes the previous `_spinnerManagedByCaller` option unnecessary —
// `refreshOnce` inside `runFetchOnce` can hold its own claim harmlessly
// because the claims stack.
let spinnerHolders = 0;
function holdSpinner(): void {
  if (spinnerHolders++ === 0) {
    useRepoStore.getState().setUserRefreshing(true);
  }
}
function releaseSpinner(): void {
  if (spinnerHolders === 0) return; // guard against extra releases in misuse
  if (--spinnerHolders === 0) {
    useRepoStore.getState().setUserRefreshing(false);
  }
}

export interface RefreshOptions {
  // When true, flips the store `userRefreshing` flag so the RepoBar spinner
  // animates and the grid grey-out wrapper dims. Background ticks leave it
  // false — the spinner would otherwise animate on every 15s heartbeat.
  userInitiated?: boolean;
}

async function runRefreshOnce(): Promise<void> {
  const state = useRepoStore.getState();
  const { repo, setError, setLoading, commitRefreshResult } = state;
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
    //
    // Note: empty→unmerged demotion for worktrees with activity is applied
    // AFTER the ratchet (see the post-ratchet step below). Keeping it here
    // would force the ratchet to carve out worktree-attached branches,
    // which breaks ratchet protection when a rev-list subprocess
    // transiently fails on a worktree-attached branch.
    const wtByBranch = new Map(wts.map((w) => [w.branch, w.path]));
    let enrichedBranches = branches.map((b) => {
      const wp = wtByBranch.get(b.name);
      if (!wp) return b;
      return { ...b, worktreePath: wp };
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

    // Ratchet: prevent transient detection failures (API blip, subprocess
    // error, cache miss) from bouncing resolved branches back to unmerged.
    // Read the previous store snapshot here rather than relying on the one
    // captured later for structural sharing — the ratchet must run before
    // the conflict-detection filter, or a branch that was squash-merged on
    // the last tick but transiently unmerged on this tick would wrongly
    // enter the conflict-candidate set.
    const prevBranches = useRepoStore.getState().branches;
    const ratcheted = ratchetBranchStatuses(
      prevBranches,
      detect.updatedBranches,
    );

    // Post-ratchet: demote empty→unmerged for branches whose worktree has
    // activity (uncommitted edits, conflicts, or an in-progress op like
    // rebase/bisect). This runs AFTER the ratchet so the ratchet can
    // unconditionally protect `empty` against transient subprocess failures,
    // and this step only overrides when there is actual work. A clean
    // worktree keeps `empty` — the branch genuinely has no work yet.
    const activeWtBranches = new Set<string>();
    for (const w of wts) {
      if (worktreeHasActivity(w)) {
        activeWtBranches.add(w.branch);
      }
    }
    const postRatchet = activeWtBranches.size > 0
      ? ratcheted.map((b) =>
          b.mergeStatus === 'empty' && activeWtBranches.has(b.name)
            ? { ...b, mergeStatus: 'unmerged' as const }
            : b,
        )
      : ratcheted;

    // Diagnostic: log merge-status changes between ticks so bouncing is
    // visible in the dev console. Only fires when something actually changed.
    if (import.meta.env.DEV && prevBranches.length > 0) {
      const prevByName = new Map(prevBranches.map((b) => [b.name, b]));
      const diffs: string[] = [];
      for (const b of postRatchet) {
        const old = prevByName.get(b.name);
        if (old && old.mergeStatus !== b.mergeStatus) {
          diffs.push(`  ${b.name}: ${old.mergeStatus} → ${b.mergeStatus}`);
        }
      }
      if (diffs.length > 0) {
        console.log(`[refreshLoop] merge-status changes:\n${diffs.join('\n')}`);
      }
    }

    // Exclude worktrees whose branch is already merged (squash-merged,
    // merged-normally, or direct-merged) from conflict detection — conflicts
    // between them are not actionable because the changes are already on main.
    const mergedBranches = new Set(
      postRatchet
        .filter((b) => b.mergeStatus === 'merged-normally' || b.mergeStatus === 'squash-merged' || b.mergeStatus === 'direct-merged')
        .map((b) => b.name),
    );
    const conflictCandidateWts = wts.filter((w) => !mergedBranches.has(w.branch));

    // Claude Code awareness + cross-worktree conflict detection both depend
    // only on `wts` and are independent of each other — run in parallel.
    // Each has its own error handling so a failure in one doesn't block the
    // other: fetchClaudePresence has an internal try/catch that degrades to
    // an empty map; conflict detection uses .catch() here to degrade to an
    // empty result.
    const [presence, conflictResult] = await Promise.all([
      fetchClaudePresence(wts),
      detectCrossWorktreeConflicts({
        repoPath: repo.path,
        defaultBranch: repo.defaultBranch,
        worktrees: conflictCandidateWts,
      }).catch((e) => {
        console.warn('[refreshLoop] conflict detection failed:', e);
        return { pairs: [], summaryByPath: new Map() } as ConflictDetectResult;
      }),
    ]);

    // Structural-share against the previous store state BEFORE committing.
    // Any element whose content didn't change is reused by reference, so
    // downstream React.memo on WorktreeCard can skip re-render for cards
    // whose own data didn't move. Read the pre-commit snapshot fresh rather
    // than reusing the `state` captured at the top of runRefreshOnce —
    // another tick may have committed in between if the pipeline was long.
    const before = useRepoStore.getState();
    const reconciledWts = reconcileWorktrees(before.worktrees, wts);
    const reconciledBranches = reconcileBranches(
      before.branches,
      postRatchet,
    );
    const reconciledPresence = reconcileClaudePresence(
      before.claudePresence,
      presence,
    );
    const reconciledConflictSummary = reconcileConflictSummary(
      before.conflictSummaryByPath,
      conflictResult.summaryByPath,
    );

    // The pipeline started against `repo` captured at the top of this run,
    // but many awaits (subprocess IPC, GitHub network calls, squash
    // detection) sit between that capture and here — collectively 1-5s
    // on a busy repo. If the user switched repos during any of those
    // awaits, committing now would clobber the NEW repo's data with this
    // OLD repo's pipeline results and set `dataRepoPath` to the old path —
    // re-opening the exact stale-flash window that PR #22 closed (1-5s of
    // previous repo's data after a switch). Bail silently instead; the
    // new repo's own refresh is already managing its loading state, so
    // don't touch `loading` here.
    //
    // CONTRACT: every caller that sets the store's `repo` MUST queue a
    // follow-up refreshOnce() synchronously. The new repo's refresh is
    // what drives `loading` back to false when it commits. If you're
    // adding a new setRepo() call site, prefer `setRepoAndRefresh()`
    // below — it couples the two steps so the invariant can't be
    // forgotten. The only exception is the bootstrap path in
    // `useRepoBootstrap`, which deliberately awaits `runFetchOnce()`
    // before starting the refresh loop (to avoid a stale-refs flash on
    // first paint); bootstrap uses raw `setRepo()` with a commented
    // justification.
    if (useRepoStore.getState().repo?.path !== repo.path) return;

    // Atomic commit — a single setState triggers exactly one render pass.
    // dataRepoPath is set ONLY on success (never in a finally) so a failed
    // first refresh leaves the gate closed and we keep showing the shimmer
    // + error banner instead of lying about the repo's contents.
    commitRefreshResult({
      worktrees: reconciledWts,
      branches: reconciledBranches,
      mainCommits,
      mainCommitsTotal,
      squashMappings: detect.mappings,
      claudePresence: reconciledPresence,
      crossWorktreeConflicts: conflictResult.pairs,
      conflictSummaryByPath: reconciledConflictSummary,
      dataRepoPath: repo.path,
    });
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
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
    holdSpinner();
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
        releaseSpinner();
      });
      return wait;
    }
    // Background callers (e.g. fetch loop's chained refresh) also need a
    // follow-up — the in-flight run may be operating on stale pre-fetch
    // state. Without this, the chained refresh after fetchAllPrune was
    // silently merged into the stale first run at startup.
    pendingBackgroundRefresh = true;
    return existing;
  }
  const launch = (): Promise<void> => {
    refreshInFlight = runRefreshOnce().finally(() => {
      refreshInFlight = null;
      // If another caller joined while we were running, drain the queue
      // with a single follow-up run. We clear both flags BEFORE launching
      // so any caller that lands during the follow-up gets its own slot.
      // Hold the spinner claim across the re-launch so the claim we
      // acquired at the top of this refreshOnce() call stays live through
      // the entire drain chain — the final launch in the chain (the one
      // that finds no pending work) is the only one that releases.
      if (pendingUserRefresh || pendingBackgroundRefresh) {
        pendingUserRefresh = false;
        pendingBackgroundRefresh = false;
        launch();
      } else if (userInitiated) {
        releaseSpinner();
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
      // Hold the spinner for the whole click via the module-level refcount.
      // The optimistic and post-fetch refreshOnce calls each hold+release
      // their own claim; the refcount keeps userRefreshing pinned until
      // the LAST claim drops — exactly what prevents the two-clicks-in-
      // one-fetch-window flicker from #73.
      holdSpinner();
      try {
        void refreshOnce({ userInitiated: true });
        await fetchInFlightPromise.catch(() => {});
        await refreshOnce(opts);
      } finally {
        releaseSpinner();
      }
    }
    return;
  }
  const { repo, setFetching, setLastFetchError, setError } = useRepoStore.getState();
  if (!repo) return;
  fetchInFlight = true;
  setFetching(true);
  // Hold the spinner via the refcount for the full click. holdSpinner
  // flips userRefreshing ON if nothing else is holding it; any inner
  // refreshOnce calls add their own holds and their own releases, so the
  // spinner stays pinned through the whole fetch → optimistic refresh →
  // post-fetch refresh chain, and drops exactly once when the last holder
  // releases in the finally below.
  if (userInitiated) {
    holdSpinner();
  }
  // Optimistic refresh. User-initiated clicks fire an immediate refreshOnce
  // against LOCAL state (no waiting for the network fetch) so cards update
  // within ~half a second instead of after the 1-2 seconds the remote takes
  // to respond. The real fetch runs in parallel below; once it completes,
  // `await refreshOnce(opts)` re-derives a second time with the fresh remote
  // refs. Dedupe semantics in refreshOnce handle the sequencing: if the
  // optimistic is still in flight when the post-fetch call fires, the
  // post-fetch call queues as pendingUserRefresh and runs automatically
  // after the optimistic completes. If the optimistic has already finished,
  // the post-fetch call starts a fresh pipeline.
  //
  // Fire-and-forget (`void`) because awaiting it would serialize with the
  // fetch and cost us the parallelism that makes this feel instant. The
  // `fetching` flag (set here) + the spinner refcount (held above) keep
  // the RepoBar spinner + grid grey-out pinned through both phases.
  if (userInitiated) {
    void refreshOnce({ userInitiated: true });
  }
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
      const rawMsg = e instanceof Error ? e.message : String(e);
      // Classify the stderr so recognizable failures (missing SSH key,
      // expired HTTPS creds, DNS down) get an actionable hint prepended
      // to the raw git message. Unknown errors pass through unchanged.
      const msg = formatClassifiedError(classifyFetchError(rawMsg));
      if (userInitiated) {
        setError(`Fetch failed: ${msg}`);
      } else {
        console.warn('[refreshLoop] background fetch failed:', msg);
      }
      // Surface background failures via the subtle RepoBar indicator so
      // silent auth/network issues (e.g. expired SSH key after a reboot)
      // don't go completely unnoticed. User-initiated failures already
      // get the full ErrorBanner via setError above — don't also set
      // lastFetchError or the user sees two independently-dismissible
      // error surfaces for the same failure.
      if (!userInitiated) {
        setLastFetchError(msg);
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
    // Fetch succeeded — clear any prior background failure indicator.
    setLastFetchError(null);
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
      if (refsChanged) {
        invalidateOpenPrListCache(repo.owner, repo.name);
        // Refs moved — remote PR state could legitimately be stale (e.g. a
        // freshly-merged PR). Drop the per-PR detail cache for user-initiated
        // fetches so squashDetector pass 1 doesn't serve `state: 'open'` for
        // a PR that just merged.
        if (userInitiated) invalidatePrCacheForRepo(repo.owner, repo.name);
      } else if (userInitiated) {
        // Refs didn't move, but PR metadata (closed-without-merge, draft
        // toggle, checks, reviews) can change independently of ref moves.
        // Refresh the open-PR list so those surface on the click; preserve
        // the per-PR detail cache so the post-fetch pass serves the
        // optimistic's ~2s-old entries instead of making a duplicate
        // GraphQL round-trip. The per-PR cache's 5-min TTL makes the
        // preservation safe — actually-stale entries expire naturally.
        invalidateOpenPrListCache(repo.owner, repo.name);
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
      const rawMsg = e instanceof Error ? e.message : String(e);
      const msg = formatClassifiedError(classifyFetchError(rawMsg));
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
    // Release the spinner claim in the same finally as setFetching so
    // the grid's grey-out and the RepoBar spinner stop together. The
    // refcount ensures that if another caller (e.g. a second rapid
    // click that joined this fetch) still holds a claim, the flag stays
    // pinned until they release too.
    if (userInitiated) {
      releaseSpinner();
    }
  }
  })();
  fetchInFlightPromise = body;
  await body;
}

// `skipFirstTick` suppresses the immediate fetch on startup so callers that
// already ran an initial `runFetchOnce()` themselves (e.g. the bootstrap,
// which awaits one before the loops start to avoid a stale-refs flash) don't
// trigger a redundant back-to-back `fetchAllPrune` subprocess. When skipped,
// the first tick is scheduled after the normal interval instead.
export function startFetchLoop(opts?: { skipFirstTick?: boolean }): void {
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
  if (opts?.skipFirstTick) {
    const { fetchIntervalMs } = useRepoStore.getState();
    const delay = fetchIntervalMs > 0 ? fetchIntervalMs : 60_000;
    fetchTimer = setTimeout(tick, delay);
  } else {
    tick();
  }
}

export function stopFetchLoop(): void {
  fetchRunning = false;
  if (fetchTimer) clearTimeout(fetchTimer);
  fetchTimer = null;
}

// Store a new repo AND queue the follow-up refresh atomically. Prefer this
// over calling `useRepoStore.getState().setRepo()` directly — `runRefreshOnce`
// has a repo-switch early return that leaks `loading: true` on purpose,
// relying on the new repo's refresh to drive loading back to false. If a
// caller sets `repo` without queuing a refresh, the shimmer pins forever.
// See the CONTRACT comment above the early return in runRefreshOnce.
export function setRepoAndRefresh(
  repo: RepoState,
  opts?: RefreshOptions,
): void {
  useRepoStore.getState().setRepo(repo);
  void refreshOnce(opts ?? { userInitiated: true });
}

// Test-only: reset all module-level state between tests. Without this, a
// failing test that leaves an unresolved refreshInFlight or a stuck
// pendingUserRefresh poisons every test that follows in the same file.
export function _resetRefreshLoopForTests(): void {
  refreshInFlight = null;
  pendingUserRefresh = false;
  pendingBackgroundRefresh = false;
  fetchInFlight = false;
  fetchInFlightPromise = null;
  spinnerHolders = 0;
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  fetchRunning = false;
  if (fetchTimer) clearTimeout(fetchTimer);
  fetchTimer = null;
}
