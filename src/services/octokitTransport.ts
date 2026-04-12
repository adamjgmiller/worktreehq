import { Octokit } from '@octokit/rest';
import type { PRInfo } from '../types';
import type { GithubTransport } from './githubTransport';
import { graphqlNodeToPRInfo, restDataToPRInfo, buildBatchQuery } from './githubApiMapping';

/**
 * Direct HTTP transport using Octokit. Used when the user provides a PAT
 * (stored in the OS keychain). The token is held in memory for the session.
 */
export class OctokitTransport implements GithubTransport {
  private octokit: Octokit;

  constructor(private token: string) {
    this.octokit = token ? new Octokit({ auth: token }) : new Octokit();
  }

  async validateAuth(): Promise<'missing' | 'valid' | 'invalid'> {
    if (!this.token) return 'missing';
    try {
      await this.octokit.users.getAuthenticated();
      return 'valid';
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 403) return 'invalid';
      // Network/5xx errors: can't prove invalidity, report 'valid' to avoid
      // misleading "token invalid" pill during an airport-wifi outage.
      console.warn('[OctokitTransport] validateAuth inconclusive:', e?.status, e?.message);
      return 'valid';
    }
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<PRInfo | null> {
    try {
      const { data } = await this.octokit.pulls.get({ owner, repo, pull_number: number });
      return restDataToPRInfo(data);
    } catch (e: any) {
      if (e?.status === 404) return null;
      if (e?.status === 401 || e?.status === 403) {
        console.warn('[OctokitTransport] getPR auth/rate-limit failure', e?.status, e?.message);
      } else if (e?.status && e?.status >= 500) {
        console.warn('[OctokitTransport] getPR upstream error', e?.status, e?.message);
      }
      throw e;
    }
  }

  async batchGetPullRequests(
    owner: string,
    repo: string,
    numbers: number[],
  ): Promise<Map<number, PRInfo>> {
    const out = new Map<number, PRInfo>();
    if (numbers.length === 0) return out;

    const query = buildBatchQuery(numbers);
    // Let transport errors propagate — the caller (batchFetchPRs) catches them
    // to avoid negative-caching valid PRs on transient failures.
    const data: any = await this.octokit.graphql(query, { owner, repo });
    const repoNode = data?.repository ?? {};
    for (const n of numbers) {
      const node = repoNode[`p${n}`];
      if (!node) continue;
      out.set(n, graphqlNodeToPRInfo(node));
    }
    return out;
  }

  async listOpenPullRequests(
    owner: string,
    repo: string,
  ): Promise<Array<Omit<PRInfo, 'state'>>> {
    const all = await this.octokit.paginate(this.octokit.pulls.list, {
      owner,
      repo,
      state: 'open',
      per_page: 100,
    });
    return all.map((p) => ({
      number: p.number,
      title: p.title,
      headRef: p.head.ref,
      url: p.html_url,
      isDraft: p.draft ?? false,
    }));
  }
}
