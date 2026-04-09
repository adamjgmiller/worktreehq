import { formatDistanceToNowStrict } from 'date-fns';

export function relativeTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatDistanceToNowStrict(d, { addSuffix: true });
}

export function shortSha(sha: string): string {
  return sha ? sha.slice(0, 7) : '';
}

export function aheadBehind(ahead: number, behind: number): string {
  if (ahead === 0 && behind === 0) return 'even';
  const parts = [];
  if (ahead > 0) parts.push(`↑${ahead}`);
  if (behind > 0) parts.push(`↓${behind}`);
  return parts.join(' ');
}

// Return the final path segment (directory name) of an absolute worktree
// path. Handles both POSIX and Windows separators because `wt.path` comes
// straight from `git worktree list --porcelain`, which emits native paths on
// whichever platform Tauri is running on. Strips trailing separators first
// so e.g. `/foo/bar/` still yields `bar`.
export function basename(path: string): string {
  if (!path) return '';
  const cleaned = path.replace(/[/\\]+$/, '');
  const lastSep = cleaned.search(/[/\\][^/\\]*$/);
  return lastSep === -1 ? cleaned : cleaned.slice(lastSep + 1);
}
