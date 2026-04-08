import { useEffect, useRef, useState } from 'react';
import { invoke } from '../../services/tauriBridge';
import { initGithub } from '../../services/githubService';
import { useRepoStore } from '../../store/useRepoStore';
import { X } from 'lucide-react';

interface AppConfigShape {
  github_token: string;
  github_token_explicitly_set?: boolean;
  refresh_interval_ms: number;
  fetch_interval_ms: number;
  last_repo_path?: string | null;
  zoom_level?: number;
}

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const setTokenPresent = useRepoStore((s) => s.setTokenPresent);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track whether the modal has loaded the existing token. Until then we
  // don't allow Save — otherwise a fast user could submit the empty
  // initial state and inadvertently wipe their working token.
  const [loaded, setLoaded] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Re-fetch the current config every time the modal opens. The previous
  // version started with an empty string and silently overwrote the saved
  // token if the user clicked Save without re-typing.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLoaded(false);
    (async () => {
      try {
        const cfg = await invoke<AppConfigShape>('read_config');
        if (cancelled) return;
        setToken(cfg.github_token ?? '');
        setLoaded(true);
      } catch (e: any) {
        if (cancelled) return;
        setError(`Could not read config: ${e?.message ?? e}`);
        setLoaded(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Escape closes; focus the input on open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, saving, onClose]);

  useEffect(() => {
    if (open && loaded && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open, loaded]);

  if (!open) return null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const state = useRepoStore.getState();
      // Always set github_token_explicitly_set: true on save. This makes
      // explicit clears stick even when GITHUB_TOKEN is exported in the
      // user's shell, and is harmless when the user is just updating the
      // token because the value is also being written.
      await invoke('write_config', {
        cfg: {
          github_token: token,
          github_token_explicitly_set: true,
          refresh_interval_ms: state.refreshIntervalMs,
          fetch_interval_ms: state.fetchIntervalMs,
          last_repo_path: state.repo?.path ?? null,
          // Preserve the user's zoom across settings saves. Without this, every
          // token save would silently reset zoom to the Rust serde default.
          zoom_level: state.zoomLevel,
        },
      });
      initGithub(token);
      setTokenPresent(!!token);
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

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="bg-wt-panel border border-wt-border rounded-xl p-6 w-[480px]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">GitHub Token</h2>
          <button onClick={onClose} disabled={saving} aria-label="close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-neutral-400 mb-3">
          Needed to look up PRs for squash-merge detection. Stored in{' '}
          <code className="font-mono">~/.config/worktreehq/config.toml</code>.
        </p>
        <div className="relative">
          <input
            ref={inputRef}
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={loading ? 'loading…' : 'ghp_…'}
            disabled={loading || saving}
            className="w-full bg-wt-bg border border-wt-border rounded px-3 py-2 font-mono text-sm pr-16 disabled:opacity-50"
          />
          {token && !loading && !saving && (
            <button
              type="button"
              onClick={clearToken}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[0.6875rem] uppercase tracking-wide text-neutral-500 hover:text-wt-conflict"
            >
              clear
            </button>
          )}
        </div>
        {error && (
          <div className="mt-3 text-xs text-wt-conflict bg-wt-conflict/10 border border-wt-conflict/40 rounded px-2 py-1.5 font-mono">
            {error}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 text-sm text-neutral-400 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!loaded || loading || saving}
            className="px-3 py-1.5 text-sm bg-wt-info/20 border border-wt-info/50 rounded hover:bg-wt-info/30 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
