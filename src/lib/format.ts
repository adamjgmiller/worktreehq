import { formatDistanceToNowStrict } from 'date-fns';

export function relativeTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Under 3s of delta reads as "just now" rather than "0 seconds ago".
  // formatDistanceToNowStrict rounds down so anything <1s prints as
  // "0 seconds ago", which looks frozen in the first frame after a refresh
  // commits (lastRefresh is set to Date.now() at that instant). The
  // threshold is small on purpose — by 3s the exact count is meaningful
  // again. Guard on delta >= 0 so clock skew putting a timestamp slightly
  // in the future still falls through to formatDistanceToNowStrict, which
  // emits "in X seconds" via addSuffix.
  const deltaMs = Date.now() - d.getTime();
  if (deltaMs >= 0 && deltaMs < 3000) return 'just now';
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
