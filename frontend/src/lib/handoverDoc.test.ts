import { describe, it, expect } from 'vitest';
import {
  buildHandoverTimeline,
  collectLinks,
  extractLinks,
  formatStamp,
  generateHandoverMarkdown,
  relativeToFolder,
  type HandoverItem,
} from './handoverDoc';
import { NOTE_SOURCE } from './transcriptNotes';
import type { Transcript, ScreenshotData, ClipboardData } from '@/types';
import type { Jot } from './meetingJots';

const FOLDER = 'D:\\Meetings\\2026-08-29 Client call';

function speech(text: string, at: number): Transcript {
  return { id: `s-${at}-${text}`, text, timestamp: '10:00:00', audio_start_time: at, source: 'Local' };
}

function note(text: string, at: number): Transcript {
  return { id: `n-${at}-${text}`, text, timestamp: '10:00:00', audio_start_time: at, source: NOTE_SOURCE };
}

function shot(at: number, mode: 'fullscreen' | 'region' = 'fullscreen', file = 'shot.png'): ScreenshotData {
  return {
    id: `sh-${at}`,
    file_path: `${FOLDER}\\screenshots\\${file}`,
    thumbnail_base64: '',
    timestamp: '10:00:00',
    recording_elapsed_secs: at,
    width: 100,
    height: 100,
    capture_mode: mode,
  };
}

function clip(text: string, at: number): ClipboardData {
  return { id: `c-${at}`, content_type: 'text', text, timestamp: '10:00:00', recording_elapsed_secs: at };
}

function jot(content: string, audioMs: number | null): Jot {
  return { id: `j-${audioMs}`, createdAtMs: 0, audioMs, content, kind: 'text' };
}

describe('formatStamp', () => {
  it('uses MM:SS under an hour and HH:MM:SS past it', () => {
    expect(formatStamp(0)).toBe('00:00');
    expect(formatStamp(65)).toBe('01:05');
    expect(formatStamp(3661)).toBe('1:01:01');
  });

  it('treats missing or negative time as the start of the recording', () => {
    expect(formatStamp(NaN)).toBe('00:00');
    expect(formatStamp(-5)).toBe('00:00');
  });
});

