import { describe, it, expect } from 'vitest';
import {
  buildPaletteMeetingRows,
  shouldSearchMeetings,
  MEETING_SEARCH_CAP,
} from './paletteMeetingSearch';

const projects = [{ name: 'Acme', path: 'D:/Dev-projects/Client_projects/Acme' }];
const acmeFolder = (leaf: string) => `D:/Dev-projects/Client_projects/Acme/.tandem/${leaf}`;

describe('shouldSearchMeetings', () => {
  it('is false at 2 chars or fewer, true past 2', () => {
    expect(shouldSearchMeetings('')).toBe(false);
    expect(shouldSearchMeetings('ab')).toBe(false);
    expect(shouldSearchMeetings('  ab  ')).toBe(false);
    expect(shouldSearchMeetings('abc')).toBe(true);
  });
});

describe('buildPaletteMeetingRows', () => {
  const meetings = [
    { id: 'm1', title: 'Acme Kickoff', folderPath: acmeFolder('Kickoff') },
    { id: 'm2', title: 'Budget planning', folderPath: null },
    { id: 'm3', title: 'Acme Review', folderPath: acmeFolder('Review') },
  ];

  it('returns nothing below the min length', () => {
    expect(buildPaletteMeetingRows('ac', meetings, [], projects)).toEqual({ rows: [], overflow: 0 });
  });

  it('matches by title and resolves the project chip', () => {
    const { rows } = buildPaletteMeetingRows('acme', meetings, [], projects);
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm3']);
    expect(rows[0].projectName).toBe('Acme');
    expect(rows[0].snippet).toBeUndefined();
  });

  it('puts transcript hits (with snippet + date) first, then title-only hits, de-duplicated', () => {
    const transcripts = [
      { id: 'm3', title: 'Acme Review', matchContext: '…discussed the acme rollout…', timestamp: '2026-02-20T10:00:00Z' },
    ];
    const { rows } = buildPaletteMeetingRows('acme', meetings, transcripts, projects);
    // m3 comes from transcripts first; m1 is the remaining title match. m3 is not duplicated.
    expect(rows.map((r) => r.id)).toEqual(['m3', 'm1']);
    expect(rows[0].snippet).toContain('acme rollout');
    expect(rows[0].date).toBe('2026-02-20T10:00:00Z');
    expect(rows[1].snippet).toBeUndefined();
  });

  it('includes transcript hits even when the title does not contain the query', () => {
    // "kickoff" is not in m2's title, but a transcript for m2 matched.
    const transcripts = [{ id: 'm2', title: 'Budget planning', matchContext: '…the kickoff plan…' }];
    const { rows } = buildPaletteMeetingRows('kickoff', meetings, transcripts, projects);
    expect(rows.map((r) => r.id)).toContain('m2');
    // m2 is unfiled → no chip
    expect(rows.find((r) => r.id === 'm2')?.projectName).toBeUndefined();
  });

  it('caps rows and reports the overflow count', () => {
    const many = Array.from({ length: MEETING_SEARCH_CAP + 3 }, (_, i) => ({
      id: `x${i}`,
      title: `Acme meeting ${i}`,
      folderPath: null,
    }));
    const { rows, overflow } = buildPaletteMeetingRows('acme', many, [], projects);
    expect(rows).toHaveLength(MEETING_SEARCH_CAP);
    expect(overflow).toBe(3);
  });
});
