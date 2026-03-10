import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { RecordingService } from './recordingService';

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

describe('RecordingService', () => {
  let service: RecordingService;

  beforeEach(() => {
    service = new RecordingService();
    vi.clearAllMocks();
  });

  describe('isRecording', () => {
    it('invokes is_recording command', async () => {
      mockInvoke.mockResolvedValue(true);
      const result = await service.isRecording();
      expect(mockInvoke).toHaveBeenCalledWith('is_recording');
      expect(result).toBe(true);
    });
  });

  describe('getRecordingState', () => {
    it('invokes get_recording_state and returns state', async () => {
      const mockState = {
        is_recording: true,
        is_paused: false,
        is_active: true,
        recording_duration: 42.5,
        active_duration: 42.5,
      };
      mockInvoke.mockResolvedValue(mockState);

      const result = await service.getRecordingState();
      expect(mockInvoke).toHaveBeenCalledWith('get_recording_state');
      expect(result).toEqual(mockState);
    });
  });

  describe('startRecordingWithDevices', () => {
    it('invokes with correct command and args', async () => {
      mockInvoke.mockResolvedValue(undefined);
      await service.startRecordingWithDevices('Mic 1', 'Speaker 1', 'Team Standup');

      expect(mockInvoke).toHaveBeenCalledWith('start_recording_with_devices_and_meeting', {
        mic_device_name: 'Mic 1',
        system_device_name: 'Speaker 1',
        meeting_name: 'Team Standup',
      });
    });

    it('passes null for default devices', async () => {
      mockInvoke.mockResolvedValue(undefined);
      await service.startRecordingWithDevices(null, null, 'Meeting');

      expect(mockInvoke).toHaveBeenCalledWith('start_recording_with_devices_and_meeting', {
        mic_device_name: null,
        system_device_name: null,
        meeting_name: 'Meeting',
      });
    });
  });

  describe('stopRecording', () => {
    it('invokes stop_recording with save path', async () => {
      mockInvoke.mockResolvedValue(undefined);
      await service.stopRecording('/path/to/save');

      expect(mockInvoke).toHaveBeenCalledWith('stop_recording', {
        args: { save_path: '/path/to/save' },
      });
    });
  });

  describe('pauseRecording', () => {
    it('invokes pause_recording', async () => {
      mockInvoke.mockResolvedValue(undefined);
      await service.pauseRecording();
      expect(mockInvoke).toHaveBeenCalledWith('pause_recording');
    });
  });

  describe('resumeRecording', () => {
    it('invokes resume_recording', async () => {
      mockInvoke.mockResolvedValue(undefined);
      await service.resumeRecording();
      expect(mockInvoke).toHaveBeenCalledWith('resume_recording');
    });
  });

  describe('event listeners', () => {
    it('onRecordingStarted listens to recording-started', async () => {
      const callback = vi.fn();
      const mockUnlisten: UnlistenFn = () => {};
      mockListen.mockResolvedValue(mockUnlisten);

      const unlisten = await service.onRecordingStarted(callback);
      expect(mockListen).toHaveBeenCalledWith('recording-started', callback);
      expect(unlisten).toBe(mockUnlisten);
    });

    it('onRecordingStopped listens and unwraps payload', async () => {
      const callback = vi.fn();
      let capturedHandler: Function;
      mockListen.mockImplementation(async (_event, handler) => {
        capturedHandler = handler as Function;
        return (() => {}) as UnlistenFn;
      });

      await service.onRecordingStopped(callback);
      expect(mockListen).toHaveBeenCalledWith('recording-stopped', expect.any(Function));

      // Simulate event with payload wrapper
      capturedHandler!({ payload: { message: 'done', folder_path: '/tmp' } });
      expect(callback).toHaveBeenCalledWith({ message: 'done', folder_path: '/tmp' });
    });

    it('onRecordingPaused listens to recording-paused', async () => {
      const callback = vi.fn();
      mockListen.mockResolvedValue(vi.fn());
      await service.onRecordingPaused(callback);
      expect(mockListen).toHaveBeenCalledWith('recording-paused', callback);
    });

    it('onRecordingResumed listens to recording-resumed', async () => {
      const callback = vi.fn();
      mockListen.mockResolvedValue(vi.fn());
      await service.onRecordingResumed(callback);
      expect(mockListen).toHaveBeenCalledWith('recording-resumed', callback);
    });
  });
});
