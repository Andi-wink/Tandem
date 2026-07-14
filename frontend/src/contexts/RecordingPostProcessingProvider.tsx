'use client';

import React, { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { appDataDir } from '@tauri-apps/api/path';
import { useRecordingStop } from '@/hooks/useRecordingStop';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { shouldAcceptToggle } from '@/lib/recordToggle';

/**
 * RecordingPostProcessingProvider
 *
 * This provider handles post-processing when recording stops from any source:
 * - Tray menu stop
 * - Global keyboard shortcut
 * - Overlay stop button
 * - Main UI stop button
 *
 * It listens for the 'recording-stop-complete' event from Rust backend
 * and triggers the full post-processing flow (save to database, navigate, analytics)
 * regardless of which page the user is currently on.
 */
export function RecordingPostProcessingProvider({ children }: { children: React.ReactNode }) {
  // No-op functions since the global RecordingStateContext already handles state updates
  // These are only needed for the hook's local component state management
  const setIsRecording = () => { };
  const setIsRecordingDisabled = () => { };

  const {
    handleRecordingStop,
  } = useRecordingStop(setIsRecording, setIsRecordingDisabled);

  // Global record hotkey (Alt+Shift+D, I4): read the live recording state through a ref so the
  // one-time listener never captures a stale value, and collapse OS key-repeat via a 1s debounce.
  const { isRecording } = useRecordingState();
  const isRecordingRef = useRef(isRecording);
  isRecordingRef.current = isRecording;
  const lastToggleRef = useRef<number | null>(null);

  // The toggle listener is registered once (empty deps) so it never re-attaches. Route, navigation
  // and the stop handler are read through refs so the listener always sees current values without
  // being torn down and rebuilt on every render.
  const pathname = usePathname();
  const router = useRouter();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const routerRef = useRef(router);
  routerRef.current = router;
  const handleRecordingStopRef = useRef(handleRecordingStop);
  handleRecordingStopRef.current = handleRecordingStop;

  useEffect(() => {
    let unlistenFn: (() => void) | undefined;

    const setupListener = async () => {
      try {
        // Listen for recording-stop-complete event from Rust
        unlistenFn = await listen<boolean>('recording-stop-complete', (event) => {
          console.log('[RecordingPostProcessing] Received recording-stop-complete event:', event.payload);

          // Call the post-processing handler
          // event.payload is the callApi boolean (true for normal stops)
          handleRecordingStop(event.payload);
        });

        console.log('[RecordingPostProcessing] Event listener set up successfully');
      } catch (error) {
        console.error('[RecordingPostProcessing] Failed to set up event listener:', error);
      }
    };

    setupListener();

    return () => {
      if (unlistenFn) {
        console.log('[RecordingPostProcessing] Cleaning up event listener');
        unlistenFn();
      }
    };
  }, [handleRecordingStop]);

  // Global record toggle: on Alt+Shift+D, start or stop recording from ANY page (the shortcut is
  // OS-level, so it fires even when Tandem is in the background — the Settings card promises this).
  //
  // On the home route the on-screen RecordingControls are mounted, so we reuse the exact DOM events
  // the record/stop button responds to (identical device selection, model validation, solo modal).
  // Off the home route those controls are unmounted, so we drive the recording directly:
  //   - stop: invoke the Rust stop command, then run the same post-processing the tray/UI stop runs
  //     (save + summary), so a hotkey stop from Settings/meeting-details never silently no-ops.
  //   - start: set the auto-start flag and navigate home, mirroring the tray and sidebar "New
  //     meeting" flow so the home page auto-starts with full device/model handling.
  // Debounced so OS key-repeat maps one intent to one toggle.
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;

    const stopFromAnywhere = async () => {
      // Home route: let the mounted controls own the full stop UI + post-processing.
      if (pathnameRef.current === '/') {
        window.dispatchEvent(new CustomEvent('tandem:request-stop-recording'));
        return;
      }
      // Off route: stop the Rust pipeline ourselves, then post-process. The stop command does not
      // emit 'recording-stop-complete' (only the tray does), so we call the handler directly.
      try {
        const dataDir = await appDataDir();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const savePath = `${dataDir}/recording-${timestamp}.wav`;
        await invoke('stop_recording', { args: { save_path: savePath } });
        // handleRecordingStop is idempotent (guarded by stopInProgressRef) so this is safe even if
        // another stop path races us.
        await handleRecordingStopRef.current(true);
      } catch (error) {
        console.error('[RecordingPostProcessing] Off-route hotkey stop failed:', error);
      }
    };

    const startFromAnywhere = () => {
      // Home route: reuse the on-screen start path (device pickers, solo pre-record modal, etc.).
      if (pathnameRef.current === '/') {
        window.dispatchEvent(new CustomEvent('tandem:request-start-recording'));
        return;
      }
      // Off route: navigate home and let the auto-start flag drive the full start flow there.
      try {
        sessionStorage.setItem('autoStartRecording', 'true');
      } catch { /* sessionStorage unavailable — navigation below still lands the user on home */ }
      routerRef.current.push('/');
    };

    const setupToggleListener = async () => {
      try {
        unlistenFn = await listen('global-record-toggle', () => {
          const now = Date.now();
          if (!shouldAcceptToggle(lastToggleRef.current, now)) {
            console.log('[RecordingPostProcessing] Ignoring repeated record toggle within debounce window');
            return;
          }
          lastToggleRef.current = now;

          if (isRecordingRef.current) {
            console.log('[RecordingPostProcessing] Alt+Shift+D — stopping recording');
            void stopFromAnywhere();
          } else {
            console.log('[RecordingPostProcessing] Alt+Shift+D — starting recording');
            startFromAnywhere();
          }
        });
      } catch (error) {
        console.error('[RecordingPostProcessing] Failed to set up record-toggle listener:', error);
      }
    };

    setupToggleListener();

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, []);

  return <>{children}</>;
}
