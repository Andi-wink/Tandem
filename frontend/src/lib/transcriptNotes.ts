/**
 * Typed transcript notes (Solo mode).
 *
 * A "note" is a user-typed line (text or a link) injected INTO the live
 * transcript as a first-class segment, so it lands everywhere the transcript
 * goes: the live view, the saved meeting transcript (Rust SQLite), the
 * `.tandem/live-transcript.md` that Claude Code reads, and the summary input.
 *
 * The marker reuses the existing `source` field (persisted to the DB `speaker`
 * column) — no schema change. Speech carries "Local"/"Remote"; a note carries
 * "note". `speakerNameFromSource` returns undefined for "note", so notes never
 * get a speaker badge; the UI keys the distinct "Note" badge off this marker.
 */

import { Transcript } from '@/types';

/** Marker value stored in a segment's `source` (and thus the DB `speaker` column). */
export const NOTE_SOURCE = 'note';

/**
 * Notes live in their own sequence_id namespace, high above the worker's
 * counter, so a note's id can never collide with a spoken segment's sequence_id
 * (which would make the dedup-by-sequence_id logic drop a real segment) while
 * still ordering multiple notes deterministically among themselves.
 */
export const NOTE_SEQUENCE_BASE = 1_000_000_000;

/** True when a segment is a typed note (accepts either `source` or the DB `speaker`). */
export function isNoteSegment(seg: { source?: string | null; speaker?: string | null }): boolean {
  const s = (seg.source ?? seg.speaker ?? '').toString().toLowerCase();
  return s === NOTE_SOURCE;
}

/**
 * Recording-relative time (seconds) to stamp a new note with: the end of the
 * latest transcribed audio so far. This places the note right after the most
 * recent speech (transcription lags live audio by a few seconds, so this is the
 * moment the user just heard). Returns 0 when there is no transcript yet.
 */
export function noteElapsedSecs(
  transcripts: Pick<Transcript, 'audio_start_time' | 'audio_end_time'>[],
): number {
  let max = 0;
  for (const t of transcripts) {
    const end = t.audio_end_time ?? t.audio_start_time ?? 0;
    if (Number.isFinite(end) && end > max) max = end;
  }
  return max;
}

/** Format a Date as a wall-clock `HH:MM:SS` timestamp (matches spoken segments). */
function formatClock(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface CreateNoteOptions {
  /** Wall-clock time for the note (defaults to now). Injectable for tests. */
  now?: Date;
  /** Deterministic id suffix for tests (defaults to a random base36 tag). */
  idSuffix?: string;
}

/**
 * Build a transcript segment for a typed note, ready to be inserted into
 * TranscriptContext state. Returns null for empty/whitespace-only input.
 *
 * The text is stored verbatim (trimmed only) so links survive intact. The note
 * is timestamped at the current recording position and given a note-namespace
 * `sequence_id` strictly greater than any existing note, so repeated notes keep
 * their entry order.
 */
export function createNoteTranscript(
  text: string,
  transcripts: Transcript[],
  options: CreateNoteOptions = {},
): Transcript | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const now = options.now ?? new Date();
  const elapsed = noteElapsedSecs(transcripts);

  // Next id in the note namespace: base + 1, or one past the highest existing note.
  const maxNoteSeq = transcripts.reduce((m, t) => {
    const s = t.sequence_id ?? 0;
    return s >= NOTE_SEQUENCE_BASE && s > m ? s : m;
  }, NOTE_SEQUENCE_BASE);
  const sequence_id = maxNoteSeq + 1;

  const idSuffix = options.idSuffix ?? Math.random().toString(36).slice(2, 8);

  return {
    id: `note-${now.getTime()}-${idSuffix}`,
    text: trimmed,
    timestamp: formatClock(now),
    sequence_id,
    chunk_start_time: elapsed,
    audio_start_time: elapsed,
    audio_end_time: elapsed,
    duration: 0,
    is_partial: false,
    confidence: 1,
    source: NOTE_SOURCE,
  };
}

/**
 * Insert a segment into a transcript list keeping the same ordering the live
 * buffered path uses: by recording-relative start time, then sequence_id. Pure
 * (returns a new array); the note's note-namespace sequence_id keeps it after
 * same-timestamped speech and before any later speech.
 */
export function insertSegmentOrdered(transcripts: Transcript[], segment: Transcript): Transcript[] {
  if (transcripts.some(t => t.id === segment.id)) return transcripts;
  const startOf = (t: Transcript) => t.chunk_start_time ?? t.audio_start_time ?? 0;
  return [...transcripts, segment].sort((a, b) => {
    const at = startOf(a);
    const bt = startOf(b);
    if (at !== bt) return at - bt;
    return (a.sequence_id ?? 0) - (b.sequence_id ?? 0);
  });
}
