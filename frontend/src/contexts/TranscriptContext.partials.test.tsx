import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { listen } from '@tauri-apps/api/event';

/**
 * Unit tests for the Scribe Realtime volatile-tail layer (Phase 1, design decision D4).
 *
 * These assert the partial-rendering contract in TranscriptContext:
 *   - `transcript-partial` replaces the pending tail IN PLACE, per source
 *   - stale / out-of-order session_seq are dropped
 *   - a committed `transcript-update` clears the pending tail for that source
 *   - recording stop clears ALL pending tails
 *   - partials NEVER enter the committed `transcripts` list or the IndexedDB save path
 */

// ── Mocks ───────────────────────────────────────────────────────────────────
vi.mock('@/contexts/RecordingStateContext', async () => {
  const actual = await vi.importActual<typeof import('./RecordingStateContext')>('./RecordingStateContext');
  return {
    ...actual,
    useRecordingState: () => ({
      status: actual.RecordingStatus.IDLE,
      setStatus: vi.fn(),
      isStopping: false,
      isRecording: false,
      isPaused: false,
      isProcessing: false,
      isSaving: false,
    }),
  };
});

const idbSave = vi.fn().mockResolvedValue(undefined);
vi.mock('@/services/indexedDBService', () => ({
  indexedDBService: {
    init: vi.fn().mockResolvedValue(undefined),
    saveMeetingMetadata: vi.fn().mockResolvedValue(undefined),
    getMeetingMetadata: vi.fn().mockResolvedValue(null),
    markMeetingSaved: vi.fn().mockResolvedValue(undefined),
    saveTranscript: (...args: unknown[]) => idbSave(...args),
  },
}));

const mockListen = vi.mocked(listen);

// Capture the (payload-unwrapping) handlers the services register per event.
const eventHandlers: Record<string, Function> = {};

async function emitPartial(source: string, text: string, session_seq: number) {
  const h = eventHandlers['transcript-partial'];
  if (!h) throw new Error('transcript-partial listener not registered');
  await act(async () => { await h({ payload: { source, text, session_seq } }); });
}

async function emitCommitted(source: string, text: string, sequence_id: number) {
  const h = eventHandlers['transcript-update'];
  if (!h) throw new Error('transcript-update listener not registered');
  await act(async () => {
    await h({
      payload: {
        text, source, sequence_id,
        timestamp: '12:00:00', chunk_start_time: 0, is_partial: false, confidence: 1,
        audio_start_time: 0, audio_end_time: 1, duration: 1,
      },
    });
  });
}

async function emitRecordingStopped() {
  const h = eventHandlers['recording-stopped'];
  if (!h) throw new Error('recording-stopped listener not registered');
  await act(async () => { await h({ payload: { message: 'stopped' } }); });
}

// Imported AFTER mocks (vi.mock is hoisted, so order is cosmetic).
import { TranscriptProvider, useTranscripts } from './TranscriptContext';

function wrapper({ children }: { children: React.ReactNode }) {
  return <TranscriptProvider>{children}</TranscriptProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  idbSave.mockClear();
  Object.keys(eventHandlers).forEach((k) => delete eventHandlers[k]);
  mockListen.mockImplementation(async (event, handler) => {
    eventHandlers[event as string] = handler as Function;
    return (() => {}) as unknown as ReturnType<typeof listen> extends Promise<infer U> ? U : never;
  });
});

async function renderReady() {
  const rendered = renderHook(() => useTranscripts(), { wrapper });
  await waitFor(() => {
    expect(eventHandlers['transcript-partial']).toBeDefined();
    expect(eventHandlers['transcript-update']).toBeDefined();
    expect(eventHandlers['recording-stopped']).toBeDefined();
  });
  return rendered;
}

