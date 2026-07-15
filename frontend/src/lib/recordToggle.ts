/**
 * Global record-toggle debounce (I4).
 *
 * The Alt+Shift+E global shortcut can repeat (OS key-repeat, or an over-eager
 * double press). We collapse repeats inside a short window so one intent maps to
 * one start/stop, never a start-then-immediate-stop.
 *
 * Pure and side-effect free so it can be unit tested without a DOM or timers.
 */

export const RECORD_TOGGLE_DEBOUNCE_MS = 1000;

/**
 * Returns whether a toggle happening at `now` should be accepted, given the
 * timestamp (ms) of the last accepted toggle. The first toggle (lastAcceptedAt
 * === null) always fires; subsequent toggles inside `windowMs` are dropped.
 */
export function shouldAcceptToggle(
  lastAcceptedAt: number | null,
  now: number,
  windowMs: number = RECORD_TOGGLE_DEBOUNCE_MS,
): boolean {
  if (lastAcceptedAt === null) return true;
  return now - lastAcceptedAt >= windowMs;
}
