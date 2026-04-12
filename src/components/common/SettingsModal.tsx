import { useEffect, useRef, useState } from 'react';
import { invoke, keychainStore, keychainRead, keychainDelete } from '../../services/tauriBridge';
import {
  initGithub,
  validateToken,
  detectGhCli,
  type AuthMethod,
} from '../../services/githubService';
import { useRepoStore } from '../../store/useRepoStore';
import { X, Terminal, Key, ShieldOff } from 'lucide-react';

// Loose shape — we read the full config object, spread it on save, and only
// override the fields this modal owns. The rest (recent_repo_paths, zoom_level,
// any future field) round-trips untouched.
type AppConfigShape = Record<string, unknown> & {
  github_token?: string;
  auth_method?: AuthMethod;
  post_create_commands?: string;
};

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const setGithubAuthStatus = useRepoStore((s) => s.setGithubAuthStatus);
  const setAuthMethod = useRepoStore((s) => s.setAuthMethod);
  const currentAuthMethod = useRepoStore((s) => s.authMethod);

  const [selectedMethod, setSelectedMethod] = useState<AuthMethod>('none');
  const [token, setToken] = useState('');
  const [postCreateCommands, setPostCreateCommands] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [ghDetected, setGhDetected] = useState<boolean | null>(null);
  const [ghChecking, setGhChecking] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const baseCfgRef = useRef<AppConfigShape | null>(null);

  // Re-fetch config + detect gh CLI every time the modal opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLoaded(false);
    setGhChecking(true);

    (async () => {
      try {
        const [cfg, gh] = await Promise.all([
          invoke<AppConfigShape>('read_config'),
          detectGhCli(),
        ]);
        if (cancelled) return;
        baseCfgRef.current = cfg;

        setGhDetected(gh);
        setGhChecking(false);
        setPostCreateCommands((cfg.post_create_commands as string | undefined) ?? '');

        // Initialize the radio selection from the current method
        setSelectedMethod(currentAuthMethod);

        // Load the PAT from keychain (preferred) or config (legacy)
        let keychainToken: string | null = null;
        try {
          keychainToken = await keychainRead('github_token');
        } catch {
          /* keychain may not be available */
        }
        if (cancelled) return;
        setToken(keychainToken || (cfg.github_token as string | undefined) || '');
        setLoaded(true);
      } catch (e: any) {
        if (cancelled) return;
        setError(`Could not read config: ${e?.message ?? e}`);
        setGhChecking(false);
        setLoaded(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, currentAuthMethod]);

  // Escape closes; focus the input on open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open && loaded && selectedMethod === 'pat' && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open, loaded, selectedMethod]);

  if (!open) return null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      let base: AppConfigShape;
      try {
        base = await invoke<AppConfigShape>('read_config');
      } catch {
        base = baseCfgRef.current ?? {};
      }

      // Handle keychain BEFORE persisting config — if keychain write fails,
      // we don't want config pointing at a missing token.
      if (selectedMethod === 'pat' && token) {
        await keychainStore('github_token', token);
      } else {
        // Switching away from PAT, or PAT with empty token — remove stale entry
        try {
          await keychainDelete('github_token');
        } catch {
          /* best-effort cleanup */
        }
      }

      // Persist auth method preference and clear the plaintext token from config
      await invoke('write_config', {
        cfg: {
          ...base,
          github_token: '',
          github_token_explicitly_set: true,
          auth_method: selectedMethod,
          post_create_commands: postCreateCommands,
        },
      });

      // Initialize the transport with the new method
      switch (selectedMethod) {
        case 'gh-cli':
          initGithub('gh-cli');
          break;
        case 'pat':
          initGithub('pat', token);
          break;
        case 'none':
          initGithub('none');
          break;
      }
      setAuthMethod(selectedMethod);

      // Re-validate against GitHub
      if (selectedMethod !== 'none') {
        setGithubAuthStatus('checking');
        void validateToken().then(setGithubAuthStatus);
      } else {
        setGithubAuthStatus('missing');
      }
      onClose();
    } catch (e: any) {
      setError(`Save failed: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  const clearToken = () => {
    setToken('');
    inputRef.current?.focus();
  };

  const radioClass = (method: AuthMethod) =>
    `flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
      selectedMethod === method
        ? 'border-wt-info/50 bg-wt-info/5'
        : 'border-wt-border hover:border-wt-border/80 hover:bg-wt-bg/50'
    }`;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-wt-panel border border-wt-border rounded-xl p-6 w-[560px] max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button onClick={onClose} aria-label="close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── Auth method selector ── */}
        <h3 className="text-sm font-semibold mb-2">GitHub Authentication</h3>
        <p className="text-xs text-wt-fg-2 mb-3">
          Required for PR status and squash-merge detection. Core worktree features work without auth.
        </p>

        <div className="flex flex-col gap-2 mb-4">
          {/* Option 1: gh CLI */}
          <label className={radioClass('gh-cli')}>
            <input
              type="radio"
              name="auth-method"
              checked={selectedMethod === 'gh-cli'}
              onChange={() => setSelectedMethod('gh-cli')}
              disabled={loading || saving}
              className="mt-0.5 accent-wt-info"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-wt-fg-2 shrink-0" />
                <span className="text-sm font-medium">GitHub CLI</span>
                <span className="text-[0.6875rem] text-wt-clean font-medium">recommended</span>
              </div>
              <p className="text-xs text-wt-fg-2 mt-1">
                {ghChecking
                  ? 'Checking for gh CLI...'
                  : ghDetected
                    ? 'Detected and authenticated. No token stored by this app.'
                    : 'Not detected. Install from cli.github.com, then run gh auth login.'}
              </p>
            </div>
          </label>

          {/* Option 2: PAT */}
          <label className={radioClass('pat')}>
            <input
              type="radio"
              name="auth-method"
              checked={selectedMethod === 'pat'}
              onChange={() => setSelectedMethod('pat')}
              disabled={loading || saving}
              className="mt-0.5 accent-wt-info"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <Key className="w-4 h-4 text-wt-fg-2 shrink-0" />
                <span className="text-sm font-medium">Personal access token</span>
              </div>
              <p className="text-xs text-wt-fg-2 mt-1">
                Stored in your OS keychain, not on disk. Fine-grained PAT recommended: Pull&nbsp;requests&nbsp;(read) scope.
              </p>
              {selectedMethod === 'pat' && (
                <div className="mt-2 relative">
                  <input
                    ref={inputRef}
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={loading ? 'loading...' : 'ghp_... or github_pat_...'}
                    disabled={loading || saving}
                    className="w-full bg-wt-bg border border-wt-border rounded px-3 py-2 font-mono text-sm pr-16 disabled:opacity-50"
                  />
                  {token && !loading && !saving && (
                    <button
                      type="button"
                      onClick={clearToken}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-[0.6875rem] uppercase tracking-wide text-wt-muted hover:text-wt-conflict"
                    >
                      clear
                    </button>
                  )}
                </div>
              )}
            </div>
          </label>

          {/* Option 3: None */}
          <label className={radioClass('none')}>
            <input
              type="radio"
              name="auth-method"
              checked={selectedMethod === 'none'}
              onChange={() => setSelectedMethod('none')}
              disabled={loading || saving}
              className="mt-0.5 accent-wt-info"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <ShieldOff className="w-4 h-4 text-wt-fg-2 shrink-0" />
                <span className="text-sm font-medium">No GitHub auth</span>
              </div>
              <p className="text-xs text-wt-fg-2 mt-1">
                Core worktree features work without auth. PR status and squash archaeology unavailable.
              </p>
            </div>
          </label>
        </div>

        {/* ── Post-create commands ── */}
        <div className="pt-4 border-t border-wt-border">
          <h3 className="text-sm font-semibold mb-1">Post-create commands</h3>
          <p className="text-xs text-wt-fg-2 mb-2">
            Runs in each new worktree's directory after{' '}
            <code className="font-mono">git worktree add</code> succeeds.
            Piped to <code className="font-mono">/bin/sh</code>, so{' '}
            <code className="font-mono">&amp;&amp;</code>, env vars, and{' '}
            <code className="font-mono">cd</code> all work. Failures surface
            as an error but do not undo the worktree.
          </p>
          <textarea
            value={postCreateCommands}
            onChange={(e) => setPostCreateCommands(e.target.value)}
            placeholder={'cp ../main/.env .env\nnpm install'}
            disabled={loading || saving}
            rows={5}
            spellCheck={false}
            className="w-full bg-wt-bg border border-wt-border rounded px-3 py-2 font-mono text-xs resize-y disabled:opacity-50"
          />
        </div>
        {error && (
          <div className="mt-3 text-xs text-wt-conflict bg-wt-conflict/10 border border-wt-conflict/40 rounded px-2 py-1.5 font-mono">
            {error}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-wt-fg-2"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!loaded || loading || saving}
            className="px-3 py-1.5 text-sm bg-wt-info/20 border border-wt-info/50 rounded hover:bg-wt-info/30 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
