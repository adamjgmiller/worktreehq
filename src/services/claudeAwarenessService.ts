// Joins raw Claude Code on-disk state against the current worktree list to
// produce a per-worktree ClaudePresence map. Pure join logic — the filesystem
// read lives in the Rust `read_claude_state` command, fetched here via
// tauriBridge so unit tests can pass a stub instead of hitting the bridge.

import { readClaudeState } from './tauriBridge';
import type {
  ClaudePresence,
  ClaudePresenceStatus,
  ClaudeStateRaw,
  Worktree,
} from '../types';

// Liveness thresholds. `live` needs to be wider than the refresh interval
// or a session will flicker between live and recent between ticks; 60s
// gives us comfortable headroom over even the old 5s default and the new
// 15s default.
export const LIVE_WINDOW_MS = 60_000; // 1 min
export const RECENT_WINDOW_MS = 10 * 60_000; // 10 min

/**
 * Encode a filesystem path the way Claude Code encodes cwds into its
 * ~/.claude/projects/ directory names. The encoding replaces both `/` and `.`
 * with `-`, so `/foo/.bar` → `-foo--bar`. This is **lossy** (you can't decode
 * back), but it's deterministic in the forward direction so we can use it as
 * a fast lookup key. For ambiguous cases, the caller should prefer the
 * `worktree_path` field read from inside the JSONL, which is authoritative.
 */
export function encodeProjectDirName(path: string): string {
  return path.replace(/[/.]/g, '-');
}

/**
 * Build a Map<worktreePath, ClaudePresence> from raw claude state + worktree list.
 * Exported as a pure function so tests can exercise it without the bridge.
 */
export function joinClaudeState(
  raw: ClaudeStateRaw,
  worktrees: Worktree[],
  now: number = Date.now(),
): Map<string, ClaudePresence> {
  // Index project dirs two ways: by authoritative worktree_path (when the
  // JSONL contained one) and by encoded dir name as a fallback. Critically,
  // projects that DO have an authoritative path are excluded from the
  // dirname fallback — otherwise a second worktree whose encoded name
  // collides (e.g. `/a/b` and `/a.b` both encode to `-a-b`) would
  // incorrectly be credited with the first worktree's sessions.
  const byWorktreePath = new Map<string, ClaudeStateRaw['projects'][number]>();
  const byDirName = new Map<string, ClaudeStateRaw['projects'][number]>();
  for (const p of raw.projects) {
    if (p.worktree_path) {
      byWorktreePath.set(p.worktree_path, p);
    } else {
      byDirName.set(p.dir_name, p);
    }
  }

  // Index IDE lockfiles by each of their workspace_folders. A single lock can
  // reference multiple workspace folders, and Claude only runs one per IDE
  // window, so we take the first lock that matches.
  const lockByFolder = new Map<string, ClaudeStateRaw['ide_locks'][number]>();
  for (const lock of raw.ide_locks) {
    for (const folder of lock.workspace_folders) {
      if (!lockByFolder.has(folder)) lockByFolder.set(folder, lock);
    }
  }

  // Set membership of worktree paths that have a `claude` process running
  // with cwd == path. Used to promote `recent`/`dormant` → `idle` for
  // worktrees where the user just stepped away from the prompt instead of
  // closing the session. Falls back to empty set if Rust didn't populate
  // the field (older snapshots in tests, or platforms with no scanner).
  const liveCwds = new Set(raw.live_worktree_cwds ?? []);

  const out = new Map<string, ClaudePresence>();
  for (const wt of worktrees) {
    const project =
      byWorktreePath.get(wt.path) ?? byDirName.get(encodeProjectDirName(wt.path));

    if (!project || project.sessions.length === 0) {
      // A lockfile without a project dir is rare but can happen mid-startup
      // (IDE has the lock but no JSONL has been flushed yet). Count it as 1
      // live agent so the badge isn't blank in that window.
      // We deliberately do NOT promote to `idle` here even if a process is
      // running in this cwd: without a project dir we have no session to
      // attribute the process to, and fabricating one would mean the badge
      // appears with no resumable session id.
      const lock = lockByFolder.get(wt.path);
      out.set(wt.path, {
        status: lock ? 'live-ide' : 'none',
        ideName: lock?.ide_name,
        pid: lock?.pid,
        inactiveSessions: [],
        liveSessionCount: lock ? 1 : 0,
      });
      continue;
    }

    // Sessions come from Rust already sorted newest-first, but don't trust —
    // re-sort defensively so the UI contract is unconditional.
    const sessions = [...project.sessions].sort((a, b) => b.mtime_ms - a.mtime_ms);
    const newest = sessions[0];
    const age = now - newest.mtime_ms;

    const lock = lockByFolder.get(wt.path);
    const hasLiveProcess = liveCwds.has(wt.path);

    let status: ClaudePresenceStatus;
    if (lock) status = 'live-ide';
    else if (hasLiveProcess && age <= LIVE_WINDOW_MS) status = 'live';
    else if (hasLiveProcess) {
      // The JSONL is stale (≥60s) but a `claude` process is running with
      // cwd == this worktree. The user is almost certainly idle in front
      // of a still-open prompt rather than having closed the session.
      // Promote past `recent`/`dormant` directly to `idle` so the closed
      // sessions list doesn't lie about the most-recent session.
      status = 'idle';
    } else if (age <= RECENT_WINDOW_MS) status = 'recent';
    else status = 'dormant';

    // Count distinct live agents. The process scan is the authoritative
    // signal for whether Claude is actually running — JSONL mtime alone
    // can't distinguish "just closed" from "actively running". Without a
    // live process (or IDE lock), liveSessionCount is 0 regardless of
    // how fresh the JSONL is, so the multi-session warning clears
    // immediately when sessions close instead of lingering for 60s.
    //
    // When a process IS running, we count JSONL sessions within
    // LIVE_WINDOW_MS to approximate how many concurrent agents are active.
    // The IDE lock adds 1 when the newest JSONL is outside the live window
    // (it may overlap with the newest session otherwise).
    const liveJsonlCount = (hasLiveProcess || lock)
      ? sessions.filter((s) => now - s.mtime_ms <= LIVE_WINDOW_MS).length
      : 0;
    let liveSessionCount = liveJsonlCount + (lock && age > LIVE_WINDOW_MS ? 1 : 0);
    if (status === 'idle' && liveJsonlCount === 0) {
      liveSessionCount += 1;
    }

    // A session counts as "currently active" for live/live-ide AND for the
    // new `idle` status: the running process is attributed to the most-
    // recent JSONL in this worktree, so it shouldn't appear in the closed
    // list (where the UI would invite the user to "resume" a session that
    // is already running). For non-live/non-idle states, every session
    // including the newest goes to the closed list so the user can reopen.
    const isActive = status === 'live' || status === 'live-ide' || status === 'idle';
    const activeSessionId = isActive ? newest.session_id : undefined;
    const inactive = (isActive ? sessions.slice(1) : sessions).map((s) => ({
      sessionId: s.session_id,
      lastActivity: new Date(s.mtime_ms).toISOString(),
    }));

    out.set(wt.path, {
      status,
      ideName: lock?.ide_name,
      pid: lock?.pid,
      lastActivity: new Date(newest.mtime_ms).toISOString(),
      activeSessionId,
      inactiveSessions: inactive,
      liveSessionCount,
    });
  }
  return out;
}

