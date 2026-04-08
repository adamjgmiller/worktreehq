import { useState } from 'react';
import { invoke } from '../../services/tauriBridge';
import { initGithub } from '../../services/githubService';
import { useRepoStore } from '../../store/useRepoStore';
import { X } from 'lucide-react';

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [token, setToken] = useState('');
  const setTokenPresent = useRepoStore((s) => s.setTokenPresent);
  if (!open) return null;
  const save = async () => {
    try {
      const state = useRepoStore.getState();
      await invoke('write_config', {
        cfg: {
          github_token: token,
          refresh_interval_ms: state.refreshIntervalMs,
          fetch_interval_ms: state.fetchIntervalMs,
          last_repo_path: state.repo?.path ?? null,
        },
      });
      initGithub(token);
      setTokenPresent(!!token);
      onClose();
    } catch (e) {
      /* noop */
    }
  };
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-wt-panel border border-wt-border rounded-xl p-6 w-[480px]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">GitHub Token</h2>
          <button onClick={onClose} aria-label="close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-neutral-400 mb-3">
          Needed to look up PRs for squash-merge detection. Stored in{' '}
          <code className="font-mono">~/.config/worktreehq/config.toml</code>.
        </p>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="ghp_…"
          className="w-full bg-wt-bg border border-wt-border rounded px-3 py-2 font-mono text-sm"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-neutral-400">
            Cancel
          </button>
          <button
            onClick={save}
            className="px-3 py-1.5 text-sm bg-wt-info/20 border border-wt-info/50 rounded hover:bg-wt-info/30"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
