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
import Analytics from '@/lib/analytics';

type SummaryStatus = 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';

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
    isProcessing: isProcessingTranscript,
    isSaving: isSavingTranscript
  } = recordingState;

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

  // Guard to prevent duplicate/concurrent stop calls (e.g., from UI and tray simultaneously)
  const stopInProgressRef = useRef(false);

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
  }, [router]);

  // Main recording stop handler
  const handleRecordingStop = useCallback(async (isCallApi: boolean) => {
    if (recordingStoppedDataRef.current) {
      await recordingStoppedDataRef.current;
    }

    // Guard: prevent duplicate/concurrent stop calls
    if (stopInProgressRef.current) {
      return;
    }
    stopInProgressRef.current = true;

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

      if (!transcriptionComplete && elapsedTime >= MAX_WAIT_TIME) {
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

      // F020: Auto-trigger handoff generation (runs in parallel with DB save).
      // The returned promise resolves when the user confirms or cancels the dialog,
      // so we can await it before navigating away (prevents dialog from being destroyed).
      let handoffPromise: Promise<void> | undefined;
      try {
        const handoffFolderPath = sessionStorage.getItem('last_recording_folder_path');
        const handoffMeetingName = sessionStorage.getItem('last_recording_meeting_name');
        if (handoffFolderPath && window.triggerHandoff) {
          handoffPromise = window.triggerHandoff(
            handoffFolderPath,
            handoffMeetingName || meetingTitle || 'New Meeting',
          );
        }
      } catch (handoffError) {
        console.error('Failed to trigger handoff:', handoffError);
      }

      // Save to SQLite
      // NOTE: enabled to save COMPLETE transcripts after frontend receives all updates
      // This ensures user sees all transcripts streaming in before database save
      if (isCallApi && transcriptionComplete == true) {

        setStatus(RecordingStatus.SAVING, 'Saving meeting to database...');

        // Get fresh transcript state (ALL transcripts including late ones)
        const freshTranscripts = [...transcriptsRef.current];

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

          // Clean up session storage
          sessionStorage.removeItem('last_recording_folder_path');
          sessionStorage.removeItem('last_recording_meeting_name');
          // Clean up IndexedDB meeting ID (redundant with markMeetingAsSaved cleanup, but ensures cleanup)
          sessionStorage.removeItem('indexeddb_current_meeting_id');

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
              try { if (handoffPromise) await handoffPromise; } catch { /* proceed regardless */ }
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
                  try { if (handoffPromise) await handoffPromise; } catch { /* proceed regardless */ }
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

          // I4: kick off the summary now that transcripts are persisted — works for tray/hotkey
          // stops that never navigate through the meeting-details page. Idempotent per meeting id.
          void kickoffAutoSummary(meetingId, freshTranscripts);

          // Show success toast with navigation option
          toast.success('Recording saved successfully!', {
            description: `${freshTranscripts.length} transcript segments saved.`,
            action: {
              label: 'View Meeting',
              onClick: () => {
                router.push(`/meeting-details?id=${meetingId}`);
                Analytics.trackButtonClick('view_meeting_from_toast', 'recording_complete');
              }
            },
            duration: 10000,
          });

          // Auto-navigate after handoff dialog is dismissed (or immediately if no handoff)
          const navigateToMeeting = () => {
            router.push(`/meeting-details?id=${meetingId}&source=recording`);
            clearTranscripts()
            Analytics.trackPageView('meeting_details');

            // Reset to IDLE after navigation
            setStatus(RecordingStatus.IDLE);
          };

          if (handoffPromise) {
            // Wait for user to confirm/cancel the handoff dialog, then navigate
            handoffPromise.then(() => {
              setTimeout(navigateToMeeting, 500);
            });
          } else {
            setTimeout(navigateToMeeting, 2000);
          }
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
          setStatus(RecordingStatus.ERROR, saveError instanceof Error ? saveError.message : 'Unknown error');
          toast.error('Failed to save meeting', {
            description: saveError instanceof Error ? saveError.message : 'Unknown error'
          });
          throw saveError;
        }
      } else {
        // No save needed, go back to IDLE
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
      // Always reset the guard flag when done
      stopInProgressRef.current = false;
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
