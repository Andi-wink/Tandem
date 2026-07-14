import { describe, it, expect, beforeEach } from 'vitest';
import {
  hasAutoSummaryStarted,
  markAutoSummaryStarted,
  resetAutoSummary,
  isAutoSummaryEnabled,
  formatTranscriptTime,
  buildTranscriptText,
} from './autoSummary';
import { Transcript } from '@/types';

describe('auto-summary idempotency guard', () => {
  beforeEach(() => {
    resetAutoSummary('a');
    resetAutoSummary('b');
  });

  it('latches per meeting id', () => {
    expect(hasAutoSummaryStarted('a')).toBe(false);
    markAutoSummaryStarted('a');
    expect(hasAutoSummaryStarted('a')).toBe(true);
    expect(hasAutoSummaryStarted('b')).toBe(false);
  });

  it('can be reset to allow a retry', () => {
    markAutoSummaryStarted('a');
    resetAutoSummary('a');
    expect(hasAutoSummaryStarted('a')).toBe(false);
  });
});

describe('isAutoSummaryEnabled', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to false when unset (mirrors ConfigContext)', () => {
    expect(isAutoSummaryEnabled()).toBe(false);
  });

  it('is true only for the exact string "true"', () => {
    localStorage.setItem('isAutoSummary', 'true');
    expect(isAutoSummaryEnabled()).toBe(true);
    localStorage.setItem('isAutoSummary', 'false');
    expect(isAutoSummaryEnabled()).toBe(false);
    localStorage.setItem('isAutoSummary', '1');
    expect(isAutoSummaryEnabled()).toBe(false);
  });
});

describe('formatTranscriptTime', () => {
  it('formats seconds as [MM:SS]', () => {
    expect(formatTranscriptTime(0, 'x')).toBe('[00:00]');
    expect(formatTranscriptTime(65, 'x')).toBe('[01:05]');
    expect(formatTranscriptTime(600, 'x')).toBe('[10:00]');
  });

  it('falls back to the wall-clock timestamp when seconds is undefined', () => {
    expect(formatTranscriptTime(undefined, '12:34 PM')).toBe('12:34 PM');
  });
});

describe('buildTranscriptText', () => {
  it('joins one timestamped line per segment', () => {
    const transcripts = [
      { text: 'hello', audio_start_time: 0, timestamp: 't0' },
      { text: 'world', audio_start_time: 61, timestamp: 't1' },
    ] as unknown as Transcript[];
    expect(buildTranscriptText(transcripts)).toBe('[00:00] hello\n[01:01] world');
  });

  it('returns an empty string for no transcripts', () => {
    expect(buildTranscriptText([])).toBe('');
  });
});
