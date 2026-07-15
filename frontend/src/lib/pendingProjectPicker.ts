/**
 * pendingProjectPicker — a tiny, single-slot sessionStorage store that carries an ambiguity-chooser
 * payload (ranked candidates + meeting title) from startRecordingForEvent to the home page.
 *
 * Why it exists: the chooser is opened by dispatching `tandem:open-project-picker`, but ProjectPicker
 * is only MOUNTED on the home route. When an ambiguous reminder fires off-route (the I5b handover
 * starts the next meeting while the user is on Settings / meeting-details, then navigates home), that
 * event has no listener and the picker is lost. Stashing the payload here lets the home page consume
 * it on mount, mirroring how `autoStartRecording` bridges an off-route start into the home controls.
 *
 * Short TTL (2 min, matching recordingSeed): a chooser the user never reached must not reopen stale on
 * some later, unrelated home mount. Pure TS, SSR-guarded, never throws.
 */

import type { ChooserCandidate } from '@/lib/startFromEvent';

const STORAGE_KEY = 'tandem.pendingProjectPicker';
const TTL_MS = 2 * 60_000;

export interface PendingProjectPicker {
  candidates: ChooserCandidate[];
  meetingTitle: string;
  /** Epoch ms the payload was written (drives the TTL). */
  createdAt: number;
}

export function setPendingProjectPicker(payload: { candidates: ChooserCandidate[]; meetingTitle: string }): void {
  if (typeof window === 'undefined') return;
  try {
    const full: PendingProjectPicker = { ...payload, createdAt: Date.now() };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(full));
  } catch {
    // Storage disabled/full — the live event dispatch still covers the on-route case.
  }
}

/** Read and remove the payload in one call. Returns null when missing, corrupt, or expired. */
export function consumePendingProjectPicker(): PendingProjectPicker | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  clearPendingProjectPicker();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingProjectPicker;
    if (
      !parsed ||
      !Array.isArray(parsed.candidates) ||
      typeof parsed.meetingTitle !== 'string' ||
      typeof parsed.createdAt !== 'number'
    ) {
      return null;
    }
    if (Date.now() - parsed.createdAt > TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingProjectPicker(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
