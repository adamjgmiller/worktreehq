import { useRepoStore } from '../store/useRepoStore';
import {
  listWorktrees,
  listBranches,
  listMainCommits,
  listTags,
  getRemoteUrl,
  fetchAllPrune,
} from './gitService';
import { detectSquashMerges } from './squashDetector';
import { listOpenPRsForBranches } from './githubService';
import { fetchClaudePresence } from './claudeAwarenessService';

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
// Re-entrancy guard: refreshOnce is called from the poll tick AND from
// user-triggered paths (RepoBar onClick, BranchesView post-delete). Without
// this, concurrent invocations can race through the store setters at the
// bottom of the try block, letting a stale earlier-started refresh overwrite
// a newer one's results.
let inFlight = false;

let fetchRunning = false;
let fetchTimer: ReturnType<typeof setTimeout> | null = null;
// Prevents overlapping fetches — if a fetch is still in flight when the tick fires,
// we just skip this round rather than queue up work.
let fetchInFlight = false;

export async function refreshOnce(): Promise<void> {
  if (inFlight) return;
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
  inFlight = true;
  setLoading(true);
  setError(null);
  try {
    const [wts, branches, mainCommits, tags, remote] = await Promise.all([
      listWorktrees(repo.path),
      listBranches(repo.path, repo.defaultBranch),
      listMainCommits(repo.path, repo.defaultBranch),
      listTags(repo.path),
      getRemoteUrl(repo.path),
    ]);

    // Attach worktree paths to branches
    const wtByBranch = new Map(wts.map((w) => [w.branch, w.path]));
    for (const b of branches) {
      const wp = wtByBranch.get(b.name);
      if (wp) b.worktreePath = wp;
    }

    // Attach open PRs to branches
    const openPRs = await listOpenPRsForBranches(
      remote.owner ?? '',
      remote.name ?? '',
      branches.map((b) => b.name),
    );
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
    setMainCommits(mainCommits);
    setSquashMappings(detect.mappings);
    setClaudePresence(presence);
    markRefreshed();
  } catch (e: any) {
    setError(e?.message ?? String(e));
  } finally {
    setLoading(false);
    inFlight = false;
  }
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
export async function runFetchOnce(): Promise<void> {
  if (fetchInFlight) return;
  const { repo, setFetching } = useRepoStore.getState();
  if (!repo) return;
  fetchInFlight = true;
  setFetching(true);
  try {
    await fetchAllPrune(repo.path);
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
