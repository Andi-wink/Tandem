/**
 * stopRecordingFlow: the single off-route "stop the pipeline + run full post-processing" sequence.
 *
 * Extracted from RecordingPostProcessingProvider's I4 off-route hotkey stop so callers that need to
 * stop a recording from outside the home-route controls (the hotkey, and the I5b meeting handover)
 * share ONE code path instead of duplicating the stop_recording invoke + handleRecordingStop call.
 *
 * Awaits handleRecordingStop, so a caller can sequence a follow-up action (e.g. starting the next
 * meeting) only AFTER transcripts are saved and the auto-summary latch has fired. handleRecordingStop
 * is idempotent (guarded by its own stopInProgressRef), so racing this with another stop path is safe.
 */

import { invoke } from '@tauri-apps/api/core';
import { appDataDir } from '@tauri-apps/api/path';

export async function stopRecordingViaPipeline(
  handleRecordingStop: (callApi: boolean) => Promise<void>,
): Promise<void> {
  const dataDir = await appDataDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const savePath = `${dataDir}/recording-${timestamp}.wav`;
  // The stop command does not emit 'recording-stop-complete' (only the tray does), so we run the
  // post-processing handler directly, exactly as the off-route hotkey stop does.
  await invoke('stop_recording', { args: { save_path: savePath } });
  await handleRecordingStop(true);
}
