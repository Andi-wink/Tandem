/**
 * enhanceNotes: orchestration for the "Enhance my notes" model pass.
 *
 * Runs after transcripts are saved, in parallel with the auto-summary and non-blocking. It is a thin,
 * shared pipeline used by BOTH entry points (the recording-stop path and the meeting-details
 * "Regenerate" button):
 *   1. build the prompt (pure, from meetingJots),
 *   2. call the configured provider through the backend /enhance-notes endpoint (one synchronous call,
 *      no polling and no summary-pipeline chunking),
 *   3. run the deterministic quote verifier and mark unverified quotes,
 *   4. write enhanced-notes.md into the meeting folder, resolved at write time so a post-stop folder
 *      relocation lands the notes in the folder the meeting actually ends up in.
 *
 * The idempotency latch mirrors autoSummary: a module-level Set keyed by meeting id keeps the stop
 * path from colliding with itself; Regenerate resets the latch explicitly.
 */

import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import type { Transcript } from '@/types';
import { buildEnhancePrompt, formatStamp, jotWindowCentersSec, type Jot } from '@/lib/meetingJots';
import { markUnverifiedQuotes, countUnverifiedQuotes, type StampedSegment } from '@/lib/quoteVerifier';

const started = new Set<string>();

export function hasEnhanceStarted(meetingId: string): boolean {
  return started.has(meetingId);
}
export function markEnhanceStarted(meetingId: string): void {
  started.add(meetingId);
}
export function resetEnhanceNotes(meetingId: string): void {
  started.delete(meetingId);
}

export const ENHANCED_NOTES_FILENAME = 'enhanced-notes.md';

/**
 * Timestamped transcript segments used ONLY for deterministic quote verification. Carrying the start
 * time (not a flat joined string) is what lets the verifier localize each quote to its claimed [MM:SS]
 * stamp, so a real quote mis-attributed to the wrong moment cannot pass. Order preserved.
 */
function verificationSegments(transcripts: Transcript[]): StampedSegment[] {
  return transcripts.map((t) => ({ startSec: t.audio_start_time ?? 0, text: t.text }));
}

function joinPath(dir: string, file: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  const trimmed = dir.replace(/[\\/]+$/, '');
  return `${trimmed}${sep}${file}`;
}

function normalizeBaseUrl(serverAddress: string | null | undefined): string {
  const addr = (serverAddress || '').trim() || 'http://localhost:5167';
  return addr.startsWith('http') ? addr : `http://${addr}`;
}

export interface RunEnhanceArgs {
  meetingId: string;
  jots: Jot[];
  transcripts: Transcript[];
  provider: string;
  model: string;
  apiKey: string | null;
  serverAddress: string;
  /** Resolves the CURRENT meeting folder at write time (post-relocation). Return null if unknown. */
  resolveFolderPath: () => Promise<string | null>;
  /** Navigate to the meeting. Wired to router.push by the caller. */
  onView?: (meetingId: string) => void;
  /** 'stop' shows the calm auto lifecycle; 'regenerate' is button-driven. Only affects copy. */
  source?: 'stop' | 'regenerate';
  /**
   * Whether the caller already persisted the raw jots to jots.json. Defaults to true (Regenerate reads
   * jots straight from jots.json, so they are on disk by definition). The stop path passes the real
   * result of its write so the failure toast never claims "your jots are saved" when that write failed.
   */
  jotsPersisted?: boolean;
}

export interface RunEnhanceResult {
  ok: boolean;
  unverified?: number;
  error?: string;
}

/**
 * Run the enhance pass end to end with a calm toast lifecycle ("Enhancing your notes..." ->
 * "Notes ready - View"). Never throws: returns a result object and leaves an error toast with a
 * Retry action on failure. Raw jots are assumed already persisted by the caller, so a model failure
 * never loses them.
 */
export async function runEnhanceNotes(args: RunEnhanceArgs): Promise<RunEnhanceResult> {
  const { meetingId, jots, transcripts, provider, model, apiKey, serverAddress, resolveFolderPath, onView } = args;
  const jotsPersisted = args.jotsPersisted ?? true;
  const toastId = `enhance-notes-${meetingId}`;

  if (!jots.length) return { ok: false, error: 'no jots' };

  toast.loading('Enhancing your notes...', {
    id: toastId,
    description: 'Weaving your jots into the transcript.',
  });

  try {
    const prompt = buildEnhancePrompt(jots, transcripts);
    const baseUrl = normalizeBaseUrl(serverAddress);

    const response = await fetch(`${baseUrl}/enhance-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        provider,
        model_name: model,
        api_key: apiKey,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`enhance-notes ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }

    const payload = (await response.json().catch(() => null)) as { notes?: string } | null;
    const rawNotes = (payload?.notes || '').trim();
    if (!rawNotes) throw new Error('The model returned no notes.');

    // Deterministic trust pass: mark any quote that is not a verbatim, contiguous span of the transcript
    // AROUND its own claimed [MM:SS] stamp (so a real quote pinned to the wrong moment is caught too).
    const segments = verificationSegments(transcripts);
    // Jot-window centers let the verifier localize an UNSTAMPED quote to the same windows the prompt
    // showed the model, closing the "drop the stamp to escape localization" bypass.
    const centers = jotWindowCentersSec(jots, transcripts);
    const verified = markUnverifiedQuotes(rawNotes, segments, centers);
    const unverified = countUnverifiedQuotes(rawNotes, segments, centers);

    const folder = await resolveFolderPath();
    if (!folder) throw new Error('Could not resolve the meeting folder to save the notes.');

    const filePath = joinPath(folder, ENHANCED_NOTES_FILENAME);
    await invoke('save_transcript', { filePath, content: verified });

    // Nudge an already-open meeting-details page to reload the freshly written notes.
    try {
      window.dispatchEvent(new CustomEvent('tandem:notes-updated', { detail: { meetingId } }));
    } catch { /* SSR / no window, ignore */ }

    // The deterministic pass verifies QUOTED spans against the transcript, not the surrounding prose,
    // so the "all clear" copy says exactly that (quotes checked) rather than implying the whole note
    // is grounded. Overclaiming here would be the misleading signal the trust backbone must avoid.
    toast.success('Notes ready', {
      id: toastId,
      description:
        unverified > 0
          ? `${unverified} quote${unverified === 1 ? '' : 's'} could not be matched to your transcript and ${unverified === 1 ? 'is' : 'are'} marked.`
          : 'Every quote was matched against your transcript.',
      action: onView
        ? { label: 'View', onClick: () => onView(meetingId) }
        : undefined,
      duration: 10000,
    });

    return { ok: true, unverified };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[enhanceNotes] failed:', message);
    // A failure must release the latch so Retry can re-run.
    resetEnhanceNotes(meetingId);
    // Only claim the raw jots are safe when they actually reached jots.json; otherwise be honest that
    // they live only in this session so the user knows not to close the app before retrying.
    const jotFate = jotsPersisted
      ? 'Your jots are saved. You can retry from the meeting.'
      : 'Your jots could not be saved to disk and are kept only for this session, so retry before closing the app.';
    toast.error('Could not enhance your notes', {
      id: toastId,
      description: `${message} ${jotFate}`,
      action: onView
        ? { label: 'Open meeting', onClick: () => onView(meetingId) }
        : undefined,
      duration: 10000,
    });
    return { ok: false, error: message };
  }
}

/** Re-export for callers that render a preview of when a jot was flagged. */
export { formatStamp };
