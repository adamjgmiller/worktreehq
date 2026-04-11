import type {
  Worktree,
  WorktreePairOverlap,
  ConflictFile,
  OverlapSeverity,
  WorktreeConflictSummary,
} from '../types';
import { getChangedFiles, getMergeBase, simulateMerge } from './gitService';

// ─── Caches ────────────────────────────────────────────────────────────
// Content-addressed by branch + head SHA so entries auto-invalidate when
// a branch tip moves. Same pattern as branchAbCache in gitService.ts.

const changedFilesCache = new Map<string, string[]>();
const CHANGED_FILES_CACHE_MAX = 200;

const mergeBaseCache = new Map<string, string>();
const MERGE_BASE_CACHE_MAX = 500;

export function _clearConflictCacheForTests(): void {
  changedFilesCache.clear();
  mergeBaseCache.clear();
}

// ─── Concurrency limiter ───────────────────────────────────────────────

async function withConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;
  const run = async () => {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, () => run()),
  );
  return results;
}

// ─── merge-tree output parser ──────────────────────────────────────────

/**
 * Parse the three-argument `git merge-tree` output into per-file results.
 *
 * The output contains blocks like:
 *   changed in both
 *     base   100644 <sha> <path>
 *     our    100644 <sha> <path>
 *     their  100644 <sha> <path>
 *   <optional unified-diff with conflict markers>
 *
 * or, when both branches create the same new file:
 *   added in both
 *     our    100644 <sha> <path>
 *     their  100644 <sha> <path>
 *   <optional unified-diff with conflict markers>
 *
 * Files with `<<<<<<<` markers are conflicts; others are clean merges of
 * the same file.
 */
function parseMergeTreeOutput(
  output: string,
  overlappingFiles: Set<string>,
): ConflictFile[] {
  if (!output.trim()) return [];

  const files: ConflictFile[] = [];
  // Split on "changed in both" or "added in both" sentinels to get per-file blocks.
  const blocks = output.split(/^(?:changed|added) in both$/m);

  for (const block of blocks) {
    if (!block.trim()) continue;
    // Extract file path from "base", "our", or "result" lines:
    //   base   100644 <sha> <path>   (changed in both)
    //   our    100644 <sha> <path>   (added in both — no base line)
    //   result 100644 <sha> <path>   (added in both — alternate form)
    const pathMatch = block.match(/^\s+(?:base|our|result)\s+\d+\s+\S+\s+(.+)$/m);
    if (!pathMatch) continue;
    const filePath = pathMatch[1].trim();
    // Only report files that are in our overlap set
    if (!overlappingFiles.has(filePath)) continue;

    const hasMarkers = block.includes('<<<<<<<');
    files.push({
      path: filePath,
      severity: hasMarkers ? 'conflict' : 'clean',
      conflictMarkers: hasMarkers ? extractConflictBlock(block) : undefined,
    });
  }

  return files;
}

/** Extract just the diff/conflict portion from a merge-tree block. */
function extractConflictBlock(block: string): string {
  const lines = block.split('\n');
  // Skip the header lines (base/our/their) and grab the rest
  const diffStart = lines.findIndex((l) => l.startsWith('@@') || l.includes('<<<<<<<'));
  if (diffStart === -1) return block.trim();
  return lines.slice(diffStart).join('\n').trim();
}

// ─── Public API ────────────────────────────────────────────────────────

export interface ConflictDetectInput {
  repoPath: string;
  defaultBranch: string;
  worktrees: Worktree[];
}

export interface ConflictDetectResult {
  pairs: WorktreePairOverlap[];
  summaryByPath: Map<string, WorktreeConflictSummary>;
}

