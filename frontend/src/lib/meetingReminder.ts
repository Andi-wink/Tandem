/**
 * meetingReminder: the pure "should we prompt about this call now, and how?" logic (I5 / I5b).
 *
 * No React, no Tauri, no DOM: vitest-friendly. The React hook (useMeetingReminder) owns the ticker,
 * the async project match, and the OS side effects; everything about WHICH event to surface, WHEN to
 * stop surfacing it, and in WHICH mode lives here so it can be tested with fake timers.
 *
 * Presentation mode (I5b): being mid-recording no longer SUPPRESSES a reminder, it SELECTS how it is
 * shown. Not recording -> 'dialog' (the focus-grabbing pre-meeting prompt). Already recording ->
 * 'handover' (a calm, non-modal notification offering to wrap up the current call and start the next
 * one). The eligibility rules (window, all-day, dedupe) are identical for both modes.
 *
 * Firing window: an event is eligible when its start is within `leadMs` ahead of now, and has not
 * already slipped more than `pastGraceMs` into the past (so opening the app a few seconds late still
 * prompts, but a call that started five minutes ago does not). All-day events never fire. Each
 * occurrence fires at most once per session unless snoozed, which re-arms it exactly once.
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

/**
 * How a reminder should be presented. 'dialog' is the focus-grabbing pre-meeting prompt shown when
 * idle; 'handover' is the calm, non-modal "wrap up and start next" notification shown while a
 * recording is already running (I5b).
 */
export type ReminderMode = 'dialog' | 'handover';

/** An eligible occurrence plus the mode it should surface in right now. */
export interface ReminderPick {
  event: CalendarEvent;
  mode: ReminderMode;
}

/** Stable per-occurrence key: uid + start distinguishes two instances of a recurring call. */
export function reminderKey(ev: CalendarEvent): string {
  return `${ev.uid}::${ev.startMs}`;
}

/** Derive the presentation mode purely from whether a recording is currently active. */
export function reminderModeFor(isRecording: boolean): ReminderMode {
  return isRecording ? 'handover' : 'dialog';
}

/**
 * Whether a tick / queue-drain may surface a reminder right now (I5b). During a handover TRANSITION
 * (the current call is being stopped and the next seeded), the global isRecording flips transiently
 * false. A naive tick landing in that gap would see idle and pop a focus-stealing DIALOG for a THIRD
 * imminent event, mid live-call, and would also compete with the handover itself. So while a handover
 * transition is active, suppress ALL surfacing. The occurrence is never marked fired, so it simply
 * re-evaluates on the next natural tick, correctly surfacing as a calm handover once the next
 * recording is active. Pure so the hook's guard is unit-testable.
 */
export function canSurfaceReminder(handoverTransitionActive: boolean): boolean {
  return !handoverTransitionActive;
}

export interface PickOptions {
  leadMs: number;
  /** Epoch ms until which a key stays suppressed (0 = not suppressed). */
  suppressedUntil: (key: string) => number;
  pastGraceMs?: number;
}

/**
 * Pure: the single event that should prompt a reminder right now, or null. When several are eligible
 * the earliest-starting one wins (you handle the imminent call first). Recording state does NOT enter
 * eligibility (I5b): it only decides the mode, which the caller derives. Never fires for an all-day
 * event, nor for a suppressed (already-fired / snoozed) key.
 */
export function pickReminderEvent(
  events: CalendarEvent[],
  nowMs: number,
  opts: PickOptions,
): CalendarEvent | null {
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
 * React so its dedupe, snooze re-arm, mode selection and back-to-back behavior are unit-testable
 * with fake timers.
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
   * Pick the occurrence to prompt for now WITHOUT mutating state, tagged with its presentation mode.
   * Returns null when nothing is eligible. The caller commits with markFired only once it is actually
   * going to surface the prompt, so an async gap (project match) cannot permanently swallow a reminder
   * the user never saw, and a recording that starts mid-tick simply flips 'dialog' to 'handover'.
   */
  peek(events: CalendarEvent[], nowMs: number, isRecording: boolean): ReminderPick | null {
    const ev = pickReminderEvent(events, nowMs, {
      leadMs: this.leadMs,
      pastGraceMs: this.pastGraceMs,
      suppressedUntil: (k) => this.suppressed.get(k) ?? 0,
    });
    if (!ev) return null;
    return { event: ev, mode: reminderModeFor(isRecording) };
  }

  /** Mark an occurrence fired so it will not fire again (until a snooze re-arms it). */
  markFired(ev: CalendarEvent): void {
    this.suppressed.set(reminderKey(ev), PERMANENT);
  }

  /**
   * Pick the occurrence to prompt for now, marking it fired so it will not fire again (until a snooze
   * re-arms it). Returns null when nothing is eligible. Convenience wrapper over peek + markFired for
   * callers (and tests) that commit atomically.
   */
  tick(events: CalendarEvent[], nowMs: number, isRecording: boolean): ReminderPick | null {
    const pick = this.peek(events, nowMs, isRecording);
    if (pick) this.markFired(pick.event);
    return pick;
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