// Fingerprint-based memo cache for fetchClaudePresence. We pass the last
// projects fingerprint back to Rust on each call; if it still matches, Rust
// returns `unchanged: true` with empty `projects` (skipping JSONL header
// reads) but ALWAYS-fresh `ide_locks` (so crashed-IDE detection still works
// via pid_is_alive). The TS side merges the fresh ide_locks with the cached
// projects data and re-joins against the current wall clock — that way the
// live/recent/dormant status fields update as time passes even when no
// underlying mtimes have moved, instead of being frozen at the last full
// read's value.
//
// We cache the LAST FULL `raw` (not the joined map) so the re-join sees the
// real project sessions data. Returning the previously joined map directly
// would freeze status fields and is the bug the re-join was added to fix.
const CLAUDE_FORCE_REFRESH_MS = 30_000;
let cachedFingerprint: string | null = null;
let cachedRaw: ClaudeStateRaw | null = null;
let cachedWorktreeKey: string | null = null;
let cachedAt = 0;

// Test seam: clear the cache between tests so behavior is deterministic.
export function _resetClaudePresenceCacheForTests(): void {
  cachedFingerprint = null;
  cachedRaw = null;
  cachedWorktreeKey = null;
  cachedAt = 0;
}

function worktreeKey(worktrees: Worktree[]): string {
  // Order-stable join — the cache hit is sensitive to the worktree set, not
  // their iteration order. Path is the only field the join uses for keying.
  return worktrees
    .map((w) => w.path)
    .sort()
    .join('\u0001');
}

/**
 * Convenience wrapper: fetches raw state via the Tauri bridge, then joins.
 * Returns an empty map if the bridge is unavailable (dev preview / tests) so
 * the refresh loop doesn't blank the UI on a missing runtime.
 */
export async function fetchClaudePresence(
  worktrees: Worktree[],
): Promise<Map<string, ClaudePresence>> {
  try {
    const wtKey = worktreeKey(worktrees);
    const now = Date.now();
    const canUseCache =
      cachedFingerprint !== null &&
      cachedWorktreeKey === wtKey &&
      now - cachedAt < CLAUDE_FORCE_REFRESH_MS;
    const expected = canUseCache ? cachedFingerprint ?? undefined : undefined;

    const raw = await readClaudeState(expected);
    if (raw.unchanged && cachedRaw && canUseCache) {
      // Rust confirmed the projects haven't moved. Combine the fresh
      // ide_locks AND live_worktree_cwds (both always re-read so
      // crashed-IDE and exited-process detection still work) with the
      // cached projects data, then re-join against the current `now` so
      // live/recent/idle/dormant transitions fire on time. Don't bump
      // cachedAt — that timestamp tracks the last *full* read, not the
      // last cache hit, so the force-refresh window remains accurate.
      const merged: ClaudeStateRaw = {
        ide_locks: raw.ide_locks,
        projects: cachedRaw.projects,
        live_worktree_cwds: raw.live_worktree_cwds,
        fingerprint: raw.fingerprint,
        unchanged: false,
      };
      return joinClaudeState(merged, worktrees);
    }
    const presence = joinClaudeState(raw, worktrees);
    cachedFingerprint = raw.fingerprint || null;
    cachedRaw = raw;
    cachedWorktreeKey = wtKey;
    cachedAt = now;
    return presence;
  } catch (e) {
    // Log rather than silently blanking the presence map — a regression in
    // readClaudeState/joinClaudeState would otherwise make the Claude
    // awareness indicator look permanently empty with no hint why.
    console.warn('[claude] fetchClaudePresence failed:', e);
    return new Map();
  }
}

/**
 * Build the shell snippet a user would run to resume a given closed session.
 * Shown in the UI via a "copy to clipboard" button. We quote the worktree
 * path because it can contain spaces; session IDs are UUIDs so they don't
 * need quoting.
 */
export function resumeCommand(worktreePath: string, sessionId: string): string {
  return `cd ${shellQuote(worktreePath)} && claude --resume ${sessionId}`;
}

function shellQuote(s: string): string {
  // Single-quote with embedded-single-quote escaping: 'foo' + "'" + 'bar'
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
