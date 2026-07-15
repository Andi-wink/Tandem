'use client';

import React, { createContext, useContext, useCallback, useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { listen } from '@tauri-apps/api/event';
import { useRecordingStop } from '@/hooks/useRecordingStop';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { shouldAcceptToggle } from '@/lib/recordToggle';
import { stopRecordingViaPipeline } from '@/lib/stopRecordingFlow';

/**
 * Off-route recording stop, shared beyond this provider. The I5b meeting handover needs to stop the
 * current recording through the exact same path as the I4 hotkey stop (invoke stop_recording + full
 * handleRecordingStop post-processing) and AWAIT it before starting the next meeting, so it consumes
 * this rather than re-implementing the sequence.
 */
export interface RecordingStopControls {
  /** Stop the active recording and run full post-processing; resolves once transcripts are saved. */
  stopActiveRecording: () => Promise<void>;
}

const RecordingStopContext = createContext<RecordingStopControls | null>(null);

export function useRecordingStopControls(): RecordingStopControls {
  const ctx = useContext(RecordingStopContext);
  if (!ctx) throw new Error('useRecordingStopControls must be used within RecordingPostProcessingProvider');
  return ctx;
}

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

  // Global record hotkey (Alt+Shift+E, I4): read the live recording state through a ref so the
  // one-time listener never captures a stale value, and collapse OS key-repeat via a 1s debounce.
  const { isRecording } = useRecordingState();
  const isRecordingRef = useRef(isRecording);
  isRecordingRef.current = isRecording;
  const lastToggleRef = useRef<number | null>(null);

  // True while an I5b handover is stopping the current recording and seeding the next (bracketed by the
  // 'tandem:recording-transition' event the handover already emits). During that transition isRecording
  // flips false partway through, so an Alt+Shift+E toggle would otherwise (a) fire a SECOND independent
  // stop pipeline against the still-live recording, or (b) start an unrelated recording that races the
  // handover's own seeded start. We make the toggle a no-op in BOTH directions until the transition
  // ends. Read through a ref because the toggle listener is registered once (empty deps).
  const handoverActiveRef = useRef(false);
  useEffect(() => {
    const onTransition = (e: Event) => {
      handoverActiveRef.current = !!(e as CustomEvent<{ active?: boolean }>).detail?.active;
    };
    window.addEventListener('tandem:recording-transition', onTransition as EventListener);
    return () => window.removeEventListener('tandem:recording-transition', onTransition as EventListener);
  }, []);

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

  // Global record toggle: on Alt+Shift+E, start or stop recording from ANY page (the shortcut is
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
      // Off route: stop the Rust pipeline ourselves, then post-process, via the shared helper. It is
      // idempotent (handleRecordingStop is guarded by stopInProgressRef) so this is safe even if
      // another stop path races us.
      try {
        await stopRecordingViaPipeline(handleRecordingStopRef.current);
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
          // A handover is mid-flight: swallow the toggle entirely (both start and stop). Acting now
          // would double-stop the still-live recording or race the handover's seeded start.
          if (handoverActiveRef.current) {
            console.log('[RecordingPostProcessing] Ignoring record toggle during handover transition');
            return;
          }
          lastToggleRef.current = now;

          if (isRecordingRef.current) {
            console.log('[RecordingPostProcessing] Alt+Shift+E, stopping recording');
            void stopFromAnywhere();
          } else {
            console.log('[RecordingPostProcessing] Alt+Shift+E, starting recording');
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

  // Stable, always-current stop entry point for consumers (I5b handover). Reads handleRecordingStop
  // through its ref so the callback identity never changes yet always runs the latest handler.
  const stopActiveRecording = useCallback(
    () => stopRecordingViaPipeline(handleRecordingStopRef.current),
    [],
  );

  return (
    <RecordingStopContext.Provider value={{ stopActiveRecording }}>
      {children}
    </RecordingStopContext.Provider>
  );
}
