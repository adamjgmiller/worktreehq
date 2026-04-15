/**
 * Shared mapping functions for converting GitHub API responses (REST and
 * GraphQL) into our PRInfo type. Used by both OctokitTransport and
 * GhCliTransport so the JSON → PRInfo logic lives in exactly one place.
 */
import type { PRInfo, ChecksStatus, ReviewDecision } from '../types';

// ── REST response mapping ──────────────────────────────────────────────

export function restDataToPRInfo(data: any): PRInfo {
  return {
    number: data.number,
    title: data.title,
    state: data.merged ? 'merged' : (data.state as 'open' | 'closed'),
    mergedAt: data.merged_at ?? undefined,
    mergeCommitSha: data.merge_commit_sha ?? undefined,
    headRef: data.head.ref,
    headSha: data.head?.sha ?? null,
    url: data.html_url,
    isDraft: data.draft ?? false,
    mergeable: data.mergeable ?? null,
  };
}

// ── GraphQL batch query building ───────────────────────────────────────

export function buildBatchQuery(numbers: number[]): string {
  const aliased = numbers
    .map(
      (n) => `p${n}: pullRequest(number: ${n}) {
        number
        title
        state
        merged
        mergedAt
        mergeCommit { oid }
        headRefName
        headRefOid
        url
        isDraft
        mergeable
        reviewDecision
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup { state }
            }
          }
        }
      }`,
    )
    .join('\n');

  return `query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      ${aliased}
    }
  }`;
}

// ── GraphQL response mapping ───────────────────────────────────────────

export function graphqlNodeToPRInfo(node: any): PRInfo {
  let state: PRInfo['state'];
  if (node.merged) state = 'merged';
  else if (node.state === 'OPEN') state = 'open';
  else state = 'closed';

  const rollup: string | undefined = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  const checksStatus: ChecksStatus = mapChecksStatus(rollup);
  const reviewDecision: ReviewDecision = mapReviewDecision(node.reviewDecision);

  return {
    number: node.number,
    title: node.title ?? '',
    state,
    mergedAt: node.mergedAt ?? undefined,
    mergeCommitSha: node.mergeCommit?.oid ?? undefined,
    headRef: node.headRefName,
    headSha: node.headRefOid ?? null,
    url: node.url,
    isDraft: !!node.isDraft,
    mergeable: mapMergeable(node.mergeable),
    checksStatus,
    reviewDecision,
  };
}

// ── Enum mappers (exported for tests) ──────────────────────────────────

export function mapChecksStatus(rollup: string | undefined | null): ChecksStatus {
  switch (rollup) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'none';
  }
}

export function mapReviewDecision(decision: string | undefined | null): ReviewDecision {
  switch (decision) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'REVIEW_REQUIRED':
      return 'review_required';
    default:
      return null;
  }
}

export function mapMergeable(m: string | undefined | null): boolean | null {
  if (m === 'MERGEABLE') return true;
  if (m === 'CONFLICTING') return false;
  return null;
}
