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

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export async function refreshOnce(): Promise<void> {
  const { repo, setWorktrees, setBranches, setMainCommits, setSquashMappings, setError, markRefreshed, setLoading } =
    useRepoStore.getState();
  if (!repo) return;
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

    setWorktrees(wts);
    setBranches(detect.updatedBranches);
    setMainCommits(mainCommits);
    setSquashMappings(detect.mappings);
    markRefreshed();
  } catch (e: any) {
    setError(e?.message ?? String(e));
  } finally {
    setLoading(false);
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
