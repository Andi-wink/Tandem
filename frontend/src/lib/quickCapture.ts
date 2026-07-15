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
