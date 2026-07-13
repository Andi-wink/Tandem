/**
 * pendingRelocation — a tiny single-slot sessionStorage store that records "after this recording
 * saves, move its folder into project X's .tandem" (R3).
 *
 * Why: when a call is filed to a project MID-recording, the folder cannot be moved while the audio
 * pipeline is still writing into it. So `fileUnder` stashes the intent here; `useRecordingStop`
 * consumes it once, after saveMeeting + handoff settle, and invokes `relocate_meeting_folder`.
 * Filing-undo clears it so a cancelled filing never relocates.
 *
 * Pure TS, SSR-guarded, never throws. No TTL: it is consumed exactly once or explicitly cleared.
 */

const STORAGE_KEY = 'tandem.pendingRelocation';

export interface PendingRelocation {
  /**
   * Owning recording-session token (the `live-<ts>` id generated at recording start). The consumer
   * relocates ONLY when this matches the current session's token, so a stale entry left by a
   * crashed/failed prior session can never attach to a later, unrelated meeting (R3).
   */
  meetingId: string;
  /** Original meeting folder path (captured before the move) — enables undo-back-to-origin. */
  fromFolder?: string;
  /** Destination parent dir: the project's `.tandem` directory. */
  toProjectPath: string;
  /** Project display name for the post-move confirmation toast. */
  projectName: string;
  /** Epoch ms written. */
  createdAt: number;
}

export function setPendingRelocation(pending: Omit<PendingRelocation, 'createdAt'>): void {
  if (typeof window === 'undefined') return;
  try {
    const full: PendingRelocation = { ...pending, createdAt: Date.now() };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(full));
  } catch {
    // Storage disabled/full — filing still proceeds, just without deferred relocation.
  }
}

/** Read the pending relocation without removing it. Returns null when missing or corrupt. */
export function peekPendingRelocation(): PendingRelocation | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingRelocation;
    if (
      !parsed ||
      typeof parsed.meetingId !== 'string' ||
      typeof parsed.toProjectPath !== 'string' ||
      typeof parsed.projectName !== 'string'
    ) {
      clearPendingRelocation();
      return null;
    }
    return parsed;
  } catch {
    clearPendingRelocation();
    return null;
  }
}

export function clearPendingRelocation(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
