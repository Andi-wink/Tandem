import { describe, it, expect, beforeEach } from 'vitest';
import {
  addJot,
  editJot,
  deleteJot,
  readJots,
  clearJots,
  serializeJots,
  parseJotsFile,
  buildEnhancePrompt,
  buildRescueMarkdown,
  formatStamp,
  type Jot,
} from './meetingJots';
import { rescueFileName } from './jotsRescue';
import type { Transcript } from '@/types';

/** Minimal transcript factory: only the fields the prompt builder reads. */
function seg(text: string, start: number, end?: number): Transcript {
  return {
    id: `${start}`,
    text,
    timestamp: '',
    audio_start_time: start,
    audio_end_time: end ?? start + 3,
  } as unknown as Transcript;
}

beforeEach(() => {
  clearJots();
});

describe('meetingJots store', () => {
  it('round-trips add / read / edit / delete through sessionStorage', () => {
    expect(readJots()).toEqual([]);

    addJot('pricing concerns', 12_000);
    addJot('wants Q3 rollout', 45_000);
    let jots = readJots();
    expect(jots.map((j) => j.content)).toEqual(['pricing concerns', 'wants Q3 rollout']);
    expect(jots[0].audioMs).toBe(12_000);
    expect(jots[0].kind).toBe('text');

    const id = jots[0].id;
    editJot(id, 'pricing objections');
    expect(readJots()[0].content).toBe('pricing objections');

    deleteJot(id);
    jots = readJots();
    expect(jots).toHaveLength(1);
    expect(jots[0].content).toBe('wants Q3 rollout');

    clearJots();
    expect(readJots()).toEqual([]);
  });

  it('ignores a blank add and trims content', () => {
    addJot('   ', 0);
    expect(readJots()).toHaveLength(0);
    addJot('  spaced  ', null);
    expect(readJots()[0].content).toBe('spaced');
    expect(readJots()[0].audioMs).toBeNull();
  });

  it('editing to blank deletes the jot', () => {
    addJot('temp', 1000);
    const id = readJots()[0].id;
    editJot(id, '   ');
    expect(readJots()).toHaveLength(0);
  });

  it('serializes to a versioned envelope and parses back', () => {
    addJot('a', 1000);
    addJot('b', 2000);
    const json = serializeJots(readJots());
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    expect(parsed.jots).toHaveLength(2);

    const round = parseJotsFile(json);
    expect(round.map((j) => j.content)).toEqual(['a', 'b']);
  });

  it('parseJotsFile tolerates junk and a bare array', () => {
    expect(parseJotsFile(null)).toEqual([]);
    expect(parseJotsFile('not json')).toEqual([]);
    expect(parseJotsFile('{"nope":1}')).toEqual([]);
    const bare: Jot[] = [{ id: 'x', createdAtMs: 1, audioMs: null, content: 'hi', kind: 'text' }];
    expect(parseJotsFile(JSON.stringify(bare))[0].content).toBe('hi');
  });

  it('readJots survives a corrupt slot', () => {
    window.sessionStorage.setItem('tandem.meetingJots.active', '{broken');
    expect(readJots()).toEqual([]);
  });
});

describe('formatStamp', () => {
  it('formats seconds as [MM:SS] and clamps negatives', () => {
    expect(formatStamp(0)).toBe('[00:00]');
    expect(formatStamp(75)).toBe('[01:15]');
    expect(formatStamp(-5)).toBe('[00:00]');
    expect(formatStamp(null)).toBe('[--:--]');
  });
});

describe('buildRescueMarkdown', () => {
  const stoppedAt = new Date('2026-07-16T09:30:15.000Z');

  it('includes the meeting title, stop timestamp, and each jot with its [MM:SS] stamp', () => {
    const jots: Jot[] = [
      { id: '1', createdAtMs: 1, audioMs: 62_000, content: 'pricing concerns', kind: 'text' },
      { id: '2', createdAtMs: 2, audioMs: null, content: 'no timing yet', kind: 'text' },
    ];
    const md = buildRescueMarkdown('Acme discovery call', stoppedAt, jots);
    expect(md).toContain('# Rescued jots: Acme discovery call');
    expect(md).toContain('Recording stopped: 2026-07-16T09:30:15.000Z');
    expect(md).toContain('- [01:02] pricing concerns');
    expect(md).toContain('- [--:--] no timing yet');
  });

  it('falls back to a placeholder title when none is given', () => {
    const md = buildRescueMarkdown('   ', stoppedAt, [
      { id: '1', createdAtMs: 1, audioMs: 0, content: 'x', kind: 'text' },
    ]);
    expect(md).toContain('# Rescued jots: Untitled meeting');
  });
});

