import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MeetingReminderEngine,
  pickReminderEvent,
  reminderKey,
  reminderModeFor,
  canSurfaceReminder,
  DEFAULT_LEAD_MS,
  SNOOZE_MS,
  PAST_GRACE_MS,
} from './meetingReminder';
import type { CalendarEvent } from '@/lib/ics';

const T0 = Date.parse('2026-07-14T09:00:00Z');

function ev(partial: Partial<CalendarEvent>): CalendarEvent {
  return {
    uid: 'u1',
    summary: 'Client call',
    startMs: T0,
    endMs: T0 + 30 * 60_000,
    allDay: false,
    attendees: [],
    attendeeEmails: [],
    ...partial,
  };
}

describe('pickReminderEvent: window boundaries (recording-agnostic)', () => {
  const noSuppress = () => 0;

  it('fires when the call starts within the lead window', () => {
    const now = T0 - 45_000; // 45s before start, lead 60s
    const e = ev({ startMs: T0 });
    expect(pickReminderEvent([e], now, { leadMs: DEFAULT_LEAD_MS, suppressedUntil: noSuppress })).toBe(e);
  });

  it('does NOT fire when the call is further out than the lead', () => {
    const now = T0 - 90_000; // 90s before start, lead 60s
    const e = ev({ startMs: T0 });
    expect(pickReminderEvent([e], now, { leadMs: DEFAULT_LEAD_MS, suppressedUntil: noSuppress })).toBeNull();
  });

  it('still fires just after start (within the past grace)', () => {
    const now = T0 + 20_000; // started 20s ago, grace 30s
    const e = ev({ startMs: T0 });
    expect(pickReminderEvent([e], now, { leadMs: DEFAULT_LEAD_MS, suppressedUntil: noSuppress })).toBe(e);
  });

  it('ignores an in-progress call that started before the grace window', () => {
    const now = T0 + PAST_GRACE_MS + 5_000; // 35s in
    const e = ev({ startMs: T0 });
    expect(pickReminderEvent([e], now, { leadMs: DEFAULT_LEAD_MS, suppressedUntil: noSuppress })).toBeNull();
  });

  it('ignores all-day events', () => {
    const now = T0 - 10_000;
    const e = ev({ startMs: T0, allDay: true });
    expect(pickReminderEvent([e], now, { leadMs: DEFAULT_LEAD_MS, suppressedUntil: noSuppress })).toBeNull();
  });

  it('picks the earliest-starting eligible event when several are in window', () => {
    const now = T0 - 30_000;
    const soon = ev({ uid: 'a', startMs: T0 });
    const sooner = ev({ uid: 'b', startMs: T0 - 5_000 });
    const picked = pickReminderEvent([soon, sooner], now, { leadMs: DEFAULT_LEAD_MS, suppressedUntil: noSuppress });
    expect(picked?.uid).toBe('b');
  });

  it('respects a configured lead time', () => {
    const now = T0 - 4 * 60_000; // 4 min before
    const e = ev({ startMs: T0 });
    expect(pickReminderEvent([e], now, { leadMs: 60_000, suppressedUntil: noSuppress })).toBeNull();
    expect(pickReminderEvent([e], now, { leadMs: 5 * 60_000, suppressedUntil: noSuppress })).toBe(e);
  });

  // Regression: the hook now peeks over the FULL yesterday..+7d window instead of a per-poll
  // "today" snapshot, so an event on the NEW local day is eligible the instant its lead window
  // opens (no dependence on a poll re-snapshotting after local midnight). Feeding the whole window
  // must still pick exactly the imminent event and ignore both the stale past day and future days.
  it('picks a just-past-midnight event from the full multi-day window, ignoring past/future days', () => {
    const midnight = Date.parse('2026-07-15T00:00:00Z');
    const now = midnight + 4 * 60_000; // 00:04 the new day; lead 60s
    const firstOfNewDay = ev({ uid: 'new-day', startMs: midnight + 5 * 60_000 }); // 00:05, imminent
    const yesterday = ev({ uid: 'yesterday', startMs: midnight - 2 * 60 * 60_000 }); // long past
    const laterToday = ev({ uid: 'later', startMs: midnight + 6 * 60 * 60_000 }); // hours out
    const window = [yesterday, firstOfNewDay, laterToday];
    const picked = pickReminderEvent(window, now, { leadMs: DEFAULT_LEAD_MS, suppressedUntil: noSuppress });
    expect(picked?.uid).toBe('new-day');
  });
});

