import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MeetingReminderEngine,
  pickReminderEvent,
  reminderKey,
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

describe('pickReminderEvent: window boundaries', () => {
  const noSuppress = () => 0;

  it('fires when the call starts within the lead window', () => {
    const now = T0 - 45_000; // 45s before start, lead 60s
    const e = ev({ startMs: T0 });
    expect(pickReminderEvent([e], now, { leadMs: DEFAULT_LEAD_MS, isRecording: false, suppressedUntil: noSuppress }))
      .toBe(e);
  });

  it('does NOT fire when the call is further out than the lead', () => {
    const now = T0 - 90_000; // 90s before start, lead 60s
    const e = ev({ startMs: T0 });
    expect(pickReminderEvent([e], now, { leadMs: DEFAULT_LEAD_MS, isRecording: false, suppressedUntil: noSuppress }))
      .toBeNull();
  });

  it('still fires just after start (within the past grace)', () => {
    const now = T0 + 20_000; // started 20s ago, grace 30s
    const e = ev({ startMs: T0 });
    expect(pickReminderEvent([e], now, { leadMs: DEFAULT_LEAD_MS, isRecording: false, suppressedUntil: noSuppress }))
      .toBe(e);
  });

  it('ignores an in-progress call that started before the grace window', () => {
    const now = T0 + PAST_GRACE_MS + 5_000; // 35s in
    const e = ev({ startMs: T0 });
    expect(pickReminderEvent([e], now, { leadMs: DEFAULT_LEAD_MS, isRecording: false, suppressedUntil: noSuppress }))
      .toBeNull();
  });

  it('ignores all-day events', () => {
    const now = T0 - 10_000;
    const e = ev({ startMs: T0, allDay: true });
    expect(pickReminderEvent([e], now, { leadMs: DEFAULT_LEAD_MS, isRecording: false, suppressedUntil: noSuppress }))
      .toBeNull();
  });

  it('never fires while already recording', () => {
    const now = T0 - 30_000;
    const e = ev({ startMs: T0 });
    expect(pickReminderEvent([e], now, { leadMs: DEFAULT_LEAD_MS, isRecording: true, suppressedUntil: noSuppress }))
      .toBeNull();
  });

  it('picks the earliest-starting eligible event when several are in window', () => {
    const now = T0 - 30_000;
    const soon = ev({ uid: 'a', startMs: T0 });
    const sooner = ev({ uid: 'b', startMs: T0 - 5_000 });
    const picked = pickReminderEvent([soon, sooner], now, {
      leadMs: DEFAULT_LEAD_MS, isRecording: false, suppressedUntil: noSuppress,
    });
    expect(picked?.uid).toBe('b');
  });

  it('respects a configured lead time', () => {
    const now = T0 - 4 * 60_000; // 4 min before
    const e = ev({ startMs: T0 });
    // 1-min lead: too far out.
    expect(pickReminderEvent([e], now, { leadMs: 60_000, isRecording: false, suppressedUntil: noSuppress }))
      .toBeNull();
    // 5-min lead: fires.
    expect(pickReminderEvent([e], now, { leadMs: 5 * 60_000, isRecording: false, suppressedUntil: noSuppress }))
      .toBe(e);
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

    // Before the window: quiet.
    vi.setSystemTime(T0 - 90_000);
    expect(engine.tick([e], Date.now(), false)).toBeNull();

    // Enter the window: fires.
    vi.setSystemTime(T0 - 45_000);
    expect(engine.tick([e], Date.now(), false)).toBe(e);

    // Subsequent ticks inside the window do NOT re-fire.
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
    expect(engine.tick([e], Date.now(), false)).toBe(e); // first fire

    engine.snooze(e, Date.now());
    // Immediately after snooze: still suppressed.
    expect(engine.tick([e], Date.now(), false)).toBeNull();

    // After the snooze window: re-arms and fires again.
    vi.setSystemTime(Date.now() + SNOOZE_MS + 1_000);
    expect(engine.tick([e], Date.now(), false)).toBe(e);

    // A second snooze is permanent: it must never fire again.
    engine.snooze(e, Date.now());
    vi.setSystemTime(Date.now() + SNOOZE_MS + 1_000);
    expect(engine.tick([e], Date.now(), false)).toBeNull();
  });

  it('dismiss suppresses the call permanently', () => {
    const engine = new MeetingReminderEngine({ leadMs: 5 * 60_000 });
    const e = ev({ startMs: T0 });
    vi.setSystemTime(T0 - 2 * 60_000);
    expect(engine.tick([e], Date.now(), false)).toBe(e);
    engine.dismiss(e);
    vi.setSystemTime(T0 - 30_000);
    expect(engine.tick([e], Date.now(), false)).toBeNull();
  });

  it('back-to-back calls both fire (dismissing the first does not gag the second)', () => {
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const first = ev({ uid: 'first', startMs: T0 });
    const second = ev({ uid: 'second', startMs: T0 + 30 * 60_000 });
    const events = [first, second];

    // First window.
    vi.setSystemTime(T0 - 45_000);
    expect(engine.tick(events, Date.now(), false)).toBe(first);
    engine.dismiss(first);
    // Still inside the first window, nothing new.
    vi.advanceTimersByTime(15_000);
    expect(engine.tick(events, Date.now(), false)).toBeNull();

    // Second window arrives later: it fires on its own merit.
    vi.setSystemTime(second.startMs - 45_000);
    expect(engine.tick(events, Date.now(), false)).toBe(second);
  });

  it('does not fire when a recording is already in progress at window time', () => {
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const e = ev({ startMs: T0 });
    vi.setSystemTime(T0 - 45_000);
    expect(engine.tick([e], Date.now(), true)).toBeNull();
    // Once recording stops, the same window still prompts.
    expect(engine.tick([e], Date.now(), false)).toBe(e);
  });
});

