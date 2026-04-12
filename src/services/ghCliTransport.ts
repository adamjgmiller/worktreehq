import type { PRInfo } from '../types';
import type { GithubTransport } from './githubTransport';
import { restDataToPRInfo, graphqlNodeToPRInfo, buildBatchQuery } from './githubApiMapping';
import { ghExec } from './tauriBridge';

/**
 * GitHub transport that delegates all API calls to the `gh` CLI. The app
 * never sees, stores, or handles a token — `gh` reads its own credential
 * store. Each API call spawns a subprocess; the ~50-100ms overhead is
 * negligible against network RTT.
 */
export class GhCliTransport implements GithubTransport {
  async validateAuth(): Promise<'missing' | 'valid' | 'invalid'> {
    try {
      const result = await ghExec(['auth', 'status', '--hostname', 'github.com']);
      if (result.code === 0) return 'valid';

      const stderr = (result.stderr ?? '').toLowerCase();

      // Definitive auth failures — gh explicitly says we're not logged in.
      const authFailurePatterns = [
        'not logged in',
        'authentication',
        'token',
        'login required',
        'no oauth token',
      ];
      if (authFailurePatterns.some((p) => stderr.includes(p))) return 'invalid';

      // Network / transient failures — can't prove invalidity, so report
      // 'valid' (inconclusive) to match OctokitTransport's conservative
      // behavior and avoid a misleading "token invalid" pill during an
      // airport-wifi outage.
      const networkPatterns = [
        'connection',
        'timeout',
        'dns',
        'resolve host',
        'network',
        'could not resolve',
        'no such host',
        'tls',
        'certificate',
      ];
      if (networkPatterns.some((p) => stderr.includes(p))) {
        console.warn('[GhCliTransport] validateAuth inconclusive (network):', result.stderr);
        return 'valid';
      }

      // Unknown non-zero exit — default to 'valid' (inconclusive) rather
      // than falsely marking auth as broken.
      console.warn('[GhCliTransport] validateAuth inconclusive (unknown):', result.stderr);
      return 'valid';
    } catch {
      // ghExec throws when Tauri bridge is unavailable (tests, plain dev).
      return 'missing';
    }
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<PRInfo | null> {
    const result = await ghExec(['api', `/repos/${owner}/${repo}/pulls/${number}`]);
    if (result.code !== 0) {
      // 404 → null, auth/other → throw to let caller decide on caching
      if (result.stderr.includes('404') || result.stderr.includes('Not Found')) return null;
      throw new Error(`gh api failed (code ${result.code}): ${result.stderr}`);
    }
    const data = JSON.parse(result.stdout);
    return restDataToPRInfo(data);
  }

  async batchGetPullRequests(
    owner: string,
    repo: string,
    numbers: number[],
  ): Promise<Map<number, PRInfo>> {
    const out = new Map<number, PRInfo>();
    if (numbers.length === 0) return out;

    const query = buildBatchQuery(numbers);
    const result = await ghExec([
      'api', 'graphql',
      '-f', `query=${query}`,
      '-f', `owner=${owner}`,
      '-f', `repo=${repo}`,
    ]);
    if (result.code !== 0) {
      console.warn('[GhCliTransport] batchGetPullRequests failed:', result.stderr);
      return out;
    }

    try {
      const data = JSON.parse(result.stdout);
      const repoNode = data?.data?.repository ?? {};
      for (const n of numbers) {
        const node = repoNode[`p${n}`];
        if (!node) continue;
        out.set(n, graphqlNodeToPRInfo(node));
      }
    } catch (e) {
      console.warn('[GhCliTransport] failed to parse GraphQL response:', e);
    }
    return out;
  }

  async listOpenPullRequests(
    owner: string,
    repo: string,
  ): Promise<Array<Omit<PRInfo, 'state'>>> {
    // gh api --paginate concatenates all pages into a single JSON array.
    const result = await ghExec([
      'api', '--paginate',
      `/repos/${owner}/${repo}/pulls?state=open&per_page=100`,
    ]);
    if (result.code !== 0) {
      console.warn('[GhCliTransport] listOpenPullRequests failed:', result.stderr);
      return [];
    }

    try {
      const data = JSON.parse(result.stdout);
      return (data as any[]).map((p) => ({
        number: p.number,
        title: p.title,
        headRef: p.head.ref,
        url: p.html_url,
        isDraft: p.draft ?? false,
      }));
    } catch (e) {
      console.warn('[GhCliTransport] failed to parse open PRs response:', e);
      return [];
    }
  }
}