describe('reminderModeFor: presentation mode selection (I5b)', () => {
  it('idle -> dialog, recording -> handover', () => {
    expect(reminderModeFor(false)).toBe('dialog');
    expect(reminderModeFor(true)).toBe('handover');
  });
});

describe('MeetingReminderEngine: mode selection, not suppression (I5b)', () => {
  it('surfaces a DIALOG when not recording', () => {
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const e = ev({ startMs: T0 });
    const pick = engine.peek([e], T0 - 30_000, false);
    expect(pick?.event).toBe(e);
    expect(pick?.mode).toBe('dialog');
  });

  it('surfaces a HANDOVER (NOT suppressed) when already recording', () => {
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const e = ev({ startMs: T0 });
    const pick = engine.peek([e], T0 - 30_000, true);
    expect(pick?.event).toBe(e);
    expect(pick?.mode).toBe('handover');
  });

  it('tick returns the pick with its mode and marks it fired in both modes', () => {
    // Handover mode still commits the occurrence, so ignoring the toast never re-fires it.
    const handoverEngine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const e1 = ev({ uid: 'rec', startMs: T0 });
    const firstHandover = handoverEngine.tick([e1], T0 - 30_000, true);
    expect(firstHandover?.mode).toBe('handover');
    expect(handoverEngine.tick([e1], T0 - 25_000, true)).toBeNull(); // no re-fire

    const dialogEngine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const e2 = ev({ uid: 'idle', startMs: T0 });
    const firstDialog = dialogEngine.tick([e2], T0 - 30_000, false);
    expect(firstDialog?.mode).toBe('dialog');
    expect(dialogEngine.tick([e2], T0 - 25_000, false)).toBeNull(); // no re-fire
  });

  it('a queued idle item surfaces as a handover if a recording began before it is shown', () => {
    // Models the hook: peek an event while idle (would be a dialog), but by the time it is actually
    // surfaced a recording is running, so re-peeking yields the SAME event in handover mode.
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const e = ev({ startMs: T0 });
    const now = T0 - 30_000;
    expect(engine.peek([e], now, false)?.mode).toBe('dialog'); // queued while idle, not committed
    const atShow = engine.peek([e], now, true); // recording began before it is shown
    expect(atShow?.event).toBe(e);
    expect(atShow?.mode).toBe('handover');
  });
});

describe('MeetingReminderEngine: with fake timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires exactly once as the lead window is crossed, then stays quiet', () => {
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const e = ev({ startMs: T0 });

    vi.setSystemTime(T0 - 90_000);
    expect(engine.tick([e], Date.now(), false)).toBeNull();

    vi.setSystemTime(T0 - 45_000);
    expect(engine.tick([e], Date.now(), false)?.event).toBe(e);

    vi.advanceTimersByTime(15_000);
    expect(engine.tick([e], Date.now(), false)).toBeNull();
    vi.advanceTimersByTime(15_000);
    expect(engine.tick([e], Date.now(), false)).toBeNull();
  });

  it('de-dupes by occurrence key across many ticks', () => {
    const engine = new MeetingReminderEngine();
    const e = ev({ startMs: T0 });
    vi.setSystemTime(T0 - 30_000);
    let fires = 0;
    for (let i = 0; i < 5; i++) {
      if (engine.tick([e], Date.now(), false)) fires++;
      vi.advanceTimersByTime(5_000);
    }
    expect(fires).toBe(1);
  });

  it('snooze re-arms the SAME call exactly once, then suppresses it for good', () => {
    const engine = new MeetingReminderEngine({ leadMs: 5 * 60_000, snoozeMs: SNOOZE_MS });
    const e = ev({ startMs: T0 });

    vi.setSystemTime(T0 - 3 * 60_000);
    expect(engine.tick([e], Date.now(), false)?.event).toBe(e); // first fire

    engine.snooze(e, Date.now());
    expect(engine.tick([e], Date.now(), false)).toBeNull();

    vi.setSystemTime(Date.now() + SNOOZE_MS + 1_000);
    expect(engine.tick([e], Date.now(), false)?.event).toBe(e);

    engine.snooze(e, Date.now());
    vi.setSystemTime(Date.now() + SNOOZE_MS + 1_000);
    expect(engine.tick([e], Date.now(), false)).toBeNull();
  });

  it('dismiss suppresses the call permanently', () => {
    const engine = new MeetingReminderEngine({ leadMs: 5 * 60_000 });
    const e = ev({ startMs: T0 });
    vi.setSystemTime(T0 - 2 * 60_000);
    expect(engine.tick([e], Date.now(), false)?.event).toBe(e);
    engine.dismiss(e);
    vi.setSystemTime(T0 - 30_000);
    expect(engine.tick([e], Date.now(), false)).toBeNull();
  });

  it('back-to-back calls both fire (dismissing the first does not gag the second)', () => {
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const first = ev({ uid: 'first', startMs: T0 });
    const second = ev({ uid: 'second', startMs: T0 + 30 * 60_000 });
    const events = [first, second];

    vi.setSystemTime(T0 - 45_000);
    expect(engine.tick(events, Date.now(), false)?.event).toBe(first);
    engine.dismiss(first);
    vi.advanceTimersByTime(15_000);
    expect(engine.tick(events, Date.now(), false)).toBeNull();

    vi.setSystemTime(second.startMs - 45_000);
    expect(engine.tick(events, Date.now(), false)?.event).toBe(second);
  });

  it('handover expiry: a fired handover occurrence does not re-fire even after its window passes', () => {
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const e = ev({ startMs: T0 });
    vi.setSystemTime(T0 - 45_000);
    expect(engine.tick([e], Date.now(), true)?.mode).toBe('handover'); // fired as handover
    // The toast lingers; when its window elapses the occurrence is simply gone, never re-offered.
    vi.setSystemTime(T0 + PAST_GRACE_MS + 5_000);
    expect(engine.peek([e], Date.now(), true)).toBeNull();
    expect(engine.peek([e], Date.now(), false)).toBeNull();
  });
});