export async function detectCrossWorktreeConflicts(
  input: ConflictDetectInput,
): Promise<ConflictDetectResult> {
  const { repoPath, defaultBranch, worktrees } = input;
  const empty: ConflictDetectResult = { pairs: [], summaryByPath: new Map() };

  // ── Filter candidates ──────────────────────────────────────────────
  // Skip: primary worktree (IS the default branch), prunable/orphaned,
  // detached HEADs (branch is empty or "HEAD").
  const candidates = worktrees.filter(
    (w) => !w.isPrimary && !w.prunable && w.branch && w.branch !== 'HEAD',
  );
  if (candidates.length < 2) return empty;

  // ── Phase 1: changed-file sets (parallel, cached) ──────────────────
  // Trim cache if it's grown too large
  if (changedFilesCache.size > CHANGED_FILES_CACHE_MAX) {
    const keys = Array.from(changedFilesCache.keys());
    for (let i = 0; i < keys.length - CHANGED_FILES_CACHE_MAX / 2; i++) {
      changedFilesCache.delete(keys[i]);
    }
  }

  const filesByBranch = new Map<string, Set<string>>();
  await Promise.all(
    candidates.map(async (wt) => {
      const cacheKey = `${wt.branch}:${wt.head}`;
      let files = changedFilesCache.get(cacheKey);
      if (!files) {
        files = await getChangedFiles(repoPath, defaultBranch, wt.branch);
        changedFilesCache.set(cacheKey, files);
      }
      filesByBranch.set(wt.branch, new Set(files));
    }),
  );

  // ── Phase 2: pairwise overlap (set intersection, no subprocess) ────
  type PendingPair = {
    a: typeof candidates[0];
    b: typeof candidates[0];
    overlap: Set<string>;
  };
  const overlappingPairs: PendingPair[] = [];
  const noOverlapPairs: WorktreePairOverlap[] = [];

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      // Normalize so branchA < branchB alphabetically for stable sort order
      const [a, b] = candidates[i].branch.localeCompare(candidates[j].branch) <= 0
        ? [candidates[i], candidates[j]]
        : [candidates[j], candidates[i]];
      const filesA = filesByBranch.get(a.branch);
      const filesB = filesByBranch.get(b.branch);
      if (!filesA || !filesB || filesA.size === 0 || filesB.size === 0) {
        noOverlapPairs.push({
          branchA: a.branch,
          branchB: b.branch,
          severity: 'none',
          files: [],
        });
        continue;
      }

      // Intersect
      const smaller = filesA.size <= filesB.size ? filesA : filesB;
      const larger = filesA.size <= filesB.size ? filesB : filesA;
      const overlap = new Set<string>();
      for (const f of smaller) {
        if (larger.has(f)) overlap.add(f);
      }

      if (overlap.size === 0) {
        noOverlapPairs.push({
          branchA: a.branch,
          branchB: b.branch,
          severity: 'none',
          files: [],
        });
      } else {
        overlappingPairs.push({ a, b, overlap });
      }
    }
  }

  // ── Phase 3: merge simulation (only overlapping pairs, capped) ─────
  if (mergeBaseCache.size > MERGE_BASE_CACHE_MAX) {
    const keys = Array.from(mergeBaseCache.keys());
    for (let i = 0; i < keys.length - MERGE_BASE_CACHE_MAX / 2; i++) {
      mergeBaseCache.delete(keys[i]);
    }
  }

  const resolvedPairs = await withConcurrency(
    overlappingPairs.map(({ a, b, overlap }) => async (): Promise<WorktreePairOverlap> => {
      // Cached merge-base lookup, keyed by sorted SHAs
      const mbKey = [a.head, b.head].sort().join(':');
      let mergeBase = mergeBaseCache.get(mbKey);
      if (!mergeBase) {
        mergeBase = await getMergeBase(repoPath, a.branch, b.branch);
        if (mergeBase) mergeBaseCache.set(mbKey, mergeBase);
      }

      if (!mergeBase) {
        // Can't determine merge-base — treat overlap as clean (conservative)
        return {
          branchA: a.branch,
          branchB: b.branch,
          severity: 'clean',
          files: Array.from(overlap, (path) => ({ path, severity: 'clean' as const })),
        };
      }

      const sim = await simulateMerge(repoPath, mergeBase, a.branch, b.branch);
      const parsedFiles = parseMergeTreeOutput(sim.output, overlap);

      // Any overlap files not mentioned in merge-tree output are clean
      const mentioned = new Set(parsedFiles.map((f) => f.path));
      for (const path of overlap) {
        if (!mentioned.has(path)) {
          parsedFiles.push({ path, severity: 'clean' });
        }
      }

      const hasConflict = sim.hasConflicts || parsedFiles.some((f) => f.severity === 'conflict');
      const severity: OverlapSeverity = hasConflict ? 'conflict' : 'clean';

      return {
        branchA: a.branch,
        branchB: b.branch,
        severity,
        files: parsedFiles.sort((x, y) => {
          // Conflicts first, then clean
          if (x.severity !== y.severity) return x.severity === 'conflict' ? -1 : 1;
          return x.path.localeCompare(y.path);
        }),
      };
    }),
    6, // concurrency cap
  );

  // ── Phase 4: derive per-worktree summaries ─────────────────────────
  const allPairs = [...noOverlapPairs, ...resolvedPairs];
  const summaryByPath = new Map<string, WorktreeConflictSummary>();

  // Initialize summaries for all candidates
  for (const wt of candidates) {
    summaryByPath.set(wt.path, { conflictCount: 0, cleanOverlapCount: 0 });
  }

  // Build a branch→path lookup for incrementing the right worktree
  const pathByBranch = new Map(candidates.map((w) => [w.branch, w.path]));

  for (const pair of allPairs) {
    if (pair.severity === 'none') continue;
    const pathA = pathByBranch.get(pair.branchA);
    const pathB = pathByBranch.get(pair.branchB);
    if (!pathA || !pathB) continue;

    const sumA = summaryByPath.get(pathA)!;
    const sumB = summaryByPath.get(pathB)!;

    if (pair.severity === 'conflict') {
      sumA.conflictCount++;
      sumB.conflictCount++;
    } else {
      sumA.cleanOverlapCount++;
      sumB.cleanOverlapCount++;
    }
  }

  return { pairs: allPairs, summaryByPath };
}
