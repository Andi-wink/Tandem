'use client';

import React, { createContext, useContext, useState, useEffect, useRef, useCallback, ReactNode, MutableRefObject } from 'react';
import { Transcript, TranscriptUpdate, TranscriptPartial } from '@/types';
import { toast } from 'sonner';
import { useRecordingState } from './RecordingStateContext';
import { transcriptService } from '@/services/transcriptService';
import { recordingService } from '@/services/recordingService';
import { indexedDBService } from '@/services/indexedDBService';
import { installDevTranscriptEmitter } from '@/lib/devTranscriptEmitter';

interface TranscriptContextType {
  transcripts: Transcript[];
  // Volatile partial tails, keyed by source ("Local" / "Remote"). Never persisted;
  // replaced in place by incoming `transcript-partial` events, cleared when the
  // matching committed segment arrives or recording stops.
  pendingBySource: Record<string, string>;
  transcriptsRef: MutableRefObject<Transcript[]>
  addTranscript: (update: TranscriptUpdate) => void;
  updateTranscriptText: (transcriptId: string, newText: string) => void;
  copyTranscript: () => void;
  flushBuffer: () => void;
  transcriptContainerRef: React.RefObject<HTMLDivElement>;
  meetingTitle: string;
  setMeetingTitle: (title: string) => void;
  clearTranscripts: () => void;
  currentMeetingId: string | null;
  markMeetingAsSaved: () => Promise<void>;
}

const TranscriptContext = createContext<TranscriptContextType | undefined>(undefined);

