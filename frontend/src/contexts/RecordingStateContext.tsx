'use client';

import React, { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { recordingService } from '@/services/recordingService';
import { toast } from 'sonner';

/**
 * Recording state synchronized with backend
 * This context provides a single source of truth for recording state
 * that automatically syncs with the Rust backend, solving:
 * 1. Page refresh desync (backend recording but UI shows stopped)
 * 2. Pause state visibility across components
 * 3. Comprehensive state for future features (reconnection, etc.)
 */

// Recording lifecycle status enum
export enum RecordingStatus {
  IDLE = 'idle',                          // Not recording
  STARTING = 'starting',                  // Initiating recording
  RECORDING = 'recording',                // Active recording
  STOPPING = 'stopping',                  // Stop initiated, waiting for backend
  PROCESSING_TRANSCRIPTS = 'processing',  // Transcription completion wait
  SAVING = 'saving',                      // Saving to database
  COMPLETED = 'completed',                // Successfully saved
  ERROR = 'error'                         // Error occurred
}

export type RecordingMode = 'meeting' | 'solo';

interface RecordingState {
  isRecording: boolean;           // Is a recording session active
  isPaused: boolean;              // Is the recording paused
  isActive: boolean;              // Is actively recording (recording && !paused)
  recordingDuration: number | null;  // Total duration including pauses
  activeDuration: number | null;     // Active recording time (excluding pauses)

  // NEW: Lifecycle status
  status: RecordingStatus;
  statusMessage?: string;  // Optional message for current status

  // Solo Mode: recording mode selector
  recordingMode: RecordingMode;
}

interface RecordingStateContextType extends RecordingState {
  // NEW: Setters for status management
  setStatus: (status: RecordingStatus, message?: string) => void;
  setRecordingMode: (mode: RecordingMode) => void;

  // Computed helpers (derived from status)
  isStopping: boolean;
  isProcessing: boolean;
  isSaving: boolean;
}

const RecordingStateContext = createContext<RecordingStateContextType | null>(null);

export const useRecordingState = () => {
  const context = useContext(RecordingStateContext);
  if (!context) {
    throw new Error('useRecordingState must be used within a RecordingStateProvider');
  }
  return context;
};

export function RecordingStateProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<RecordingState>({
    isRecording: false,
    isPaused: false,
    isActive: false,
    recordingDuration: null,
    activeDuration: null,
    status: RecordingStatus.IDLE,
    statusMessage: undefined,
    recordingMode: (typeof window !== 'undefined'
      ? (localStorage.getItem('tandem-recording-mode') as RecordingMode) ?? 'meeting'
      : 'meeting') as RecordingMode,
  });

  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // R016: Status setter — uses functional update to avoid stale closure
  const setStatus = useCallback((newStatus: RecordingStatus, message?: string) => {
    setState(prev => {
      console.log(`[RecordingState] Status: ${prev.status} → ${newStatus}`, message || '');
      return {
        ...prev,
        status: newStatus,
        statusMessage: message,
      };
    });
  }, []);

  const setRecordingMode = useCallback((mode: RecordingMode) => {
    localStorage.setItem('tandem-recording-mode', mode);
    setState(prev => ({ ...prev, recordingMode: mode }));
  }, []);

  /**
   * Sync recording state with backend
   * Called on mount (fixes refresh desync) and periodically while recording
   */
  const syncWithBackend = async () => {
    try {
      const backendState = await recordingService.getRecordingState();

      setState(prev => ({
        ...prev,
        isRecording: backendState.is_recording,
        isPaused: backendState.is_paused,
        isActive: backendState.is_active,
        recordingDuration: backendState.recording_duration,
        activeDuration: backendState.active_duration,
      }));

      console.log('[RecordingStateContext] Synced with backend:', backendState);
    } catch (error) {
      console.error('[RecordingStateContext] Failed to sync with backend:', error);
      // Don't update state on error - keep current state
    }
  };

  /**
   * Start polling backend state (called when recording starts)
   */
  const startPolling = () => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
    }

    console.log('[RecordingStateContext] Starting state polling (500ms interval)');
    pollingIntervalRef.current = setInterval(syncWithBackend, 500);
  };

  /**
   * Stop polling backend state (called when recording stops)
   */
  const stopPolling = () => {
    if (pollingIntervalRef.current) {
      console.log('[RecordingStateContext] Stopping state polling');
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  };

  /**
   * Set up event listeners for backend state changes
   */
  useEffect(() => {
    console.log('[RecordingStateContext] Setting up event listeners');
    // Guard against the async-setup race: if cleanup runs before setupListeners finishes
    // awaiting a registration, `cancelled` short-circuits any remaining registrations and
    // immediately unsubscribes the one that just resolved, so no listener leaks past unmount.
    let cancelled = false;
    const unsubscribers: (() => void)[] = [];

    const setupListeners = async () => {
      try {
        // Recording started
        const unlistenStarted = await recordingService.onRecordingStarted(() => {
          console.log('[RecordingStateContext] Recording started event');
          setState(prev => ({
            ...prev,
            isRecording: true,
            isPaused: false,
            isActive: true,
            status: RecordingStatus.RECORDING,  // NEW: Set status to RECORDING
          }));
          toast.success('Recording started', { duration: 2000 });
          startPolling();
        });
        if (cancelled) { unlistenStarted(); return; }
        unsubscribers.push(unlistenStarted);

        // Recording stopped
        const unlistenStopped = await recordingService.onRecordingStopped((payload) => {
          console.log('[RecordingStateContext] Recording stopped event:', payload);
          setState(prev => {
            // Set status to STOPPING if not already in stop flow
            // This ensures smooth UI transition for tray/keyboard stops
            const newStatus = [
              RecordingStatus.STOPPING,
              RecordingStatus.PROCESSING_TRANSCRIPTS,
              RecordingStatus.SAVING
            ].includes(prev.status)
              ? prev.status  // Already in stop flow
              : RecordingStatus.STOPPING;  // New stop, transition smoothly

            return {
              ...prev,
              status: newStatus,
              statusMessage: newStatus === RecordingStatus.STOPPING ? 'Stopping recording...' : prev.statusMessage,
              isRecording: false,
              isPaused: false,
              isActive: false,
              recordingDuration: null,
              activeDuration: null,
            };
          });
          stopPolling();
        });
        if (cancelled) { unlistenStopped(); return; }
        unsubscribers.push(unlistenStopped);

        // Recording paused
        const unlistenPaused = await recordingService.onRecordingPaused(() => {
          console.log('[RecordingStateContext] Recording paused event');
          setState(prev => ({
            ...prev,
            isPaused: true,
            isActive: false,
          }));
          toast.info('Recording paused', { duration: 2000 });
        });
        if (cancelled) { unlistenPaused(); return; }
        unsubscribers.push(unlistenPaused);

        // Recording resumed
        const unlistenResumed = await recordingService.onRecordingResumed(() => {
          console.log('[RecordingStateContext] Recording resumed event');
          setState(prev => ({
            ...prev,
            isPaused: false,
            isActive: true,
          }));
          toast.success('Recording resumed', { duration: 2000 });
        });
        if (cancelled) { unlistenResumed(); return; }
        unsubscribers.push(unlistenResumed);

        // Transcription degraded (live path fell back to batch, or the realtime
        // catch-up buffer hit its cap). The recording is fine and continues, so
        // this is a warning rather than an error. The backend emits each of these
        // at most once per recording, so no de-duplication is needed here.
        const unlistenTranscriptionWarning = await recordingService.onTranscriptionWarning(
          (message) => {
            console.warn('[RecordingStateContext] Transcription warning:', message);
            toast.warning(message, { duration: 8000 });
          }
        );
        if (cancelled) { unlistenTranscriptionWarning(); return; }
        unsubscribers.push(unlistenTranscriptionWarning);

        console.log('[RecordingStateContext] Event listeners set up successfully');
      } catch (error) {
        console.error('[RecordingStateContext] Failed to set up event listeners:', error);
      }
    };

    setupListeners();

    return () => {
      console.log('[RecordingStateContext] Cleaning up event listeners');
      cancelled = true;
      unsubscribers.forEach(unsub => unsub());
      stopPolling();
    };
  }, []);

  /**
   * Initial sync on mount - CRITICAL for fixing refresh desync bug
   * If backend is recording but UI state is false, this will correct it
   */
  useEffect(() => {
    console.log('[RecordingStateContext] Initial mount - syncing with backend');
    syncWithBackend();
  }, []);

  // Computed helpers from status
  const contextValue = useMemo(() => ({
    ...state,
    setStatus,
    setRecordingMode,
    isStopping: state.status === RecordingStatus.STOPPING,
    isProcessing: state.status === RecordingStatus.PROCESSING_TRANSCRIPTS,
    isSaving: state.status === RecordingStatus.SAVING,
  }), [state, setStatus, setRecordingMode]);

  return (
    <RecordingStateContext.Provider value={contextValue}>
      {children}
    </RecordingStateContext.Provider>
  );
}
