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
