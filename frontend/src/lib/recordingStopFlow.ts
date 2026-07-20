/**
 * Pure decision helpers for the recording-stop post-processing flow (useRecordingStop).
 *
 * Extracted so the load-bearing branch decisions can be unit tested without rendering the whole
 * hook or standing up Tauri/React context. Side-effect free (except clearLastRecordingKeys, which
 * only touches the Storage handle passed to it).
 */

/**
 * sessionStorage keys that carry the just-stopped recording's destination folder + meeting name into
 * handleRecordingStop, plus the IndexedDB recovery id. Every stop path (save, discard, timeout) must
 * clear these so a stale value can never misdirect the next recording's save.
 */
export const LAST_RECORDING_KEYS = [
  'last_recording_folder_path',
  'last_recording_meeting_name',
  'indexeddb_current_meeting_id',
] as const;

/**
 * Whether the stop flow should persist the meeting to SQLite.
 *
 * Root fix for the timeout-discard bug: persistence must NOT be gated solely on the transcription
 * wait loop reaching completion. If the wait times out with chunks still queued, we still save the
 * transcripts that arrived rather than silently dropping the whole recording. A discard stop
 * (isCallApi=false) never saves; a real stop saves when transcription completed OR when at least one
 * transcript segment is present (superset of the old `isCallApi && transcriptionComplete` gate, so
 * it never removes a save that used to happen and only adds the missing timeout case).
 */
export function shouldPersistOnStop(
  isCallApi: boolean,
  transcriptionComplete: boolean,
  transcriptCount: number,
): boolean {
  return isCallApi && (transcriptionComplete || transcriptCount > 0);
}

/**
 * Whether the deferred post-save navigation (+2s) should still run.
 *
 * It navigates away and clears the app-global transcript store. If a new recording is live by the
 * time it fires (e.g. an I5b handover started the next meeting on the same shared transcript store),
 * running it would wipe the live meeting's early segments and yank the user off it, so we skip.
 */
export function shouldNavigateAfterStop(isRecordingNow: boolean): boolean {
  return !isRecordingNow;
}

/** Remove every last_recording_* / recovery key so no stop path leaks folder state into the next call. */
export function clearLastRecordingKeys(storage: Pick<Storage, 'removeItem'>): void {
  for (const key of LAST_RECORDING_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      /* storage unavailable — best effort */
    }
  }
}
