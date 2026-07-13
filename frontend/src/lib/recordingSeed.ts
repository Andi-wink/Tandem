/**
 * recordingSeed — a tiny, single-slot sessionStorage store that carries the "start recording for
 * THIS calendar event" intent from the click/palette action to the recording-start machinery.
 *
 * Why a store and not props: the start is dispatched as a window event (tandem:request-start-recording)
 * that fans out to RecordingControls, useRecordingStart (title), and page.tsx (filing). A seed lets
 * all three read the same pre-computed match without threading state through the event.
 *
 * Short TTL (2 min): if a start is aborted (e.g. the transcription model is missing), the seed must
 * not linger and hijack an unrelated manual start later. Pure TS, SSR-guarded, never throws.
 */

const STORAGE_KEY = 'tandem.recordingSeed';
const TTL_MS = 2 * 60_000;

export interface RecordingSeed {
  /** Meeting title to pre-fill (the event title). */
  title: string;
  /** The source event's UID, so a consumer can dedupe. */
  eventUid: string;
  /** Matched project id, if the event routed to a registered project. */
  projectId?: string;
  /** Matched project folder path (drives preRecordDir suppression + AI panel dir). */
  projectPath?: string;
  /** Matched project display name. */
  projectName?: string;
  /** Human-readable match reason for the "Filed under X — matched …" toast. */
  signal?: string;
  /** True when the user explicitly clicked a matched row (R1: explicit consent, never re-ask). */
  userConfirmed?: boolean;
  /** Epoch ms the seed was written (drives the TTL). */
  createdAt: number;
}

export function setRecordingSeed(seed: Omit<RecordingSeed, 'createdAt'>): void {
  if (typeof window === 'undefined') return;
  try {
    const full: RecordingSeed = { ...seed, createdAt: Date.now() };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(full));
  } catch {
    // Storage disabled/full — the start still proceeds, just without a seed.
  }
}

/** Read the seed without removing it. Returns null (and clears) when missing, corrupt, or expired. */
export function peekRecordingSeed(): RecordingSeed | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RecordingSeed;
    if (!parsed || typeof parsed.title !== 'string' || typeof parsed.createdAt !== 'number') {
      clearRecordingSeed();
      return null;
    }
    if (Date.now() - parsed.createdAt > TTL_MS) {
      clearRecordingSeed();
      return null;
    }
    return parsed;
  } catch {
    clearRecordingSeed();
    return null;
  }
}

/** Read and remove the seed in one call. */
export function consumeRecordingSeed(): RecordingSeed | null {
  const seed = peekRecordingSeed();
  clearRecordingSeed();
  return seed;
}

export function clearRecordingSeed(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
