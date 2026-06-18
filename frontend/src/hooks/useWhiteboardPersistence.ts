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

  const save = useCallback(
    async (folder: string | null) => {
      if (!folder || !inTauri()) return;
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
      currentFolderRef.current = folder; // set synchronously so the visibility effect doesn't re-resolve
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
      if (!currentFolderRef.current) {
        invoke<string | null>('get_meeting_folder_path')
          .then((f) => {
            if (f) void load(f);
          })
          .catch(() => {});
      }
    } else if (!canvasVisible && wasVisible) {
      void save(currentFolderRef.current);
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

  // Best-effort save when the app window is closing.
  useEffect(() => {
    const onBeforeUnload = () => {
      void save(currentFolderRef.current);
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [save]);
}

/** Mountable null-renderer so the hook can live once near the app root. */
export function WhiteboardPersistence() {
  useWhiteboardPersistence();
  return null;
}
