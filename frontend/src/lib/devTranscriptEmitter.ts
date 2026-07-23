/**
 * Dev / test emitter for the Scribe Realtime partial-rendering layer (Phase 1).
 *
 * There is no Rust emitter for `transcript-partial` yet (Phase 2). This module
 * fires synthetic `transcript-partial` and `transcript-update` events through the
 * SAME Tauri event bus the real engine will use, so the frontend volatile-tail
 * layer can be exercised in dev (browser console) and in Playwright e2e (the Tauri
 * mock implements `plugin:event|emit`, which `emit()` routes to).
 *
 * It is intentionally NOT imported by any production code path; the installer is
 * gated to non-production and only attaches console helpers to `window`.
 */
import { emit } from '@tauri-apps/api/event';
import { TranscriptPartial, TranscriptUpdate } from '@/types';

/** Emit a single revisable partial for a source. */
export async function emitPartial(partial: TranscriptPartial): Promise<void> {
  await emit('transcript-partial', partial);
}

/** Build a committed TranscriptUpdate with sane defaults for the required fields. */
export function makeCommitted(
  init: Partial<TranscriptUpdate> & { text: string; source: string; sequence_id: number }
): TranscriptUpdate {
  return {
    text: init.text,
    source: init.source,
    sequence_id: init.sequence_id,
    timestamp: init.timestamp ?? new Date().toISOString(),
    chunk_start_time: init.chunk_start_time ?? 0,
    confidence: init.confidence ?? 1,
    audio_start_time: init.audio_start_time ?? 0,
    audio_end_time: init.audio_end_time ?? 0,
    duration: init.duration ?? 0,
    // Committed events are never partial, regardless of what the caller passed.
    is_partial: false,
  };
}

/** Emit a committed segment (the event every downstream consumer already handles). */
export async function emitCommitted(
  init: Partial<TranscriptUpdate> & { text: string; source: string; sequence_id: number }
): Promise<void> {
  await emit('transcript-update', makeCommitted(init));
}

/**
 * Emit a growing partial sequence for one source, then (optionally) the committed
 * segment that supersedes it. `growths` are the successive tail texts.
 */
export async function emitPartialSequence(
  source: string,
  growths: string[],
  opts: { seqStart?: number; delayMs?: number; commit?: boolean } = {}
): Promise<void> {
  const { seqStart = 1, delayMs = 30, commit = true } = opts;
  let seq = seqStart;
  for (const text of growths) {
    await emitPartial({ source, text, session_seq: seq++ });
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  if (commit && growths.length > 0) {
    await emitCommitted({ source, text: growths[growths.length - 1], sequence_id: seq });
  }
}

/**
 * Install console helpers on `window.__tandemDevTranscript` (dev / e2e only).
 * Call from a dev-gated effect. Returns a cleanup that removes the helpers.
 */
export function installDevTranscriptEmitter(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (process.env.NODE_ENV === 'production') return () => {};
  (window as unknown as Record<string, unknown>).__tandemDevTranscript = {
    emitPartial,
    emitCommitted,
    emitPartialSequence,
    makeCommitted,
  };
  return () => {
    try {
      delete (window as unknown as Record<string, unknown>).__tandemDevTranscript;
    } catch {
      /* ignore */
    }
  };
}
