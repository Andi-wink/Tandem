import { describe, it, expect } from 'vitest';
import { generateHandoverHtml, escapeHtml } from './handoverHtml';
import { buildHandoverTimeline, collectLinks, type HandoverData } from './handoverDoc';
import { NOTE_SOURCE } from './transcriptNotes';
import type { Transcript, ScreenshotData, ClipboardData } from '@/types';

const FOLDER = 'D:\\Meetings\\call';
const SHOT_PATH = `${FOLDER}\\screenshots\\a.png`;
const DATA_URI = 'data:image/jpeg;base64,AAAA';

function speech(text: string, at: number): Transcript {
  return { id: `s${at}`, text, timestamp: '', audio_start_time: at, source: 'Local' };
}
function note(text: string, at: number): Transcript {
  return { id: `n${at}`, text, timestamp: '', audio_start_time: at, source: NOTE_SOURCE };
}
const shot: ScreenshotData = {
  id: 'sh', file_path: SHOT_PATH, thumbnail_base64: '', timestamp: '',
  recording_elapsed_secs: 30, width: 10, height: 10, capture_mode: 'region',
};
const clip: ClipboardData = {
  id: 'c', content_type: 'text', text: 'const x = 1', timestamp: '', recording_elapsed_secs: 40,
};

function build(images = new Map([[SHOT_PATH, DATA_URI]])): string {
  const timeline = buildHandoverTimeline(
    [speech('we agreed the scope', 0), note('spec at https://example.com/spec', 12)],
    [shot],
    [clip],
    [],
  );
  const data: HandoverData = {
    meetingName: 'Client call',
    date: '2026-08-29T09:00:00Z',
    durationSeconds: 62,
    timeline,
    links: collectLinks(timeline),
    folderPath: FOLDER,
  };
  return generateHandoverHtml(data, images);
}

describe('escapeHtml', () => {
  it('neutralises markup in user content', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
  });
});

describe('generateHandoverHtml', () => {
  it('is one self-contained file with the images inlined', () => {
    const html = build();
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain(`src="${DATA_URI}"`);
    // No path references at all: nothing to resolve once the file is moved.
    expect(html).not.toContain('screenshots/a.png');
  });

  it('carries its own styles and a print stylesheet for the PDF path', () => {
    const html = build();
    expect(html).toContain('<style>');
    expect(html).toContain('@media print');
    expect(html).toContain('@page');
    expect(html).not.toContain('<link rel="stylesheet"');
  });

  it('keeps every stream in recording order', () => {
    const html = build();
    const order = [
      html.indexOf('we agreed the scope'),
      html.indexOf('spec at'),
      html.indexOf(DATA_URI),
      html.indexOf('const x = 1'),
    ];
    expect(order.every(p => p > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('lists typed and copied links up top as real anchors', () => {
    const html = build();
    expect(html).toContain('<a href="https://example.com/spec">https://example.com/spec</a>');
    expect(html).toContain('typed at 00:12');
    expect(html.indexOf('>Links<')).toBeLessThan(html.indexOf('>Timeline<'));
  });

  it('makes a link inside a note clickable in place', () => {
    expect(build()).toContain('<div class="note"><span class="label">Note</span>spec at <a href="https://example.com/spec">');
  });

  it('flags an image it could not embed instead of silently dropping it', () => {
    const html = build(new Map());
    expect(html).toContain('could not be embedded');
    expect(html).not.toContain('<img');
  });

  it('escapes user content rather than rendering it', () => {
    const timeline = buildHandoverTimeline([speech('<img src=x onerror=alert(1)>', 0)], [], [], []);
    const html = generateHandoverHtml(
      { meetingName: '<b>x</b>', date: '2026-08-29T09:00:00Z', durationSeconds: null, timeline, links: [] },
      new Map(),
    );
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('<h1>&lt;b&gt;x&lt;/b&gt;</h1>');
  });

  it('says so plainly when a call captured nothing', () => {
    const html = generateHandoverHtml(
      { meetingName: 'Empty', date: '2026-08-29T09:00:00Z', durationSeconds: null, timeline: [], links: [] },
      new Map(),
    );
    expect(html).toContain('Nothing was captured on this call.');
  });
});