describe('MeetingReminderEngine: serialize / hydrate (reload survival)', () => {
  it('a hydrated fired key does not re-fire after a simulated reload', () => {
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const e = ev({ startMs: T0 });
    expect(engine.tick([e], T0 - 30_000, false)?.event).toBe(e);
    const snapshot = engine.serialize();

    const reloaded = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    reloaded.hydrate(snapshot);
    expect(reloaded.tick([e], T0 - 20_000, false)).toBeNull();
  });

  it('persist-at-show holds for a handover too: a fired handover key survives reload', () => {
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const e = ev({ startMs: T0 });
    expect(engine.tick([e], T0 - 30_000, true)?.mode).toBe('handover');
    const snapshot = engine.serialize();

    const reloaded = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    reloaded.hydrate(snapshot);
    expect(reloaded.peek([e], T0 - 20_000, true)).toBeNull();
    expect(reloaded.peek([e], T0 - 20_000, false)).toBeNull();
  });

  it('reminderKey separates two occurrences of the same recurring uid', () => {
    const a = ev({ uid: 'weekly', startMs: T0 });
    const b = ev({ uid: 'weekly', startMs: T0 + 7 * 24 * 60 * 60_000 });
    expect(reminderKey(a)).not.toBe(reminderKey(b));
  });
});

describe('MeetingReminderEngine: peek does not commit (async-gap safety)', () => {
  it('peek is pure: repeated peeks return the same event without marking it fired', () => {
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const e = ev({ startMs: T0 });
    const now = T0 - 30_000;
    expect(engine.peek([e], now, false)?.event).toBe(e);
    expect(engine.peek([e], now, false)?.event).toBe(e);
    expect(engine.tick([e], now, false)?.event).toBe(e);
  });

  it('a peeked-then-abandoned event (out of window mid-gap) can still fire once eligible again', () => {
    // With recording no longer suppressing, the only way peek yields null is ineligibility. Model an
    // event that briefly slips out of window then comes back: it must never be lost, since it was
    // never marked fired.
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const e = ev({ startMs: T0 });
    expect(engine.peek([e], T0 - 30_000, false)?.event).toBe(e); // hook peeks
    // ... suppose the hook bails without markFired (e.g. a transient re-validation miss) ...
    expect(engine.peek([e], T0 - 30_000, false)?.event).toBe(e); // still eligible, never lost
  });

  it('a second back-to-back call still surfaces while the first prompt is open', () => {
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const first = ev({ uid: 'first', startMs: T0 });
    const second = ev({ uid: 'second', startMs: T0 + 60_000 });
    const events = [first, second];

    expect(engine.peek(events, T0 - 45_000, false)?.event).toBe(first);
    engine.markFired(first);

    expect(engine.peek(events, second.startMs - 45_000, false)?.event).toBe(second);
  });
});

