/**
 * quickCapture: pure logic for the global quick-capture bar (Alt+Shift+N).
 *
 * No React, no Tauri: every function here is deterministic and unit-tested. The
 * capture window (/capture) and the Rust clipboard watcher share this vocabulary:
 *   - a rolling buffer of the last 3 copied text items (consecutive dupes collapse),
 *   - chip selection (which buffered clips are attached to this capture),
 *   - the dated note-file name + markdown body written into a project's .tandem/notes,
 *   - the router payload assembled from the note + attached clips.
 */

import type { Project } from '@/services/projectService';

export interface QuickClip {
  id: string;
  /** Plain text of the copied item (image clips are out of scope this pass). */
  text: string;
}

/** Max clipboard items kept in the rolling, memory-only buffer. */
export const CLIP_BUFFER_CAP = 3;

/**
 * Roll a freshly copied text item into the rolling buffer. `buffer[0]` is the most
 * recent. Re-copying the exact same text (a consecutive duplicate) is a no-op, so a
 * poll that keeps reading the same clipboard never floods the buffer. Empty / blank
 * text is ignored. Capped at `cap` (oldest dropped). Pure.
 */
export function rollClipBuffer(buffer: QuickClip[], next: QuickClip, cap = CLIP_BUFFER_CAP): QuickClip[] {
  const text = next.text;
  if (!text || !text.trim()) return buffer;
  if (buffer.length > 0 && buffer[0].text === text) return buffer; // consecutive dupe
  return [next, ...buffer].slice(0, cap);
}

/** The default chip selection: the latest clip (index 0) is attached, the rest are not. */
export function defaultSelection(buffer: QuickClip[]): Set<number> {
  return buffer.length > 0 ? new Set([0]) : new Set<number>();
}

/** Toggle a chip's inclusion by buffer index. Pure (returns a new Set). */
export function toggleChip(selected: Set<number>, index: number): Set<number> {
  const next = new Set(selected);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  return next;
}

