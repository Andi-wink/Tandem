/**
 * Stop-driven auto-summary (I4).
 *
 * Auto-summary used to fire ONLY via the `?source=recording` query param on the
 * meeting-details page, so recordings stopped from the tray or the global hotkey
 * (which may never bring that page into focus) were never summarized. We now kick
 * off summary generation directly from the recording-stop path, guarded by meeting
 * id so the legacy query-param path can never double-generate the same meeting.
 *
 * The guard is a module-level Set (survives navigation, not a full reload — which is
 * fine: a reload means a fresh app with no in-flight generation to collide with).
 */

import { Transcript } from '@/types';

const started = new Set<string>();

/** Has an auto-summary already been kicked off for this meeting this session? */
export function hasAutoSummaryStarted(meetingId: string): boolean {
  return started.has(meetingId);
}

/** Mark a meeting as having its auto-summary started (idempotency latch). */
export function markAutoSummaryStarted(meetingId: string): void {
  started.add(meetingId);
}

/** Release the latch so a failed/cancelled generation can be retried. */
export function resetAutoSummary(meetingId: string): void {
  started.delete(meetingId);
}

/**
 * Reads the persisted auto-summary preference. Mirrors ConfigContext exactly:
 * the key is `isAutoSummary` and the default when unset is OFF (false).
 */
export function isAutoSummaryEnabled(): boolean {
  try {
    const saved = localStorage.getItem('isAutoSummary');
    return saved !== null ? saved === 'true' : false;
  } catch {
    return false;
  }
}

/**
 * Formats a recording-relative timestamp `[MM:SS]`, falling back to the wall-clock
 * string for legacy transcripts that predate audio timing. Pure — testable.
 */
export function formatTranscriptTime(seconds: number | undefined, fallbackTimestamp: string): string {
  if (seconds === undefined) return fallbackTimestamp;
  const totalSecs = Math.floor(seconds);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `[${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
}

/**
 * Builds the single transcript blob the summarizer consumes: one line per segment,
 * timestamp then text. Matches useSummaryGeneration's on-page formatting so the
 * stop-driven and manual paths produce identical input.
 */
export function buildTranscriptText(transcripts: Transcript[]): string {
  return transcripts
    .map((t) => `${formatTranscriptTime(t.audio_start_time, t.timestamp)} ${t.text}`)
    .join('\n');
}
