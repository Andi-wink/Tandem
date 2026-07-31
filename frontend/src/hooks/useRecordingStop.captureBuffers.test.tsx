import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Regression tests: the live capture buffers must be reset when a meeting ends.
 *
 * Screenshots and clips live in app-global contexts. They were cleared only on the NEXT recording's
 * start, so after a meeting finished they kept showing on the home timeline until the user started
 * another recording or reloaded the window (Ctrl+R) — a finished meeting's captures bleeding into
 * the new-meeting view. Both stop outcomes are covered here:
 *
 *   1. saved meeting  → deferred navigation (+2s) clears transcripts AND capture buffers
 *   2. no-save stop   → the user stays on Home, so the buffers are cleared there too
 *
 * Plus the handover guard: a stop must NOT wipe buffers a newly started recording is already using.
 */

const clearScreenshots = vi.fn();
const clearClipboard = vi.fn();
const clearTranscripts = vi.fn();
const push = vi.fn();

// Mutable across tests: `isRecording` drives the I5b handover guard.
let isRecordingNow = false;
let transcripts: Array<{ id: string; text: string }> = [];

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
}));

vi.mock('@/contexts/RecordingStateContext', async () => {
  const actual = await vi.importActual<typeof import('@/contexts/RecordingStateContext')>(
    '@/contexts/RecordingStateContext'
  );
  return {
    ...actual,
    useRecordingState: () => ({
      status: actual.RecordingStatus.IDLE,
      setStatus: vi.fn(),
      isStopping: false,
      get isRecording() { return isRecordingNow; },
      isProcessing: false,
      isSaving: false,
    }),
  };
});

vi.mock('@/contexts/TranscriptContext', () => ({
  useTranscripts: () => ({
    get transcriptsRef() { return { current: transcripts }; },
    flushBuffer: vi.fn(),
    clearTranscripts,
    meetingTitle: 'Test Meeting',
    markMeetingAsSaved: vi.fn(),
  }),
}));

vi.mock('@/components/Sidebar/SidebarProvider', () => ({
  useSidebar: () => ({
    refetchMeetings: vi.fn(),
    setCurrentMeeting: vi.fn(),
    setMeetings: vi.fn(),
    meetings: [],
    setIsMeetingActive: vi.fn(),
    startSummaryPolling: vi.fn(),
    serverAddress: 'http://localhost:5167',
  }),
}));

vi.mock('@/contexts/ScreenshotContext', () => ({
  useScreenshots: () => ({ clearScreenshots }),
}));

vi.mock('@/contexts/ClipboardContext', () => ({
  useClipboard: () => ({ clearClipboard }),
}));

// Transcription wait: report "done, nothing queued" so the poll loop exits on its first iteration.
vi.mock('@/services/transcriptService', () => ({
  transcriptService: {
    getTranscriptionStatus: vi.fn().mockResolvedValue({
      is_processing: false,
      chunks_in_queue: 0,
      last_activity_ms: 0,
    }),
  },
}));

vi.mock('@/services/storageService', () => ({
  storageService: {
    saveMeeting: vi.fn().mockResolvedValue({ meeting_id: 'meeting-123' }),
    getMeeting: vi.fn().mockResolvedValue({ id: 'meeting-123', title: 'Test Meeting' }),
  },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

vi.mock('@/lib/analytics', () => ({
  default: {
    trackButtonClick: vi.fn(),
    trackPageView: vi.fn(),
    track: vi.fn().mockResolvedValue(undefined),
    trackMeetingCompleted: vi.fn().mockResolvedValue(undefined),
    getMeetingsCountToday: vi.fn().mockResolvedValue(1),
    updateMeetingCount: vi.fn().mockResolvedValue(undefined),
    calculateDaysSince: vi.fn().mockResolvedValue(0),
  },
}));

import { useRecordingStop } from './useRecordingStop';

/** Drive a full stop: the flow awaits real timers (late-segment wait, deferred navigation). */
async function runStop(handleRecordingStop: (callApi: boolean) => Promise<void>, callApi: boolean) {
  await act(async () => {
    const done = handleRecordingStop(callApi);
    // Late-segment wait (4s) + state-settle (0.5s), then the deferred navigation (2s).
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    await vi.advanceTimersByTimeAsync(10_000);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  isRecordingNow = false;
  transcripts = [];
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('stopping a meeting resets the live capture buffers', () => {
  it('clears screenshots and clips when a saved meeting navigates away', async () => {
    transcripts = [{ id: 't1', text: 'hello' }];
    sessionStorage.setItem('last_recording_folder_path', 'C:/recordings/meeting');

    const { result } = renderHook(() => useRecordingStop(vi.fn(), vi.fn()));
    await runStop(result.current.handleRecordingStop, true);

    expect(push).toHaveBeenCalledWith(expect.stringContaining('meeting-123'));
    expect(clearTranscripts).toHaveBeenCalled();
    expect(clearScreenshots).toHaveBeenCalled();
    expect(clearClipboard).toHaveBeenCalled();
  });

  it('clears screenshots and clips on a stop that saves nothing (user stays on Home)', async () => {
    const { result } = renderHook(() => useRecordingStop(vi.fn(), vi.fn()));
    await runStop(result.current.handleRecordingStop, false);

    expect(push).not.toHaveBeenCalled();
    expect(clearScreenshots).toHaveBeenCalled();
    expect(clearClipboard).toHaveBeenCalled();
  });

  it('leaves the buffers alone when a new recording is already live (handover)', async () => {
    isRecordingNow = true;

    const { result } = renderHook(() => useRecordingStop(vi.fn(), vi.fn()));
    await runStop(result.current.handleRecordingStop, false);

    expect(clearScreenshots).not.toHaveBeenCalled();
    expect(clearClipboard).not.toHaveBeenCalled();
  });
});
