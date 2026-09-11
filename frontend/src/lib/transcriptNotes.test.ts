import { describe, it, expect } from 'vitest';
import { Transcript } from '@/types';
import {
  NOTE_SOURCE,
  NOTE_SEQUENCE_BASE,
  isNoteSegment,
  noteElapsedSecs,
  createNoteTranscript,
  insertSegmentOrdered,
} from './transcriptNotes';

function seg(partial: Partial<Transcript>): Transcript {
  return {
    id: partial.id ?? 't-1',
    text: partial.text ?? 'hello',
    timestamp: partial.timestamp ?? '12:00:00',
    sequence_id: partial.sequence_id,
    chunk_start_time: partial.chunk_start_time,
    audio_start_time: partial.audio_start_time,
    audio_end_time: partial.audio_end_time,
    duration: partial.duration,
    is_partial: partial.is_partial,
    confidence: partial.confidence,
    source: partial.source,
    speaker: partial.speaker,
    speaker_label: partial.speaker_label,
  };
}

describe('isNoteSegment', () => {
  it('matches source === "note"', () => {
    expect(isNoteSegment({ source: 'note' })).toBe(true);
    expect(isNoteSegment({ source: 'NOTE' })).toBe(true);
  });

  it('matches the DB speaker field carrying "note"', () => {
    expect(isNoteSegment({ speaker: 'note' })).toBe(true);
  });

  it('is false for spoken channels and empties', () => {
    expect(isNoteSegment({ source: 'Local' })).toBe(false);
    expect(isNoteSegment({ source: 'Remote' })).toBe(false);
    expect(isNoteSegment({})).toBe(false);
    expect(isNoteSegment({ source: null, speaker: null })).toBe(false);
  });
});

describe('noteElapsedSecs', () => {
  it('returns 0 for an empty transcript', () => {
    expect(noteElapsedSecs([])).toBe(0);
  });

  it('uses the max audio_end_time', () => {
    expect(noteElapsedSecs([
      seg({ audio_start_time: 0, audio_end_time: 3 }),
      seg({ audio_start_time: 3, audio_end_time: 7.5 }),
    ])).toBe(7.5);
  });

  it('falls back to audio_start_time when end is missing', () => {
    expect(noteElapsedSecs([seg({ audio_start_time: 12 })])).toBe(12);
  });

  it('ignores non-finite values', () => {
    expect(noteElapsedSecs([seg({ audio_end_time: Number.NaN }), seg({ audio_end_time: 4 })])).toBe(4);
  });
});

describe('createNoteTranscript', () => {
  const now = new Date(2026, 6, 23, 9, 5, 7); // local time

  it('returns null for empty / whitespace input', () => {
    expect(createNoteTranscript('', [], { now })).toBeNull();
    expect(createNoteTranscript('   \n\t ', [], { now })).toBeNull();
  });

  it('builds a note-marked segment stamped at the current recording position', () => {
    const transcripts = [
      seg({ id: 's1', audio_start_time: 0, audio_end_time: 4, sequence_id: 1 }),
      seg({ id: 's2', audio_start_time: 4, audio_end_time: 9, sequence_id: 2 }),
    ];
    const note = createNoteTranscript('  follow up with client  ', transcripts, { now, idSuffix: 'abc' });
    expect(note).not.toBeNull();
    expect(note!.source).toBe(NOTE_SOURCE);
    expect(note!.text).toBe('follow up with client'); // trimmed, verbatim
    expect(note!.audio_start_time).toBe(9);
    expect(note!.audio_end_time).toBe(9);
    expect(note!.chunk_start_time).toBe(9);
    expect(note!.duration).toBe(0);
    expect(note!.is_partial).toBe(false);
    expect(note!.id).toBe(`note-${now.getTime()}-abc`);
    expect(note!.timestamp).toBe('09:05:07');
  });

  it('preserves a URL verbatim', () => {
    const url = 'https://example.com/path?q=1&x=2#frag';
    const note = createNoteTranscript(url, [], { now });
    expect(note!.text).toBe(url);
  });

  it('assigns sequence_ids in the note namespace, strictly increasing per note', () => {
    const first = createNoteTranscript('one', [], { now })!;
    expect(first.sequence_id).toBe(NOTE_SEQUENCE_BASE + 1);

    // A second note added while the first is already present must sort after it.
    const second = createNoteTranscript('two', [first], { now })!;
    expect(second.sequence_id).toBe(NOTE_SEQUENCE_BASE + 2);
  });

  it('never collides with the spoken-segment sequence_id space', () => {
    const spoken = [seg({ id: 's', sequence_id: 42, audio_end_time: 5 })];
    const note = createNoteTranscript('n', spoken, { now })!;
    expect(note.sequence_id).toBeGreaterThanOrEqual(NOTE_SEQUENCE_BASE);
    expect(note.sequence_id).not.toBe(42);
  });
});

describe('insertSegmentOrdered', () => {
  const now = new Date();

  it('places a note after same-timestamped speech but before later speech', () => {
    const transcripts = [
      seg({ id: 's1', chunk_start_time: 0, audio_start_time: 0, audio_end_time: 5, sequence_id: 1 }),
      seg({ id: 's2', chunk_start_time: 5, audio_start_time: 5, audio_end_time: 9, sequence_id: 2 }),
    ];
    const note = createNoteTranscript('note here', transcripts, { now })!; // stamped at t=9
    const ordered = insertSegmentOrdered(transcripts, note);
    expect(ordered.map(t => t.id)).toEqual(['s1', 's2', note.id]);

    // A later spoken segment (t=12) must sort AFTER the note.
    const later = seg({ id: 's3', chunk_start_time: 12, audio_start_time: 12, sequence_id: 3 });
    const ordered2 = insertSegmentOrdered(ordered, later);
    expect(ordered2.map(t => t.id)).toEqual(['s1', 's2', note.id, 's3']);
  });

  it('is idempotent on duplicate ids', () => {
    const note = createNoteTranscript('x', [], { now })!;
    const once = insertSegmentOrdered([], note);
    const twice = insertSegmentOrdered(once, note);
    expect(twice).toHaveLength(1);
  });
});
