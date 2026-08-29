/**
 * Handover document: a deterministic, no-AI record of what happened on a call.
 *
 * This is the "just give me the raw thing" counterpart to the AI summary. It answers a different
 * question: not "what did this mean" but "what exactly happened, in order". Everything in it is
 * copied, never generated, so it is instant, costs nothing, and can never hallucinate.
 *
 * It interleaves four streams on one recording-relative clock:
 *   - speech      : transcribed segments
 *   - notes       : lines the user typed during the call. In Solo mode the JotStrip files typed text
 *                   straight into the transcript tagged `source: 'note'` (see lib/transcriptNotes),
 *                   so notes arrive as transcript segments and are split back out here. Meeting mode
 *                   also has the separate jot store, which callers may pass in as `jots`.
 *   - screenshots : Alt+Shift+S / Alt+Shift+R captures, embedded inline as images
 *   - clipboard   : Alt+Shift+V captures
 *
 * Links get their own section at the top. The user's reason for typing or copying a link mid-call is
 * almost always "I need this afterwards", so making them hunt through the timeline for it would defeat
 * the point. Only typed notes and clipboard captures feed that section: a URL heard in speech is
 * usually mangled by transcription ("h t t p colon slash slash"), so promoting those would fill the
 * section with junk.
 *
 * Pure and framework-free so it is unit-testable and safe to call from any surface.
 */

import { Transcript, ScreenshotData, ClipboardData } from '@/types';
import { isNoteSegment } from '@/lib/transcriptNotes';
import type { Jot } from '@/lib/meetingJots';

// ─── Types ───────────────────────────────────────────────────────────────────

export type HandoverItemType = 'speech' | 'note' | 'screenshot' | 'clipboard';

export interface HandoverItem {
  /** Recording-relative seconds. The single axis every stream is merged on. */
  elapsedSecs: number;
  type: HandoverItemType;
  text: string;
  /** Absolute path on disk (screenshots, clipboard images). */
  filePath?: string;
  /** 'fullscreen' | 'region' for screenshots. */
  captureMode?: string;
  /** 'text' | 'image' for clipboard items. */
  contentType?: string;
}

export interface HandoverLink {
  url: string;
  /** Where it came from, so the reader knows whether they typed it or copied it. */
  from: 'note' | 'clipboard';
  elapsedSecs: number;
}

export interface HandoverData {
  meetingName: string;
  /** ISO date string or anything Date can parse. */
  date: string;
  durationSeconds: number | null;
  timeline: HandoverItem[];
  links: HandoverLink[];
  /** Meeting folder. Screenshot paths inside it are rewritten relative so the images render. */
  folderPath?: string;
}

// ─── Time formatting ─────────────────────────────────────────────────────────

/** `MM:SS`, or `HH:MM:SS` once a call runs past an hour. */
export function formatStamp(secs: number): string {
  const safe = Number.isFinite(secs) && secs > 0 ? Math.floor(secs) : 0;
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

// ─── Links ───────────────────────────────────────────────────────────────────

/**
 * Absolute http(s) URLs, plus bare `www.` hosts (which people paste constantly).
 * Trailing sentence punctuation and a trailing unbalanced `)` are trimmed: a URL at the end of a
 * typed line usually collects a full stop, and a markdown-wrapped one collects a bracket.
 */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

export function extractLinks(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.match(URL_RE) ?? []) {
    let url = raw.replace(/[.,;:!?]+$/, '');
    // Only strip a closing paren the URL does not open itself, so wikipedia-style links survive.
    while (url.endsWith(')') && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length) {
      url = url.slice(0, -1);
    }
    if (url.length > 4) out.push(url);
  }
  return out;
}

/**
 * Pull every link the user typed or copied, first occurrence wins, in timeline order.
 * Speech is deliberately excluded: see the module header.
 */
export function collectLinks(timeline: HandoverItem[]): HandoverLink[] {
  const seen = new Set<string>();
  const links: HandoverLink[] = [];

  for (const item of timeline) {
    if (item.type !== 'note' && item.type !== 'clipboard') continue;
    for (const url of extractLinks(item.text)) {
      const key = url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ url, from: item.type, elapsedSecs: item.elapsedSecs });
    }
  }

  return links;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

/**
 * Rewrite an absolute capture path to one relative to the meeting folder, so the embedded image
 * resolves when the document is read from inside that folder (which is where it is written, and how
 * every markdown viewer will open it). Falls back to the original path when the file lives elsewhere,
 * which still beats emitting a broken link.
 */
export function relativeToFolder(filePath: string, folderPath?: string): string {
  if (!filePath) return '';
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const file = norm(filePath);
  if (!folderPath) return encodeMarkdownPath(file);

  const folder = norm(folderPath);
  const prefix = `${folder}/`;
  const rel = file.toLowerCase().startsWith(prefix.toLowerCase())
    ? file.slice(prefix.length)
    : file;
  return encodeMarkdownPath(rel);
}

