'use client';

import { invoke } from '@tauri-apps/api/core';
import { appDataDir } from '@tauri-apps/api/path';
import { useCallback, useEffect, useState, useRef } from 'react';
import { Play, Pause, Square, Mic, AlertCircle, X, Loader2, ChevronDown, Users, User } from 'lucide-react';
import { ProcessRequest, SummaryResponse } from '@/types/summary';
import { listen } from '@tauri-apps/api/event';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { motion, AnimatePresence } from 'framer-motion';
import { logger } from '@/lib/logger';
import { MIN_RECORDING_DURATION_MS } from '@/lib/constants';
import Analytics from '@/lib/analytics';
import { useRecordingState, RecordingMode } from '@/contexts/RecordingStateContext';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSoloMode } from '@/contexts/SoloModeContext';
import { LanguageMenuItems, useLanguageMenuState } from './LanguagePicker';
import { Globe } from 'lucide-react';

interface RecordingControlsProps {
  isRecording: boolean;
  barHeights: string[];
  onRecordingStop: (callApi?: boolean) => void;
  onRecordingStart: () => void;
  onTranscriptReceived: (summary: SummaryResponse) => void;
  onTranscriptionError?: (message: string) => void;
  onStopInitiated?: () => void; // Called immediately when stop button is clicked
  isRecordingDisabled: boolean;
  isParentProcessing: boolean;
  selectedDevices?: {
    micDevice: string | null;
    systemDevice: string | null;
  };
  meetingName?: string;
  onBeforeRecord?: (start: () => void) => void; // Intercept record click to show pre-record modal
}

