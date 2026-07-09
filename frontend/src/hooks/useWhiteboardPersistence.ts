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
import { useCanvas, type CanvasSaveResult } from '@/contexts/CanvasContext';
import { useSoloMode } from '@/contexts/SoloModeContext';
import { useClaude } from '@/contexts/ClaudeContext';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { storageService } from '@/services/storageService';
import { indexedDBService } from '@/services/indexedDBService';
import { logger } from '@/lib/logger';

export const WHITEBOARD_FILE = 'whiteboard.tldr.json';

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const joinPath = (folder: string, file: string) => `${folder}${folder.includes('\\') ? '\\' : '/'}${file}`;

/** Write a board's three artifacts ({stem}.tldr.json / .md / .png) into a directory. */
async function writeBoardArtifacts(dir: string, stem: string, result: CanvasSaveResult): Promise<void> {
  await invoke('save_transcript', { filePath: joinPath(dir, `${stem}.tldr.json`), content: JSON.stringify(result.snapshot) });
  if (result.markdown) {
    await invoke('save_transcript', { filePath: joinPath(dir, `${stem}.md`), content: result.markdown }).catch((e) =>
      logger.warn('[Whiteboard] md save failed', e),
    );
  }
  if (result.png) {
    await invoke('save_base64_file', { path: joinPath(dir, `${stem}.png`), base64: result.png }).catch((e) =>
      logger.warn('[Whiteboard] png save failed', e),
    );
  }
}

