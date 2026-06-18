'use client';

/**
 * useWhiteboardPersistence — ties the embedded whiteboard to a meeting, so each meeting has its own
 * board that is saved like notes and can be reopened later.
 *
 * Tandem owns persistence (the iframe is a cross-origin editing surface we can't read directly):
 *   - on opening the canvas during a live meeting, load that meeting's saved board (or a blank one),
 *   - on closing the canvas / ending the recording / quitting, snapshot the board and write it to the
 *     meeting folder as `whiteboard.tldr.json` (alongside transcripts, screenshots, etc.),
 *   - the meeting-details "Whiteboard" button fires `tandem:canvas-open-saved` to reopen a past board.
 *
 * Mount once (see WhiteboardPersistence). Returns nothing — it's pure side-effect glue.
 */

import { useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useCanvas } from '@/contexts/CanvasContext';
import { logger } from '@/lib/logger';

export const WHITEBOARD_FILE = 'whiteboard.tldr.json';

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const joinPath = (folder: string, file: string) => `${folder}${folder.includes('\\') ? '\\' : '/'}${file}`;

export function useWhiteboardPersistence() {
  const { canvasVisible, showCanvas, saveSnapshot, loadSnapshot, clearCanvas } = useCanvas();
  const currentFolderRef = useRef<string | null>(null);
  const prevVisibleRef = useRef(false);
  // Marks that the next canvas-open was triggered by the "open this saved board" path, so the live
  // open effect doesn't overwrite it with the active meeting's board.
  const openedSavedRef = useRef<string | null>(null);
  // Single-flight save per folder: coalesces concurrent saves (close + recording-stop + unload) so
  // two round-trips can't interleave torn writes to the same file.
  const savingRef = useRef<Map<string, Promise<void>>>(new Map());

  const save = useCallback(
    (folder: string | null): Promise<void> => {
      if (!folder || !inTauri()) return Promise.resolve();
      // Coalesce concurrent saves of the same folder onto one in-flight round-trip.
      const inflight = savingRef.current.get(folder);
      if (inflight) return inflight;
      const run = (async () => {
        try {
          const result = await saveSnapshot();
          if (!result?.snapshot) return; // board unreachable — don't clobber a good save with an empty one
          // .tldr.json = full fidelity (restore). .md + .png = agent-friendly companions.
          await invoke('save_transcript', {
            filePath: joinPath(folder, WHITEBOARD_FILE),
            content: JSON.stringify(result.snapshot),
          });
          if (result.markdown) {
            await invoke('save_transcript', {
              filePath: joinPath(folder, 'whiteboard.md'),
              content: result.markdown,
            }).catch((e) => logger.warn('[Whiteboard] md save failed', e));
          }
          if (result.png) {
            await invoke('save_base64_file', {
              path: joinPath(folder, 'whiteboard.png'),
              base64: result.png,
            }).catch((e) => logger.warn('[Whiteboard] png save failed', e));
          }
        } catch (e) {
          logger.warn('[Whiteboard] save failed', e);
        }
      })();
      savingRef.current.set(folder, run);
      void run.finally(() => {
        if (savingRef.current.get(folder) === run) savingRef.current.delete(folder);
      });
      return run;
    },
    [saveSnapshot],
  );

  const load = useCallback(
    async (folder: string | null) => {
      if (!folder || !inTauri()) return;
      // Persist whatever was open for a different meeting before switching boards.
      if (currentFolderRef.current && currentFolderRef.current !== folder) {
        await save(currentFolderRef.current);
      }
      currentFolderRef.current = folder;
      try {
        const raw = await invoke<string | null>('read_file_if_exists', { path: joinPath(folder, WHITEBOARD_FILE) });
        if (raw) {
          try {
            await loadSnapshot(JSON.parse(raw));
          } catch {
            await clearCanvas();
          }
        } else {
          await clearCanvas();
        }
      } catch (e) {
        logger.warn('[Whiteboard] load failed', e);
      }
    },
    [save, loadSnapshot, clearCanvas],
  );

  // Reopen a specific past meeting's board (meeting-details "Whiteboard" button).
  useEffect(() => {
    const onOpenSaved = (e: Event) => {
      const folder = (e as CustomEvent<{ folderPath?: string }>).detail?.folderPath || null;
      if (!folder) return;
      // Flag + target synchronously so the live-open effect doesn't re-resolve to the active meeting.
      openedSavedRef.current = folder;
      currentFolderRef.current = folder;
      showCanvas();
      void load(folder);
    };
    window.addEventListener('tandem:canvas-open-saved', onOpenSaved as EventListener);
    return () => window.removeEventListener('tandem:canvas-open-saved', onOpenSaved as EventListener);
  }, [load, showCanvas]);

  // Live meeting: load the active meeting's board when the canvas opens; save it when it closes.
  useEffect(() => {
    const wasVisible = prevVisibleRef.current;
    prevVisibleRef.current = canvasVisible;
    if (canvasVisible && !wasVisible) {
      // Opened via the meeting-details "Whiteboard" button — it already targeted + loaded that board.
      if (openedSavedRef.current) {
        openedSavedRef.current = null;
        return;
      }
      // Live open: load the ACTIVE meeting's board, swapping if it differs from what's loaded.
      invoke<string | null>('get_meeting_folder_path')
        .then((f) => {
          if (f && f !== currentFolderRef.current) void load(f);
        })
        .catch(() => {});
    } else if (!canvasVisible && wasVisible) {
      void save(currentFolderRef.current);
      openedSavedRef.current = null;
    }
  }, [canvasVisible, load, save]);

  // Auto-save when a recording ends (mirrors screenshot/clipboard persistence).
  useEffect(() => {
    if (!inTauri()) return;
    let un: UnlistenFn | undefined;
    let cancelled = false;
    listen('recording-stopped', () => {
      void save(currentFolderRef.current);
    }).then((fn) => {
      if (cancelled) fn();
      else un = fn;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [save]);

  // Reliable save on app quit: intercept the window close, finish the (async) save, then close.
  // beforeunload alone can't do this — the window tears down before the postMessage+IPC round-trip
  // completes — so we hold the close until the save resolves.
  useEffect(() => {
    if (!inTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let closing = false;
    (async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      const fn = await win.onCloseRequested(async (event) => {
        const folder = currentFolderRef.current;
        if (closing || !folder) return; // nothing to persist — let the close proceed normally
        event.preventDefault();
        closing = true;
        try {
          await save(folder);
        } catch {
          /* ignore — don't trap the user in an unclosable window */
        }
        await win.destroy();
      });
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [save]);
}

/** Mountable null-renderer so the hook can live once near the app root. */
export function WhiteboardPersistence() {
  useWhiteboardPersistence();
  return null;
}
