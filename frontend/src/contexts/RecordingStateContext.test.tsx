import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { RecordingStateProvider, useRecordingState, RecordingStatus } from './RecordingStateContext';

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

// Capture event handlers registered via listen()
const eventHandlers: Record<string, Function> = {};

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(eventHandlers).forEach(key => delete eventHandlers[key]);

  // Default: backend says not recording
  mockInvoke.mockResolvedValue({
    is_recording: false,
    is_paused: false,
    is_active: false,
    recording_duration: null,
    active_duration: null,
  });

  // Capture event handlers as they're registered
  mockListen.mockImplementation(async (event, handler) => {
    eventHandlers[event as string] = handler as Function;
    return (() => {}) as UnlistenFn; // unlisten
  });
});

function wrapper({ children }: { children: React.ReactNode }) {
  return <RecordingStateProvider>{children}</RecordingStateProvider>;
}

describe('RecordingStateContext', () => {
  it('provides initial idle state', async () => {
    const { result } = renderHook(() => useRecordingState(), { wrapper });

    await waitFor(() => {
      expect(result.current.status).toBe(RecordingStatus.IDLE);
    });

    expect(result.current.isRecording).toBe(false);
    expect(result.current.isPaused).toBe(false);
    expect(result.current.isActive).toBe(false);
    expect(result.current.isStopping).toBe(false);
    expect(result.current.isProcessing).toBe(false);
    expect(result.current.isSaving).toBe(false);
  });

  it('syncs with backend on mount', async () => {
    mockInvoke.mockResolvedValue({
      is_recording: true,
      is_paused: false,
      is_active: true,
      recording_duration: 10.0,
      active_duration: 10.0,
    });

    const { result } = renderHook(() => useRecordingState(), { wrapper });

    await waitFor(() => {
      expect(result.current.isRecording).toBe(true);
    });

    expect(result.current.isActive).toBe(true);
    expect(result.current.recordingDuration).toBe(10.0);
  });

  it('throws when used outside provider', () => {
    // Suppress console.error from React for expected error
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => {
      renderHook(() => useRecordingState());
    }).toThrow('useRecordingState must be used within a RecordingStateProvider');
    spy.mockRestore();
  });

  it('transitions to RECORDING on recording-started event', async () => {
    const { result } = renderHook(() => useRecordingState(), { wrapper });

    // Wait for listeners to be set up
    await waitFor(() => {
      expect(eventHandlers['recording-started']).toBeDefined();
    });

    act(() => {
      eventHandlers['recording-started']!({});
    });

    await waitFor(() => {
      expect(result.current.status).toBe(RecordingStatus.RECORDING);
    });
    expect(result.current.isRecording).toBe(true);
    expect(result.current.isActive).toBe(true);
  });

  it('resets state on recording-stopped event', async () => {
    // Start in recording state
    mockInvoke.mockResolvedValue({
      is_recording: true,
      is_paused: false,
      is_active: true,
      recording_duration: 30.0,
      active_duration: 30.0,
    });

    const { result } = renderHook(() => useRecordingState(), { wrapper });

    await waitFor(() => {
      expect(eventHandlers['recording-stopped']).toBeDefined();
    });

    act(() => {
      eventHandlers['recording-stopped']!({
        payload: { message: 'Recording saved', folder_path: '/tmp/meeting' },
      });
    });

    await waitFor(() => {
      expect(result.current.isRecording).toBe(false);
    });
    expect(result.current.isActive).toBe(false);
    expect(result.current.recordingDuration).toBeNull();
  });

  it('handles pause and resume events', async () => {
    const { result } = renderHook(() => useRecordingState(), { wrapper });

    await waitFor(() => {
      expect(eventHandlers['recording-started']).toBeDefined();
    });

    // Start recording
    act(() => {
      eventHandlers['recording-started']!({});
    });

    await waitFor(() => {
      expect(result.current.isRecording).toBe(true);
    });

    // Pause
    act(() => {
      eventHandlers['recording-paused']!({});
    });

    await waitFor(() => {
      expect(result.current.isPaused).toBe(true);
    });
    expect(result.current.isActive).toBe(false);

    // Resume
    act(() => {
      eventHandlers['recording-resumed']!({});
    });

    await waitFor(() => {
      expect(result.current.isPaused).toBe(false);
    });
    expect(result.current.isActive).toBe(true);
  });

  it('setStatus updates status and message', async () => {
    const { result } = renderHook(() => useRecordingState(), { wrapper });

    await waitFor(() => {
      expect(result.current.status).toBe(RecordingStatus.IDLE);
    });

    act(() => {
      result.current.setStatus(RecordingStatus.STOPPING, 'Finalizing...');
    });

    expect(result.current.status).toBe(RecordingStatus.STOPPING);
    expect(result.current.statusMessage).toBe('Finalizing...');
    expect(result.current.isStopping).toBe(true);
  });
});
