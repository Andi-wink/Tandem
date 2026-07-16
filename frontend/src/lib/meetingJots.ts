/**
 * meetingJots: the pure store and prompt builder for the "Enhance my notes" feature (phase 1).
 *
 * During a recording the user types short jots ("pricing concerns", "wants Q3 rollout"). Each jot is
 * an act of judgment: this mattered. After the call a model pass weaves the transcript into the jots,
 * grounding each one in what was actually said around that moment.
 *
 * This module is deliberately pure and framework-free so it is unit-testable and safe to call from
 * both the live jot strip (add/edit/delete) and the stop path (serialize + build prompt). It owns:
 *   - the jot data shape (designed so phase 2 ink/voice jots slot in without a migration),
 *   - crash-safe sessionStorage persistence keyed to the single active recording (mirrors recordingSeed),
 *   - serialization to jots.json,
 *   - the enhance-prompt builder (windows around each jot + a compressed full-transcript appendix).
 *
 * Speaker attribution is out of scope for phase 1: the transcript text carries no diarization, so the
 * prompt rules forbid the model from inventing who said what.
 */

import type { Transcript } from '@/types';

/**
 * A single jot. `kind` is a discriminator so phase 2 can add `'ink' | 'voice'` without reshaping the
 * store or jots.json. `audioMs` is the recording-relative time in milliseconds (derived from the live
 * transcript's latest audio timestamp at jot time); null when no transcript timing was available yet.
 */
export interface Jot {
  id: string;
  createdAtMs: number;
  audioMs: number | null;
  content: string;
  kind: 'text';
}

/** jots.json envelope. Versioned so a future reader can migrate phase-2 shapes. */
export interface JotsFile {
  version: 1;
  jots: Jot[];
}

/**
 * Single active slot. Only one recording is active per tab at a time, so a single key is enough and
 * survives reload (crash-safe) without needing to thread a recording id through the UI. It is cleared
 * on a genuine recording start (the recording-started event, which never re-fires on reload) and again
 * at stop after serialization, so jots can never leak across two consecutive recordings.
 */
const STORAGE_KEY = 'tandem.meetingJots.active';

const WINDOW_SEC = 90;
const FULL_TRANSCRIPT_CHAR_BUDGET = 24_000;
/**
 * Per-jot window character budget. The +/-90s window is already bounded in TIME, but a dense stretch of
 * speech (or many jots on a long call) can still assemble a prompt larger than a small local model's
 * context. When a single window exceeds this, we keep the segments nearest the jot's moment and announce
 * the trim visibly, so truncation is never silent (the plan's explicit requirement for this risk).
 */
const WINDOW_CHAR_BUDGET = 6_000;

// ── Persistence ──────────────────────────────────────────────────────────────

/** Read the active jots. Returns [] on missing, corrupt, or SSR. Never throws. */
export function readJots(): Jot[] {
  if (typeof window === 'undefined') return [];
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidJot);
  } catch {
    return [];
  }
}

function isValidJot(j: unknown): j is Jot {
  if (!j || typeof j !== 'object') return false;
  const o = j as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.createdAtMs === 'number' &&
    (o.audioMs === null || typeof o.audioMs === 'number') &&
    typeof o.content === 'string' &&
    o.kind === 'text'
  );
}

function writeJots(jots: Jot[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(jots));
  } catch {
    // Storage disabled/full: the jot is still returned to the caller for in-memory display.
  }
}

