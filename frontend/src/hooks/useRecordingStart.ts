import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useConfig } from '@/contexts/ConfigContext';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { useScreenshots } from '@/contexts/ScreenshotContext';
import { useClipboard } from '@/contexts/ClipboardContext';
import { recordingService } from '@/services/recordingService';
import { isConsentRequired } from '@/services/consentService';
import Analytics from '@/lib/analytics';
import { showRecordingNotification } from '@/lib/recordingNotification';
import { peekRecordingSeed } from '@/lib/recordingSeed';
import { toast } from 'sonner';

/**
 * R3: the base directory the meeting folder should be created under, derived from a calendar seed.
 * When the event routed to a project, we file directly into `<project>/.tandem` at start; otherwise
 * null (default recordings folder, with post-stop relocation handling any later filing).
 */
function seedMeetingBaseDir(): string | null {
  const seed = peekRecordingSeed();
  if (!seed?.projectPath) return null;
  const sep = seed.projectPath.includes('\\') ? '\\' : '/';
  return `${seed.projectPath}${sep}.tandem`;
}

/** Where a start request came from. Only affects analytics labels and error surfacing. */
type StartSource = 'home_page' | 'sidebar_auto' | 'sidebar_direct';

interface UseRecordingStartReturn {
  handleRecordingStart: () => Promise<void>;
  isAutoStarting: boolean;
  /** Props for the pre-record consent dialog. Render `<ConsentDialog {...consentDialog} />`. */
  consentDialog: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    meetingTitle: string | null;
    onConsentRecorded: () => void;
  };
}

/**
 * Custom hook for managing recording start lifecycle.
 * Handles both manual start (button click) and auto-start (from sidebar navigation).
 *
 * Features:
 * - Meeting title generation (format: Meeting DD_MM_YY_HH_MM_SS)
 * - Transcript clearing on start
 * - Analytics tracking
 * - Pre-record consent gate (see below)
 * - Auto-start from sidebar via sessionStorage flag
 *
 * ## Consent gate
 *
 * `start_recording` refuses with `CONSENT_REQUIRED` until a consent record has been written and
 * the Rust-side gate armed. When that happens we open the consent dialog and retry the same start
 * once consent is given. The gate lives in Rust so the tray menu and global shortcut are covered
 * too; this hook is just the UI half.
 */
