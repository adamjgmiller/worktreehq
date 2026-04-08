import { useRepoStore } from '../store/useRepoStore';
import {
  listWorktrees,
  listBranches,
  listMainCommits,
  listTags,
  getDefaultBranch,
  getRemoteUrl,
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
