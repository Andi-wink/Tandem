import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import React from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * Regression tests for the Tauri event-listener lifecycle of the two most critical stop listeners:
 *
 *   - 'recording-stop-complete'  (RecordingPostProcessingProvider, "bug 2")
 *   - 'recording-stopped'        (useRecordingStop, "bug 4")
 *
 * Both were previously registered with a NON-empty dependency array ([handleRecordingStop] and
 * [router] respectively). Every time that dep's identity changed, React tore the listener down and
 * re-listened, leaving a teardown gap in which a Rust-emitted stop event could be dropped: the
 * recording was never saved / folder_path never written. The fix registers each listener exactly
 * once (empty deps) and reads volatile values through refs.
 *
 * These tests are DISCRIMINATING: they force the volatile inputs (router identity, and therefore
 * handleRecordingStop's identity) to change across re-renders and assert that neither listener is
 * ever re-registered or torn down. Against the old dep arrays they would fail (extra listen() calls
 * plus unlisten() invocations on re-render).
 */

const mockListen = vi.mocked(listen);

// Per-event registration + teardown accounting.
const listenCounts: Record<string, number> = {};
const unlistenCounts: Record<string, number> = {};

// A fresh router object every call, so any effect keyed on `router` re-runs on every render.
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/'),
}));

vi.mock('@/contexts/RecordingStateContext', async () => {
  const actual = await vi.importActual<typeof import('./RecordingStateContext')>('./RecordingStateContext');
  return {
    ...actual,
    useRecordingState: () => ({
      status: actual.RecordingStatus.IDLE,
      setStatus: vi.fn(),
      isStopping: false,
      isRecording: false,
      isProcessing: false,
      isSaving: false,
    }),
  };
});

vi.mock('@/contexts/TranscriptContext', () => ({
  useTranscripts: () => ({
    transcriptsRef: { current: [] },
    flushBuffer: vi.fn(),
    clearTranscripts: vi.fn(),
    meetingTitle: '',
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

// Imported AFTER the mocks above are declared (vi.mock is hoisted, so order is cosmetic).
import { RecordingPostProcessingProvider } from './RecordingPostProcessingProvider';

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(listenCounts).forEach((k) => delete listenCounts[k]);
  Object.keys(unlistenCounts).forEach((k) => delete unlistenCounts[k]);

  // Each registration returns an unlisten fn that records the teardown against its own event.
  mockListen.mockImplementation(async (event) => {
    const name = event as string;
    listenCounts[name] = (listenCounts[name] ?? 0) + 1;
    const unlisten: UnlistenFn = () => {
      unlistenCounts[name] = (unlistenCounts[name] ?? 0) + 1;
    };
    return unlisten;
  });
});

describe('critical stop listeners register exactly once', () => {
  it('registers recording-stop-complete (bug 2) and recording-stopped (bug 4) once and never re-registers across re-renders', async () => {
    const { rerender } = render(
      <RecordingPostProcessingProvider>
        <div>child</div>
      </RecordingPostProcessingProvider>
    );

    // Both listeners are set up asynchronously (await listen). Wait for the first registration.
    await waitFor(() => {
      expect(listenCounts['recording-stop-complete']).toBe(1);
      expect(listenCounts['recording-stopped']).toBe(1);
    });

    // Force several re-renders. useRouter returns a NEW object each render, so handleRecordingStop's
    // identity (and, under the old code, the effect deps) changes every time.
    for (let i = 0; i < 3; i++) {
      rerender(
        <RecordingPostProcessingProvider>
          <div>child {i}</div>
        </RecordingPostProcessingProvider>
      );
    }

    // Give any (erroneously) re-registering effect its chance to run.
    await waitFor(() => {
      expect(listenCounts['recording-stop-complete']).toBe(1);
      expect(listenCounts['recording-stopped']).toBe(1);
    });

    // The one-time listeners must never have been torn down while mounted.
    expect(unlistenCounts['recording-stop-complete'] ?? 0).toBe(0);
    expect(unlistenCounts['recording-stopped'] ?? 0).toBe(0);
  });
});
