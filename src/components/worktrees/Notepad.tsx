import { useEffect, useRef, useState } from 'react';
import {
  computeNotepadAutofill,
  readNotepad,
  writeNotepad,
} from '../../services/notepadService';
import { useRepoStore } from '../../store/useRepoStore';

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
  // typing before the read resolved. Autofill is NOT inline here — it
  // lives in a separate refresh-tick effect below so a worktree opened
  // before its Claude session has typed a first prompt still gets seeded
  // a few seconds later when the next refresh tick fires.
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

  // Autofill: re-checked on every successful refresh tick while the notepad
  // is still empty AND nothing is in flight. This handles the common case
  // where the user creates a worktree, the card mounts immediately, the
  // user then types their first prompt to claude — and we want the next
  // 15s poll to discover that prompt and seed the notepad.
  //
  // The touched flag inside computeNotepadAutofill is what makes this safe
  // to call repeatedly: once any write succeeds (autofill, manual edit, or
  // manual clear-to-empty) the path is locked out forever and re-checks
  // become no-ops. So this effect is self-terminating without needing its
  // own "did we already try" tracking.
  //
  // We subscribe to lastRefresh as a primitive selector — Zustand only
  // re-renders this component when the timestamp actually changes, not on
  // every store mutation.
  const lastRefresh = useRepoStore((s) => s.lastRefresh);
  useEffect(() => {
    // Wait for the initial load to settle. Until `loaded` flips, latestRef
    // still holds the default '' from useState, NOT the persisted notepad
    // value, and we'd race with the load effect.
    if (!loaded) return;
    // Bail if anything is in flight or the notepad already has content.
    // Read latestRef rather than `value` because `value` is captured at
    // effect-schedule time and can lag behind the most recent keystroke.
    if (latestRef.current !== '' || dirtyRef.current || timerRef.current != null) {
      return;
    }

    let cancelled = false;
    computeNotepadAutofill(worktreePath)
      .then((seed) => {
        // Re-check guards after the async hop. The user could have started
        // typing during the autofill fetch, in which case we drop the
        // seed on the floor rather than clobbering input.
        if (cancelled || !seed) return;
        if (latestRef.current !== '' || dirtyRef.current) return;
        setValue(seed);
        latestRef.current = seed;
        // Persisting is what sets the touched flag in notepads.json, which
        // prevents this autofill from firing again on subsequent ticks
        // (or on a future mount). System-driven write — bypass the
        // scheduleSave/flush UI machinery so 'saving…' doesn't flash.
        writeNotepad(worktreePath, seed).catch(() => {
          // Persist failure is non-fatal: the seed stays on screen, the
          // user can edit normally. The touched flag won't be set, so the
          // next refresh tick would re-attempt — acceptable for a disk-
          // full / permissions edge case.
        });
      })
      .catch(() => {
        // Any error in the autofill path is purely cosmetic — leave the
        // notepad empty and wait for the next tick.
      });

    return () => {
      cancelled = true;
    };
  }, [worktreePath, lastRefresh, loaded]);

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
    <div className="mt-2 border-t border-wt-border pt-3">
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
        rows={5}
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
