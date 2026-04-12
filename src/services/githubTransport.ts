import type { PRInfo } from '../types';

/**
 * Transport abstraction for GitHub API calls. Implementations handle the
 * actual HTTP/subprocess mechanics; the caching layer in githubService.ts
 * wraps above this interface so cache logic is shared across all backends.
 */
export interface GithubTransport {
  /** Validate that the current auth is working. */
  validateAuth(): Promise<'missing' | 'valid' | 'invalid'>;

  /** Fetch a single PR by number (REST GET /repos/{o}/{r}/pulls/{n}). */
  getPullRequest(owner: string, repo: string, number: number): Promise<PRInfo | null>;

  /**
   * Batch-fetch multiple PRs with full detail (checks, reviews, mergeable).
   * Uses GraphQL aliases internally. Chunks are handled by the caller.
   */
  batchGetPullRequests(
    owner: string,
    repo: string,
    numbers: number[],
  ): Promise<Map<number, PRInfo>>;

  /**
   * List every open PR for the repo (paginated REST or gh api --paginate).
   * Returns the unfiltered list; caller filters by branch set.
   */
  listOpenPullRequests(
    owner: string,
    repo: string,
  ): Promise<Array<Omit<PRInfo, 'state'>>>;
}
