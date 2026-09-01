'use client';

import { useState, useEffect, useRef } from 'react';
import { RecordingControls } from '@/components/RecordingControls';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { usePermissionCheck } from '@/hooks/usePermissionCheck';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useConfig } from '@/contexts/ConfigContext';
import { StatusOverlays } from '@/app/_components/StatusOverlays';
import Analytics from '@/lib/analytics';
import { SettingsModals } from './_components/SettingsModal';
import { TranscriptPanel } from './_components/TranscriptPanel';
import { useModalState } from '@/hooks/useModalState';
import { useRecordingStateSync } from '@/hooks/useRecordingStateSync';
import { useAutoMeetingTitle } from '@/hooks/useAutoMeetingTitle';
import { useRecordingStart } from '@/hooks/useRecordingStart';
import { useRecordingStop } from '@/hooks/useRecordingStop';
import { useTranscriptRecovery } from '@/hooks/useTranscriptRecovery';
import { TranscriptRecovery } from '@/components/TranscriptRecovery';
import { JotStrip } from '@/components/JotStrip';
import { useHandoffExport } from '@/hooks/useHandoffExport';
import { useLiveTranscriptWriter } from '@/hooks/useLiveTranscriptWriter';
import { HandoffDialog } from '@/components/HandoffDialog';
import { indexedDBService } from '@/services/indexedDBService';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { useClaude } from '@/contexts/ClaudeContext';
import { Bot } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { motion, AnimatePresence } from 'framer-motion';
import { ProjectPickerDialog } from '@/components/ProjectPickerDialog';
import { useSoloMode } from '@/contexts/SoloModeContext';
import { useSoloModeRouter } from '@/hooks/useSoloModeRouter';
import { useProjectAutoRoute } from '@/hooks/useProjectAutoRoute';
import { useProjectRouteActions } from '@/hooks/useProjectRouteActions';
import { createProject, Project } from '@/services/projectService';
import { ProjectPickerSelection } from '@/components/ProjectPicker';
import { peekRecordingSeed, clearRecordingSeed } from '@/lib/recordingSeed';
import { clearPendingRelocation } from '@/lib/pendingRelocation';
import { useCalendar } from '@/contexts/CalendarContext';
import { findEventNear, rankEventProjectCandidates } from '@/services/calendarEventMatcher';
import { getMatchPool } from '@/services/clientFolderDiscovery';
import type { ChooserCandidate } from '@/lib/startFromEvent';
import { consumePendingProjectPicker, clearPendingProjectPicker } from '@/lib/pendingProjectPicker';