/** Clear the active slot. Called at genuine recording start and at stop (post-serialize). */
export function clearJots(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

function makeId(): string {
  return `jot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Append a jot and persist. Returns the new list (so a UI can setState from it). A blank content is
 * ignored (returns the current list unchanged) so an accidental empty Enter never adds a chip.
 */
export function addJot(content: string, audioMs: number | null): Jot[] {
  const trimmed = content.trim();
  if (!trimmed) return readJots();
  const next = [
    ...readJots(),
    {
      id: makeId(),
      createdAtMs: Date.now(),
      audioMs: typeof audioMs === 'number' && Number.isFinite(audioMs) ? Math.max(0, Math.round(audioMs)) : null,
      content: trimmed,
      kind: 'text' as const,
    },
  ];
  writeJots(next);
  return next;
}

/** Edit a jot's content in place. Blank content deletes it (a natural "clear to remove"). */
export function editJot(id: string, content: string): Jot[] {
  const trimmed = content.trim();
  if (!trimmed) return deleteJot(id);
  const next = readJots().map((j) => (j.id === id ? { ...j, content: trimmed } : j));
  writeJots(next);
  return next;
}

export function deleteJot(id: string): Jot[] {
  const next = readJots().filter((j) => j.id !== id);
  writeJots(next);
  return next;
}

/** Serialize to the jots.json file body. Pretty-printed so a human can read it in the folder. */
export function serializeJots(jots: Jot[]): string {
  const file: JotsFile = { version: 1, jots };
  return JSON.stringify(file, null, 2);
}

/** Parse a jots.json body back into jots (for the meeting-details Regenerate path). [] on any error. */
export function parseJotsFile(raw: string | null | undefined): Jot[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as JotsFile | Jot[];
    const arr = Array.isArray(parsed) ? parsed : parsed?.jots;
    if (!Array.isArray(arr)) return [];
    return arr.filter(isValidJot);
  } catch {
    return [];
  }
}

// ── Time formatting ────────────────────────────────────────────────────────────

/** Format a recording-relative time (in seconds) as [MM:SS]. Clamps negatives to 0. */
export function formatStamp(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '[--:--]';
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `[${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
}

// ── Rescue markdown ──────────────────────────────────────────────────────────────

/**
 * Build a human-readable rescue copy of the jots. Used when the primary jots.json write fails (or a
 * new recording / crash would otherwise clear the store): a plain markdown file with the meeting title,
 * the stop timestamp, and every jot with its [MM:SS] stamp, so the user's judgments are never lost even
 * when no meeting folder is reachable. Pure and deterministic given its inputs (a fixed `stoppedAt`).
 */
export function buildRescueMarkdown(meetingTitle: string | null | undefined, stoppedAt: Date, jots: Jot[]): string {
  const title = (meetingTitle || '').trim() || 'Untitled meeting';
  const lines: string[] = [];
  lines.push(`# Rescued jots: ${title}`);
  lines.push('');
  lines.push(`Recording stopped: ${stoppedAt.toISOString()}`);
  lines.push('');
  lines.push(
    'These jots could not be saved into the meeting folder, so they were rescued here. Copy them into the meeting notes when you get a chance.',
  );
  lines.push('');
  for (const jot of jots) {
    const stamp = jot.audioMs !== null ? formatStamp(jot.audioMs / 1000) : '[--:--]';
    lines.push(`- ${stamp} ${jot.content}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ── Prompt builder ─────────────────────────────────────────────────────────────

interface TranscriptWindow {
  lines: { stampSec: number; text: string }[];
  /** Set when the window was trimmed to the char budget: how many of the in-window segments were kept. */
  trimmed?: { kept: number; total: number };
}

/** Best-effort recording length in seconds (last segment's end, else start, else 0). */
function transcriptDurationSec(transcripts: Transcript[]): number {
  let max = 0;
  for (const t of transcripts) {
    const end = t.audio_end_time ?? t.audio_start_time ?? 0;
    if (Number.isFinite(end) && end > max) max = end;
  }
  return max;
}

/**
 * The recording-relative second a jot's window is centered on. When the jot has audioMs, center on it;
 * otherwise fall back to a proportional position derived from the jot's ordinal (so windows still spread
 * across the call instead of all collapsing onto 00:00). Shared by the prompt builder and the verifier's
 * jot-center list so both localize an unstamped quote to exactly the same region.
 */
function centerForJot(
  transcripts: Transcript[],
  jotIndex: number,
  jotCount: number,
  audioMs: number | null,
): number {
  if (audioMs !== null) return audioMs / 1000;
  const dur = transcriptDurationSec(transcripts);
  const fraction = jotCount > 0 ? (jotIndex + 0.5) / jotCount : 0.5;
  return dur * fraction;
}

/**
 * The center (in seconds) of every jot's transcript window, in jot order. Passed to the quote verifier so
 * an unstamped quote is checked against the same windows the prompt showed the model, never the whole
 * call. Mirrors the centering the prompt builder uses via the shared `centerForJot`.
 */
export function jotWindowCentersSec(jots: Jot[], transcripts: Transcript[]): number[] {
  return jots.map((j, i) => centerForJot(transcripts, i, jots.length, j.audioMs));
}

/**
 * Collect the transcript window around a jot. Centers via `centerForJot`. Never truncates a segment; only
 * selects which segments fall inside the +/-90s window.
 */
function windowForJot(
  transcripts: Transcript[],
  jotIndex: number,
  jotCount: number,
  audioMs: number | null,
): TranscriptWindow {
  if (transcripts.length === 0) return { lines: [] };
  const centerSec = centerForJot(transcripts, jotIndex, jotCount, audioMs);
  const lo = centerSec - WINDOW_SEC;
  const hi = centerSec + WINDOW_SEC;
  const inWindow = transcripts
    .filter((t) => {
      const s = t.audio_start_time ?? 0;
      return s >= lo && s <= hi && t.text.trim().length > 0;
    })
    .map((t) => ({ stampSec: t.audio_start_time ?? 0, text: t.text.trim() }));

  const rendered = (ls: { stampSec: number; text: string }[]) =>
    ls.reduce((n, l) => n + l.text.length + 8, 0); // + a little for each "[MM:SS] " prefix

  if (rendered(inWindow) <= WINDOW_CHAR_BUDGET) return { lines: inWindow };

  // Over budget: keep the segments nearest the jot's moment, then restore chronological order so the
  // model reads them in sequence. The trim is reported to the caller so the prompt can flag it.
  const byDistance = [...inWindow].sort(
    (a, b) => Math.abs(a.stampSec - centerSec) - Math.abs(b.stampSec - centerSec),
  );
  const kept: { stampSec: number; text: string }[] = [];
  let used = 0;
  for (const line of byDistance) {
    const cost = line.text.length + 8;
    if (kept.length > 0 && used + cost > WINDOW_CHAR_BUDGET) break;
    kept.push(line);
    used += cost;
  }
  kept.sort((a, b) => a.stampSec - b.stampSec);
  return { lines: kept, trimmed: { kept: kept.length, total: inWindow.length } };
}

/**
 * Compressed full-transcript block for the "Also discussed" appendix. Includes every segment when it
 * fits the char budget; otherwise samples segments evenly and marks the omission visibly (never a
 * silent truncation). Timestamps are kept so the model can cite [MM:SS] from the appendix too.
 */
function buildFullTranscriptBlock(transcripts: Transcript[]): string {
  const segs = transcripts.filter((t) => t.text.trim().length > 0);
  if (segs.length === 0) return '[no transcript captured]';

  const render = (list: Transcript[]) =>
    list.map((t) => `${formatStamp(t.audio_start_time)} ${t.text.trim()}`).join('\n');

  const full = render(segs);
  if (full.length <= FULL_TRANSCRIPT_CHAR_BUDGET) return full;

  // Over budget: sample evenly so the whole call is represented, and say so.
  const approxKeep = Math.max(1, Math.floor((FULL_TRANSCRIPT_CHAR_BUDGET / full.length) * segs.length));
  const step = Math.max(1, Math.ceil(segs.length / approxKeep));
  const sampled: Transcript[] = [];
  for (let i = 0; i < segs.length; i += step) sampled.push(segs[i]);
  return `[transcript sampled to fit the model context: showing ${sampled.length} of ${segs.length} segments]\n${render(sampled)}`;
}

const PROMPT_RULES = `You turn a user's short in-call jots into proper meeting notes, grounded in the transcript.

Write the notes in the user's voice: direct, plain language, no hype, no marketing tone, and never use em dashes or en dashes (use a comma or a colon).

Rules you must follow exactly:
- Produce one section per jot, in the order given, using the jot text as the section heading.
- Every factual claim must be grounded in the transcript provided for that jot. Do not invent facts, numbers, names, commitments, or outcomes.
- When you quote, quote verbatim from the transcript and wrap the quote in double quotes, followed by its [MM:SS] stamp. Do not paraphrase inside quotation marks. Do not stitch words from different moments into one quote.
- Do not attribute a quote to a specific speaker (the transcript has no reliable speaker labels).
- If the transcript around a jot does not support anything, write exactly: flagged, but the transcript around this moment does not elaborate. Do not pad it with invented content.
- End with a short "## Also discussed" section drawn only from the full transcript, for context the jots did not cover. Keep it to a few bullet points. Omit the section if there is nothing material to add.
- Output Markdown only. Start with "# Notes". No preamble, no closing commentary.`;

/**
 * Build the full enhance prompt. Pure and deterministic given its inputs. Ordering of jots is
 * preserved; each jot gets its +/-90s (or proportional) transcript window; a compressed full
 * transcript follows for the appendix.
 */
export function buildEnhancePrompt(jots: Jot[], transcripts: Transcript[]): string {
  const parts: string[] = [PROMPT_RULES, ''];

  parts.push('## The jots (in order)');
  parts.push('');
  jots.forEach((jot, i) => {
    const stamp = jot.audioMs !== null ? formatStamp(jot.audioMs / 1000) : '[--:--]';
    parts.push(`### Jot ${i + 1}: ${jot.content}`);
    parts.push(`Flagged at ${stamp}.`);
    const win = windowForJot(transcripts, i, jots.length, jot.audioMs);
    if (win.lines.length === 0) {
      parts.push('Transcript around this moment: (none captured)');
    } else {
      parts.push('Transcript around this moment:');
      if (win.trimmed) {
        parts.push(
          `[window trimmed to fit the model context: showing the ${win.trimmed.kept} of ${win.trimmed.total} segments nearest this moment]`,
        );
      }
      for (const line of win.lines) {
        parts.push(`${formatStamp(line.stampSec)} ${line.text}`);
      }
    }
    parts.push('');
  });

  parts.push('## Full transcript (for the "Also discussed" appendix only)');
  parts.push(buildFullTranscriptBlock(transcripts));
  parts.push('');
  parts.push('Now write the notes following the rules above.');

  return parts.join('\n');
}