describe('MeetingReminderEngine: queued-while-open reminders survive reload', () => {
  it('a queued (not-yet-shown) event is NOT marked fired until dequeue/show', () => {
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const first = ev({ uid: 'first', startMs: T0 });
    const second = ev({ uid: 'second', startMs: T0 + 60_000 });
    const events = [first, second];

    expect(engine.peek(events, T0 - 45_000, false)?.event).toBe(first);
    engine.markFired(first);

    const atSecond = second.startMs - 45_000;
    expect(engine.peek(events, atSecond, false)?.event).toBe(second);
    expect(engine.peek(events, atSecond, false)?.event).toBe(second); // still not committed

    engine.markFired(second);
    expect(engine.peek(events, atSecond, false)).toBeNull();
  });

  it('a simulated reload while an item is queued still fires the second event', () => {
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const first = ev({ uid: 'first', startMs: T0 });
    const second = ev({ uid: 'second', startMs: T0 + 60_000 });
    const events = [first, second];

    expect(engine.peek(events, T0 - 45_000, false)?.event).toBe(first);
    engine.markFired(first);
    const atSecond = second.startMs - 45_000;
    expect(engine.peek(events, atSecond, false)?.event).toBe(second); // queued, not committed

    const snapshot = engine.serialize();
    const reloaded = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    reloaded.hydrate(snapshot);

    expect(reloaded.peek(events, atSecond, false)?.event).toBe(second);
  });

  it('a queued item that goes stale before dequeue is dropped without being marked fired', () => {
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const second = ev({ uid: 'second', startMs: T0 });

    expect(engine.peek([second], T0 - 45_000, false)?.event).toBe(second);

    const pastGrace = T0 + PAST_GRACE_MS + 5_000;
    expect(engine.peek([second], pastGrace, false)).toBeNull(); // hook drops it, no markFired

    expect(engine.serialize().suppressed).toHaveLength(0);
  });
});

describe('canSurfaceReminder: third-event suppression during a handover transition (I5b)', () => {
  it('blocks all surfacing while a handover transition is active', () => {
    expect(canSurfaceReminder(true)).toBe(false);
    expect(canSurfaceReminder(false)).toBe(true);
  });

  it('a THIRD imminent event does NOT surface (as a focus-stealing dialog) mid-handover, but does once the transition ends', () => {
    // Model the hook's tick: during a handover the current call is being stopped and the next seeded,
    // so the global isRecording flips transiently false. A naive tick in that gap would peek the third
    // event and, seeing idle, surface it as a DIALOG — forbidden during a live call. The guard
    // (canSurfaceReminder) must block it while the transition is active; the occurrence is NEVER marked
    // fired, so once the next recording is active it re-evaluates and surfaces as a calm handover.
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const third = ev({ uid: 'third', startMs: T0 });
    const now = T0 - 30_000;

    // Mid-transition: isRecording transiently false. Peek WOULD yield a dialog pick...
    const midPick = engine.peek([third], now, /* isRecording */ false);
    expect(midPick?.event).toBe(third);
    expect(midPick?.mode).toBe('dialog');
    // ...but the transition guard suppresses surfacing entirely, and nothing is committed.
    const handoverTransitionActive = true;
    expect(canSurfaceReminder(handoverTransitionActive)).toBe(false);
    expect(engine.serialize().suppressed).toHaveLength(0); // never marked fired

    // Transition ends and the next recording is active: the SAME occurrence is still eligible and now
    // surfaces as a calm handover, not a dialog.
    expect(canSurfaceReminder(false)).toBe(true);
    const afterPick = engine.peek([third], now, /* isRecording */ true);
    expect(afterPick?.event).toBe(third);
    expect(afterPick?.mode).toBe('handover');
  });
});

describe('pickReminderEvent: past-grace boundary is inclusive', () => {
  const noSuppress = () => 0;
  it('still fires exactly PAST_GRACE_MS after start', () => {
    const e = ev({ startMs: T0 });
    const now = T0 + PAST_GRACE_MS; // delta == -grace exactly
    expect(pickReminderEvent([e], now, { leadMs: DEFAULT_LEAD_MS, suppressedUntil: noSuppress })).toBe(e);
  });
});
