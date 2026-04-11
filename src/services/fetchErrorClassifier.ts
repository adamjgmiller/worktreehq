// Classifies raw `git fetch` stderr into an actionable category. Used by
// refreshLoop's fetch catch block so users see "SSH key not loaded" instead
// of "Permission denied (publickey)" as the leading hint. The raw stderr
// stays visible in the composed message for dev debugging — we never hide
// what git actually said.
//
// Adding a new pattern: append to PATTERNS in order of specificity. Auth
// patterns run before repo-not-found because a private-repo 404 often shows
// both strings in the same stderr and "fix your auth" is the user's real
// next action.

export type FetchErrorCategory =
  | 'ssh-auth-failed'
  | 'https-auth-failed'
  | 'network-unreachable'
  | 'repo-not-found'
  | 'unknown';

export interface ClassifiedFetchError {
  category: FetchErrorCategory;
  hint: string;
  raw: string;
}

interface Pattern {
  category: FetchErrorCategory;
  hint: string;
  matches: RegExp[];
}

const PATTERNS: Pattern[] = [
  {
    category: 'ssh-auth-failed',
    hint: 'SSH key not loaded or not authorized on GitHub. Try `ssh-add -l` to check loaded keys, and verify the key is listed at github.com/settings/keys.',
    matches: [
      /Permission denied \(publickey\)/i,
      /Could not read from remote repository/i,
      /Host key verification failed/i,
    ],
  },
  {
    category: 'https-auth-failed',
    hint: 'Git HTTPS credentials are missing or expired. Update your credential helper, or switch this remote to SSH.',
    matches: [
      /could not read Username/i,
      /Authentication failed for/i,
      /Invalid username or password/i,
      /Invalid username or token/i,
      /Support for password authentication was removed/i,
    ],
  },
  {
    category: 'network-unreachable',
    hint: 'Network unreachable — check connectivity, then retry.',
    matches: [
      /Could not resolve host/i,
      /Connection timed out/i,
      /Connection refused/i,
      /Network is unreachable/i,
      /Temporary failure in name resolution/i,
    ],
  },
  {
    category: 'repo-not-found',
    hint: 'Remote repository not found or inaccessible. Verify the remote URL and your access rights.',
    matches: [
      /Repository not found/i,
      /does not appear to be a git repository/i,
    ],
  },
];

export function classifyFetchError(stderr: string): ClassifiedFetchError {
  for (const p of PATTERNS) {
    if (p.matches.some((re) => re.test(stderr))) {
      return { category: p.category, hint: p.hint, raw: stderr };
    }
  }
  return { category: 'unknown', hint: '', raw: stderr };
}

// Single display string combining hint and raw stderr. Returns raw alone when
// the category is 'unknown' so an unclassified message doesn't get an empty
// "\n\n" prefix.
export function formatClassifiedError(c: ClassifiedFetchError): string {
  if (!c.hint) return c.raw;
  return `${c.hint}\n\n${c.raw}`;
}
