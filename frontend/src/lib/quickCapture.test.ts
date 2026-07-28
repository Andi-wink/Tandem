import { describe, it, expect } from 'vitest';
import {
  rollClipBuffer,
  defaultSelection,
  toggleChip,
  selectedClips,
  buildNoteMarkdown,
  quickCaptureFilename,
  buildRouterInput,
  orderRouteCandidates,
  cycleIndex,
  CLIP_BUFFER_CAP,
  type QuickClip,
} from './quickCapture';
import type { Project } from '@/services/projectService';

const clip = (id: string, text: string): QuickClip => ({ id, text });

describe('rollClipBuffer', () => {
  it('prepends the newest item (index 0 is most recent)', () => {
    const b0: QuickClip[] = [];
    const b1 = rollClipBuffer(b0, clip('a', 'first'));
    const b2 = rollClipBuffer(b1, clip('b', 'second'));
    expect(b2.map(c => c.text)).toEqual(['second', 'first']);
  });

  it('collapses a consecutive duplicate copy (no growth)', () => {
    let b = rollClipBuffer([], clip('a', 'same'));
    b = rollClipBuffer(b, clip('a2', 'same')); // re-copy identical text
    expect(b).toHaveLength(1);
    expect(b[0].text).toBe('same');
  });

  it('keeps a non-consecutive duplicate', () => {
    let b = rollClipBuffer([], clip('a', 'A'));
    b = rollClipBuffer(b, clip('b', 'B'));
    b = rollClipBuffer(b, clip('a3', 'A')); // A again, but not consecutive
    expect(b.map(c => c.text)).toEqual(['A', 'B', 'A']);
  });

  it('caps at 3, dropping the oldest', () => {
    let b: QuickClip[] = [];
    for (const t of ['one', 'two', 'three', 'four']) b = rollClipBuffer(b, clip(t, t));
    expect(b).toHaveLength(CLIP_BUFFER_CAP);
    expect(b.map(c => c.text)).toEqual(['four', 'three', 'two']);
  });

  it('ignores blank / empty text', () => {
    const b = rollClipBuffer([clip('a', 'A')], clip('x', '   '));
    expect(b.map(c => c.text)).toEqual(['A']);
  });
});

describe('chip selection', () => {
  it('defaults to attaching only the latest clip', () => {
    const buffer = [clip('a', 'A'), clip('b', 'B'), clip('c', 'C')];
    expect([...defaultSelection(buffer)]).toEqual([0]);
    expect(defaultSelection([])).toEqual(new Set());
  });

  it('toggles a chip in and out without mutating the input', () => {
    const sel = new Set([0]);
    const withSecond = toggleChip(sel, 1);
    expect([...withSecond].sort()).toEqual([0, 1]);
    expect([...sel]).toEqual([0]); // original untouched
    const removed = toggleChip(withSecond, 0);
    expect([...removed]).toEqual([1]);
  });

  it('selectedClips returns attached clips in buffer order', () => {
    const buffer = [clip('a', 'A'), clip('b', 'B'), clip('c', 'C')];
    expect(selectedClips(buffer, new Set([0, 2])).map(c => c.text)).toEqual(['A', 'C']);
  });
});

describe('buildNoteMarkdown', () => {
  const date = new Date(2026, 6, 15, 14, 32); // 2026-07-15 14:32 local

  it('renders heading, filed-under, note and fenced clip blocks', () => {
    const md = buildNoteMarkdown({
      note: 'objection about onboarding cost',
      clips: [clip('a', 'Line one\nLine two')],
      projectName: 'Acme',
      date,
    });
    expect(md).toContain('# Quick capture: 2026-07-15 14:32');
    expect(md).toContain('Filed under: Acme');
    expect(md).toContain('objection about onboarding cost');
    expect(md).toContain('## Clipboard item 1 (captured from clipboard)');
    expect(md).toContain('```\nLine one\nLine two\n```');
  });

  it('is valid with an empty note and a single clip', () => {
    const md = buildNoteMarkdown({ note: '', clips: [clip('a', 'pasted text')], projectName: null, date });
    expect(md).toContain('pasted text');
    expect(md).not.toContain('Filed under:');
  });

  it('contains no em dashes', () => {
    const md = buildNoteMarkdown({ note: 'x', clips: [], projectName: 'Y', date });
    expect(md).not.toMatch(/[–—]/);
  });
});

describe('quickCaptureFilename', () => {
  it('builds a dated, sortable file name', () => {
    expect(quickCaptureFilename(new Date(2026, 6, 15, 9, 5))).toBe('2026-07-15-0905-quick-capture.md');
  });
});

describe('buildRouterInput', () => {
  it('uses the note as the title and note+clips as the body', () => {
    const { meetingTitle, transcriptText } = buildRouterInput('Acme pricing', [clip('a', 'we discussed Acme')]);
    expect(meetingTitle).toBe('Acme pricing');
    expect(transcriptText).toBe('Acme pricing\n\nwe discussed Acme');
  });

  it('degrades to null title / clip-only body when the note is blank', () => {
    const { meetingTitle, transcriptText } = buildRouterInput('   ', [clip('a', 'only clip')]);
    expect(meetingTitle).toBeNull();
    expect(transcriptText).toBe('only clip');
  });
});

describe('orderRouteCandidates', () => {
  const proj = (id: string, name: string): Project => ({ id, name, path: `/p/${id}`, aliases: [], auto_discovered: false, session_id: null, created_at: '' });
  const pool = [proj('acme', 'Acme'), proj('globex', 'Globex'), proj('aro', 'ARO'), proj('n8n', 'n8n')];

  it('puts the routed project first, then the rest, capped', () => {
    const out = orderRouteCandidates(proj('globex', 'Globex'), pool, 3);
    expect(out.map(p => p.id)).toEqual(['globex', 'acme', 'aro']);
  });

  it('handles no routed match (pool order, capped)', () => {
    expect(orderRouteCandidates(null, pool, 3).map(p => p.id)).toEqual(['acme', 'globex', 'aro']);
  });
});

describe('cycleIndex', () => {
  it('wraps forward and backward', () => {
    expect(cycleIndex(0, 3, 1)).toBe(1);
    expect(cycleIndex(2, 3, 1)).toBe(0);
    expect(cycleIndex(0, 3, -1)).toBe(2);
    expect(cycleIndex(0, 0, 1)).toBe(0);
  });
});
