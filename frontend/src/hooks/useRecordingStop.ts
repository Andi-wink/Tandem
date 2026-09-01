import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { peekPendingRelocation, clearPendingRelocation } from '@/lib/pendingRelocation';
import { normalizeDir } from '@/lib/projectDirHistory';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { storageService } from '@/services/storageService';
import { transcriptService } from '@/services/transcriptService';
import { Transcript } from '@/types';
import {
  buildTranscriptText,
  hasAutoSummaryStarted,
  isAutoSummaryEnabled,
  markAutoSummaryStarted,
  resetAutoSummary,
} from '@/lib/autoSummary';
import { readJots, clearJots, serializeJots, type Jot } from '@/lib/meetingJots';
import { rescueJotsToDisk } from '@/lib/jotsRescue';
import { setActiveSoloProject } from '@/services/screenshotService';
import { runEnhanceNotes, hasEnhanceStarted, markEnhanceStarted } from '@/lib/enhanceNotes';
import {
  shouldPersistOnStop,
  shouldNavigateAfterStop,
  clearLastRecordingKeys,
} from '@/lib/recordingStopFlow';
import { startDiarization, getDiarizationHealth } from '@/services/diarizationService';
import Analytics from '@/lib/analytics';

type SummaryStatus = 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';

/**
 * Shared across ALL useRecordingStop instances (page.tsx's on-screen controls AND the
 * RecordingPostProcessingProvider). A per-instance ref only stops a path from re-entering ITSELF; it
 * does not stop the sibling instance from racing. During an I5b handover the provider instance runs a
 * stop while the on-screen Stop button / Alt+Shift+E can drive page.tsx's independent instance, so a
 * module-level guard is required to keep a single recording from being saved twice. Only one instance
 * ever handles a given stop in normal flow (UI stop -> page instance; tray 'recording-stop-complete'
 * -> provider instance), so sharing the guard never blocks a legitimate stop.
 *
 * It is a PROMISE, not a boolean: a boolean lets the loser return instantly while the winner's save +
 * auto-summary still run unawaited in the sibling instance, so the I5b handover's stopActiveRecording()
 * could resolve and start the next recording while the previous meeting's save (and the shared
 * sessionStorage last_recording_* keys) is still in flight. By awaiting the SAME in-flight promise,
 * every stop path — winner or loser, same instance re-entry or sibling race — resolves only once the
 * actual save has completed.
 */
let stopInFlight: Promise<void> | null = null;

interface UseRecordingStopReturn {
  handleRecordingStop: (callApi: boolean) => Promise<void>;
  isStopping: boolean;
  isProcessingTranscript: boolean;
  isSavingTranscript: boolean;
  summaryStatus: SummaryStatus;
  setIsStopping: (value: boolean) => void;
}

/**
 * Custom hook for managing recording stop lifecycle.
 * Handles the complex stop sequence: transcription wait → buffer flush → SQLite save → navigation.
 *
 * Features:
 * - Transcription completion polling (60s max, 500ms interval)
 * - Transcript buffer flush coordination
 * - SQLite meeting save with folder_path from sessionStorage
 * - Comprehensive analytics tracking (duration, word count, activation)
 * - Auto-navigation to meeting details
 * - Toast notifications for success/error
 * - Window exposure for Rust callbacks
 */