describe('MeetingReminderEngine: serialize / hydrate (reload survival)', () => {
  it('a hydrated fired key does not re-fire after a simulated reload', () => {
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const e = ev({ startMs: T0 });
    expect(engine.tick([e], T0 - 30_000, false)).toBe(e);
    const snapshot = engine.serialize();

    const reloaded = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    reloaded.hydrate(snapshot);
    expect(reloaded.tick([e], T0 - 20_000, false)).toBeNull();
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
    // Peeking any number of times must never suppress the event.
    expect(engine.peek([e], now, false)).toBe(e);
    expect(engine.peek([e], now, false)).toBe(e);
    // A subsequent tick still fires, proving peek left state untouched.
    expect(engine.tick([e], now, false)).toBe(e);
  });

  it('a peeked-then-abandoned event (recording started mid-gap) can still fire later', () => {
    // Models the hook: peek picks an event, but during the async match a recording begins, so the
    // hook bails WITHOUT markFired. The occurrence must remain eligible once recording stops.
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const e = ev({ startMs: T0 });
    const now = T0 - 30_000;
    expect(engine.peek([e], now, false)).toBe(e); // hook peeks
    // ... recording starts during the match; hook does NOT markFired ...
    expect(engine.peek([e], now, true)).toBeNull(); // suppressed only while recording
    expect(engine.peek([e], now, false)).toBe(e); // recording stopped: still eligible, never lost
  });

  it('a second back-to-back call still surfaces while the first prompt is open', () => {
    // The first event is peeked and markFired (its dialog is open, not yet dismissed). The engine
    // must still surface the second event when its own window arrives, rather than swallowing it.
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const first = ev({ uid: 'first', startMs: T0 });
    const second = ev({ uid: 'second', startMs: T0 + 60_000 });
    const events = [first, second];

    const firstPick = engine.peek(events, T0 - 45_000, false);
    expect(firstPick).toBe(first);
    engine.markFired(first); // dialog shown, occurrence committed

    // First dialog is still open (never dismissed). The second enters its own window: peek must
    // return it even though the first is fired-but-unattended, so it can be queued and shown.
    expect(engine.peek(events, second.startMs - 45_000, false)).toBe(second);
  });
});

