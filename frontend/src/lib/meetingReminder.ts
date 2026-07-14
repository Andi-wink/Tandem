/**
 * meetingReminder: the pure "should we prompt to record this call now?" logic (I5).
 *
 * No React, no Tauri, no DOM: vitest-friendly. The React hook (useMeetingReminder) owns the
 * ticker, the async project match, and the OS focus/notification side effects; everything about
 * WHICH event to surface and WHEN to stop surfacing it lives here so it can be tested with fake
 * timers.
 *
 * Firing window: an event fires when its start is within `leadMs` ahead of now, and has not
 * already slipped more than `pastGraceMs` into the past (so opening the app a few seconds late
 * still prompts, but a call that started five minutes ago does not). All-day events never fire.
 * Each occurrence fires at most once per session unless snoozed, which re-arms it exactly once.
 */

import type { CalendarEvent } from '@/lib/ics';

/** One minute before the call by default. */
export const DEFAULT_LEAD_MS = 60_000;
/** Still prompt up to 30s after a call has started (you opened Tandem a touch late). */
export const PAST_GRACE_MS = 30_000;
/** Snooze re-arms the same call after one minute. */
export const SNOOZE_MS = 60_000;
/** Auto-dismiss an unattended prompt two minutes after the call's start. */
export const AUTO_DISMISS_AFTER_START_MS = 120_000;

const PERMANENT = Number.POSITIVE_INFINITY;

/** Stable per-occurrence key: uid + start distinguishes two instances of a recurring call. */
export function reminderKey(ev: CalendarEvent): string {
  return `${ev.uid}::${ev.startMs}`;
}

export interface PickOptions {
  leadMs: number;
  isRecording: boolean;
  /** Epoch ms until which a key stays suppressed (0 = not suppressed). */
  suppressedUntil: (key: string) => number;
  pastGraceMs?: number;
}

/**
 * Pure: the single event that should prompt a reminder right now, or null. When several are
 * eligible the earliest-starting one wins (you handle the imminent call first). Never fires while
 * recording, never for all-day events, never for a suppressed (already-fired / snoozed) key.
 */
export function pickReminderEvent(
  events: CalendarEvent[],
  nowMs: number,
  opts: PickOptions,
): CalendarEvent | null {
  if (opts.isRecording) return null;
  const grace = opts.pastGraceMs ?? PAST_GRACE_MS;
  let best: CalendarEvent | null = null;
  for (const ev of events) {
    if (ev.allDay) continue;
    const delta = ev.startMs - nowMs;
    if (delta > opts.leadMs) continue; // too far out
    if (delta < -grace) continue; // already started more than the grace window ago
    const until = opts.suppressedUntil(reminderKey(ev));
    if (until && nowMs < until) continue; // fired or snoozed
    if (!best || ev.startMs < best.startMs) best = ev;
  }
  return best;
}

/** Serializable engine state, mirrored into sessionStorage so a reload does not re-fire. */
export interface ReminderEngineState {
  /** key -> epoch ms suppressed until, or 'inf' for a permanent (fired / dismissed) suppression. */
  suppressed: Array<[string, number | 'inf']>;
  /** keys that have already used their single snooze re-arm. */
  snoozedOnce: string[];
}

/**
 * Stateful, framework-agnostic driver around pickReminderEvent. The hook calls `tick` every 15s;
 * `snooze` / `dismiss` record how an occurrence should be suppressed going forward. Kept out of
 * React so its dedupe, snooze re-arm, and back-to-back behavior are unit-testable with fake timers.
 */
export class MeetingReminderEngine {
  private suppressed = new Map<string, number>();
  private snoozedOnce = new Set<string>();
  private leadMs: number;
  private snoozeMs: number;
  private pastGraceMs: number;

  constructor(cfg?: { leadMs?: number; snoozeMs?: number; pastGraceMs?: number }) {
    this.leadMs = cfg?.leadMs ?? DEFAULT_LEAD_MS;
    this.snoozeMs = cfg?.snoozeMs ?? SNOOZE_MS;
    this.pastGraceMs = cfg?.pastGraceMs ?? PAST_GRACE_MS;
  }

  setLeadMs(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.leadMs = ms;
  }

  getLeadMs(): number {
    return this.leadMs;
  }

  /**
   * Pick the event to prompt for now WITHOUT mutating state. Returns null when nothing is eligible.
   * The caller commits with markFired only once it is actually going to surface the prompt, so an
   * async gap (project match) or a recording that starts mid-tick cannot permanently swallow a
   * reminder the user never saw.
   */
  peek(events: CalendarEvent[], nowMs: number, isRecording: boolean): CalendarEvent | null {
    return pickReminderEvent(events, nowMs, {
      leadMs: this.leadMs,
      isRecording,
      pastGraceMs: this.pastGraceMs,
      suppressedUntil: (k) => this.suppressed.get(k) ?? 0,
    });
  }

  /** Mark an occurrence fired so it will not fire again (until a snooze re-arms it). */
  markFired(ev: CalendarEvent): void {
    this.suppressed.set(reminderKey(ev), PERMANENT);
  }

  /**
   * Pick the event to prompt for now, marking it fired so it will not fire again (until a snooze
   * re-arms it). Returns null when nothing is eligible. Convenience wrapper over peek + markFired
   * for callers (and tests) that commit atomically.
   */
  tick(events: CalendarEvent[], nowMs: number, isRecording: boolean): CalendarEvent | null {
    const ev = this.peek(events, nowMs, isRecording);
    if (ev) this.markFired(ev);
    return ev;
  }

  /** Snooze: re-arm this occurrence once after snoozeMs; a second snooze suppresses it for good. */
  snooze(ev: CalendarEvent, nowMs: number): void {
    const key = reminderKey(ev);
    if (this.snoozedOnce.has(key)) {
      this.suppressed.set(key, PERMANENT);
      return;
    }
    this.snoozedOnce.add(key);
    this.suppressed.set(key, nowMs + this.snoozeMs);
  }

  /** Dismiss permanently for this session. */
  dismiss(ev: CalendarEvent): void {
    this.suppressed.set(reminderKey(ev), PERMANENT);
  }

  serialize(): ReminderEngineState {
    return {
      suppressed: Array.from(this.suppressed.entries()).map(
        ([k, v]) => [k, Number.isFinite(v) ? v : 'inf'] as [string, number | 'inf'],
      ),
      snoozedOnce: Array.from(this.snoozedOnce),
    };
  }

  hydrate(state: ReminderEngineState | null | undefined): void {
    if (!state) return;
    if (Array.isArray(state.suppressed)) {
      for (const [k, v] of state.suppressed) {
        this.suppressed.set(k, v === 'inf' ? PERMANENT : Number(v));
      }
    }
    if (Array.isArray(state.snoozedOnce)) {
      for (const k of state.snoozedOnce) this.snoozedOnce.add(k);
    }
  }
}