export function useRecordingStop(
  setIsRecording: (value: boolean) => void,
  setIsRecordingDisabled: (value: boolean) => void
): UseRecordingStopReturn {
  // USE global state instead
  const recordingState = useRecordingState();
  const {
    status,
    setStatus,
    isStopping,
    isRecording,
    isProcessing: isProcessingTranscript,
    isSaving: isSavingTranscript,
  } = recordingState;

  // Live recording flag read through a ref so the deferred post-save navigation (+2s) can see whether
  // a NEW recording (e.g. an I5b handover's next meeting) has started since it was scheduled. Both
  // recordings share the app-global transcript store, so navigating/clearing then would wipe the live
  // meeting's early segments. Ref (not the captured value) so the check reflects state at fire time.
  const isRecordingRef = useRef(isRecording);
  isRecordingRef.current = isRecording;

  // Pending deferred-navigation timeout id, so an unmount can cancel it before it fires.
  const navTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    transcriptsRef,
    flushBuffer,
    clearTranscripts,
    meetingTitle,
    markMeetingAsSaved,
  } = useTranscripts();

  const {
    refetchMeetings,
    setCurrentMeeting,
    setMeetings,
    meetings,
    setIsMeetingActive,
    startSummaryPolling,
    serverAddress,
  } = useSidebar();

  const router = useRouter();

  // Stop-driven auto-summary (I4): kick off summary generation the moment transcripts are saved,
  // from ANY stop source (tray, hotkey, UI). Idempotent per meeting id so the legacy
  // `?source=recording` page path can never double-generate. Fire-and-forget; failures are calm.
  const kickoffAutoSummary = useCallback(async (meetingId: string, transcripts: Transcript[]) => {
    if (!isAutoSummaryEnabled()) return;
    if (hasAutoSummaryStarted(meetingId)) return;
    if (!transcripts.length) return;

    const toastId = `auto-summary-${meetingId}`;
    try {
      // Summarizing needs a configured model. Resolve the config BEFORE taking the idempotency
      // latch: if no provider is configured we must leave the latch UNSET so the legacy
      // meeting-details `?source=recording` fallback (which auto-configures gemma3:1b on first run)
      // still runs. Latching first and only releasing after a slow config read is a race — the page
      // could mount, see the latch, and skip, leaving the meeting with no summary at all.
      let provider: string | null = null;
      let model: string | null = null;
      try {
        const cfg = await invoke('api_get_model_config') as { provider?: string; model?: string } | null;
        provider = cfg?.provider ?? null;
        model = cfg?.model ?? null;
      } catch { /* no config saved yet */ }

      if (!provider) {
        console.log('[autoSummary] No model configured — leaving the legacy fallback to summarize');
        return;
      }

      // A provider is configured: commit the latch now (before any further await) so the legacy
      // page path sees the guard and never double-generates this meeting.
      markAutoSummaryStarted(meetingId);

      toast.loading('Summarizing…', { id: toastId, description: 'Generating your meeting summary.' });

      const transcriptText = buildTranscriptText(transcripts);
      const result = await invoke('api_process_transcript', {
        text: transcriptText,
        model: provider,
        modelName: model || '',
        meetingId,
        chunkSize: 40000,
        overlap: 1000,
        customPrompt: '',
        templateId: 'standard_meeting',
      }) as { process_id?: string };

      const processId = result?.process_id;
      if (!processId) {
        toast.dismiss(toastId);
        resetAutoSummary(meetingId);
        return;
      }

      startSummaryPolling(meetingId, processId, (poll: any) => {
        if (poll.status === 'completed' && poll.data) {
          toast.success('Summary ready', {
            id: toastId,
            description: 'Your meeting summary is ready to view.',
            action: {
              label: 'View',
              onClick: () => {
                router.push(`/meeting-details?id=${meetingId}`);
                Analytics.trackButtonClick('view_summary_from_toast', 'auto_summary');
              },
            },
            duration: 10000,
          });
          // Nudge an already-open meeting-details page to refetch the freshly written summary.
          window.dispatchEvent(new CustomEvent('tandem:summary-updated', { detail: { meetingId } }));
        } else if (poll.status === 'error' || poll.status === 'failed' || poll.status === 'cancelled' || poll.status === 'idle') {
          toast.dismiss(toastId);
          // Let the user retry manually from the meeting page.
          resetAutoSummary(meetingId);
        }
      });
    } catch (err) {
      console.error('[autoSummary] Failed to kick off stop-driven summary:', err);
      toast.dismiss(toastId);
      resetAutoSummary(meetingId);
    }
  }, [router, startSummaryPolling]);

  // Enhance-my-notes: run the jot->notes model pass in parallel with auto-summary and non-blocking.
  // Only fires when jots exist (activation is jot-gated, per spec). Uses its own toast id so it never
  // collides with the summary toast, and its own idempotency latch. Writes enhanced-notes.md to the
  // folder the meeting actually ends up in (resolved at write time so a post-stop relocation is safe).
  const kickoffEnhanceNotes = useCallback(async (
    meetingId: string,
    jots: Jot[],
    transcripts: Transcript[],
    fallbackFolderPath: string | null,
    jotsPersisted: boolean,
  ) => {
    if (!jots.length) return;
    if (hasEnhanceStarted(meetingId)) return;

    let provider: string | null = null;
    let model: string | null = null;
    try {
      const cfg = await invoke('api_get_model_config') as { provider?: string; model?: string } | null;
      provider = cfg?.provider ?? null;
      model = cfg?.model ?? null;
    } catch { /* no config saved yet */ }

    // No provider configured: raw jots.json is already saved, so simply skip the model pass.
    if (!provider) {
      console.log('[enhanceNotes] No model configured, skipping the enhance pass (jots.json is saved)');
      return;
    }

    markEnhanceStarted(meetingId);

    const resolveFolderPath = async (): Promise<string | null> => {
      // Resolve the CURRENT folder from the DB (post-relocation), fall back to the save-time path.
      try {
        const meta = await invoke('api_get_meeting_metadata', { meetingId }) as { folder_path?: string } | null;
        if (meta?.folder_path) return meta.folder_path;
      } catch { /* fall through to the save-time path */ }
      return fallbackFolderPath;
    };

    await runEnhanceNotes({
      meetingId,
      jots,
      transcripts,
      provider,
      model: model || '',
      apiKey: null, // backend resolves the provider key from its own store (mirrors /generate-title)
      serverAddress,
      resolveFolderPath,
      onView: (id) => {
        router.push(`/meeting-details?id=${id}`);
        Analytics.trackButtonClick('view_notes_from_toast', 'enhance_notes');
      },
      source: 'stop',
      jotsPersisted,
    });
  }, [router, serverAddress]);

  // Guard to prevent duplicate/concurrent stop calls (e.g., from UI and tray simultaneously). Shared
  // at module scope (see `stopInFlight` above) so the on-screen and provider instances cannot both
  // save the same recording during an I5b handover double-stop; concurrent callers await the same
  // promise rather than returning early.

  // Promise to track recording-stopped event data (fixes race condition with recording-stop-complete)
  const recordingStoppedDataRef = useRef<Promise<void> | null>(null);

  // Set up recording-stopped listener for meeting navigation
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;

    const setupRecordingStoppedListener = async () => {
      try {
        console.log('Setting up recording-stopped listener for navigation...');
        unlistenFn = await listen<{
          message: string;
          folder_path?: string;
          meeting_name?: string;
        }>('recording-stopped', async (event) => {
          // Create promise that resolves when sessionStorage is set (prevents race condition)
          recordingStoppedDataRef.current = (async () => {
            const { folder_path, meeting_name } = event.payload;

            // Store folder_path and meeting_name for later use in handleRecordingStop
            if (folder_path) {
              sessionStorage.setItem('last_recording_folder_path', folder_path);
            }
            if (meeting_name) {
              sessionStorage.setItem('last_recording_meeting_name', meeting_name);
            }
          })();

        });
        console.log('Recording stopped listener setup complete');
      } catch (error) {
        console.error('Failed to setup recording stopped listener:', error);
      }
    };

    setupRecordingStoppedListener();

    return () => {
      console.log('Cleaning up recording stopped listener...');
      if (unlistenFn) {
        unlistenFn();
      }
    };
    // B014: register the listener ONCE (empty deps). The listener body only writes sessionStorage
    // from the event payload and never reads `router`, so the former [router] dependency was
    // spurious: it churned the Tauri listener (tear down + re-register on every router reference
    // change) and opened a teardown gap where a `recording-stopped` event could be dropped and
    // folder_path lost.
  }, []);

  // Main recording stop handler
  const handleRecordingStop = useCallback(async (isCallApi: boolean) => {
    // Screenshot routing is a global in the Rust process: while Solo Mode has an active project,
    // every capture is written into that project's session folder. It was previously cleared only by
    // stopSoloSession, which is wired to the on-screen stop button alone, so stopping from the tray,
    // the overlay, or the hotkey while off the home route left it set. A later recording then filed
    // its screenshots into the previous session's folder, silently: screenshots.json is written to
    // the correct meeting folder, so the manifest and the images end up in different places and the
    // meeting shows none at all.
    //
    // This is the choke point every stop route reaches (button, tray event, hotkey, overlay), so
    // clearing here covers all of them. It is intentionally the raw command rather than
    // stopSoloSession: this hook has no Solo context, and only the Rust-side routing needs resetting.
    // Fire and forget, since a failure here must never block the save.
    void setActiveSoloProject(null).catch(err =>
      console.warn('[RecordingStop] Failed to clear screenshot routing:', err),
    );

    if (recordingStoppedDataRef.current) {
      await recordingStoppedDataRef.current;
    }

    // Guard: a stop is already running — either this instance re-entering, or the sibling instance
    // racing us during an I5b handover double-stop. Await the SAME in-flight promise (created below by
    // the first caller) so every stop path resolves only once the real save/auto-summary has finished,
    // then return without re-doing the work. The check-and-create is synchronous (no await between),
    // so two callers can never both create a promise.
    if (stopInFlight) {
      await stopInFlight;
      return;
    }
    let resolveInFlight!: () => void;
    stopInFlight = new Promise<void>((res) => { resolveInFlight = res; });

    // Set status to STOPPING immediately
    setStatus(RecordingStatus.STOPPING);
    setIsRecording(false);
    setIsRecordingDisabled(true);
    const stopStartTime = Date.now();

    try {
      console.log('Post-stop processing (new implementation)...', {
        stop_initiated_at: new Date(stopStartTime).toISOString(),
        current_transcript_count: transcriptsRef.current.length
      });

      // Note: stop_recording is already called by RecordingControls.stopRecordingAction
      // This function only handles post-stop processing (transcription wait, API call, navigation)
      console.log('Recording already stopped by RecordingControls, processing transcription...');

      // Wait for transcription to complete
      setStatus(RecordingStatus.PROCESSING_TRANSCRIPTS, 'Waiting for transcription...');
      console.log('Waiting for transcription to complete...');

      const MAX_WAIT_TIME = 60000; // 60 seconds maximum wait (increased for longer processing)
      const POLL_INTERVAL = 500; // Check every 500ms
      let elapsedTime = 0;
      let transcriptionComplete = false;

      // Listen for transcription-complete event
      const unlistenComplete = await listen('transcription-complete', () => {
        console.log('Received transcription-complete event');
        transcriptionComplete = true;
      });

      // Poll for transcription status
      while (elapsedTime < MAX_WAIT_TIME && !transcriptionComplete) {
        try {
          const status = await transcriptService.getTranscriptionStatus();
          console.log('Transcription status:', status);

          // Check if transcription is complete
          if (!status.is_processing && status.chunks_in_queue === 0) {
            console.log('Transcription complete - no active processing and no chunks in queue');
            transcriptionComplete = true;
            break;
          }

          // If no activity for more than 8 seconds and no chunks in queue, consider it done (increased from 5s to 8s)
          if (status.last_activity_ms > 8000 && status.chunks_in_queue === 0) {
            console.log('Transcription likely complete - no recent activity and empty queue');
            transcriptionComplete = true;
            break;
          }

          // Update user with current status
          if (status.chunks_in_queue > 0) {
            console.log(`Processing ${status.chunks_in_queue} remaining audio chunks...`);
            setStatus(RecordingStatus.PROCESSING_TRANSCRIPTS, `Processing ${status.chunks_in_queue} remaining chunks...`);
          }

          // Wait before next check
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
          elapsedTime += POLL_INTERVAL;
        } catch (error) {
          console.error('Error checking transcription status:', error);
          break;
        }
      }

      // Clean up listener
      console.log('🧹 CLEANUP: Cleaning up transcription-complete listener');
      unlistenComplete();

      const transcriptionTimedOut = !transcriptionComplete && elapsedTime >= MAX_WAIT_TIME;
      if (transcriptionTimedOut) {
        console.warn('⏰ Transcription wait timeout reached after', elapsedTime, 'ms');
      } else {
        console.log('✅ Transcription completed after', elapsedTime, 'ms');
        // Wait longer for any late transcript segments (increased from 1s to 4s)
        console.log('⏳ Waiting for late transcript segments...');
        await new Promise(resolve => setTimeout(resolve, 4000));
      }

      // Final buffer flush: process ALL remaining transcripts regardless of timing
      const flushStartTime = Date.now();
      console.log('🔄 Final buffer flush: forcing processing of any remaining transcripts...', {
        flush_started_at: new Date(flushStartTime).toISOString(),
        time_since_stop: flushStartTime - stopStartTime,
        current_transcript_count: transcriptsRef.current.length
      });
      setStatus(RecordingStatus.PROCESSING_TRANSCRIPTS, 'Flushing transcript buffer...');
      flushBuffer();
      const flushEndTime = Date.now();
      console.log('✅ Final buffer flush completed', {
        flush_duration: flushEndTime - flushStartTime,
        total_time_since_stop: flushEndTime - stopStartTime,
        final_transcript_count: transcriptsRef.current.length
      });

      // NOTE: Status remains PROCESSING_TRANSCRIPTS until we start saving

      // Wait a bit more to ensure all transcript state updates have been processed
      console.log('Waiting for transcript state updates to complete...');
      await new Promise(resolve => setTimeout(resolve, 500));

      // F020 auto-handoff at recording stop is DISABLED (user 2026-07-16: "at the end of meeting,
      // don't ask to make handoff doc anymore"). Handoffs are manual-only now, via the Ctrl+K
      // /handoff command, which still uses window.triggerHandoff and the remembered anonymize
      // preference.

      // Snapshot the final transcript set (ALL transcripts including late ones) BEFORE the save gate so
      // the gate can decide on real content rather than on the transcription-wait outcome alone.
      const freshTranscripts = [...transcriptsRef.current];

      // Save to SQLite
      // NOTE: enabled to save COMPLETE transcripts after frontend receives all updates
      // This ensures user sees all transcripts streaming in before database save
      //
      // Root fix (timeout-discard bug): persistence must NOT be gated solely on transcriptionComplete.
      // A wait timeout with chunks still queued used to fall through to the no-save else branch, which
      // just set IDLE — the whole recording was silently dropped, no save, no error. shouldPersistOnStop
      // now saves whatever transcripts arrived (a strict superset of the old gate), and on a timeout we
      // warn the user that late audio may be missing.
      if (shouldPersistOnStop(isCallApi, transcriptionComplete, freshTranscripts.length)) {

        setStatus(RecordingStatus.SAVING, 'Saving meeting to database...');

        // Get folder_path and meeting_name from recording-stopped event
        const folderPath = sessionStorage.getItem('last_recording_folder_path');
        const savedMeetingName = sessionStorage.getItem('last_recording_meeting_name');

        console.log('💾 Saving COMPLETE transcripts to database...', {
          transcript_count: freshTranscripts.length,
          meeting_name: savedMeetingName || meetingTitle,
          folder_path: folderPath,
          sample_text: freshTranscripts.length > 0 ? freshTranscripts[0].text.substring(0, 50) + '...' : 'none',
          last_transcript: freshTranscripts.length > 0 ? freshTranscripts[freshTranscripts.length - 1].text.substring(0, 30) + '...' : 'none',
        });

        try {
          const responseData = await storageService.saveMeeting(
            savedMeetingName || meetingTitle || 'New Meeting',  // PREFER savedMeetingName (backend source)
            freshTranscripts,
            folderPath
          );

          const meetingId = responseData.meeting_id;
          if (!meetingId) {
            console.error('No meeting_id in response:', responseData);
            throw new Error('No meeting ID received from save operation');
          }

          console.log('✅ Successfully saved COMPLETE meeting with ID:', meetingId);
          console.log('   Transcripts:', freshTranscripts.length);
          console.log('   folder_path:', folderPath);

          // Mark meeting as saved in IndexedDB (for recovery system)
          await markMeetingAsSaved();

          // Clean up session storage (folder path, meeting name, and IndexedDB recovery id) so no
          // stale last_recording_* value can leak into the next recording's save.
          clearLastRecordingKeys(sessionStorage);

          // Enhance-my-notes: persist the user's jots into the meeting folder BEFORE any deferred
          // relocation runs below, so jots.json travels with the folder when it moves. There is no mode
          // gate here on purpose: the JotStrip only ever writes to the jot store while it is mounted, and
          // it mounts only for non-solo recordings. So a genuine pure-solo call leaves the store empty and
          // readJots() is already []. Reading unconditionally means a Solo -> Meeting mid-call switch (which
          // mounts the strip and lets the user flag jots) keeps those jots instead of a stale start-time
          // pin discarding them.
          const capturedJots: Jot[] = readJots();

          // Resolve a folder to write jots.json into. folderPath from the recording-stopped event can
          // legitimately be null (event without folder_path, or sessionStorage cleared under us), so we
          // fall back to the just-saved meeting's folder from the DB before giving up.
          let jotsFolderPath: string | null = folderPath;
          let jotsPersisted = false;
          if (capturedJots.length > 0) {
            if (!jotsFolderPath && meetingId) {
              try {
                const meta = await invoke('api_get_meeting_metadata', { meetingId }) as { folder_path?: string } | null;
                if (meta?.folder_path) jotsFolderPath = meta.folder_path;
              } catch { /* fall through to the no-folder error path below */ }
            }
            if (jotsFolderPath) {
              try {
                const sep = jotsFolderPath.includes('\\') ? '\\' : '/';
                const jotsPath = `${jotsFolderPath.replace(/[\\/]+$/, '')}${sep}jots.json`;
                await invoke('save_transcript', { filePath: jotsPath, content: serializeJots(capturedJots) });
                jotsPersisted = true;
                console.log('[enhanceNotes] Saved jots.json with', capturedJots.length, 'jots');
              } catch (jotsErr) {
                console.error('[enhanceNotes] Failed to write jots.json:', jotsErr);
              }
            } else {
              console.error('[enhanceNotes] No meeting folder resolved for jots.json');
            }

            // Never-lose invariant: if the primary jots.json write failed (or no folder was resolvable),
            // drop a rescue copy into the default recordings base dir (a location that always exists),
            // independent of the missing/failed meeting folder. Crucially the store is NOT cleared below
            // (jotsPersisted stays false), so useMeetingJots' recording-started clear can only fire after
            // the rescue exists. Best effort: if even this write fails, keep the session-only behavior.
            if (!jotsPersisted) {
              const rescue = await rescueJotsToDisk(capturedJots, savedMeetingName || meetingTitle || 'New Meeting');
              if (rescue.ok) {
                toast.error('Could not save your jots to the meeting folder', {
                  description: `They were rescued to ${rescue.path}. Your jots are kept for this session, so you can retry.`,
                });
              } else {
                toast.error('Could not save your jots', {
                  description: 'Your jots could not be written to disk and are kept only for this session, so retry before closing the app.',
                });
              }
            }
          }
          // Clear the active slot only when there is nothing to lose (no jots, solo) or the jots were
          // persisted. On a write/resolve failure we keep the store so jots are never silently lost
          // (the plan's invariant); a genuine new recording still clears it via the recording-started
          // event, so this can never leak into the next call.
          if (capturedJots.length === 0 || jotsPersisted) {
            clearJots();
          }

          // R3: deferred relocation. If the call was filed to a project mid-recording, its folder
          // could NOT be moved while the pipeline was writing. Now that the meeting is saved (audio
          // merged into audio.mp4, transcripts persisted) and the handoff has settled (HANDOFF.md
          // written), physically move the folder into <project>/.tandem and update the DB row.
          // Ownership token for THIS recording session (stamped at recording start in page.tsx).
          const currentToken = (() => {
            try { return sessionStorage.getItem('tandem.currentRecordingToken'); } catch { return null; }
          })();

          const pending = peekPendingRelocation();
          // Honor a deferred relocation ONLY if THIS session queued it. A stale entry from a
          // crashed/failed prior session (token mismatch, or no current token) must never file this
          // unrelated meeting — clear it and move on. This is the R3 "wrong folder" guard.
          const ownedPending =
            pending && currentToken && pending.meetingId === currentToken ? pending : null;
          if (pending && !ownedPending) {
            clearPendingRelocation();
          }
          if (ownedPending && meetingId) {
            const originalParent = (() => {
              if (!folderPath) return null;
              const norm = folderPath.replace(/[\\/]+$/, '');
              const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
              return idx > 0 ? norm.slice(0, idx) : null;
            })();
            void (async () => {
              try {
                await invoke<string>('relocate_meeting_folder', {
                  meetingId,
                  destParentDir: ownedPending.toProjectPath,
                });
                clearPendingRelocation();
                await refetchMeetings();
                toast.success(`Saved into ${ownedPending.projectName}/.tandem`, {
                  description: 'Recording files filed with the client.',
                  duration: 10000,
                  action: originalParent
                    ? {
                        label: 'Undo',
                        onClick: () => {
                          void invoke('relocate_meeting_folder', { meetingId, destParentDir: originalParent })
                            .then(() => refetchMeetings())
                            .catch(() => { /* best-effort */ });
                        },
                      }
                    : undefined,
                });
              } catch (relocErr) {
                clearPendingRelocation();
                toast.error(`Couldn't file into ${ownedPending.projectName}`, {
                  description: `${relocErr instanceof Error ? relocErr.message : String(relocErr)} Files stay in the recordings folder; use Move to project to retry.`,
                });
              }
            })();
          }

          // R3 issue-2: a calendar-seeded recording is created directly under <project>/.tandem via a
          // Rust base override that can SILENTLY fall back to the default recordings folder when the
          // dir is unwritable. Verify the ACTUAL saved folder against the expected tandem and relocate
          // on fallback, so seeded artifacts always land with the client (never a silent miss).
          // Skipped when an owned pending already handled filing (an explicit later choice wins).
          try {
            const rawSeed = (() => {
              try { return sessionStorage.getItem('tandem.seedExpectedRelocation'); } catch { return null; }
            })();
            try { sessionStorage.removeItem('tandem.seedExpectedRelocation'); } catch { /* ignore */ }
            if (rawSeed && folderPath && meetingId && !ownedPending) {
              const seedExp = JSON.parse(rawSeed) as { token: string; tandem: string; projectName: string };
              const parentOf = (p: string) => {
                const norm = p.replace(/[\\/]+$/, '');
                const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
                return idx > 0 ? norm.slice(0, idx) : '';
              };
              // Already correctly placed (override succeeded) → nothing to do. Relocating would make
              // relocate_meeting_folder mint a spurious "<leaf> (2)" copy, so guard against it.
              const alreadyPlaced =
                normalizeDir(parentOf(folderPath)) === normalizeDir(seedExp.tandem);
              if (currentToken && seedExp.token === currentToken && !alreadyPlaced) {
                void (async () => {
                  try {
                    await invoke<string>('relocate_meeting_folder', {
                      meetingId,
                      destParentDir: seedExp.tandem,
                    });
                    await refetchMeetings();
                    toast.success(`Saved into ${seedExp.projectName}/.tandem`, {
                      description: 'The scheduled folder was unavailable at start, so the files were filed after saving.',
                      duration: 10000,
                    });
                  } catch (recErr) {
                    toast.error(`Couldn't file into ${seedExp.projectName}`, {
                      description: `${recErr instanceof Error ? recErr.message : String(recErr)} Files stay in the recordings folder; use Move to project to retry.`,
                    });
                  }
                })();
              }
            }
          } catch { /* malformed seed reconciliation entry — ignore */ }

          // Refetch meetings and set current meeting
          await refetchMeetings();

          try {
            const meetingData = await storageService.getMeeting(meetingId);
            if (meetingData) {
              setCurrentMeeting({
                id: meetingId,
                title: meetingData.title
              });
              console.log('✅ Current meeting set:', meetingData.title);
            }
          } catch (error) {
            console.warn('Could not fetch meeting details, using ID only:', error);
            setCurrentMeeting({ id: meetingId, title: savedMeetingName || meetingTitle || 'New Meeting' });
          }

          // Mark as completed
          setStatus(RecordingStatus.COMPLETED);

          // F022: Auto-trigger speaker diarization if enabled
          if (folderPath && localStorage.getItem('tandem_auto_diarize') === 'true') {
            getDiarizationHealth().then(h => {
              if (h.available) {
                startDiarization(meetingId, `${folderPath}/audio.mp4`).then(() => {
                  toast.info('Speaker diarization started in background');
                }).catch(err => {
                  console.warn('Auto-diarization failed to start:', err);
                });
              }
            }).catch(() => {});
          }

          // I4: kick off the summary now that transcripts are persisted — works for tray/hotkey
          // stops that never navigate through the meeting-details page. Idempotent per meeting id.
          void kickoffAutoSummary(meetingId, freshTranscripts);

          // Enhance-my-notes: weave the jots into the transcript. Runs in parallel with auto-summary,
          // fully non-blocking, and only when jots exist.
          if (capturedJots.length > 0) {
            void kickoffEnhanceNotes(meetingId, capturedJots, freshTranscripts, jotsFolderPath, jotsPersisted);
          }

          // Show a toast with navigation option. On a transcription-wait timeout we saved partial
          // transcripts, so warn (rather than a plain success) that late audio may be missing.
          const toastAction = {
            label: 'View Meeting',
            onClick: () => {
              router.push(`/meeting-details?id=${meetingId}`);
              Analytics.trackButtonClick('view_meeting_from_toast', 'recording_complete');
            },
          };
          if (transcriptionTimedOut) {
            toast.warning('Saved, but transcription was still processing', {
              description: `Saved ${freshTranscripts.length} transcript segments captured so far. Some late audio may be missing.`,
              action: toastAction,
              duration: 10000,
            });
          } else {
            toast.success('Recording saved successfully!', {
              description: `${freshTranscripts.length} transcript segments saved.`,
              action: toastAction,
              duration: 10000,
            });
          }

          // Auto-navigate after handoff dialog is dismissed (or immediately if no handoff)
          const navigateToMeeting = () => {
            // A NEW recording (e.g. an I5b handover's next meeting) may have started in the ~2s since
            // this was scheduled. It shares the app-global transcript store and recording status, so
            // navigating away + clearTranscripts() now would wipe the live meeting's early segments and
            // yank the user off it. Skip entirely when a recording is live (shouldNavigateAfterStop).
            if (!shouldNavigateAfterStop(isRecordingRef.current)) {
              return;
            }
            router.push(`/meeting-details?id=${meetingId}&source=recording`);
            clearTranscripts()
            Analytics.trackPageView('meeting_details');

            // Reset to IDLE after navigation
            setStatus(RecordingStatus.IDLE);
          };

          // Cancelable so an unmount (or a superseding stop) doesn't fire a stale navigation.
          if (navTimeoutRef.current) clearTimeout(navTimeoutRef.current);
          navTimeoutRef.current = setTimeout(navigateToMeeting, 2000);
          // Track meeting completion analytics
          try {
            // Calculate meeting duration from transcript timestamps
            let durationSeconds = 0;
            if (freshTranscripts.length > 0 && freshTranscripts[0].audio_start_time !== undefined) {
              // Use audio_end_time of last transcript if available
              const lastTranscript = freshTranscripts[freshTranscripts.length - 1];
              durationSeconds = lastTranscript.audio_end_time || lastTranscript.audio_start_time || 0;
            }

            // Calculate word count
            const transcriptWordCount = freshTranscripts
              .map(t => t.text.split(/\s+/).length)
              .reduce((a, b) => a + b, 0);

            // Calculate words per minute
            const wordsPerMinute = durationSeconds > 0 ? transcriptWordCount / (durationSeconds / 60) : 0;

            // Get meetings count today
            const meetingsToday = await Analytics.getMeetingsCountToday();

            // Track meeting completed
            await Analytics.trackMeetingCompleted(meetingId, {
              duration_seconds: durationSeconds,
              transcript_segments: freshTranscripts.length,
              transcript_word_count: transcriptWordCount,
              words_per_minute: wordsPerMinute,
              meetings_today: meetingsToday
            });

            // Update meeting count in analytics.json
            await Analytics.updateMeetingCount();

            // Check for activation (first meeting)
            const { Store } = await import('@tauri-apps/plugin-store');
            const store = await Store.load('analytics.json');
            const totalMeetings = await store.get<number>('total_meetings');

            if (totalMeetings === 1) {
              const daysSinceInstall = await Analytics.calculateDaysSince('first_launch_date');
              await Analytics.track('user_activated', {
                meetings_count: '1',
                days_since_install: daysSinceInstall?.toString() || 'null',
                first_meeting_duration_seconds: durationSeconds.toString()
              });
            }
          } catch (analyticsError) {
            console.error('Failed to track meeting completion analytics:', analyticsError);
            // Don't block user flow on analytics errors
          }

        } catch (saveError) {
          console.error('Failed to save meeting to database:', saveError);
          // R3: a failed save must not leave a dangling relocation intent that a LATER, unrelated
          // recording could inherit and silently file into the wrong folder.
          clearPendingRelocation();
          try { sessionStorage.removeItem('tandem.seedExpectedRelocation'); } catch { /* ignore */ }
          // Bug 5: a save that THROWS (network/backend/disk error) is also a "stop that does not
          // save". Clear the last_recording_* / recovery keys so a stale folder path can never be
          // inherited by the next recording (whose recording-stopped event may omit folder_path).
          clearLastRecordingKeys(sessionStorage);
          setStatus(RecordingStatus.ERROR, saveError instanceof Error ? saveError.message : 'Unknown error');
          toast.error('Failed to save meeting', {
            description: saveError instanceof Error ? saveError.message : 'Unknown error'
          });
          throw saveError;
        }
      } else {
        // No save happened (a discard stop, or a timeout with zero transcripts). Clear the
        // last_recording_* / recovery keys here too, so a stop that does NOT save can never leave a
        // stale folder path that the guarded recording-stopped write (if the next event omits
        // folder_path) would let the next meeting inherit and file into the wrong folder.
        clearLastRecordingKeys(sessionStorage);
        setStatus(RecordingStatus.IDLE);
      }

      setIsMeetingActive(false);
      // isRecording already set to false at function start
      setIsRecordingDisabled(false);
    } catch (error) {
      console.error('Error in handleRecordingStop:', error);
      setStatus(RecordingStatus.ERROR, error instanceof Error ? error.message : 'Unknown error');
      // isRecording already set to false at function start
      setIsRecordingDisabled(false);
    } finally {
      // Resolve the in-flight promise (unblocking any awaiting sibling/re-entrant caller) and clear it
      // so a later, unrelated stop can create a fresh one. Always runs, even on the error paths above.
      resolveInFlight();
      stopInFlight = null;
    }
  }, [
    setIsRecording,
    setIsRecordingDisabled,
    setStatus,
    transcriptsRef,
    flushBuffer,
    clearTranscripts,
    meetingTitle,
    markMeetingAsSaved,
    refetchMeetings,
    setCurrentMeeting,
    setMeetings,
    meetings,
    setIsMeetingActive,
    router,
    kickoffAutoSummary,
    kickoffEnhanceNotes,
  ]);

  // Expose handleRecordingStop function to window for Rust callbacks
  const handleRecordingStopRef = useRef(handleRecordingStop);
  useEffect(() => {
    handleRecordingStopRef.current = handleRecordingStop;
  });

  useEffect(() => {
    (window as any).handleRecordingStop = (callApi: boolean = true) => {
      handleRecordingStopRef.current(callApi);
    };

    // Cleanup on unmount
    return () => {
      delete (window as any).handleRecordingStop;
      // Cancel any pending deferred navigation so it can't fire against an unmounted tree.
      if (navTimeoutRef.current) clearTimeout(navTimeoutRef.current);
    };
  }, []);

  // Derive summaryStatus from RecordingStatus for backward compatibility
  const summaryStatus: SummaryStatus = status === RecordingStatus.PROCESSING_TRANSCRIPTS ? 'processing' : 'idle';

  return {
    handleRecordingStop,
    isStopping,
    isProcessingTranscript,
    isSavingTranscript,
    summaryStatus,
    setIsStopping: (value: boolean) => {
      setStatus(value ? RecordingStatus.STOPPING : RecordingStatus.IDLE);
    },
  };
}