describe('TranscriptContext volatile partial tails', () => {
  it('replaces the pending tail in place per source', async () => {
    const { result } = await renderReady();

    await emitPartial('Local', 'hel', 1);
    await waitFor(() => expect(result.current.pendingBySource.Local).toBe('hel'));

    await emitPartial('Local', 'hello wor', 2);
    await waitFor(() => expect(result.current.pendingBySource.Local).toBe('hello wor'));

    // Replaced, not appended: exactly one Local entry, value is the latest.
    expect(Object.keys(result.current.pendingBySource)).toEqual(['Local']);
  });

  it('tracks sources independently', async () => {
    const { result } = await renderReady();

    await emitPartial('Local', 'from mic', 1);
    await emitPartial('Remote', 'from system', 1);

    await waitFor(() => {
      expect(result.current.pendingBySource.Local).toBe('from mic');
      expect(result.current.pendingBySource.Remote).toBe('from system');
    });
  });

  it('drops stale / out-of-order session_seq per source', async () => {
    const { result } = await renderReady();

    await emitPartial('Local', 'newest', 5);
    await waitFor(() => expect(result.current.pendingBySource.Local).toBe('newest'));

    // Lower seq arrives late — must be ignored.
    await emitPartial('Local', 'stale-older', 3);
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current.pendingBySource.Local).toBe('newest');
  });

  it('clears the pending tail for a source when its committed segment arrives', async () => {
    const { result } = await renderReady();

    await emitPartial('Local', 'hello worl', 1);
    await waitFor(() => expect(result.current.pendingBySource.Local).toBe('hello worl'));

    await emitCommitted('Local', 'hello world', 10);

    // Committed segment appears in the list; the volatile tail is gone.
    await waitFor(() => {
      expect(result.current.transcripts.some((t) => t.text === 'hello world')).toBe(true);
      expect(result.current.pendingBySource.Local).toBeUndefined();
    });
  });

  it('clears only the committing source, leaving other tails intact', async () => {
    const { result } = await renderReady();

    await emitPartial('Local', 'mic tail', 1);
    await emitPartial('Remote', 'system tail', 1);
    await waitFor(() => {
      expect(result.current.pendingBySource.Local).toBe('mic tail');
      expect(result.current.pendingBySource.Remote).toBe('system tail');
    });

    await emitCommitted('Local', 'mic committed', 10);

    await waitFor(() => expect(result.current.pendingBySource.Local).toBeUndefined());
    expect(result.current.pendingBySource.Remote).toBe('system tail');
  });

  it('clears all pending tails on recording stop', async () => {
    const { result } = await renderReady();

    await emitPartial('Local', 'a', 1);
    await emitPartial('Remote', 'b', 1);
    await waitFor(() => expect(Object.keys(result.current.pendingBySource).length).toBe(2));

    await emitRecordingStopped();

    await waitFor(() => expect(result.current.pendingBySource).toEqual({}));
  });

  it('never lets partials enter the committed list or the IndexedDB save path', async () => {
    const { result } = await renderReady();

    await emitPartial('Local', 'volatile one', 1);
    await emitPartial('Local', 'volatile two', 2);
    await emitPartial('Remote', 'volatile three', 1);
    await waitFor(() => expect(result.current.pendingBySource.Local).toBe('volatile two'));

    // Give any errant async persistence a chance to run.
    await new Promise((r) => setTimeout(r, 40));

    expect(result.current.transcripts).toHaveLength(0);
    expect(idbSave).not.toHaveBeenCalled();
  });

  it('lets a session_seq restart render again after a commit (no permanent freeze)', async () => {
    const { result } = await renderReady();

    // Utterance 1: high seq, then commit clears it and resets the per-source baseline.
    await emitPartial('Local', 'first utterance', 5);
    await waitFor(() => expect(result.current.pendingBySource.Local).toBe('first utterance'));
    await emitCommitted('Local', 'First utterance.', 10);
    await waitFor(() => expect(result.current.pendingBySource.Local).toBeUndefined());

    // Utterance 2: the counter restarts LOWER than the previous max. It must render,
    // not be dropped as "stale" (regression guard for the freeze bug).
    await emitPartial('Local', 'second utterance', 1);
    await waitFor(() => expect(result.current.pendingBySource.Local).toBe('second utterance'));
  });

  it('ignores partials with a non-finite session_seq without poisoning the source', async () => {
    const { result } = await renderReady();

    // NaN seq — must be ignored and must not set lastSeq to NaN.
    await emitPartial('Local', 'poison', Number.NaN);
    // Missing seq entirely (malformed payload).
    await act(async () => {
      await eventHandlers['transcript-partial']!({ payload: { source: 'Local', text: 'also poison' } });
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current.pendingBySource.Local).toBeUndefined();

    // A subsequent valid partial still renders (baseline was never corrupted).
    await emitPartial('Local', 'valid now', 1);
    await waitFor(() => expect(result.current.pendingBySource.Local).toBe('valid now'));
  });

  it('does not create a tail key for an empty-text partial', async () => {
    const { result } = await renderReady();

    // Empty tail for Local, real text for Remote: only Remote should be present, so
    // the view renders a single unlabeled tail (pendingTails.length === 1).
    await emitPartial('Local', '   ', 1);
    await emitPartial('Remote', 'system speaking', 1);
    await waitFor(() => expect(result.current.pendingBySource.Remote).toBe('system speaking'));
    expect(result.current.pendingBySource.Local).toBeUndefined();
    expect(Object.keys(result.current.pendingBySource)).toEqual(['Remote']);
  });

  it('removes an existing tail when a later empty-text partial arrives for that source', async () => {
    const { result } = await renderReady();

    await emitPartial('Local', 'about to be cleared', 1);
    await waitFor(() => expect(result.current.pendingBySource.Local).toBe('about to be cleared'));

    // A later empty partial (e.g. server revised to nothing) drops the tail.
    await emitPartial('Local', '', 2);
    await waitFor(() => expect(result.current.pendingBySource.Local).toBeUndefined());
  });
});