describe('rescueFileName', () => {
  it('formats jots-rescue-<yyyyMMdd-HHmmss>.md from local time', () => {
    // Constructed from local-time components so the assertion is timezone-independent.
    const d = new Date(2026, 6, 16, 9, 3, 5); // 2026-07-16 09:03:05 local
    expect(rescueFileName(d)).toBe('jots-rescue-20260716-090305.md');
  });
});

describe('buildEnhancePrompt', () => {
  const transcripts = [
    seg('intro chatter', 5),
    seg('we are worried about the price', 60),
    seg('specifically the onboarding cost', 63),
    seg('unrelated tangent about lunch', 200),
    seg('they want a Q3 rollout for sure', 600),
    seg('final wrap up', 610),
  ];

  it('preserves jot order and uses each jot as a heading', () => {
    const jots: Jot[] = [
      { id: '1', createdAtMs: 1, audioMs: 62_000, content: 'pricing concerns', kind: 'text' },
      { id: '2', createdAtMs: 2, audioMs: 600_000, content: 'wants Q3 rollout', kind: 'text' },
    ];
    const prompt = buildEnhancePrompt(jots, transcripts);
    const iA = prompt.indexOf('### Jot 1: pricing concerns');
    const iB = prompt.indexOf('### Jot 2: wants Q3 rollout');
    expect(iA).toBeGreaterThan(-1);
    expect(iB).toBeGreaterThan(iA);
  });

  it('windows the transcript to +/-90s around a jot audioMs', () => {
    const jots: Jot[] = [
      { id: '1', createdAtMs: 1, audioMs: 62_000, content: 'pricing concerns', kind: 'text' },
    ];
    const prompt = buildEnhancePrompt(jots, transcripts);
    const jotSection = prompt.slice(prompt.indexOf('### Jot 1'), prompt.indexOf('## Full transcript'));
    // Inside the window (60s, 63s) present; far-away segments (200s, 600s) absent from THIS window.
    expect(jotSection).toContain('we are worried about the price');
    expect(jotSection).toContain('specifically the onboarding cost');
    expect(jotSection).not.toContain('unrelated tangent about lunch');
    expect(jotSection).not.toContain('they want a Q3 rollout');
  });

  it('falls back to a proportional window when audioMs is null', () => {
    const jots: Jot[] = [
      { id: '1', createdAtMs: 1, audioMs: null, content: 'late topic', kind: 'text' },
    ];
    // Single jot, ordinal fraction 0.5 -> center at ~305s of a ~610s call. Nothing within 90s there,
    // but the builder must not throw and must render the section.
    const prompt = buildEnhancePrompt(jots, transcripts);
    expect(prompt).toContain('### Jot 1: late topic');
    expect(prompt).toContain('[--:--]');
  });

  it('handles an empty transcript without throwing', () => {
    const jots: Jot[] = [
      { id: '1', createdAtMs: 1, audioMs: 1000, content: 'flagged something', kind: 'text' },
    ];
    const prompt = buildEnhancePrompt(jots, []);
    expect(prompt).toContain('### Jot 1: flagged something');
    expect(prompt).toContain('(none captured)');
    expect(prompt).toContain('[no transcript captured]');
  });

  it('embeds the anti-hallucination rules', () => {
    const jots: Jot[] = [{ id: '1', createdAtMs: 1, audioMs: 0, content: 'x', kind: 'text' }];
    const prompt = buildEnhancePrompt(jots, transcripts);
    expect(prompt).toContain('quote verbatim');
    expect(prompt).toContain('does not elaborate');
    expect(prompt).toContain('# Notes');
  });
});