export function TranscriptProvider({ children }: { children: ReactNode }) {
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [meetingTitle, setMeetingTitle] = useState('+ New Call');
  const [currentMeetingId, setCurrentMeetingId] = useState<string | null>(null);

  // ── Volatile partial ("live") tails, one per source ─────────────────────────
  // Rendered state consumed by the transcript view. Only ever holds unpersisted,
  // revisable text; committed segments flow through `transcripts` untouched.
  const [pendingBySource, setPendingBySource] = useState<Record<string, string>>({});
  // Staging ref is the source of truth between RAF flushes; partials can arrive
  // >10/sec, so we coalesce them and push to React state at most once per frame.
  const pendingStagingRef = useRef<Record<string, string>>({});
  const pendingRafRef = useRef<number | null>(null);
  // Last session_seq seen per source, to drop stale / out-of-order partials.
  const lastSeqBySourceRef = useRef<Record<string, number>>({});

  const flushPending = useCallback(() => {
    pendingRafRef.current = null;
    setPendingBySource({ ...pendingStagingRef.current });
  }, []);

  const schedulePendingFlush = useCallback(() => {
    if (pendingRafRef.current !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      pendingRafRef.current = requestAnimationFrame(flushPending);
    } else {
      // Fallback for environments without RAF: flush on next tick.
      pendingRafRef.current = setTimeout(flushPending, 16) as unknown as number;
    }
  }, [flushPending]);

  // Apply an incoming partial: replace the tail for its source in place. Within an
  // utterance, session_seq is monotonic, so a LOWER seq is a late/out-of-order
  // delivery and is dropped. The counter can legitimately RESTART lower across an
  // utterance boundary or a Rust WS reconnect; clearPendingSource resets the per-
  // source baseline on commit so a restart is never mistaken for a stale partial.
  const applyPartial = useCallback((partial: TranscriptPartial) => {
    const { source, text, session_seq } = partial;
    // Payload validation: a missing source or a non-finite seq (NaN/undefined)
    // must never poison lastSeqBySourceRef or the staged tails.
    if (!source || !Number.isFinite(session_seq)) return;
    const lastSeq = lastSeqBySourceRef.current[source];
    if (lastSeq !== undefined && session_seq < lastSeq) {
      return; // stale — a newer partial for this source already applied
    }
    lastSeqBySourceRef.current[source] = session_seq;
    const nextText = text ?? '';
    const nextStaging: Record<string, string> = { ...pendingStagingRef.current };
    if (nextText.trim() === '') {
      // Empty tail carries nothing to render; drop the key so it can't inflate the
      // rendered tail count (which drives the per-source label heuristic).
      delete nextStaging[source];
    } else {
      nextStaging[source] = nextText;
    }
    pendingStagingRef.current = nextStaging;
    schedulePendingFlush();
  }, [schedulePendingFlush]);

  // Clear the pending tail for a single source (committed segment supersedes it).
  const clearPendingSource = useCallback((source: string) => {
    if (!source) return;
    // Reset the per-source seq baseline: the next utterance may restart the counter
    // lower, and it must be allowed to render rather than being dropped as "stale".
    delete lastSeqBySourceRef.current[source];
    if (pendingStagingRef.current[source] === undefined) return;
    const nextStaging: Record<string, string> = {};
    for (const [k, v] of Object.entries(pendingStagingRef.current)) {
      if (k !== source) nextStaging[k] = v;
    }
    pendingStagingRef.current = nextStaging;
    setPendingBySource(prev => {
      if (prev[source] === undefined) return prev;
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (k !== source) next[k] = v;
      }
      return next;
    });
  }, []);

  // Clear all pending tails (recording stop / new recording).
  const clearAllPending = useCallback(() => {
    pendingStagingRef.current = {};
    lastSeqBySourceRef.current = {};
    if (pendingRafRef.current !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pendingRafRef.current);
      else clearTimeout(pendingRafRef.current as unknown as ReturnType<typeof setTimeout>);
      pendingRafRef.current = null;
    }
    setPendingBySource(prev => (Object.keys(prev).length === 0 ? prev : {}));
  }, []);

  // Recording state context - provides backend-synced state
  const recordingState = useRecordingState();

  // Refs for transcript management
  const transcriptsRef = useRef<Transcript[]>(transcripts);
  const isUserAtBottomRef = useRef<boolean>(true);
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  const finalFlushRef = useRef<(() => void) | null>(null);

  // Keep ref updated with current transcripts
  useEffect(() => {
    transcriptsRef.current = transcripts;
  }, [transcripts]);

  // Smart auto-scroll: Track user scroll position
  useEffect(() => {
    const handleScroll = () => {
      const container = transcriptContainerRef.current;
      if (!container) return;

      const { scrollTop, scrollHeight, clientHeight } = container;
      const isAtBottom = scrollTop + clientHeight >= scrollHeight - 10; // 10px tolerance
      isUserAtBottomRef.current = isAtBottom;
    };

    const container = transcriptContainerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll);
      return () => container.removeEventListener('scroll', handleScroll);
    }
  }, []);

  // Auto-scroll when transcripts change (only if user is at bottom)
  useEffect(() => {
    // Only auto-scroll if user was at the bottom before new content
    if (isUserAtBottomRef.current && transcriptContainerRef.current) {
      // Wait for Framer Motion animation to complete (150ms) before scrolling
      // This ensures scrollHeight includes the full rendered height of the new transcript
      const scrollTimeout = setTimeout(() => {
        const container = transcriptContainerRef.current;
        if (container) {
          container.scrollTo({
            top: container.scrollHeight,
            behavior: 'smooth'
          });
        }
      }, 150); // Match Framer Motion transition duration

      return () => clearTimeout(scrollTimeout);
    }
  }, [transcripts]);

  // Initialize IndexedDB and listen for recording-started/stopped events
  useEffect(() => {
    let mounted = true;
    let unlistenRecordingStarted: (() => void) | undefined;
    let unlistenRecordingStopped: (() => void) | undefined;

    const setupRecordingListeners = async () => {
      try {
        // Initialize IndexedDB
        await indexedDBService.init();

        // Listen for recording-started event
        const startedUnlisten = await recordingService.onRecordingStarted(async () => {
          try {
            // Generate unique meeting ID
            const meetingId = `meeting-${Date.now()}`;
            setCurrentMeetingId(meetingId);

            // Store in sessionStorage as fallback for markMeetingAsSaved
            sessionStorage.setItem('indexeddb_current_meeting_id', meetingId);
            console.log('[Recording Started] 💾 IndexedDB meeting ID stored:', meetingId);

            // Get meeting name
            const meetingName = await recordingService.getRecordingMeetingName();

            // Use a better fallback that matches the backend's naming pattern
            const effectiveTitle = meetingName || `Meeting ${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}`;

            // Initialize meeting metadata in IndexedDB
            await indexedDBService.saveMeetingMetadata({
              meetingId,
              title: effectiveTitle,
              startTime: Date.now(),
              lastUpdated: Date.now(),
              transcriptCount: 0,
              savedToSQLite: false,
              folderPath: undefined // Will update shortly
            });

            // Synchronize meeting title to state (fixes tray stop title issue)
            setMeetingTitle(effectiveTitle);

            // Fetch folder path from backend and update metadata
            // This ensures folder path is persisted even if app crashes
            try {
              const { invoke } = await import('@tauri-apps/api/core');
              const folderPath = await invoke<string>('get_meeting_folder_path');
              if (folderPath) {
                const metadata = await indexedDBService.getMeetingMetadata(meetingId);
                if (metadata) {
                  metadata.folderPath = folderPath;
                  await indexedDBService.saveMeetingMetadata(metadata);
                }
              }
            } catch (error) {
              // Non-fatal - will be set on stop if recording completes normally
            }
          } catch (error) {
            console.error('Failed to initialize meeting in IndexedDB:', error);
          }
        });
        if (!mounted) { startedUnlisten(); return; }
        unlistenRecordingStarted = startedUnlisten;

        // Listen for recording-stopped event
        const stoppedUnlisten = await recordingService.onRecordingStopped(async (payload) => {
          try {
            // Recording ended: no more partials will arrive; drop any live tails.
            clearAllPending();
            if (currentMeetingId) {
              // Update folder path in IndexedDB
              const metadata = await indexedDBService.getMeetingMetadata(currentMeetingId);

              if (metadata && payload.folder_path) {
                metadata.folderPath = payload.folder_path;
                await indexedDBService.saveMeetingMetadata(metadata);
              }
            }
          } catch (error) {
            console.error('Failed to update meeting metadata on stop:', error);
          }
        });
        if (!mounted) { stoppedUnlisten(); return; }
        unlistenRecordingStopped = stoppedUnlisten;
      } catch (error) {
        console.error('Failed to setup recording listeners:', error);
      }
    };

    setupRecordingListeners();

    return () => {
      mounted = false;
      if (unlistenRecordingStarted) {
        unlistenRecordingStarted();
        console.log('🧹 Recording started listener cleaned up');
      }
      if (unlistenRecordingStopped) {
        unlistenRecordingStopped();
        console.log('🧹 Recording stopped listener cleaned up');
      }
    };
  }, [currentMeetingId]);

  // Main transcript buffering logic with sequence_id ordering
  useEffect(() => {
    let mounted = true;
    let unlistenFn: (() => void) | undefined;
    let transcriptCounter = 0;
    let transcriptBuffer = new Map<number, Transcript>();
    let lastProcessedSequence = 0;
    let processingTimer: NodeJS.Timeout | undefined;

    const processBufferedTranscripts = (forceFlush = false) => {
      const sortedTranscripts: Transcript[] = [];

      // Process all available sequential transcripts
      let nextSequence = lastProcessedSequence + 1;
      while (transcriptBuffer.has(nextSequence)) {
        const bufferedTranscript = transcriptBuffer.get(nextSequence)!;
        sortedTranscripts.push(bufferedTranscript);
        transcriptBuffer.delete(nextSequence);
        lastProcessedSequence = nextSequence;
        nextSequence++;
      }

      // Add any buffered transcripts that might be out of order
      const now = Date.now();
      const staleThreshold = 100;  // 100ms safety net only (serial workers = sequential order)
      const recentThreshold = 0;    // Show immediately - no delay needed with serial processing
      const staleTranscripts: Transcript[] = [];
      const recentTranscripts: Transcript[] = [];
      const forceFlushTranscripts: Transcript[] = [];

      for (const [sequenceId, transcript] of transcriptBuffer.entries()) {
        if (forceFlush) {
          // Force flush mode: process ALL remaining transcripts regardless of timing
          forceFlushTranscripts.push(transcript);
          transcriptBuffer.delete(sequenceId);
          console.log(`Force flush: processing transcript with sequence_id ${sequenceId}`);
        } else {
          const transcriptAge = now - parseInt(transcript.id.split('-')[0]);
          if (transcriptAge > staleThreshold) {
            // Process stale transcripts (>100ms old - safety net)
            staleTranscripts.push(transcript);
            transcriptBuffer.delete(sequenceId);
          } else if (transcriptAge >= recentThreshold) {
            // Process immediately (0ms threshold with serial workers)
            recentTranscripts.push(transcript);
            transcriptBuffer.delete(sequenceId);
            console.log(`Processing transcript with sequence_id ${sequenceId}, age: ${transcriptAge}ms`);
          }
        }
      }

      // Sort both stale and recent transcripts by chunk_start_time, then by sequence_id
      const sortTranscripts = (transcripts: Transcript[]) => {
        return transcripts.sort((a, b) => {
          const chunkTimeDiff = (a.chunk_start_time || 0) - (b.chunk_start_time || 0);
          if (chunkTimeDiff !== 0) return chunkTimeDiff;
          return (a.sequence_id || 0) - (b.sequence_id || 0);
        });
      };

      const sortedStaleTranscripts = sortTranscripts(staleTranscripts);
      const sortedRecentTranscripts = sortTranscripts(recentTranscripts);
      const sortedForceFlushTranscripts = sortTranscripts(forceFlushTranscripts);

      const allNewTranscripts = [...sortedTranscripts, ...sortedRecentTranscripts, ...sortedStaleTranscripts, ...sortedForceFlushTranscripts];

      if (allNewTranscripts.length > 0) {
        setTranscripts(prev => {
          // Create a set of existing sequence_ids for deduplication
          const existingSequenceIds = new Set(prev.map(t => t.sequence_id).filter(id => id !== undefined));

          // Filter out any new transcripts that already exist
          const uniqueNewTranscripts = allNewTranscripts.filter(transcript =>
            transcript.sequence_id !== undefined && !existingSequenceIds.has(transcript.sequence_id)
          );

          // Only combine if we have unique new transcripts
          if (uniqueNewTranscripts.length === 0) {
            console.log('No unique transcripts to add - all were duplicates');
            return prev; // No new unique transcripts to add
          }

          console.log(`Adding ${uniqueNewTranscripts.length} unique transcripts out of ${allNewTranscripts.length} received`);

          // Merge with existing transcripts, maintaining chronological order
          const combined = [...prev, ...uniqueNewTranscripts];

          // Sort by chunk_start_time first, then by sequence_id
          return combined.sort((a, b) => {
            const chunkTimeDiff = (a.chunk_start_time || 0) - (b.chunk_start_time || 0);
            if (chunkTimeDiff !== 0) return chunkTimeDiff;
            return (a.sequence_id || 0) - (b.sequence_id || 0);
          });
        });

        // Log the processing summary
        const logMessage = forceFlush
          ? `Force flush processed ${allNewTranscripts.length} transcripts (${sortedTranscripts.length} sequential, ${forceFlushTranscripts.length} forced)`
          : `Processed ${allNewTranscripts.length} transcripts (${sortedTranscripts.length} sequential, ${recentTranscripts.length} recent, ${staleTranscripts.length} stale)`;
        console.log(logMessage);
      }
    };

    // Assign final flush function to ref for external access
    finalFlushRef.current = () => processBufferedTranscripts(true);

    const setupListener = async () => {
      try {
        console.log('🔥 Setting up MAIN transcript listener during component initialization...');
        const unlisten = await transcriptService.onTranscriptUpdate((update) => {
          const now = Date.now();
          console.log('🎯 MAIN LISTENER: Received transcript update:', {
            sequence_id: update.sequence_id,
            text: update.text.substring(0, 50) + '...',
            timestamp: update.timestamp,
            is_partial: update.is_partial,
            received_at: new Date(now).toISOString(),
            buffer_size_before: transcriptBuffer.size
          });

          // Check for duplicate sequence_id before processing
          if (transcriptBuffer.has(update.sequence_id)) {
            console.log('🚫 MAIN LISTENER: Duplicate sequence_id, skipping buffer:', update.sequence_id);
            return;
          }

          // Create transcript for buffer with NEW timestamp fields
          const newTranscript: Transcript = {
            id: `${Date.now()}-${transcriptCounter++}`,
            text: update.text,
            timestamp: update.timestamp,
            sequence_id: update.sequence_id,
            chunk_start_time: update.chunk_start_time,
            is_partial: update.is_partial,
            confidence: update.confidence,
            // NEW: Recording-relative timestamps for playback sync
            audio_start_time: update.audio_start_time,
            audio_end_time: update.audio_end_time,
            duration: update.duration,
          };

          // Add to buffer
          transcriptBuffer.set(update.sequence_id, newTranscript);
          console.log(`✅ MAIN LISTENER: Buffered transcript with sequence_id ${update.sequence_id}. Buffer size: ${transcriptBuffer.size}, Last processed: ${lastProcessedSequence}`);

          // A committed segment supersedes the volatile tail for its source.
          if (update.source) {
            clearPendingSource(update.source);
          }

          // Save to IndexedDB (non-blocking)
          if (currentMeetingId) {
            indexedDBService.saveTranscript(currentMeetingId, update)
              .catch(err => console.warn('IndexedDB save failed:', err));
          }

          // Clear any existing timer and set a new one
          if (processingTimer) {
            clearTimeout(processingTimer);
          }

          // Process buffer with minimal delay for immediate UI updates (serial workers = sequential order)
          processingTimer = setTimeout(processBufferedTranscripts, 10);
        });
        if (!mounted) { unlisten(); return; }
        unlistenFn = unlisten;
        console.log('✅ MAIN transcript listener setup complete');
      } catch (error) {
        console.error('❌ Failed to setup MAIN transcript listener:', error);
        alert('Failed to setup transcript listener. Check console for details.');
      }
    };

    setupListener();
    console.log('Started enhanced listener setup');

    return () => {
      mounted = false;
      console.log('🧹 CLEANUP: Cleaning up MAIN transcript listener...');
      if (processingTimer) {
        clearTimeout(processingTimer);
        console.log('🧹 CLEANUP: Cleared processing timer');
      }
      if (unlistenFn) {
        unlistenFn();
        console.log('🧹 CLEANUP: MAIN transcript listener cleaned up');
      }
    };
  }, [currentMeetingId]); // Add currentMeetingId dependency

  // ── Volatile partial ("live") tail listener ─────────────────────────────────
  // Registered exactly once (empty deps). Reads/writes only the pending refs +
  // state via stable callbacks, so it never needs to re-subscribe. This path is
  // isolated from the committed flow above: partials never touch `transcripts`,
  // IndexedDB, or backend persistence.
  useEffect(() => {
    let mounted = true;
    let unlistenPartial: (() => void) | undefined;

    const setupPartialListener = async () => {
      try {
        const unlisten = await transcriptService.onTranscriptPartial((partial) => {
          applyPartial(partial);
        });
        if (!mounted) { unlisten(); return; }
        unlistenPartial = unlisten;
      } catch (error) {
        console.error('❌ Failed to setup transcript-partial listener:', error);
      }
    };

    setupPartialListener();

    return () => {
      mounted = false;
      if (unlistenPartial) unlistenPartial();
      clearAllPending();
    };
  }, [applyPartial, clearAllPending]);

  // Dev / e2e only: expose synthetic partial-emitter helpers on window so the
  // volatile-tail layer can be driven before the Rust engine (Phase 2) exists.
  useEffect(() => {
    return installDevTranscriptEmitter();
  }, []);

  // Sync transcript history and meeting name from backend on reload
  // This fixes the issue where reloading during active recording causes state desync
  useEffect(() => {
    const syncFromBackend = async () => {
      // If recording is active and we have no local transcripts, sync from backend
      if (recordingState.isRecording && transcripts.length === 0) {
        try {
          console.log('[Reload Sync] Recording active after reload, syncing transcript history...');

          // Fetch transcript history from backend
          const history = await transcriptService.getTranscriptHistory();
          console.log(`[Reload Sync] Retrieved ${history.length} transcript segments from backend`);

          // Convert backend format to frontend Transcript format
          const formattedTranscripts: Transcript[] = history.map((segment: any) => ({
            id: segment.id,
            text: segment.text,
            timestamp: segment.display_time, // Use display_time for UI
            sequence_id: segment.sequence_id,
            chunk_start_time: segment.audio_start_time,
            is_partial: false, // History segments are always final
            confidence: segment.confidence,
            audio_start_time: segment.audio_start_time,
            audio_end_time: segment.audio_end_time,
            duration: segment.duration,
          }));

          setTranscripts(formattedTranscripts);
          console.log('[Reload Sync] ✅ Transcript history synced successfully');

          // Fetch meeting name from backend
          const meetingName = await recordingService.getRecordingMeetingName();
          if (meetingName) {
            console.log('[Reload Sync] Retrieved meeting name:', meetingName);
            setMeetingTitle(meetingName);
            console.log('[Reload Sync] ✅ Meeting title synced successfully');
          }
        } catch (error) {
          console.error('[Reload Sync] Failed to sync from backend:', error);
        }
      }
    };

    syncFromBackend();
  }, [recordingState.isRecording]); // Run when recording state changes

  // Manual transcript update handler (for RecordingControls component)
  const addTranscript = useCallback((update: TranscriptUpdate) => {
    console.log('🎯 addTranscript called with:', {
      sequence_id: update.sequence_id,
      text: update.text.substring(0, 50) + '...',
      timestamp: update.timestamp,
      is_partial: update.is_partial
    });

    const newTranscript: Transcript = {
      id: update.sequence_id ? update.sequence_id.toString() : Date.now().toString(),
      text: update.text,
      timestamp: update.timestamp,
      sequence_id: update.sequence_id || 0,
      chunk_start_time: update.chunk_start_time,
      is_partial: update.is_partial,
      confidence: update.confidence,
      audio_start_time: update.audio_start_time,
      audio_end_time: update.audio_end_time,
      duration: update.duration,
    };

    setTranscripts(prev => {
      console.log('📊 Current transcripts count before update:', prev.length);

      // Check if this transcript already exists
      const exists = prev.some(
        t => t.text === update.text && t.timestamp === update.timestamp
      );
      if (exists) {
        console.log('🚫 Duplicate transcript detected, skipping:', update.text.substring(0, 30) + '...');
        return prev;
      }

      // Add new transcript and sort by sequence_id to maintain order
      const updated = [...prev, newTranscript];
      const sorted = updated.sort((a, b) => (a.sequence_id || 0) - (b.sequence_id || 0));

      console.log('✅ Added new transcript. New count:', sorted.length);
      console.log('📝 Latest transcript:', {
        id: newTranscript.id,
        text: newTranscript.text.substring(0, 30) + '...',
        sequence_id: newTranscript.sequence_id
      });

      return sorted;
    });
  }, []);

  // Update transcript text in-place (for inline editing)
  const updateTranscriptText = useCallback((transcriptId: string, newText: string) => {
    setTranscripts(prev =>
      prev.map(t => t.id === transcriptId ? { ...t, text: newText } : t)
    );
  }, []);

  // Copy transcript to clipboard with recording-relative timestamps
  const copyTranscript = useCallback(() => {
    // Format timestamps as recording-relative [MM:SS] instead of wall-clock time
    const formatTime = (seconds: number | undefined): string => {
      if (seconds === undefined) return '[--:--]';
      const totalSecs = Math.floor(seconds);
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;
      return `[${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
    };

    const fullTranscript = transcripts
      .map(t => `${formatTime(t.audio_start_time)} ${t.text}`)
      .join('\n');
    navigator.clipboard.writeText(fullTranscript);

    toast.success("Transcript copied to clipboard");
  }, [transcripts]);

  // Force flush buffer (for final transcript processing)
  const flushBuffer = useCallback(() => {
    if (finalFlushRef.current) {
      console.log('🔄 Flushing transcript buffer...');
      finalFlushRef.current();
    }
  }, []);

  // Clear transcripts (used when starting new recording)
  const clearTranscripts = useCallback(() => {
    setTranscripts([]);
    clearAllPending();
    // Don't clear currentMeetingId here - it will be set by recording-started event
  }, [clearAllPending]);

  // Mark current meeting as saved in IndexedDB
  const markMeetingAsSaved = useCallback(async () => {
    // Try context state first, fallback to sessionStorage
    const meetingId = currentMeetingId || sessionStorage.getItem('indexeddb_current_meeting_id');

    if (!meetingId) {
      console.error('[IndexedDB] ❌ Cannot mark meeting as saved: No meeting ID available!');
      console.error('[IndexedDB] currentMeetingId:', currentMeetingId);
      console.error('[IndexedDB] sessionStorage:', sessionStorage.getItem('indexeddb_current_meeting_id'));
      return;
    }

    try {
      await indexedDBService.markMeetingSaved(meetingId);

      // Clear both sources
      setCurrentMeetingId(null);
      sessionStorage.removeItem('indexeddb_current_meeting_id');
    } catch (error) {
      console.error('[IndexedDB] ❌ Failed to mark meeting as saved:', error);
    }
  }, [currentMeetingId]);

  const value: TranscriptContextType = {
    transcripts,
    pendingBySource,
    transcriptsRef,
    addTranscript,
    updateTranscriptText,
    copyTranscript,
    flushBuffer,
    transcriptContainerRef,
    meetingTitle,
    setMeetingTitle,
    clearTranscripts,
    currentMeetingId,
    markMeetingAsSaved,
  };

  return (
    <TranscriptContext.Provider value={value}>
      {children}
    </TranscriptContext.Provider>
  );
}

export function useTranscripts() {
  const context = useContext(TranscriptContext);
  if (context === undefined) {
    throw new Error('useTranscripts must be used within a TranscriptProvider');
  }
  return context;
}
