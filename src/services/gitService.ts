import { gitExec } from './tauriBridge';
import type { Worktree, Branch, MainCommit, WorktreeStatus } from '../types';

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

export async function listWorktrees(repo: string): Promise<Worktree[]> {
  const raw = await run(repo, ['worktree', 'list', '--porcelain']);
  const entries = parseWorktreeList(raw);
  const out: Worktree[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const isPrimary = i === 0;
    const status = await tryRun(e.path, ['status', '--porcelain=v1']);
    let uncommitted = 0;
    let staged = 0;
    let conflicts = 0;
    for (const line of status.split('\n').filter(Boolean)) {
      const x = line[0];
      const y = line[1];
      if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) conflicts++;
      if (x !== ' ' && x !== '?') staged++;
      if (y !== ' ' || x === '?') uncommitted++;
    }
    let ahead = 0;
    let behind = 0;
    const ab = (await tryRun(e.path, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])).trim();
    const abm = ab.match(/^(\d+)\s+(\d+)$/);
    if (abm) {
      behind = parseInt(abm[1], 10);
      ahead = parseInt(abm[2], 10);
    }
    const logLine = (
      await tryRun(e.path, ['log', '-1', '--format=%H%x09%s%x09%cI%x09%an'])
    ).trim();
    const [sha, message, date, author] = logLine.split('\t');
    let wtStatus: WorktreeStatus = 'clean';
    if (conflicts > 0) wtStatus = 'conflict';
    else if (ahead > 0 && behind > 0) wtStatus = 'diverged';
    else if (uncommitted > 0 || staged > 0) wtStatus = 'dirty';
    out.push({
      path: e.path,
      branch: e.branch || '(detached)',
      isPrimary,
      head: e.head,
      uncommittedCount: uncommitted,
      stagedCount: staged,
      ahead,
      behind,
      hasConflicts: conflicts > 0,
      lastCommit: {
        sha: sha || e.head,
        message: message || '',
        date: date || '',
        author: author || '',
      },
      status: wtStatus,
    });
  }
  return out;
}

export async function listBranches(repo: string, defaultBranch: string): Promise<Branch[]> {
  const localRaw = await tryRun(repo, [
    'for-each-ref',
    '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso8601)%09%(upstream:track)',
    'refs/heads',
  ]);
  const remoteRaw = await tryRun(repo, [
    'for-each-ref',
    '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso8601)',
    'refs/remotes',
  ]);
  const branches = new Map<string, Branch>();
  for (const line of localRaw.split('\n').filter(Boolean)) {
    const [name, sha, date, track] = line.split('\t');
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
    });
  }
  for (const line of remoteRaw.split('\n').filter(Boolean)) {
    const [refShort, sha, date] = line.split('\t');
    if (!refShort || refShort.endsWith('/HEAD')) continue;
    const name = refShort.replace(/^[^/]+\//, '');
    const existing = branches.get(name);
    if (existing) {
      existing.hasRemote = true;
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
      });
    }
  }
  // ahead/behind vs default
  for (const b of branches.values()) {
    const ref = b.hasLocal ? b.name : `origin/${b.name}`;
    const ab = (
      await tryRun(repo, ['rev-list', '--left-right', '--count', `${defaultBranch}...${ref}`])
    ).trim();
    const m = ab.match(/^(\d+)\s+(\d+)$/);
    if (m) {
      b.behindMain = parseInt(m[1], 10);
      b.aheadOfMain = parseInt(m[2], 10);
    }
    // merged-normally?
    const mergedCheck = await tryRun(repo, ['merge-base', '--is-ancestor', ref, defaultBranch]);
    // is-ancestor uses exit code; treat empty stdout as success only via tryRun we can't see code.
    // Instead, use merge-base check via branch --contains:
    const contains = (
      await tryRun(repo, ['branch', '--contains', ref, defaultBranch])
    ).trim();
    if (contains.length > 0) {
      b.mergeStatus = 'merged-normally';
    }
    void mergedCheck;
  }
  return Array.from(branches.values()).filter((b) => b.name !== defaultBranch);
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
