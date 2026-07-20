import { describe, it, expect, vi } from 'vitest';
import {
  shouldPersistOnStop,
  shouldNavigateAfterStop,
  clearLastRecordingKeys,
  LAST_RECORDING_KEYS,
} from './recordingStopFlow';

describe('shouldPersistOnStop', () => {
  it('does not save a discard stop (isCallApi=false), even with transcripts', () => {
    expect(shouldPersistOnStop(false, true, 12)).toBe(false);
    expect(shouldPersistOnStop(false, false, 12)).toBe(false);
  });

  it('saves when transcription completed (legacy behavior preserved, any count)', () => {
    expect(shouldPersistOnStop(true, true, 5)).toBe(true);
    expect(shouldPersistOnStop(true, true, 0)).toBe(true);
  });

  // Root regression for the timeout-discard bug: the wait loop timed out
  // (transcriptionComplete=false) but transcripts arrived — must still save, not drop them.
  it('saves on transcription-wait timeout as long as transcripts arrived', () => {
    expect(shouldPersistOnStop(true, false, 8)).toBe(true);
    expect(shouldPersistOnStop(true, false, 1)).toBe(true);
  });

  it('does not save when timed out with zero transcripts (nothing to persist)', () => {
    expect(shouldPersistOnStop(true, false, 0)).toBe(false);
  });
});

describe('shouldNavigateAfterStop', () => {
  it('navigates when no recording is live', () => {
    expect(shouldNavigateAfterStop(false)).toBe(true);
  });

  // Root regression for the handover transcript-corruption bug: a new recording is live when the
  // +2s timeout fires, so the deferred navigate/clearTranscripts must be skipped.
  it('skips navigation when a recording is live (handover next meeting)', () => {
    expect(shouldNavigateAfterStop(true)).toBe(false);
  });
});

describe('clearLastRecordingKeys', () => {
  it('removes every last_recording_* / recovery key', () => {
    const removed: string[] = [];
    const storage = { removeItem: (k: string) => { removed.push(k); } };
    clearLastRecordingKeys(storage);
    expect(removed).toEqual([...LAST_RECORDING_KEYS]);
    expect(removed).toContain('last_recording_folder_path');
    expect(removed).toContain('last_recording_meeting_name');
    expect(removed).toContain('indexeddb_current_meeting_id');
  });

  it('swallows storage errors (best effort) and still attempts every key', () => {
    const attempted: string[] = [];
    const storage = {
      removeItem: vi.fn((k: string) => {
        attempted.push(k);
        throw new Error('storage unavailable');
      }),
    };
    expect(() => clearLastRecordingKeys(storage)).not.toThrow();
    expect(attempted).toEqual([...LAST_RECORDING_KEYS]);
  });
});