describe('extractLinks', () => {
  it('finds http, https and bare www links', () => {
    expect(extractLinks('see https://example.com and www.foo.dev plus http://a.io/x')).toEqual([
      'https://example.com',
      'www.foo.dev',
      'http://a.io/x',
    ]);
  });

  it('trims trailing sentence punctuation', () => {
    expect(extractLinks('go to https://example.com/docs.')).toEqual(['https://example.com/docs']);
    expect(extractLinks('(see https://example.com/a)')).toEqual(['https://example.com/a']);
  });

  it('keeps parens the URL opens itself', () => {
    expect(extractLinks('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
  });

  it('returns nothing for empty or link-free text', () => {
    expect(extractLinks('')).toEqual([]);
    expect(extractLinks('no links here')).toEqual([]);
  });
});

describe('buildHandoverTimeline', () => {
  it('orders every stream on the recording clock', () => {
    const timeline = buildHandoverTimeline(
      [speech('hello', 0), speech('later', 30)],
      [shot(10)],
      [clip('copied', 20)],
      [],
    );
    expect(timeline.map(i => [i.type, i.elapsedSecs])).toEqual([
      ['speech', 0],
      ['screenshot', 10],
      ['clipboard', 20],
      ['speech', 30],
    ]);
  });

  it('splits typed notes out of the transcript by their note marker', () => {
    const timeline = buildHandoverTimeline([speech('spoken', 0), note('typed', 1)], [], [], []);
    expect(timeline.map(i => i.type)).toEqual(['speech', 'note']);
  });

  it('merges meeting-mode jots as notes on the same axis', () => {
    const timeline = buildHandoverTimeline([speech('spoken', 5)], [], [], [jot('jotted', 2000)]);
    expect(timeline.map(i => [i.type, i.elapsedSecs])).toEqual([
      ['note', 2],
      ['speech', 5],
    ]);
  });

  it('breaks ties in the order the actions actually happen', () => {
    const timeline = buildHandoverTimeline([speech('said', 10), note('typed', 10)], [shot(10)], [clip('copied', 10)], []);
    expect(timeline.map(i => i.type)).toEqual(['speech', 'note', 'screenshot', 'clipboard']);
  });

  it('drops empty segments and jots but keeps captures', () => {
    const timeline = buildHandoverTimeline([speech('   ', 0)], [shot(1)], [], [jot('  ', 500)]);
    expect(timeline.map(i => i.type)).toEqual(['screenshot']);
  });

  it('defaults missing timestamps to the start rather than dropping the item', () => {
    const orphan: Transcript = { id: 'x', text: 'no timing', timestamp: '10:00:00' };
    const timeline = buildHandoverTimeline([orphan], [], [], [jot('no timing either', null)]);
    expect(timeline.every(i => i.elapsedSecs === 0)).toBe(true);
    expect(timeline).toHaveLength(2);
  });
});

describe('collectLinks', () => {
  const timeline = (): HandoverItem[] =>
    buildHandoverTimeline(
      [speech('go to https://spoken.example.com', 0), note('ref https://typed.example.com', 5)],
      [],
      [clip('https://copied.example.com', 10)],
      [],
    );

  it('collects links from notes and clipboard, tagged with where they came from', () => {
    expect(collectLinks(timeline())).toEqual([
      { url: 'https://typed.example.com', from: 'note', elapsedSecs: 5 },
      { url: 'https://copied.example.com', from: 'clipboard', elapsedSecs: 10 },
    ]);
  });

  it('ignores links that only appear in speech', () => {
    expect(collectLinks(timeline()).some(l => l.url.includes('spoken'))).toBe(false);
  });

  it('keeps the first occurrence of a repeated link', () => {
    const items = buildHandoverTimeline(
      [note('https://example.com/a', 1), note('https://EXAMPLE.com/a', 9)],
      [],
      [],
      [],
    );
    expect(collectLinks(items)).toEqual([{ url: 'https://example.com/a', from: 'note', elapsedSecs: 1 }]);
  });
});

describe('relativeToFolder', () => {
  it('rewrites a capture inside the meeting folder as a relative path', () => {
    expect(relativeToFolder(`${FOLDER}\\screenshots\\a.png`, FOLDER)).toBe('screenshots/a.png');
  });

  it('percent-encodes spaces so the markdown link resolves', () => {
    expect(relativeToFolder(`${FOLDER}\\screenshots\\my shot.png`, FOLDER)).toBe('screenshots/my%20shot.png');
  });

  it('falls back to the full path when the file lives outside the folder', () => {
    expect(relativeToFolder('C:\\Other\\a.png', FOLDER)).toBe('C:/Other/a.png');
  });

  it('handles a missing folder without throwing', () => {
    expect(relativeToFolder('C:\\Other\\a.png')).toBe('C:/Other/a.png');
    expect(relativeToFolder('', FOLDER)).toBe('');
  });
});

describe('generateHandoverMarkdown', () => {
  function doc(overrides: Partial<Parameters<typeof generateHandoverMarkdown>[0]> = {}) {
    const timeline = buildHandoverTimeline(
      [speech('we agreed on the scope', 0), note('follow up https://example.com/spec', 12)],
      [shot(30, 'region')],
      [clip('const x = 1', 45)],
      [],
    );
    return generateHandoverMarkdown({
      meetingName: 'Client call',
      date: '2026-08-29T09:00:00Z',
      durationSeconds: 62,
      timeline,
      links: collectLinks(timeline),
      folderPath: FOLDER,
      ...overrides,
    });
  }

  it('keeps every stream in recording order', () => {
    const md = doc();
    const positions = [
      md.indexOf('we agreed on the scope'),
      md.indexOf('follow up'),
      md.indexOf('Screenshot (region)'),
      md.indexOf('const x = 1'),
    ];
    expect(positions.every(p => p > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('embeds screenshots as relative images so they render from the folder', () => {
    expect(doc()).toContain('![Screenshot at 00:30](screenshots/shot.png)');
  });

  it('lists typed and copied links up top with their timestamps', () => {
    const md = doc();
    expect(md).toContain('## Links');
    expect(md).toContain('- <https://example.com/spec> (typed at 00:12)');
    expect(md.indexOf('## Links')).toBeLessThan(md.indexOf('## Timeline'));
  });

  it('omits the links section entirely when nothing was typed or copied', () => {
    const timeline = buildHandoverTimeline([speech('just talking', 0)], [], [], []);
    const md = generateHandoverMarkdown({
      meetingName: 'Call',
      date: '2026-08-29T09:00:00Z',
      durationSeconds: 10,
      timeline,
      links: collectLinks(timeline),
    });
    expect(md).not.toContain('## Links');
  });

  it('fences copied text so pasted code survives intact', () => {
    expect(doc()).toContain('```\nconst x = 1\n```');
  });

  it('reports what was captured, counting in plain English', () => {
    expect(doc()).toContain('**Captured:** 1 transcript segment, 1 note, 1 screenshot, 1 clipboard item');
  });

  it('pluralises the counts when there is more than one', () => {
    const timeline = buildHandoverTimeline([speech('a', 0), speech('b', 1)], [], [], []);
    const md = generateHandoverMarkdown({
      meetingName: 'Call',
      date: '2026-08-29T09:00:00Z',
      durationSeconds: 5,
      timeline,
      links: [],
    });
    expect(md).toContain('2 transcript segments, 0 notes, 0 screenshots, 0 clipboard items');
  });

  it('says so plainly when a call captured nothing', () => {
    const md = generateHandoverMarkdown({
      meetingName: 'Empty',
      date: '2026-08-29T09:00:00Z',
      durationSeconds: null,
      timeline: [],
      links: [],
    });
    expect(md).toContain('*Nothing was captured on this call.*');
    expect(md).not.toContain('**Duration:**');
  });

  it('falls back to the raw date string when it cannot be parsed', () => {
    expect(doc({ date: 'sometime last week' })).toContain('**Date:** sometime last week');
  });
});