export default function Home() {
  // Local page state (not moved to contexts)
  const [isRecording, setIsRecordingState] = useState(false);
  const [barHeights, setBarHeights] = useState(['10px', '14px', '18px', '14px', '10px']);
  const [showRecoveryDialog, setShowRecoveryDialog] = useState(false);

  // Global "Move to project" / "Change" picker (opened by the tandem:open-project-picker event).
  const [movePickerOpen, setMovePickerOpen] = useState(false);
  // R1: when the picker is opened as the ambiguity CHOOSER, it carries ranked candidates + a title.
  const [movePickerCandidates, setMovePickerCandidates] = useState<ChooserCandidate[] | undefined>(undefined);
  const [movePickerTitle, setMovePickerTitle] = useState<string | undefined>(undefined);
  // Fed to useProjectAutoRoute's suppression check. Recording now starts straight into the meeting
  // folder (no pre-record modal), so this stays '' — the guard is dormant until a pre-pick surface
  // returns, at which point setting it will suppress auto-routing over an explicit choice.
  const preRecordDirRef = useRef<string>('');

  // Use contexts for state management
  const { meetingTitle, transcriptsRef } = useTranscripts();
  const { transcriptModelConfig, selectedDevices, modelConfig, providerApiKeys } = useConfig();
  const recordingState = useRecordingState();

  // Extract status from global state
  const { status, isStopping, isProcessing, isSaving } = recordingState;

  // Claude panel
  const { isPanelOpen, openPanel, closePanel, panelWidth } = useClaude();

  // Hooks
  const { hasMicrophone } = usePermissionCheck();
  const { setIsMeetingActive, isCollapsed: sidebarCollapsed, refetchMeetings, currentMeeting, serverAddress } = useSidebar();
  const { modals, messages, showModal, hideModal } = useModalState(transcriptModelConfig);
  const { isRecordingDisabled, setIsRecordingDisabled } = useRecordingStateSync(isRecording, setIsRecordingState, setIsMeetingActive);
  const { handleRecordingStart } = useRecordingStart(isRecording, setIsRecordingState, showModal);

  // Get handleRecordingStop function and setIsStopping (state comes from global context)
  const { handleRecordingStop, setIsStopping } = useRecordingStop(
    setIsRecordingState,
    setIsRecordingDisabled
  );

  // F020: Handoff export (registers window.triggerHandoff for auto + manual triggers)
  const {
    showHandoffDialog,
    isGenerating: isHandoffGenerating,
    anonymizeChecked,
    setAnonymizeChecked,
    piiAvailable,
    confirmHandoff,
    cancelHandoff,
  } = useHandoffExport();

  // F054: Write live transcript to .tandem/live-transcript.md during recording
  useLiveTranscriptWriter();

  // Solo Mode: routing engine + session management
  const soloMode = useSoloMode();
  useSoloModeRouter();

  // AI auto-routing: file a meeting-mode recording under the project it belongs to (once early
  // transcript arrives). Suppressed in solo mode (that has its own router) via the enabled flag.
  useProjectAutoRoute({
    enabled: recordingState.isRecording && recordingState.recordingMode !== 'solo',
    preRecordDirRef,
  });
  const { fileUnder } = useProjectRouteActions();

  // Calendar events feed the "manual start near a matched event" auto-filing. Read via a ref inside
  // the eslint-disabled isRecording effect so it never widens that effect's dep array (re-fire trap).
  const { events: calendarEvents } = useCalendar();
  const calendarEventsRef = useRef(calendarEvents);
  calendarEventsRef.current = calendarEvents;
  // Stable ref to fileUnder so the isRecording effect can file without depending on it.
  const fileUnderRef = useRef(fileUnder);
  fileUnderRef.current = fileUnder;
  // Recording state via ref so the eslint-disabled isRecording effect can read recordingMode etc.
  const recordingStateRef = useRef(recordingState);
  recordingStateRef.current = recordingState;

  // Open the ambiguity chooser (ranked candidates) non-blockingly.
  const openChooser = (candidates: ChooserCandidate[], title?: string) => {
    setMovePickerCandidates(candidates);
    setMovePickerTitle(title ?? 'Which folder is this call for?');
    setMovePickerOpen(true);
  };
  const openChooserRef = useRef(openChooser);
  openChooserRef.current = openChooser;

  // Open the global Move/Change picker on the shared window event. Fired plainly by the "Filed under
  // X" toast's Change button / a spoken-name miss (no detail), OR as the ambiguity chooser by
  // startFromEvent (detail carries ranked candidates + meetingTitle).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ candidates?: ChooserCandidate[]; meetingTitle?: string }>).detail;
      if (detail?.candidates && detail.candidates.length > 0) {
        setMovePickerCandidates(detail.candidates);
        setMovePickerTitle('Which folder is this call for?');
      } else {
        setMovePickerCandidates(undefined);
        setMovePickerTitle(undefined);
      }
      setMovePickerOpen(true);
      // The live event handled it: drop any off-route stash so a later home mount cannot reopen it.
      clearPendingProjectPicker();
    };
    window.addEventListener('tandem:open-project-picker', onOpen as EventListener);
    return () => window.removeEventListener('tandem:open-project-picker', onOpen as EventListener);
  }, []);

  // Off-route ambiguity chooser bridge (I5b): when startRecordingForEvent fired the chooser while the
  // home controls were unmounted (a handover from Settings / meeting-details), the live event above was
  // lost but the payload was stashed. Consume it on mount — after the handover has navigated home — so
  // the picker still appears. Runs once; on-route firings clear the stash via onOpen, so no double-open.
  useEffect(() => {
    const pending = consumePendingProjectPicker();
    if (pending && pending.candidates.length > 0) {
      setMovePickerCandidates(pending.candidates);
      setMovePickerTitle('Which folder is this call for?');
      setMovePickerOpen(true);
    }
  }, []);

  // Post-hoc "Move to project" for the current/last meeting. A registered project files directly;
  // a recent/browsed folder with no project is registered on the fly (like ClaudePanel's switcher),
  // and either way fileUnder records the correction into frecency so the router learns.
  const handleMovePickerSelect = async (sel: ProjectPickerSelection) => {
    setMovePickerOpen(false);
    // Whether this pick came from the ambiguity chooser (carries a per-row match signal).
    const chosenCandidate = movePickerCandidates?.find(
      (c) => c.dir === sel.dir || (sel.project && c.project?.id === sel.project.id),
    );
    setMovePickerCandidates(undefined);
    setMovePickerTitle(undefined);
    let project = sel.project;
    if (!project) {
      // Unregistered pick (a browsed folder OR a discovered client folder) — adopt via createProject
      // (same path the header switcher uses), so it becomes a first-class project going forward.
      if (!sel.dir) { toast.error('No folder to file under'); return; }
      try {
        project = await createProject(sel.name, sel.dir, []);
      } catch (err) {
        toast.error('Failed to set project', { description: String(err) });
        return;
      }
    }
    await fileUnder(project, chosenCandidate?.signal ?? 'chosen manually');
  };

  // Auto-rename meeting after 2 min of active recording (e.g. "Meeting with Steph 27.04.2026")
  useAutoMeetingTitle({
    activeDuration: recordingState.activeDuration,
    isRecording: recordingState.isRecording,
    meetingId: currentMeeting?.id,
    currentTitle: currentMeeting?.title,
    serverAddress,
    provider: modelConfig.provider,
    modelName: modelConfig.model,
    apiKey:
      modelConfig.provider === 'claude' ? providerApiKeys.claude :
      modelConfig.provider === 'groq' ? providerApiKeys.groq :
      modelConfig.provider === 'openai' ? providerApiKeys.openai :
      null,
    transcriptsRef,
    onRenamed: () => { void refetchMeetings(); },
  });

  // Recovery hook
  const {
    recoverableMeetings,
    isLoading: isLoadingRecovery,
    isRecovering,
    checkForRecoverableTranscripts,
    recoverMeeting,
    loadMeetingTranscripts,
    deleteRecoverableMeeting
  } = useTranscriptRecovery();

  const router = useRouter();

  useEffect(() => {
    // Track page view
    Analytics.trackPageView('home');
  }, []);

  // Startup recovery check
  useEffect(() => {
    const performStartupChecks = async () => {
      try {
        // Skip recovery check if currently recording or processing stop
        // This prevents the recovery dialog from showing when:
        if (recordingState.isRecording ||
          status === RecordingStatus.STOPPING ||
          status === RecordingStatus.PROCESSING_TRANSCRIPTS ||
          status === RecordingStatus.SAVING) {
          console.log('Skipping recovery check - recording in progress or processing');
          return;
        }

        // 1. Clean up old meetings (7+ days)
        try {
          await indexedDBService.deleteOldMeetings(7);
        } catch (error) {
          console.warn('⚠️ Failed to clean up old meetings:', error);
        }

        // 2. Clean up saved meetings (24+ hours after save)
        try {
          await indexedDBService.deleteSavedMeetings(24);
        } catch (error) {
          console.warn('⚠️ Failed to clean up saved meetings:', error);
        }

        // 3. Always check for recoverable meetings on startup
        // Don't skip based on sessionStorage - we need to check every time
        await checkForRecoverableTranscripts();
      } catch (error) {
        console.error('Failed to perform startup checks:', error);
      }
    };

    performStartupChecks();
  }, [checkForRecoverableTranscripts, recordingState.isRecording, status]);

  // Watch for recoverable meetings changes and show dialog once per session
  useEffect(() => {
    // Only show dialog if we have meetings and haven't shown it yet this session
    if (recoverableMeetings.length > 0) {
      const shownThisSession = sessionStorage.getItem('recovery_dialog_shown');
      if (!shownThisSession) {
        setShowRecoveryDialog(true);
        sessionStorage.setItem('recovery_dialog_shown', 'true');
      }
    }
  }, [recoverableMeetings]);

  // Handle recovery with toast notifications and navigation
  const handleRecovery = async (meetingId: string) => {
    try {
      const result = await recoverMeeting(meetingId);

      if (result.success) {
        toast.success('Meeting recovered successfully!', {
          description: result.audioRecoveryStatus?.status === 'success'
            ? 'Transcripts and audio recovered'
            : 'Transcripts recovered (no audio available)',
          action: result.meetingId ? {
            label: 'View Meeting',
            onClick: () => {
              router.push(`/meeting-details?id=${result.meetingId}`);
            }
          } : undefined,
          duration: 10000,
        });

        // Refresh sidebar to show the newly recovered meeting
        await refetchMeetings();

        // If no more recoverable meetings, clear session flag so dialog can show again
        if (recoverableMeetings.length === 0) {
          sessionStorage.removeItem('recovery_dialog_shown');
        }

        // Auto-navigate after a short delay
        if (result.meetingId) {
          setTimeout(() => {
            router.push(`/meeting-details?id=${result.meetingId}`);
          }, 2000);
        }
      }
    } catch (error) {
      toast.error('Failed to recover meeting', {
        description: error instanceof Error ? error.message : 'Unknown error occurred',
      });
      throw error;
    }
  };

  // Handle dialog close - clear session flag if no meetings left
  const handleDialogClose = () => {
    setShowRecoveryDialog(false);
    // If user closes dialog and there are no more meetings, clear the flag
    // This allows the dialog to show again next session if new meetings appear
    if (recoverableMeetings.length === 0) {
      sessionStorage.removeItem('recovery_dialog_shown');
    }
  };

  useEffect(() => {
    if (recordingState.isRecording) {
      const interval = setInterval(() => {
        setBarHeights([
          Math.random() * 16 + 6 + 'px',
          Math.random() * 20 + 8 + 'px',
          Math.random() * 24 + 10 + 'px',
          Math.random() * 20 + 8 + 'px',
          Math.random() * 16 + 6 + 'px',
        ]);
      }, 250);

      return () => clearInterval(interval);
    }
  }, [recordingState.isRecording]);

  // Pre-record modal handlers
  const handleBeforeRecord = async (startFn: () => void) => {
    // Solo mode: check model availability, skip project dir modal
    if (recordingState.recordingMode === 'solo') {
      // Only worth checking when something is actually going to call the model. With automatic
      // routing off, warning that Ollama is unreachable would be noise about a dependency this
      // session does not have.
      if (soloMode.routingEnabled) {
        try {
          const models = await invoke<Array<{ name: string }>>('get_ollama_models', { endpoint: null });
          const modelName = soloMode.routingModel;
          const hasModel = models.some(m => m.name === modelName || m.name.startsWith(modelName.split(':')[0]));
          if (!hasModel) {
            toast.warning(`Routing model "${modelName}" not found`, {
              description: `Pull it with: ollama pull ${modelName}`,
              duration: 8000,
            });
          }
        } catch {
          toast.warning('Ollama not reachable, solo routing will be limited', {
            description: 'Ensure Ollama is running for project routing.',
          });
        }
      }

      soloMode.startSoloSession();
      startFn();
      return;
    }

    // Meeting mode: start recording immediately — never block with a folder modal. The user's core
    // pain was a "which folder?" modal on every meeting; instead we start straight into the meeting
    // folder and let useProjectAutoRoute file the call under the right project once early transcript
    // arrives (with a "Filed under X — Undo / Change" toast). The AI panel still shows its own
    // lightweight setup modal lazily on first AI use if an API key or dir is missing.
    // I3: a calendar seed with a matched project re-arms the suppression guard so auto-routing
    // doesn't fight the explicit calendar choice.
    preRecordDirRef.current = peekRecordingSeed()?.projectPath || '';
    startFn();
  };

  // F054: On recording start, establish the AI meeting context so projectDir is set for the live
  // transcript writer — but do NOT reveal the panel (reveal=false). Recording should land on the
  // main transcript view; the user opens the AI panel themselves when they want it.
  const liveRecordingIdRef = useRef<string>('live-recording');
  useEffect(() => {
    if (recordingState.isRecording) {
      // Fresh identity per recording: a new id means the AI panel starts clean (no carryover
      // conversation/basket from the previous meeting) and won't restore the prior live session.
      const liveId = `live-${Date.now()}`;
      liveRecordingIdRef.current = liveId;
      // R3 hardening: bind the deferred-relocation machinery to THIS recording session and wipe any
      // stale intent left by a crashed/failed prior session, so it can never file this unrelated
      // meeting into the wrong folder. Must run BEFORE any fileUnder call below (which queues fresh
      // pending) so we clear the old slot without discarding this session's own queue.
      try {
        sessionStorage.setItem('tandem.currentRecordingToken', liveId);
        sessionStorage.removeItem('tandem.seedExpectedRelocation');
        clearPendingRelocation();
      } catch { /* sessionStorage unavailable, deferred relocation simply won't run */ }
      openPanel(liveId, meetingTitle || 'Live Recording', preRecordDirRef.current, false);

      // ── I3 / R1: auto-file the call under its project ──
      // All reads go through refs so this eslint-disabled effect never re-fires mid-call.
      const isSolo = recordingStateRef.current.recordingMode === 'solo';
      if (!isSolo) {
        const seed = peekRecordingSeed();
        if (seed) {
          // Started from a calendar event (agenda/palette).
          if (seed.projectPath) {
            // Strong / user-confirmed: the folder was created inside <project>/.tandem at start, so
            // skip relocation. Consent already given — never re-ask.
            const stub: Project = {
              id: seed.projectId || `seed:${seed.projectPath}`,
              name: seed.projectName || 'Project',
              path: seed.projectPath,
              aliases: [],
              auto_discovered: false,
              // F061: calendar-seeded stub is a plain folder project (no chat session scope).
              session_id: null,
              created_at: '',
            };
            // R3 issue-2: the folder is created directly under <project>/.tandem via the Rust base
            // override, so we skip the deferred relocation here. But that override can SILENTLY fall
            // back to the default recordings folder when the dir is unwritable, with no signal back.
            // Record the expected tandem so useRecordingStop can verify against the ACTUAL saved
            // folder and relocate on fallback — artifacts must ALWAYS land with the client.
            try {
              const sep = seed.projectPath.includes('\\') ? '\\' : '/';
              sessionStorage.setItem('tandem.seedExpectedRelocation', JSON.stringify({
                token: liveId,
                tandem: `${seed.projectPath}${sep}.tandem`,
                projectName: seed.projectName || 'Project',
              }));
            } catch { /* sessionStorage unavailable — fallback reconciliation simply won't run */ }
            void fileUnderRef.current(stub, seed.signal || 'from your calendar', {
              meetingId: liveId,
              meetingTitle: seed.title,
              skipRelocation: true,
            });
          }
          // Ambiguous / none: startFromEvent already opened the chooser (or left it title-only).
          clearRecordingSeed();
        } else {
          // Manual start (no seed): if we're within ~10 min of a matched event, offer the same
          // auto-filing (strong) or chooser (ambiguous). Fully async, ref-only reads.
          void (async () => {
            const near = findEventNear(calendarEventsRef.current, Date.now());
            if (!near) return;
            const { pool } = await getMatchPool();
            const { candidates, confidence } = rankEventProjectCandidates(near, pool);
            if (confidence === 'strong') {
              const top = candidates[0];
              // No skipRelocation: the folder was created in the default recordings dir, so file it
              // via the deferred (pending) relocation after stop.
              void fileUnderRef.current(top.project, top.signal, {
                meetingId: liveRecordingIdRef.current,
                meetingTitle: near.summary,
              });
            } else if (confidence === 'ambiguous') {
              openChooserRef.current(
                candidates.map((c) => ({
                  dir: c.project.path,
                  name: c.project.name,
                  signal: c.signal,
                  project: c.project.id.startsWith('discovered:') ? undefined : c.project,
                })),
                'Which folder is this call for?',
              );
            }
          })();
        }
      }
    }
  }, [recordingState.isRecording]); // eslint-disable-line react-hooks/exhaustive-deps

  // Computed values using global status
  const isProcessingStop = status === RecordingStatus.PROCESSING_TRANSCRIPTS || isProcessing;

  return (
    <div
      className="flex flex-col h-screen bg-background"
    >
      {/* Move-to-project / Change picker (user-initiated) + R1 ambiguity chooser (candidates set). */}
      <ProjectPickerDialog
        open={movePickerOpen}
        title={movePickerTitle}
        candidates={movePickerCandidates}
        meetingTitle={meetingTitle}
        onClose={() => { setMovePickerOpen(false); setMovePickerCandidates(undefined); setMovePickerTitle(undefined); }}
        onSelect={handleMovePickerSelect}
      />

      {/* All Modals supported*/}
      <SettingsModals
        modals={modals}
        messages={messages}
        onClose={hideModal}
      />

      {/* F020: Handoff dialog */}
      <HandoffDialog
        open={showHandoffDialog}
        onConfirm={confirmHandoff}
        onCancel={cancelHandoff}
        anonymizeChecked={anonymizeChecked}
        onAnonymizeChange={setAnonymizeChecked}
        piiAvailable={piiAvailable}
        isGenerating={isHandoffGenerating}
      />

      {/* Recovery Dialog */}
      <TranscriptRecovery
        isOpen={showRecoveryDialog}
        onClose={handleDialogClose}
        recoverableMeetings={recoverableMeetings}
        onRecover={handleRecovery}
        onDelete={deleteRecoverableMeeting}
        onLoadPreview={loadMeetingTranscripts}
      />
      <div className="flex flex-1 overflow-hidden">
        <TranscriptPanel
          isProcessingStop={isProcessingStop}
          isStopping={isStopping}
          showModal={showModal}
        />

        {/* Recording controls - only show when permissions are granted or already recording and not showing status messages */}
        {(hasMicrophone || isRecording) &&
          status !== RecordingStatus.PROCESSING_TRANSCRIPTS &&
          status !== RecordingStatus.SAVING && (
            <div className="fixed bottom-12 left-0 right-0 z-10 transition-[right] duration-200" style={{ right: isPanelOpen ? `${panelWidth}px` : '0' }}>
              <div
                className="flex justify-center pl-8 transition-[margin] duration-300"
                style={{
                  marginLeft: sidebarCollapsed ? '4rem' : '16rem'
                }}
              >
                <div className="w-2/3 max-w-[750px] flex justify-center">
                  <div className="bg-card rounded-full shadow-lg flex items-center">
                    <RecordingControls
                      isRecording={recordingState.isRecording}
                      onRecordingStop={(callApi = true) => {
                        if (soloMode.isActive) soloMode.stopSoloSession();
                        handleRecordingStop(callApi);
                      }}
                      onRecordingStart={handleRecordingStart}
                      onTranscriptReceived={() => { }} // Not actually used by RecordingControls
                      onStopInitiated={() => setIsStopping(true)}
                      barHeights={barHeights}
                      onTranscriptionError={(message) => {
                        showModal('errorAlert', message);
                      }}
                      isRecordingDisabled={isRecordingDisabled}
                      isParentProcessing={isProcessingStop}
                      selectedDevices={selectedDevices}
                      meetingName={meetingTitle}
                      onBeforeRecord={handleBeforeRecord}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

        {/* Enhance-my-notes: live jot strip (visible only while a meeting recording is active). */}
        <JotStrip />

        {/* Status Overlays - Processing and Saving */}
        <StatusOverlays
          isProcessing={status === RecordingStatus.PROCESSING_TRANSCRIPTS && !recordingState.isRecording}
          isSaving={status === RecordingStatus.SAVING}
          sidebarCollapsed={sidebarCollapsed}
        />

        {/* AI Assistant toggle button */}
        <AnimatePresence>
          {!isPanelOpen && (
            <motion.button
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.15 }}
              onClick={async () => {
                // Get meeting folder as default project dir
                let projectDir = '';
                try {
                  const folder = await invoke<string | null>('get_meeting_folder_path');
                  projectDir = folder || '';
                } catch { /* use empty string */ }
                openPanel(
                  liveRecordingIdRef.current,
                  meetingTitle || 'Live Recording',
                  projectDir,
                );
              }}
              className="fixed right-4 top-4 z-30 bg-card border border-border rounded-full p-2.5 shadow-sm hover:shadow-md hover:bg-muted transition-[background-color,box-shadow] duration-150 group"
              title="Open AI Assistant"
              aria-label="Open AI Assistant"
            >
              <Bot className="w-5 h-5 text-muted-foreground group-hover:text-foreground transition-colors" />
              {recordingState.isRecording && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-recording rounded-full animate-pulse" />
              )}
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