describe('MeetingReminderEngine: queued-while-open reminders survive reload', () => {
  // Models the hook's fix: when a second event enters its window while the first dialog is still
  // open, the hook QUEUES it without markFired (queueRef is in-memory only). markFired+persist is
  // deferred until it is actually dequeued and shown, so a reload/crash while it waits does not
  // permanently swallow the second meeting's reminder.

  it('a queued (not-yet-shown) event is NOT marked fired until dequeue/show', () => {
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const first = ev({ uid: 'first', startMs: T0 });
    const second = ev({ uid: 'second', startMs: T0 + 60_000 });
    const events = [first, second];

    // First fires and its dialog opens: committed.
    expect(engine.peek(events, T0 - 45_000, false)).toBe(first);
    engine.markFired(first);

    // Second enters its window while the first dialog is still open. The hook queues it WITHOUT
    // marking it fired, so the engine must still consider it eligible on repeated peeks.
    const atSecond = second.startMs - 45_000;
    expect(engine.peek(events, atSecond, false)).toBe(second);
    expect(engine.peek(events, atSecond, false)).toBe(second); // still not committed

    // Only on dequeue/show does the hook commit it.
    engine.markFired(second);
    expect(engine.peek(events, atSecond, false)).toBeNull();
  });

  it('a simulated reload while an item is queued still fires the second event', () => {
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const first = ev({ uid: 'first', startMs: T0 });
    const second = ev({ uid: 'second', startMs: T0 + 60_000 });
    const events = [first, second];

    // First shown + committed; second is queued (in-memory) but deliberately NOT marked fired.
    expect(engine.peek(events, T0 - 45_000, false)).toBe(first);
    engine.markFired(first);
    const atSecond = second.startMs - 45_000;
    expect(engine.peek(events, atSecond, false)).toBe(second); // queued, not committed

    // Reload/crash: only the persisted (fired) state survives; the in-memory queue is gone.
    const snapshot = engine.serialize();
    const reloaded = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    reloaded.hydrate(snapshot);

    // The first stays suppressed, but the second was never persisted as fired, so it still fires.
    expect(reloaded.peek(events, atSecond, false)).toBe(second);
  });

  it('a queued item that goes stale before dequeue is dropped without being marked fired', () => {
    // The hook re-validates on dequeue and skips a stale item without markFired. Model both: peek
    // returns null once past grace (so the hook skips it), and it was never suppressed.
    const engine = new MeetingReminderEngine({ leadMs: DEFAULT_LEAD_MS });
    const second = ev({ uid: 'second', startMs: T0 });

    // Enqueued while eligible (not marked fired).
    expect(engine.peek([second], T0 - 45_000, false)).toBe(second);

    // By the time the first dialog closes, the second has slipped past its grace window.
    const pastGrace = T0 + PAST_GRACE_MS + 5_000;
    expect(engine.peek([second], pastGrace, false)).toBeNull(); // hook drops it, no markFired

    // It was never suppressed: serialize carries no fired entry for it.
    expect(engine.serialize().suppressed).toHaveLength(0);
  });
});

describe('pickReminderEvent: past-grace boundary is inclusive', () => {
  const noSuppress = () => 0;
  it('still fires exactly PAST_GRACE_MS after start', () => {
    const e = ev({ startMs: T0 });
    const now = T0 + PAST_GRACE_MS; // delta == -grace exactly
    expect(
      pickReminderEvent([e], now, { leadMs: DEFAULT_LEAD_MS, isRecording: false, suppressedUntil: noSuppress }),
    ).toBe(e);
  });
});
