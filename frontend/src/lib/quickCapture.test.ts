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
  sanitizeFolderName,
  deriveInquiryName,
  buildInquiryBrief,
  buildInquiryClaudeMd,
  isNewInquiryCandidate,
  NEW_INQUIRY_PREFIX,
  MAX_INQUIRY_NAME,
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

describe('sanitizeFolderName', () => {
  it('strips the characters Windows forbids in a path segment', () => {
    expect(sanitizeFolderName('Acme: Q3/Q4 <urgent>?')).toBe('Acme Q3 Q4 urgent');
  });

  it('keeps hyphens, ampersands and interior dots', () => {
    expect(sanitizeFolderName('Brand-Upgrade & Co. Ltd')).toBe('Brand-Upgrade & Co. Ltd');
  });

  it('drops trailing dots and spaces, which Windows silently discards', () => {
    // "Acme." on disk is really "Acme", so a read-back check would disagree with the OS.
    expect(sanitizeFolderName('  Acme.  ')).toBe('Acme');
    expect(sanitizeFolderName('Acme...')).toBe('Acme');
  });

  it('removes control characters', () => {
    expect(sanitizeFolderName('Ac\u0000me\u0007')).toBe('Ac me');
  });

  it('suffixes reserved Windows device names at any casing', () => {
    expect(sanitizeFolderName('con')).toBe('con_');
    expect(sanitizeFolderName('COM1')).toBe('COM1_');
    // Not reserved: only COM1-9 count, and CONSOLE merely starts with CON.
    expect(sanitizeFolderName('CONSOLE')).toBe('CONSOLE');
    expect(sanitizeFolderName('COM0')).toBe('COM0');
  });

  it('truncates to the cap and re-trims the exposed edge', () => {
    expect(sanitizeFolderName('a'.repeat(80))).toHaveLength(MAX_INQUIRY_NAME);
    // A cut landing on a space must not leave a trailing space behind.
    expect(sanitizeFolderName('abcd efgh', 5)).toBe('abcd');
  });

  it('returns empty when nothing usable survives', () => {
    expect(sanitizeFolderName('   ')).toBe('');
    expect(sanitizeFolderName('///')).toBe('');
    expect(sanitizeFolderName('...')).toBe('');
  });
});

describe('deriveInquiryName', () => {
  it('prefers the typed note over the clip', () => {
    expect(deriveInquiryName('Acme Corp', [clip('a', 'Looking for a dev')])).toBe('Acme Corp');
  });

  it('falls back to the first meaningful line of the first clip', () => {
    expect(deriveInquiryName('', [clip('a', '\n\n  Build a lead-scoring pipeline\nmore text')]))
      .toBe('Build a lead-scoring pipeline');
  });

  it('strips job-board boilerplate, including stacked prefixes', () => {
    expect(deriveInquiryName('', [clip('a', 'Urgent: Looking for an n8n developer')]))
      .toBe('n8n developer');
    expect(deriveInquiryName('', [clip('a', 'Hiring: Wanted - Shopify expert')]))
      .toBe('Shopify expert');
  });

  it('cuts at the first sentence break rather than taking a paragraph', () => {
    expect(deriveInquiryName('', [clip('a', 'Acme Corp. We need someone to fix our CRM.')]))
      .toBe('Acme Corp');
  });

  it('returns empty when there is nothing to work with', () => {
    expect(deriveInquiryName('', [])).toBe('');
    expect(deriveInquiryName('', [clip('a', '   ')])).toBe('');
  });
});

describe('buildInquiryBrief', () => {
  const date = new Date(2026, 7, 3, 14, 32); // 2026-08-03 local

  it('writes scannable front matter and the captured body verbatim', () => {
    const md = buildInquiryBrief({ name: 'Acme Corp', body: 'Need an n8n dev.', date });
    expect(md).toContain('# Acme Corp');
    expect(md).toContain('- Created: 2026-08-03');
    expect(md).toContain('- Status: Evaluating');
    expect(md).toContain('Need an n8n dev.');
    expect(md).toContain('## Questions for client');
  });

  it('says so instead of leaving the section blank when nothing was captured', () => {
    expect(buildInquiryBrief({ name: 'Acme', body: '   ', date }))
      .toContain('_Nothing was captured. Paste the job description here._');
  });

  it('includes the note only when one was typed', () => {
    expect(buildInquiryBrief({ name: 'Acme', body: 'x', note: 'via LinkedIn', date }))
      .toContain('## Capture note');
    expect(buildInquiryBrief({ name: 'Acme', body: 'x', date })).not.toContain('## Capture note');
  });

  it('does not emit two headings where one is a prefix of the other', () => {
    const md = buildInquiryBrief({ name: 'Acme', body: 'x', note: 'n', date });
    const headings = md.split('\n').filter(l => l.startsWith('## '));
    expect(new Set(headings).size).toBe(headings.length);
    for (const a of headings) {
      for (const b of headings) {
        if (a !== b) expect(b.startsWith(a)).toBe(false);
      }
    }
  });

  it('ends with exactly one newline', () => {
    const md = buildInquiryBrief({ name: 'Acme', body: 'x', date });
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  it('contains no em dashes', () => {
    expect(buildInquiryBrief({ name: 'Acme', body: 'x', date })).not.toMatch(/[–—]/);
  });
});

describe('buildInquiryClaudeMd', () => {
  it('points at the brief and marks the scope unconfirmed', () => {
    const md = buildInquiryClaudeMd('Acme Corp');
    expect(md).toContain('# Acme Corp');
    expect(md).toContain('[brief.md](brief.md)');
    expect(md).toContain('unconfirmed');
    expect(md).not.toMatch(/[–—]/);
  });
});

describe('isNewInquiryCandidate', () => {
  it('recognises only the synthetic create-new entries', () => {
    expect(isNewInquiryCandidate({ id: `${NEW_INQUIRY_PREFIX}D:/x/Claude` })).toBe(true);
    expect(isNewInquiryCandidate({ id: 'acme' })).toBe(false);
    expect(isNewInquiryCandidate({ id: '__unfiled__' })).toBe(false);
  });
});