export const RecordingControls: React.FC<RecordingControlsProps> = ({
  isRecording,
  barHeights,
  onRecordingStop,
  onRecordingStart,
  onTranscriptReceived,
  onTranscriptionError,
  onStopInitiated,
  isRecordingDisabled,
  isParentProcessing,
  selectedDevices,
  meetingName,
  onBeforeRecord,
}) => {
  // Use global recording state context for pause state (syncs with tray operations)
  const recordingState = useRecordingState();
  const isPaused = recordingState.isPaused;
  const { recordingMode, setRecordingMode } = recordingState;
  const soloMode = useSoloMode();
  const lang = useLanguageMenuState();

  const [recordingPath, setRecordingPath] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isPausing, setIsPausing] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const MIN_RECORDING_DURATION = MIN_RECORDING_DURATION_MS;
  const [transcriptionErrors, setTranscriptionErrors] = useState(0);
  const [isValidatingModel, setIsValidatingModel] = useState(false);
  const [speechDetected, setSpeechDetected] = useState(false);
  const [deviceError, setDeviceError] = useState<{ title: string, message: string } | null>(null);
  // True while an I5b meeting handover is stopping the current recording and seeding the next. The
  // global isRecording flag flips false partway through that flow, which would otherwise re-enable
  // the on-screen Start button and let the user race an unrelated, unseeded recording against the
  // handover's own seeded start. We disable the physical Start button AND the Stop button (below) for
  // the whole handover: without the Stop gate a manual click during the brief window where the call is
  // still recording would fire a SECOND, independent stop pipeline against the same recording. The
  // handover's own seeded start uses the request-start EVENT, which is intentionally left ungated.
  const [handoverActive, setHandoverActive] = useState(false);

  useEffect(() => {
    const onTransition = (e: Event) => {
      const active = (e as CustomEvent<{ active?: boolean }>).detail?.active;
      setHandoverActive(!!active);
    };
    window.addEventListener('tandem:recording-transition', onTransition as EventListener);
    return () => window.removeEventListener('tandem:recording-transition', onTransition as EventListener);
  }, []);

  useEffect(() => {
    const checkTauri = async () => {
      try {
        const result = await invoke('is_recording');
        logger.log('Tauri is initialized and ready, is_recording result:', result);
      } catch (error) {
        console.error('Tauri initialization error:', error);
        alert('Failed to initialize recording. Please check the console for details.');
      }
    };
    checkTauri();
  }, []);

  const handleStartRecording = useCallback(async () => {
    if (isStarting || isValidatingModel) return;
    logger.log('Starting recording...');
    logger.log('Selected devices:', selectedDevices);
    logger.log('Meeting name:', meetingName);
    logger.log('Current isRecording state:', isRecording);

    setTranscript(''); // Clear any previous transcript
    setSpeechDetected(false); // Reset speech detection on new recording

    try {
      // Call the validation callback which will:
      // 1. Check if model is ready
      // 2. Show appropriate toast/modal
      // 3. Call backend if valid
      // 4. Update UI state
      await onRecordingStart();
    } catch (error) {
      console.error('Failed to start recording:', error);
      console.error('Error details:', {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : 'Unknown',
        stack: error instanceof Error ? error.stack : undefined
      });

      // Parse error message to provide user-friendly feedback
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Check for device-related errors
      if (errorMsg.includes('microphone') || errorMsg.includes('mic') || errorMsg.includes('input')) {
        setDeviceError({
          title: 'Microphone Not Available',
          message: 'Unable to access your microphone. Please check that:\n• Your microphone is connected\n• The app has microphone permissions\n• No other app is using the microphone'
        });
      } else if (errorMsg.includes('system audio') || errorMsg.includes('speaker') || errorMsg.includes('output')) {
        setDeviceError({
          title: 'System Audio Not Available',
          message: 'Unable to capture system audio. Please check that:\n• A virtual audio device (like BlackHole) is installed\n• The app has screen recording permissions (macOS)\n• System audio is properly configured'
        });
      } else if (errorMsg.includes('permission')) {
        setDeviceError({
          title: 'Permission Required',
          message: 'Recording permissions are required. Please:\n• Grant microphone access in System Settings\n• Grant screen recording access for system audio (macOS)\n• Restart the app after granting permissions'
        });
      } else {
        setDeviceError({
          title: 'Recording Failed',
          message: 'Unable to start recording. Please check your audio device settings and try again.'
        });
      }
    }
  }, [onRecordingStart, isStarting, isValidatingModel, selectedDevices, meetingName, isRecording]);

  const stopRecordingAction = useCallback(async () => {
    logger.log('Executing stop recording...');
    try {
      setIsProcessing(true);
      const dataDir = await appDataDir();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const savePath = `${dataDir}/recording-${timestamp}.wav`;
      logger.log('Saving recording to:', savePath);
      logger.log('About to call stop_recording command');
      const result = await invoke('stop_recording', {
        args: {
          save_path: savePath
        }
      });
      logger.log('stop_recording command completed successfully:', result);
      setRecordingPath(savePath);
      // setShowPlayback(true);
      setIsProcessing(false);
      // Track successful transcription
      Analytics.trackTranscriptionSuccess();
      onRecordingStop(true);
    } catch (error) {
      console.error('Failed to stop recording:', error);
      if (error instanceof Error) {
        console.error('Error details:', {
          message: error.message,
          name: error.name,
          stack: error.stack,
        });
        if (error.message.includes('No recording in progress')) {
          return;
        }
      } else if (typeof error === 'string' && error.includes('No recording in progress')) {
        return;
      } else if (error && typeof error === 'object' && 'toString' in error) {
        if (error.toString().includes('No recording in progress')) {
          return;
        }
      }
      setIsProcessing(false);
      onRecordingStop(false);
    } finally {
      setIsStopping(false);
    }
  }, [onRecordingStop]);

  const handleStopRecording = useCallback(async () => {
    logger.log('handleStopRecording called - isRecording:', isRecording, 'isStarting:', isStarting, 'isStopping:', isStopping);
    if (!isRecording || isStarting || isStopping) {
      logger.log('Early return from handleStopRecording due to state check');
      return;
    }

    logger.log('Stopping recording...');

    // Notify parent immediately (for UI state updates)
    onStopInitiated?.();

    setIsStopping(true);

    // Immediately trigger the stop action
    await stopRecordingAction();
  }, [isRecording, isStarting, isStopping, stopRecordingAction, onStopInitiated]);

  const handlePauseRecording = useCallback(async () => {
    if (!isRecording || isPaused || isPausing) return;

    logger.log('Pausing recording...');
    setIsPausing(true);

    try {
      await invoke('pause_recording');
      // isPaused state now managed by RecordingStateContext via events
      logger.log('Recording paused successfully');
    } catch (error) {
      console.error('Failed to pause recording:', error);
      alert('Failed to pause recording. Please check the console for details.');
    } finally {
      setIsPausing(false);
    }
  }, [isRecording, isPaused, isPausing]);

  const handleResumeRecording = useCallback(async () => {
    if (!isRecording || !isPaused || isResuming) return;

    logger.log('Resuming recording...');
    setIsResuming(true);

    try {
      await invoke('resume_recording');
      // isPaused state now managed by RecordingStateContext via events
      logger.log('Recording resumed successfully');
    } catch (error) {
      console.error('Failed to resume recording:', error);
      alert('Failed to resume recording. Please check the console for details.');
    } finally {
      setIsResuming(false);
    }
  }, [isRecording, isPaused, isResuming]);

  useEffect(() => {
    return () => {
      // Cleanup on unmount if needed
    };
  }, []);

  // Command-palette bridge: reuse the exact button code paths (including onBeforeRecord, which is
  // what starts a Solo session) so a palette command behaves identically to clicking the control.
  useEffect(() => {
    const onStart = () => {
      if (isRecording || isStarting || isRecordingDisabled) return;
      if (onBeforeRecord) onBeforeRecord(handleStartRecording);
      else handleStartRecording();
    };
    const onStop = () => { handleStopRecording(); };
    window.addEventListener('tandem:request-start-recording', onStart);
    window.addEventListener('tandem:request-stop-recording', onStop);
    return () => {
      window.removeEventListener('tandem:request-start-recording', onStart);
      window.removeEventListener('tandem:request-stop-recording', onStop);
    };
  }, [isRecording, isStarting, isRecordingDisabled, onBeforeRecord, handleStartRecording, handleStopRecording]);

  useEffect(() => {
    logger.log('Setting up recording event listeners');
    let unsubscribes: (() => void)[] = [];

    const setupListeners = async () => {
      try {
        // Transcript error listener - handles both regular and actionable errors
        const transcriptErrorUnsubscribe = await listen('transcript-error', (event) => {
          logger.log('transcript-error event received:', event);
          console.error('Transcription error received:', event.payload);
          const errorMessage = event.payload as string;

          Analytics.trackTranscriptionError(errorMessage);
          logger.log('Tracked transcription error:', errorMessage);

          setTranscriptionErrors(prev => {
            const newCount = prev + 1;
            logger.log('Transcription error count incremented:', newCount);
            return newCount;
          });
          setIsProcessing(false);
          logger.log('Calling onRecordingStop(false) due to transcript error');
          onRecordingStop(false);
          if (onTranscriptionError) {
            onTranscriptionError(errorMessage);
          }
        });

        // Transcription error listener - handles structured error objects with actionable flag
        const transcriptionErrorUnsubscribe = await listen('transcription-error', (event) => {
          logger.log('transcription-error event received:', event);
          console.error('Transcription error received:', event.payload);

          let errorMessage: string;
          let isActionable = false;

          if (typeof event.payload === 'object' && event.payload !== null) {
            const payload = event.payload as { error: string, userMessage: string, actionable: boolean };
            errorMessage = payload.userMessage || payload.error;
            isActionable = payload.actionable || false;
          } else {
            errorMessage = String(event.payload);
          }

          Analytics.trackTranscriptionError(errorMessage);
          logger.log('Tracked transcription error:', errorMessage);

          setTranscriptionErrors(prev => {
            const newCount = prev + 1;
            logger.log('Transcription error count incremented:', newCount);
            return newCount;
          });
          setIsProcessing(false);
          logger.log('Calling onRecordingStop(false) due to transcription error');
          onRecordingStop(false);

          // For actionable errors (like model loading failures), the main page will handle showing the model selector
          // For regular errors, they are handled by useModalState global listener which shows a toast
          // We don't want to show a modal (via onTranscriptionError) AND a toast, so we skip the callback here
          /* if (onTranscriptionError && !isActionable) {
            onTranscriptionError(errorMessage);
          } */
        });

        // Pause/Resume events are now handled by RecordingStateContext
        // No need for duplicate listeners here

        // Speech detected listener - for UX feedback when VAD detects speech
        const speechDetectedUnsubscribe = await listen('speech-detected', (event) => {
          logger.log('speech-detected event received:', event);
          setSpeechDetected(true);
        });

        unsubscribes = [
          transcriptErrorUnsubscribe,
          transcriptionErrorUnsubscribe,
          speechDetectedUnsubscribe
        ];
        logger.log('Recording event listeners set up successfully');
      } catch (error) {
        console.error('Failed to set up recording event listeners:', error);
      }
    };

    setupListeners();

    return () => {
      logger.log('Cleaning up recording event listeners');
      unsubscribes.forEach(unsubscribe => {
        if (unsubscribe && typeof unsubscribe === 'function') {
          unsubscribe();
        }
      });
    };
  }, [onRecordingStop, onTranscriptionError]);

  return (
    <TooltipProvider>
      <div className="flex flex-col space-y-2">
        <div className={`flex items-center space-x-2 rounded-full px-4 py-2 transition-[background-color,box-shadow] duration-300 ${
          isRecording
            ? isPaused
              ? 'bg-card shadow-lg'
              : 'bg-card shadow-xl'
            : 'bg-card shadow-lg'
        }`}>
          <AnimatePresence mode="wait">
            {isProcessing && !isParentProcessing ? (
              <motion.div
                key="processing"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.15 }}
                className="flex items-center space-x-2"
              >
                <Loader2 className="h-5 w-5 animate-spin text-foreground" />
                <span className="text-sm text-muted-foreground">Processing recording...</span>
              </motion.div>
            ) : (
              <motion.div
                key="controls"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.15 }}
                className="flex items-center"
              >
                <AnimatePresence mode="wait">
                  {!isRecording ? (
                    // Start recording button with mode selector
                    <motion.div
                      key="start"
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      transition={{ duration: 0.2 }}
                      className="flex flex-col items-center gap-1"
                    >
                      <div className="flex items-center">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => {
                                Analytics.trackButtonClick('start_recording', 'recording_controls');
                                if (onBeforeRecord) {
                                  onBeforeRecord(handleStartRecording);
                                } else {
                                  handleStartRecording();
                                }
                              }}
                              disabled={isStarting || isProcessing || isRecordingDisabled || isValidatingModel || handoverActive}
                              className={`w-12 h-12 flex items-center justify-center ${
                                isStarting || isProcessing || isValidatingModel
                                  ? 'bg-muted-foreground'
                                  : 'bg-recording hover:bg-recording-hover hover:brightness-110'
                              } ${recordingMode === 'solo' ? 'rounded-l-full' : 'rounded-full'} text-recording-foreground transition-[background-color,transform] duration-150 relative`}
                            >
                              {isValidatingModel ? (
                                <Loader2 className="h-5 w-5 animate-spin text-recording-foreground" />
                              ) : (
                                <Mic size={20} />
                              )}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Start {recordingMode === 'solo' ? 'solo' : ''} recording</p>
                          </TooltipContent>
                        </Tooltip>

                        {/* Mode + language dropdown trigger */}
                        <DropdownMenu onOpenChange={open => { if (open) lang.refreshProvider(); }}>
                          <DropdownMenuTrigger asChild>
                            <button
                              disabled={isStarting || isProcessing || isRecordingDisabled || handoverActive}
                              aria-label="Recording mode and transcription language"
                              className={`relative h-12 w-7 flex items-center justify-center ${
                                isStarting || isProcessing
                                  ? 'bg-muted-foreground'
                                  : 'bg-recording hover:bg-recording-hover hover:brightness-110'
                              } rounded-r-full text-recording-foreground border-l border-recording-foreground/20 transition-[background-color] duration-150`}
                            >
                              <ChevronDown size={14} />
                              {lang.isAutoDetectOnly && (
                                <span
                                  className="absolute top-1 right-1 h-2 w-2 rounded-full bg-amber-500 ring-1 ring-recording"
                                  aria-hidden
                                />
                              )}
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="center" sideOffset={8} className="min-w-[200px]">
                            <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">Mode</DropdownMenuLabel>
                            <DropdownMenuRadioGroup
                              value={recordingMode}
                              onValueChange={(v) => setRecordingMode(v as RecordingMode)}
                            >
                              <DropdownMenuRadioItem value="meeting" className="flex items-center gap-2">
                                <Users size={14} /> Meeting
                              </DropdownMenuRadioItem>
                              <DropdownMenuRadioItem value="solo" className="flex items-center gap-2">
                                <User size={14} /> Solo
                              </DropdownMenuRadioItem>
                            </DropdownMenuRadioGroup>
                            <DropdownMenuSeparator />
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger className="flex items-center gap-2">
                                <Globe size={14} />
                                <span>Language</span>
                                <span className="ml-auto text-xs text-muted-foreground tabular-nums">{lang.current.short}</span>
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent className="w-64 max-h-[70vh] overflow-y-auto">
                                <LanguageMenuItems
                                  selectedLanguage={lang.selectedLanguage}
                                  isAutoDetectOnly={lang.isAutoDetectOnly}
                                  switching={lang.switching}
                                  onSelect={lang.handleSelect}
                                  onSwitchToWhisper={lang.handleSwitchToWhisper}
                                />
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>

                      {/* Mode label + active project indicator */}
                      {recordingMode === 'solo' && (
                        <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
                          Solo Mode
                        </span>
                      )}
                    </motion.div>
                  ) : (
                    // Recording controls (pause/resume + stop)
                    <motion.div
                      key="recording"
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      transition={{ duration: 0.2 }}
                      className="flex items-center space-x-2"
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => {
                              if (isPaused) {
                                Analytics.trackButtonClick('resume_recording', 'recording_controls');
                                handleResumeRecording();
                              } else {
                                Analytics.trackButtonClick('pause_recording', 'recording_controls');
                                handlePauseRecording();
                              }
                            }}
                            disabled={isPausing || isResuming || isStopping}
                            className={`w-9 h-9 flex items-center justify-center ${
                              isPausing || isResuming || isStopping
                                ? 'bg-muted border border-border text-muted-foreground'
                                : 'bg-background border border-border text-muted-foreground hover:text-foreground hover:bg-muted active:scale-95'
                            } rounded-full transition-[background-color,border-color,color,transform] duration-150 relative`}
                          >
                            {isPaused ? <Play size={16} /> : <Pause size={16} />}
                            {(isPausing || isResuming) && (
                              <div className="absolute -top-8 text-muted-foreground font-medium text-xs">
                                {isPausing ? 'Pausing...' : 'Resuming...'}
                              </div>
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{isPaused ? 'Resume recording' : 'Pause recording'}</p>
                        </TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => {
                              Analytics.trackButtonClick('stop_recording', 'recording_controls');
                              handleStopRecording();
                            }}
                            disabled={isStopping || isPausing || isResuming || handoverActive}
                            className={`w-10 h-10 flex items-center justify-center ${
                              isStopping || isPausing || isResuming
                                ? 'bg-muted-foreground'
                                : 'bg-recording hover:bg-recording-hover active:scale-95'
                            } rounded-full text-recording-foreground transition-[background-color,transform] duration-150 relative`}
                          >
                            <Square size={16} />
                            {isStopping && (
                              <div className="absolute -top-8 text-muted-foreground font-medium text-xs">
                                Stopping...
                              </div>
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Stop recording</p>
                        </TooltipContent>
                      </Tooltip>
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="flex items-center gap-[3px] mx-3">
                  {barHeights.map((height, index) => (
                    <div
                      key={index}
                      className={`w-1 rounded-full transition-[height,opacity] duration-150 ${isPaused ? 'bg-muted-foreground' : 'bg-recording'}`}
                      style={{
                        height: isRecording && !isPaused ? height : '4px',
                        opacity: isPaused ? 0.4 : 0.8,
                        transitionDelay: `${index * 30}ms`,
                      }}
                    />
                  ))}
                </div>

                {/* Solo Mode: Active project indicator */}
                {isRecording && recordingMode === 'solo' && (
                  <div className="flex items-center gap-1.5 ml-2 px-2 py-0.5 rounded-full bg-muted/50">
                    <div className={`w-2 h-2 rounded-full ${
                      soloMode.activeProject ? 'bg-green-500' : 'bg-amber-500'
                    } animate-pulse`} />
                    <span className="text-[11px] text-muted-foreground font-medium truncate max-w-[120px]">
                      {soloMode.activeProject
                        ? soloMode.activeProject.name
                        : 'Say a project name'}
                    </span>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Show validation status only */}
        {isValidatingModel && (
          <div className="text-xs text-muted-foreground text-center mt-2">
            Validating speech recognition...
          </div>
        )}

        {/* Device error alert */}
        {deviceError && (
          <Alert variant="destructive" className="mt-4">
            <AlertCircle className="h-5 w-5" />
            <button
              onClick={() => setDeviceError(null)}
              className="absolute right-3 top-3 text-destructive hover:text-destructive/80 transition-colors"
              aria-label="Close alert"
            >
              <X className="h-4 w-4" />
            </button>
            <AlertTitle className="font-semibold mb-2">
              {deviceError.title}
            </AlertTitle>
            <AlertDescription>
              {deviceError.message.split('\n').map((line, i) => (
                <div key={i} className={i > 0 ? 'ml-2' : ''}>
                  {line}
                </div>
              ))}
            </AlertDescription>
          </Alert>
        )}

      </div>
    </TooltipProvider>
  );
};