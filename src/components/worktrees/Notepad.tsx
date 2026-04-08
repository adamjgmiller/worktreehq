import { useEffect, useRef, useState } from 'react';
import { readNotepad, writeNotepad } from '../../services/notepadService';

const SAVE_DEBOUNCE_MS = 400;

// A small per-worktree scratchpad. Loads once on mount, debounce-saves on
// edit, and flushes immediately on blur and unmount so the last few keystrokes
// survive even if the app is quit right after typing.
export function Notepad({ worktreePath }: { worktreePath: string }) {
  const [value, setValue] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  // Surfaces a write_notepad failure (disk full, permissions, etc.) so the
  // user sees that their notes did NOT persist. Previously the catch in
  // flush/scheduleSave silently flipped the UI back to "saved" on failure
  // and the user thought their writes were durable when they weren't.
  const [saveError, setSaveError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const latestRef = useRef('');

  // Initial load. Guard against clobbering text the user already started
  // typing before the read resolved.
  useEffect(() => {
    let cancelled = false;
    readNotepad(worktreePath).then((text) => {
      if (cancelled) return;
      if (!dirtyRef.current) {
        setValue(text);
        latestRef.current = text;
      }
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [worktreePath]);

  // Flush any pending save on unmount (e.g. worktree removed, app closing).
  useEffect(() => {
    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (dirtyRef.current) {
        writeNotepad(worktreePath, latestRef.current).catch(() => {});
      }
    };
  }, [worktreePath]);

  function flush() {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!dirtyRef.current) return;
    const toSave = latestRef.current;
    setSaving(true);
    setSaveError(null);
    writeNotepad(worktreePath, toSave)
      .then(() => {
        if (latestRef.current === toSave) {
          dirtyRef.current = false;
          setSaving(false);
        }
      })
      .catch((e: unknown) => {
        setSaving(false);
        setSaveError(e instanceof Error ? e.message : String(e));
      });
  }

  function scheduleSave(next: string) {
    latestRef.current = next;
    dirtyRef.current = true;
    setSaving(true);
    setSaveError(null);
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const toSave = latestRef.current;
      writeNotepad(worktreePath, toSave)
        .then(() => {
          if (latestRef.current === toSave) {
            dirtyRef.current = false;
            setSaving(false);
          }
        })
        .catch((e: unknown) => {
          setSaving(false);
          setSaveError(e instanceof Error ? e.message : String(e));
        });
    }, SAVE_DEBOUNCE_MS);
  }

  return (
    <div className="mt-3 border-t border-wt-border pt-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[0.625rem] uppercase tracking-wide text-neutral-500">notepad</span>
        <span
          className={`text-[0.625rem] ${saveError ? 'text-wt-conflict' : 'text-neutral-600'}`}
        >
          {saveError ? 'save failed' : !loaded ? '…' : saving ? 'saving…' : 'saved'}
        </span>
      </div>
      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          scheduleSave(e.target.value);
        }}
        onBlur={flush}
        placeholder="Notes, todos, scratchpad…"
        rows={3}
        spellCheck={false}
        aria-label="Worktree notepad"
        className="w-full resize-y bg-wt-bg/60 border border-wt-border rounded px-2 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-wt-info"
      />
      {saveError && (
        <div
          className="mt-1 text-[0.625rem] text-wt-conflict font-mono break-words"
          role="alert"
        >
          {saveError}
        </div>
      )}
    </div>
  );
}