export function useRecordingStart(
  isRecording: boolean,
  setIsRecording: (value: boolean) => void,
  showModal?: (name: 'modelSelector', message?: string) => void
): UseRecordingStartReturn {
  const [isAutoStarting, setIsAutoStarting] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentMeetingTitle, setConsentMeetingTitle] = useState<string | null>(null);

  /**
   * The start that was blocked awaiting consent, replayed verbatim once consent is recorded.
   * Held in a ref so re-renders from opening the dialog do not drop it.
   */
  const pendingStartRef = useRef<(() => Promise<void>) | null>(null);

  const { clearTranscripts, setMeetingTitle } = useTranscripts();
  const { setIsMeetingActive } = useSidebar();
  const { selectedDevices } = useConfig();
  const { setStatus } = useRecordingState();
  const { clearScreenshots } = useScreenshots();
  const { clearClipboard } = useClipboard();

  // Generate meeting title: prefer a calendar seed's event title (I3), else the timestamp format.
  const generateMeetingTitle = useCallback(() => {
    const seeded = peekRecordingSeed()?.title?.trim();
    if (seeded) return seeded;
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = String(now.getFullYear()).slice(-2);
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `Meeting ${day}_${month}_${year}_${hours}_${minutes}_${seconds}`;
  }, []);

  // Check if Parakeet transcription model is ready
  const checkParakeetReady = useCallback(async (): Promise<boolean> => {
    try {
      await invoke('parakeet_init');
      const hasModels = await invoke<boolean>('parakeet_has_available_models');
      return hasModels;
    } catch (error) {
      console.error('Failed to check Parakeet status:', error);
      return false;
    }
  }, []);

  // Check if any model is currently downloading
  const checkIfModelDownloading = useCallback(async (): Promise<boolean> => {
    try {
      const models = await invoke<any[]>('parakeet_get_available_models');
      const isDownloading = models.some(m =>
        m.status && (
          typeof m.status === 'object'
            ? 'Downloading' in m.status
            : m.status === 'Downloading'
        )
      );
      return isDownloading;
    } catch (error) {
      console.error('Failed to check model download status:', error);
      return false; // Default to not downloading (will show error + modal)
    }
  }, []);

  /**
   * Model-readiness gate, shared by all start paths. Returns false when the caller must abort.
   */
  const ensureModelReady = useCallback(
    async (source: StartSource): Promise<boolean> => {
      const parakeetReady = await checkParakeetReady();
      if (parakeetReady) return true;

      const isDownloading = await checkIfModelDownloading();
      if (isDownloading) {
        toast.info('Model download in progress', {
          description: 'Please wait for the transcription model to finish downloading before recording.',
          duration: 5000,
        });
        Analytics.trackButtonClick('start_recording_blocked_downloading', source);
      } else {
        toast.error('Transcription model not ready', {
          description: 'Please download a transcription model before recording.',
          duration: 5000,
        });
        showModal?.('modelSelector', 'Transcription model setup required');
        Analytics.trackButtonClick('start_recording_blocked_missing', source);
      }
      setStatus(RecordingStatus.IDLE);
      return false;
    },
    [checkParakeetReady, checkIfModelDownloading, showModal, setStatus],
  );

  /**
   * The single start path. Every trigger (button, sidebar event, sidebar auto-start, and via the
   * Rust gate the tray and global shortcut) funnels through here, so the consent gate cannot be
   * bypassed by adding another caller later.
   *
   * `rethrow` preserves the manual path's contract: RecordingControls needs the original error to
   * surface device-specific messages.
   */
  const startRecording = useCallback(
    async (source: StartSource, meetingTitleOverride?: string, rethrow = false): Promise<void> => {
      const meetingTitle = meetingTitleOverride ?? generateMeetingTitle();

      try {
        setStatus(RecordingStatus.STARTING, 'Initializing recording...');

        await recordingService.startRecordingWithDevices(
          selectedDevices?.micDevice || null,
          selectedDevices?.systemDevice || null,
          meetingTitle,
          seedMeetingBaseDir()
        );

        setMeetingTitle(meetingTitle);
        setIsRecording(true);
        clearTranscripts();
        clearScreenshots();
        clearClipboard();
        setIsMeetingActive(true);
        Analytics.trackButtonClick('start_recording', source);

        await showRecordingNotification();
      } catch (error) {
        // Consent gate: not an error condition, a prompt. Park this exact start and replay it
        // once the user has recorded consent, so nothing about the call is lost.
        if (isConsentRequired(error)) {
          console.log('Recording blocked pending consent — opening consent dialog');
          setStatus(RecordingStatus.IDLE);
          setConsentMeetingTitle(meetingTitle);
          pendingStartRef.current = () =>
            startRecording(source, meetingTitle, rethrow);
          setConsentOpen(true);
          Analytics.trackButtonClick('start_recording_consent_required', source);
          return;
        }

        console.error(`Failed to start recording (${source}):`, error);
        setStatus(
          RecordingStatus.ERROR,
          error instanceof Error ? error.message : 'Failed to start recording'
        );
        setIsRecording(false);
        Analytics.trackButtonClick('start_recording_error', source);

        if (rethrow) throw error;
        toast.error('Failed to start recording', {
          description: error instanceof Error ? error.message : 'Check the console for details.',
        });
      }
    },
    [
      generateMeetingTitle,
      selectedDevices,
      setMeetingTitle,
      setIsRecording,
      clearTranscripts,
      clearScreenshots,
      clearClipboard,
      setIsMeetingActive,
      setStatus,
    ],
  );

  /** Replays the parked start once consent has been recorded and the Rust gate armed. */
  const handleConsentRecorded = useCallback(() => {
    const pending = pendingStartRef.current;
    pendingStartRef.current = null;
    setConsentOpen(false);
    if (pending) {
      // Swallow here: the replayed call does its own error surfacing, and a rethrow would land
      // in the dialog's event handler with nowhere useful to go.
      void pending().catch(() => {});
    }
  }, []);

  /** Drops the parked start when the user backs out of the dialog. */
  const handleConsentOpenChange = useCallback((open: boolean) => {
    setConsentOpen(open);
    if (!open) {
      pendingStartRef.current = null;
    }
  }, []);

  // Handle manual recording start (from button click)
  const handleRecordingStart = useCallback(async () => {
    console.log('handleRecordingStart called - checking Parakeet model status');
    if (!(await ensureModelReady('home_page'))) return;

    console.log('Parakeet ready - starting recording');
    // rethrow: RecordingControls handles device-specific errors itself.
    await startRecording('home_page', undefined, true);
  }, [ensureModelReady, startRecording]);

  // Check for autoStartRecording flag and start recording automatically
  useEffect(() => {
    const checkAutoStartRecording = async () => {
      if (typeof window === 'undefined') return;

      const shouldAutoStart = sessionStorage.getItem('autoStartRecording');
      if (shouldAutoStart !== 'true' || isRecording || isAutoStarting) return;

      console.log('Auto-starting recording from navigation...');
      setIsAutoStarting(true);
      sessionStorage.removeItem('autoStartRecording'); // Clear the flag

      try {
        if (!(await ensureModelReady('sidebar_auto'))) return;
        await startRecording('sidebar_auto');
      } finally {
        setIsAutoStarting(false);
      }
    };

    checkAutoStartRecording();
  }, [isRecording, isAutoStarting, ensureModelReady, startRecording]);

  // Listen for direct recording trigger from sidebar when already on home page
  useEffect(() => {
    const handleDirectStart = async () => {
      if (isRecording || isAutoStarting) {
        console.log('Recording already in progress, ignoring direct start event');
        return;
      }

      console.log('Direct start from sidebar - checking Parakeet model status');
      setIsAutoStarting(true);
      try {
        if (!(await ensureModelReady('sidebar_direct'))) return;
        await startRecording('sidebar_direct');
      } finally {
        setIsAutoStarting(false);
      }
    };

    window.addEventListener('start-recording-from-sidebar', handleDirectStart);

    return () => {
      window.removeEventListener('start-recording-from-sidebar', handleDirectStart);
    };
  }, [isRecording, isAutoStarting, ensureModelReady, startRecording]);

  return {
    handleRecordingStart,
    isAutoStarting,
    consentDialog: {
      open: consentOpen,
      onOpenChange: handleConsentOpenChange,
      meetingTitle: consentMeetingTitle,
      onConsentRecorded: handleConsentRecorded,
    },
  };
}
