/**
 * jotsRescue: best-effort "never lose a jot" write path.
 *
 * When the primary jots.json write fails, or a new recording / crash would clear the in-session jot
 * store before the jots reached disk, we drop a rescue copy into a location that ALWAYS exists: the
 * default recordings base directory. This is deliberately independent of the (missing/failed) meeting
 * folder so the user's judgments survive even the worst case.
 *
 * Everything here is best-effort and never throws: callers treat a failed rescue as "kept only in the
 * session" and keep the store for retry.
 */

import { invoke } from '@tauri-apps/api/core';
import { buildRescueMarkdown, type Jot } from '@/lib/meetingJots';

/** `jots-rescue-<yyyyMMdd-HHmmss>.md`, from a fixed Date so it is deterministic and testable. */
export function rescueFileName(date: Date): string {
  const p = (n: number) => n.toString().padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `jots-rescue-${stamp}.md`;
}

export interface RescueResult {
  ok: boolean;
  /** Absolute path of the rescue file when the write succeeded. */
  path?: string;
  error?: string;
}

/**
 * Write a rescue copy of the jots into the default recordings base directory. Returns a result rather
 * than throwing so the stop path can pick the right toast copy. `now` is injectable for tests.
 */
export async function rescueJotsToDisk(
  jots: Jot[],
  meetingTitle: string | null | undefined,
  now: Date = new Date(),
): Promise<RescueResult> {
  if (!jots.length) return { ok: false, error: 'no jots to rescue' };
  try {
    const base = await invoke<string | null>('get_recordings_base_dir');
    if (!base) return { ok: false, error: 'no recordings base dir' };
    const sep = base.includes('\\') ? '\\' : '/';
    const filePath = `${base.replace(/[\\/]+$/, '')}${sep}${rescueFileName(now)}`;
    const content = buildRescueMarkdown(meetingTitle, now, jots);
    // save_transcript creates the parent directory if needed, so the base dir need not pre-exist.
    await invoke('save_transcript', { filePath, content });
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