/** Spaces and parens break markdown link syntax, so percent-encode just those. */
function encodeMarkdownPath(p: string): string {
  return p.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

// ─── Build the timeline ──────────────────────────────────────────────────────

/**
 * Merge every stream onto the recording clock.
 *
 * Notes and speech both arrive in `transcripts` (Solo files typed lines into the transcript), so they
 * are separated by the `source: 'note'` marker rather than by origin. Any `jots` passed in are notes
 * too, from the meeting-mode jot store, and are merged on the same axis.
 *
 * Ties are broken by stream, not left to sort chance: at a shared timestamp, speech reads first, then
 * the note the user typed about it, then the screenshot they grabbed, then what they copied. That is
 * the order the actions actually happen in.
 */
const TIE_ORDER: Record<HandoverItemType, number> = {
  speech: 0,
  note: 1,
  screenshot: 2,
  clipboard: 3,
};

export function buildHandoverTimeline(
  transcripts: Transcript[],
  screenshots: ScreenshotData[],
  clipboardItems: ClipboardData[],
  jots: Jot[] = [],
): HandoverItem[] {
  const items: HandoverItem[] = [];

  for (const t of transcripts) {
    const text = (t.text ?? '').trim();
    if (!text) continue;
    items.push({
      elapsedSecs: t.audio_start_time ?? t.chunk_start_time ?? 0,
      type: isNoteSegment(t) ? 'note' : 'speech',
      text,
    });
  }

  for (const j of jots) {
    const text = (j.content ?? '').trim();
    if (!text) continue;
    items.push({
      elapsedSecs: j.audioMs != null ? j.audioMs / 1000 : 0,
      type: 'note',
      text,
    });
  }

  for (const s of screenshots) {
    items.push({
      elapsedSecs: s.recording_elapsed_secs ?? 0,
      type: 'screenshot',
      text: s.file_path,
      filePath: s.file_path,
      captureMode: s.capture_mode,
    });
  }

  for (const c of clipboardItems) {
    items.push({
      elapsedSecs: c.recording_elapsed_secs ?? 0,
      type: 'clipboard',
      text: c.content_type === 'image' ? (c.file_path ?? 'image') : (c.text ?? ''),
      filePath: c.file_path,
      contentType: c.content_type,
    });
  }

  // Stable sort on (time, stream). Array.prototype.sort is stable in every engine we target, so
  // same-time same-stream items keep the order they were added in.
  return items.sort((a, b) => {
    if (a.elapsedSecs !== b.elapsedSecs) return a.elapsedSecs - b.elapsedSecs;
    return TIE_ORDER[a.type] - TIE_ORDER[b.type];
  });
}

// ─── Render ──────────────────────────────────────────────────────────────────

export function generateHandoverMarkdown(data: HandoverData): string {
  const lines: string[] = [];

  lines.push(`# Handover: ${data.meetingName}`);
  lines.push('');

  const parsed = new Date(data.date);
  const dateLabel = Number.isNaN(parsed.getTime())
    ? data.date
    : parsed.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  lines.push(`**Date:** ${dateLabel}`);
  if (data.durationSeconds != null) {
    lines.push(`**Duration:** ${formatDuration(data.durationSeconds)}`);
  }

  const counts = countByType(data.timeline);
  lines.push(
    `**Captured:** ${plural(counts.speech, 'transcript segment')}, ${plural(counts.note, 'note')}, ` +
    `${plural(counts.screenshot, 'screenshot')}, ${plural(counts.clipboard, 'clipboard item')}`,
  );
  lines.push('');

  // Links first: this is the section people come back for.
  if (data.links.length > 0) {
    lines.push('## Links');
    lines.push('');
    for (const link of data.links) {
      const origin = link.from === 'note' ? 'typed' : 'copied';
      lines.push(`- <${link.url}> (${origin} at ${formatStamp(link.elapsedSecs)})`);
    }
    lines.push('');
  }

  lines.push('## Timeline');
  lines.push('');

  if (data.timeline.length === 0) {
    lines.push('*Nothing was captured on this call.*');
  }

  for (const item of data.timeline) {
    const ts = `[${formatStamp(item.elapsedSecs)}]`;

    switch (item.type) {
      case 'speech':
        lines.push(`${ts} ${item.text}`);
        lines.push('');
        break;

      case 'note':
        lines.push(`**${ts} Note:** ${item.text}`);
        lines.push('');
        break;

      case 'screenshot': {
        const rel = relativeToFolder(item.filePath ?? item.text, data.folderPath);
        const mode = item.captureMode === 'region' ? 'region' : 'full screen';
        lines.push(`![Screenshot at ${formatStamp(item.elapsedSecs)}](${rel})`);
        lines.push('');
        lines.push(`*${ts} Screenshot (${mode})*`);
        lines.push('');
        break;
      }

      case 'clipboard': {
        if (item.contentType === 'image') {
          const rel = relativeToFolder(item.filePath ?? '', data.folderPath);
          lines.push(`![Clipboard image at ${formatStamp(item.elapsedSecs)}](${rel})`);
          lines.push('');
          lines.push(`*${ts} Clipboard image*`);
          lines.push('');
        } else {
          lines.push(`**${ts} Copied:**`);
          lines.push('');
          // Fenced so pasted code, JSON or a multi-line block survives intact.
          lines.push('```');
          lines.push(item.text);
          lines.push('```');
          lines.push('');
        }
        break;
      }
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('*Generated by Tandem. Verbatim capture, no AI summarisation.*');

  return lines.join('\n');
}

/** `1 note` / `2 notes`. Every counted noun here pluralises with a plain -s. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function countByType(timeline: HandoverItem[]): Record<HandoverItemType, number> {
  const counts: Record<HandoverItemType, number> = { speech: 0, note: 0, screenshot: 0, clipboard: 0 };
  for (const item of timeline) counts[item.type]++;
  return counts;
}