/** The clips currently attached, in buffer order (most recent first). Pure. */
export function selectedClips(buffer: QuickClip[], selected: Set<number>): QuickClip[] {
  return buffer.filter((_, i) => selected.has(i));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local timestamp "YYYY-MM-DD HH:mm" used in the note heading. */
export function formatStamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

/** Dated note file name, e.g. "2026-07-15-1432-quick-capture.md". */
export function quickCaptureFilename(date: Date = new Date()): string {
  const y = date.getFullYear();
  const mo = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const h = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  return `${y}-${mo}-${d}-${h}${mi}-quick-capture.md`;
}

export interface NoteInput {
  note: string;
  clips: QuickClip[];
  projectName: string | null;
  date?: Date;
}

/**
 * Build the markdown body of a quick-capture note. Structure: a dated heading, the
 * "filed under" line, the optional note text, then each attached clipboard item in a
 * fenced block marked "captured from clipboard". An empty note with one clip is valid.
 * Deterministic given `date`. No em dashes.
 */
export function buildNoteMarkdown(input: NoteInput): string {
  const { note, clips } = input;
  const date = input.date ?? new Date();
  const lines: string[] = [];

  lines.push(`# Quick capture: ${formatStamp(date)}`);
  lines.push('');
  if (input.projectName && input.projectName.trim()) {
    lines.push(`Filed under: ${input.projectName.trim()}`);
    lines.push('');
  }
  const trimmedNote = note.trim();
  if (trimmedNote) {
    lines.push(trimmedNote);
    lines.push('');
  }
  clips.forEach((clip, i) => {
    lines.push(`## Clipboard item ${i + 1} (captured from clipboard)`);
    lines.push('');
    lines.push('```');
    lines.push(clip.text);
    lines.push('```');
    lines.push('');
  });

  // Collapse any trailing blank lines to a single terminating newline.
  return lines.join('\n').replace(/\n+$/, '\n');
}

/**
 * Assemble the payload for the project router from the note + attached clips. The
 * router (routeMeetingToProject) scores a "meeting title" + "transcript text": the
 * note doubles as the title (it is the user's distinctive phrasing), and the note plus
 * every clip becomes the body to match project names/aliases against. Pure.
 */
export function buildRouterInput(
  note: string,
  clips: QuickClip[],
): { meetingTitle: string | null; transcriptText: string } {
  const trimmedNote = note.trim();
  const clipText = clips.map(c => c.text).join('\n\n');
  const transcriptText = [trimmedNote, clipText].filter(Boolean).join('\n\n');
  return { meetingTitle: trimmedNote || null, transcriptText };
}

/**
 * Order the routing candidates for the chip's Tab-cycle: the routed suggestion first
 * (when present), then the rest of the pool, de-duplicated, capped at `max`. Pure.
 */
export function orderRouteCandidates(
  routed: Project | null,
  pool: Project[],
  max = 3,
): Project[] {
  const out: Project[] = [];
  const seen = new Set<string>();
  if (routed) {
    out.push(routed);
    seen.add(routed.id);
  }
  for (const p of pool) {
    if (out.length >= max) break;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/** Advance a cycle index by `delta`, wrapping. Returns 0 for an empty list. Pure. */
export function cycleIndex(current: number, length: number, delta: number): number {
  if (length <= 0) return 0;
  return (((current + delta) % length) + length) % length;
}

// ─── New inquiry (create a client folder straight from the bar) ──────────────
//
// A capture that matches no project is the moment a new client actually enters the
// system (an Upwork invite, a cold email). These helpers turn that capture into a
// folder under the clients root. Everything here is pure; the filesystem work lives
// in the Rust `create_inquiry` command, which re-validates the name independently.

/** Prefix marking a synthetic "create a new folder here" candidate in the route cycle. */
export const NEW_INQUIRY_PREFIX = '__new_inquiry__:';

/** True when a route candidate is a "+ New in <base>" entry rather than a real destination. */
export function isNewInquiryCandidate(project: Pick<Project, 'id'>): boolean {
  return typeof project.id === 'string' && project.id.startsWith(NEW_INQUIRY_PREFIX);
}

/** Longest folder name we will produce. Keeps paths well clear of MAX_PATH once
 *  `.tandem/notes/<dated file>.md` is appended underneath. */
export const MAX_INQUIRY_NAME = 60;

/** Windows reserved device names, which are illegal as a folder name at any casing. */
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Make `raw` safe to use as a single folder name on Windows and POSIX.
 *
 * Strips the characters Windows forbids (`<>:"/\|?*`) plus control characters,
 * collapses whitespace, and trims the leading/trailing dots and spaces that
 * Explorer silently drops (a folder named "Acme." is really "Acme", which would
 * make our read-back check disagree with the OS). Reserved device names get an
 * underscore suffix. Returns '' when nothing usable survives, which the caller
 * treats as "not ready to commit". Pure.
 */
export function sanitizeFolderName(raw: string, max = MAX_INQUIRY_NAME): string {
  const cleaned = raw
    .replace(/[<>:"/\\|?*]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    // Re-trim AFTER truncation: slicing can expose a new trailing space, and a
    // trailing dot or space is silently dropped by Windows.
    .replace(/[. ]+$/, '')
    .replace(/^[. ]+/, '');
  if (!cleaned) return '';
  return RESERVED_NAMES.has(cleaned.toUpperCase()) ? `${cleaned}_` : cleaned;
}

/** Job-board boilerplate that makes a worthless folder name if we grab it verbatim. */
const NAME_STOPWORDS = [
  'looking for', 'seeking', 'need a', 'need an', 'i need', 'we need',
  'hiring', 'wanted', 'urgent', 'new job', 'job post', 'invitation to interview',
  'you have been invited', 'apply now',
  // Articles, stripped in the same pass: removing "Looking for" off
  // "Looking for an n8n developer" otherwise leaves the stranded "an".
  'a ', 'an ', 'the ',
];

/**
 * Guess a folder name from the captured text so the field is prefilled rather than empty.
 *
 * Prefers the user's own note (they typed it deliberately). Otherwise takes the first
 * meaningful line of the first clip, drops leading job-board boilerplate, and cuts at
 * the first sentence-ish break. This is a starting point the user always edits before
 * committing, so a mediocre guess is acceptable and an empty field is not. Pure.
 */
export function deriveInquiryName(note: string, clips: QuickClip[]): string {
  const fromNote = sanitizeFolderName(note);
  if (fromNote) return fromNote;

  const firstClip = clips[0]?.text ?? '';
  const firstLine = firstClip
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(l => l.length > 2) ?? '';

  let candidate = firstLine;
  // Strip leading boilerplate repeatedly ("Urgent: Looking for an n8n dev" -> "n8n dev").
  let changed = true;
  while (changed) {
    changed = false;
    const lowered = candidate.toLowerCase();
    for (const stop of NAME_STOPWORDS) {
      if (lowered.startsWith(stop)) {
        candidate = candidate.slice(stop.length).replace(/^[\s:,-]+/, '');
        changed = true;
        break;
      }
    }
  }
  // Cut at the first hard break so we get a phrase, not a paragraph.
  candidate = candidate.split(/[.!?|–—]|\s[-]\s/)[0] ?? candidate;
  return sanitizeFolderName(candidate);
}

export interface InquiryBriefInput {
  name: string;
  /** The captured job post / message body. May be empty. */
  body: string;
  /** Free-text note typed in the bar, if the name came from somewhere else. */
  note?: string;
  date?: Date;
}

/**
 * Build `brief.md` for a new inquiry: front matter the eye can scan, the captured
 * body verbatim, then the empty sections that get filled in while qualifying the
 * job. Deliberately mirrors new-client.ps1 so the terminal and the bar produce the
 * same file. Deterministic given `date`. No em dashes. Pure.
 */
export function buildInquiryBrief(input: InquiryBriefInput): string {
  const date = input.date ?? new Date();
  const stamp = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const body = input.body.trim();
  const note = (input.note ?? '').trim();

  const lines: string[] = [
    `# ${input.name}`,
    '',
    '- Source: Upwork',
    `- Created: ${stamp}`,
    '- Status: Evaluating',
    '',
  ];
  if (note) {
    // "Capture note", not "Note": the brief already has a "## Notes" section further
    // down, and two headings where one is a prefix of the other is a trap for both
    // the reader and any tooling that greps this file.
    lines.push('## Capture note', '', note, '');
  }
  lines.push('## Job description', '');
  lines.push(body || '_Nothing was captured. Paste the job description here._');
  lines.push('', '## Notes', '', '## Questions for client', '', '## Estimate / approach', '');
  return lines.join('\n').replace(/\n+$/, '\n');
}

/**
 * Build the block appended to an EXISTING `brief.md` when the folder is already there
 * (the client contacted you twice, or you scaffolded it from the terminal earlier).
 *
 * Appending rather than overwriting is the whole point: the existing brief may already
 * carry your estimate and questions. Deterministic given `date`. Pure.
 */
export function buildInquiryAppend(input: { body: string; note?: string; date?: Date }): string {
  const date = input.date ?? new Date();
  const body = input.body.trim();
  const note = (input.note ?? '').trim();
  const lines = ['', `## Follow-up capture: ${formatStamp(date)}`, ''];
  if (note) lines.push(note, '');
  if (body) lines.push(body, '');
  return lines.join('\n').replace(/\n+$/, '\n');
}

/**
 * Build the project-root `CLAUDE.md` for a new inquiry.
 *
 * This is the file Claude Code reads when the folder is opened in the IDE, so its
 * whole job is to point at the brief and state what has NOT been decided yet, which
 * stops a fresh session from inventing scope. Pure.
 */
export function buildInquiryClaudeMd(name: string): string {
  return [
    `# ${name}`,
    '',
    'Prospective client inquiry. Nothing has been agreed yet.',
    '',
    `The captured job description is in [brief.md](brief.md). Read it before proposing`,
    'anything, and treat its scope as unconfirmed: the budget, the timeline and the',
    'stack are the client\'s wishes, not commitments.',
    '',
    '## Status',
    '',
    'Evaluating. No proposal sent, no work started.',
    '',
  ].join('\n');
}
