/**
 * collectAllTranscripts: the pure pagination loop behind MeetingNotesSection's Regenerate.
 *
 * The meeting-details page renders transcripts through usePaginatedTranscripts (first page only until the
 * user scrolls), so Regenerate must never build the enhance prompt from that partial subset: a jot flagged
 * past the first page would otherwise verify as "(none captured)" against a transcript that is merely
 * unloaded, not absent. This walks every page via the injected `fetchPage` until the backend reports no
 * more (or returns an empty batch), then sorts by start time for stable jot windows.
 *
 * The transport (Tauri invoke) is injected so the loop is pure and unit-testable: has_more handling, the
 * offset accumulation, and the runaway-loop ceiling are all exercisable without the app or the backend.
 */

import type { Transcript, PaginatedTranscriptsResponse } from '@/types';

export type FetchTranscriptPage = (
  limit: number,
  offset: number,
) => Promise<PaginatedTranscriptsResponse>;

/** Default page size. Matches the previous inline PAGE constant. */
export const TRANSCRIPT_PAGE_SIZE = 500;

/** Hard ceiling so a misbehaving backend that never sets has_more cannot loop forever. */
const MAX_PAGES = 1000;

export async function collectAllTranscripts(
  fetchPage: FetchTranscriptPage,
  pageSize: number = TRANSCRIPT_PAGE_SIZE,
): Promise<Transcript[]> {
  const all: Transcript[] = [];
  let offset = 0;
  for (let guard = 0; guard < MAX_PAGES; guard++) {
    const resp = await fetchPage(pageSize, offset);
    const batch = resp?.transcripts ?? [];
    all.push(...batch);
    offset += batch.length;
    if (!resp?.has_more || batch.length === 0) break;
  }
  return all.sort((a, b) => (a.audio_start_time ?? 0) - (b.audio_start_time ?? 0));
}