export function useWhiteboardPersistence() {
  const { canvasVisible, showCanvas, saveSnapshot, loadSnapshot, clearCanvas, boardReadOnly, setBoardReadOnly } =
    useCanvas();
  const { activeProject } = useSoloMode();
  const { meetingTitle } = useClaude();
  const { transcriptsRef, meetingTitle: transcriptMeetingTitle, currentMeetingId } = useTranscripts();
  const { status: recordingStatus } = useRecordingState();
  // Live refs so the (stable) quit-save callback always sees current recording state.
  const currentMeetingIdRef = useRef(currentMeetingId);
  currentMeetingIdRef.current = currentMeetingId;
  const transcriptMeetingTitleRef = useRef(transcriptMeetingTitle);
  transcriptMeetingTitleRef.current = transcriptMeetingTitle;
  const recordingStatusRef = useRef(recordingStatus);
  recordingStatusRef.current = recordingStatus;
  const currentFolderRef = useRef<string | null>(null);
  const prevVisibleRef = useRef(false);
  // Live refs so the (stable) save callback always sees the current client + title.
  const activeProjectRef = useRef(activeProject);
  activeProjectRef.current = activeProject;
  const titleRef = useRef(meetingTitle);
  titleRef.current = meetingTitle;
  // Live ref so the (stable) save callback can short-circuit while viewing a library board.
  const readOnlyRef = useRef(boardReadOnly);
  readOnlyRef.current = boardReadOnly;
  // Marks that the next canvas-open was triggered by the "open this saved board" path, so the live
  // open effect doesn't overwrite it with the active meeting's board.
  const openedSavedRef = useRef<string | null>(null);
  // Single-flight save per folder: coalesces concurrent saves (close + recording-stop + unload) so
  // two round-trips can't interleave torn writes to the same file.
  const savingRef = useRef<Map<string, Promise<void>>>(new Map());

  const save = useCallback(
    (folder: string | null): Promise<void> => {
      if (!folder || !inTauri()) return Promise.resolve();
      // Viewing a saved board from the client library: never persist it, so a peeked-at past board
      // can't overwrite the live meeting's board on close/stop/quit. (Adopting it via "Edit here"
      // clears boardReadOnly first, so saves resume into the current meeting.)
      if (readOnlyRef.current) return Promise.resolve();
      // Coalesce concurrent saves of the same folder onto one in-flight round-trip.
      const inflight = savingRef.current.get(folder);
      if (inflight) return inflight;
      const run = (async () => {
        try {
          const result = await saveSnapshot();
          if (!result?.snapshot) return; // board unreachable — don't clobber a good save with an empty one
          // 1) Per-meeting save (unchanged): <folder>/whiteboard.{tldr.json,md,png}.
          await writeBoardArtifacts(folder, 'whiteboard', result);
          // 2) Per-client library mirror (Solo project = client) — what the "Previous boards" picker
          //    reads. Keyed by the meeting folder leaf so re-saves overwrite the same entry, not pile up.
          const project = activeProjectRef.current;
          if (project?.path) {
            const sep = project.path.includes('\\') ? '\\' : '/';
            const dir = `${project.path}${sep}.tandem${sep}whiteboards`;
            const stem = folder.split(/[\\/]/).filter(Boolean).pop() || 'board';
            await writeBoardArtifacts(dir, stem, result);
            await invoke('save_transcript', {
              filePath: joinPath(dir, `${stem}.meta.json`),
              content: JSON.stringify({ title: titleRef.current || stem, savedAt: Date.now() }),
            }).catch((e) => logger.warn('[Whiteboard] meta save failed', e));
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

  // On quit, finish saving the current meeting's transcript to SQLite if the normal stop-recording
  // save (useRecordingStop) hasn't gotten there yet — e.g. the user clicked X right after Stop,
  // before the ~seconds-long transcription-wait/save chain completed. Without this, the meeting is
  // left flagged `savedToSQLite: false` in IndexedDB forever, and the next launch's recovery check
  // (useTranscriptRecovery) always finds it, even though nothing actually crashed.
  //
  // We poll the IndexedDB flag (rather than recording status) so we simply back off the instant the
  // normal save finishes, and only step in with our own fallback save if it hasn't in time — this
  // avoids writing a second, duplicate meeting row in the common case.
  const finishMeetingSaveIfNeeded = useCallback(async (): Promise<void> => {
    const meetingId = currentMeetingIdRef.current;
    if (!meetingId || !inTauri()) return;
    // Still actively recording (never stopped) — leave this to the existing crash-recovery path,
    // which also restores the audio itself from checkpoints. Finish-saving a truncated transcript
    // here would mark it "saved" and silently skip that audio recovery.
    if (recordingStatusRef.current === RecordingStatus.RECORDING) return;
    try {
      const POLL_MS = 300;
      const MAX_WAIT_MS = 8000;
      let waited = 0;
      let metadata = await indexedDBService.getMeetingMetadata(meetingId);
      while (metadata && !metadata.savedToSQLite && waited < MAX_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        waited += POLL_MS;
        metadata = await indexedDBService.getMeetingMetadata(meetingId);
      }
      if (!metadata || metadata.savedToSQLite) return; // already saved (by us waiting, or the normal flow)

      const transcripts = transcriptsRef.current;
      if (transcripts.length === 0) return; // nothing to save — let it be recoverable as usual

      const folderPath = metadata.folderPath ?? (await invoke<string | null>('get_meeting_folder_path').catch(() => null));
      const title = transcriptMeetingTitleRef.current || metadata.title || 'New Meeting';
      await storageService.saveMeeting(title, transcripts, folderPath ?? null);
      await indexedDBService.markMeetingSaved(meetingId);
    } catch (e) {
      // Best-effort: worse case is the existing recovery prompt on next launch, not data loss
      // (the raw segments are already in IndexedDB, saved incrementally as they arrived).
      logger.warn('[Quit] meeting finish-save failed', e);
    }
  }, [transcriptsRef]);

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
      // Reopening a past MEETING's board is editable (saves back to that meeting), unlike the
      // library "view" path below.
      readOnlyRef.current = false;
      setBoardReadOnly(false);
      showCanvas();
      void load(folder);
    };
    window.addEventListener('tandem:canvas-open-saved', onOpenSaved as EventListener);
    return () => window.removeEventListener('tandem:canvas-open-saved', onOpenSaved as EventListener);
  }, [load, showCanvas, setBoardReadOnly]);

  // View a saved board from the client library ("Previous boards" picker) — READ-ONLY: it loads for
  // inspection but is never written back, so it can't clobber the live meeting's board. "Edit here"
  // clears boardReadOnly to adopt it into the current meeting.
  useEffect(() => {
    const onViewBoard = (e: Event) => {
      const snapshot = (e as CustomEvent<{ snapshot?: unknown }>).detail?.snapshot;
      if (snapshot === undefined) return;
      void (async () => {
        // Persist the editable board currently open before replacing it with the read-only view.
        if (!readOnlyRef.current) await save(currentFolderRef.current);
        readOnlyRef.current = true;
        setBoardReadOnly(true);
        showCanvas();
        try {
          await loadSnapshot(snapshot ?? null);
        } catch {
          /* ignore */
        }
      })();
    };
    window.addEventListener('tandem:canvas-view-board', onViewBoard as EventListener);
    return () => window.removeEventListener('tandem:canvas-view-board', onViewBoard as EventListener);
  }, [save, loadSnapshot, showCanvas, setBoardReadOnly]);

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
      // Viewing a library board (read-only) — don't replace it with the live meeting's board.
      if (readOnlyRef.current) return;
      // Live open: load the ACTIVE meeting's board, swapping if it differs from what's loaded.
      invoke<string | null>('get_meeting_folder_path')
        .then((f) => {
          if (f && f !== currentFolderRef.current) void load(f);
        })
        .catch(() => {});
    } else if (!canvasVisible && wasVisible) {
      void save(currentFolderRef.current);
      openedSavedRef.current = null;
      // Closing clears any read-only view so the next open is the editable live board.
      readOnlyRef.current = false;
      setBoardReadOnly(false);
    }
  }, [canvasVisible, load, save, setBoardReadOnly]);

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

  // Reliable save on app quit: intercept the window close, finish the (async) save, then quit.
  // beforeunload alone can't do this — the window tears down before the postMessage+IPC round-trip
  // completes — so we hold the close until the save resolves.
  //
  // We quit via the process plugin's exit() rather than win.close()/win.destroy(). Calling close()
  // from inside a preventDefault'd close-requested handler does NOT reliably tear the window down on
  // Tauri v2/tao (the X appears dead — the bug this replaces), and destroy() races tao's event loop
  // and panics ("cannot move state from Destroyed") on Windows. exit(0) ends the app decisively and
  // still fires RunEvent::Exit, so the DB checkpoint + sidecar shutdown cleanup runs.
  useEffect(() => {
    if (!inTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let closing = false;
    (async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      const fn = await win.onCloseRequested(async (event) => {
        if (closing) return; // quit already in progress — let it proceed
        closing = true;
        event.preventDefault();
        const folder = currentFolderRef.current;
        try {
          // NEVER trap the user in an unclosable window: the whiteboard save is a postMessage
          // round-trip to the canvas iframe (can hang if it's not ready) and the meeting finish-save
          // polls for the normal stop-recording save to land — so the whole thing is capped.
          await Promise.race([
            Promise.all([save(folder), finishMeetingSaveIfNeeded()]),
            new Promise((resolve) => setTimeout(resolve, 9000)),
          ]);
        } catch {
          /* ignore — best-effort save */
        }
        try {
          const { exit } = await import('@tauri-apps/plugin-process');
          await exit(0);
        } catch (e) {
          // Process plugin unavailable — fall back to a plain close (re-enters with closing=true,
          // which returns early without preventDefault, so the teardown proceeds).
          logger.warn('[Whiteboard] process.exit failed; falling back to window close', e);
          await win.close().catch(() => {});
        }
      });
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [save, finishMeetingSaveIfNeeded]);
}

/** Mountable null-renderer so the hook can live once near the app root. */
export function WhiteboardPersistence() {
  useWhiteboardPersistence();
  return null;
}
