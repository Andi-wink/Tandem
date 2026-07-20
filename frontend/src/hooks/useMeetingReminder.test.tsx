import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { CalendarEvent } from '@/lib/ics';
import { MeetingReminderEngine } from '@/lib/meetingReminder';

// This suite exercises the REAL useMeetingReminder hook end-to-end (not pickReminderEvent in
// isolation) to guard the local-midnight rollover fix at its source: the hook must feed the FULL
// yesterday..+7d `events` window into the engine, never the per-poll `todayEvents` snapshot. A
// lib-only test on pickReminderEvent cannot catch a regression back to `todayEvents` in the hook,
// because pickReminderEvent's window scoping never changed — the wiring in the hook did.

// Distinct array identities so we can prove which one the hook wired in. `events` (full window)
// carries the just-past-midnight event; `todayEvents` (the stale snapshot) does NOT — feeding the
// wrong one would drop the imminent call, which is exactly the bug.
const T0 = Date.parse('2026-07-15T00:05:00Z');
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
const FULL_WINDOW: CalendarEvent[] = [ev({ uid: 'new-day', startMs: T0 })];
const TODAY_SNAPSHOT: CalendarEvent[] = []; // stale snapshot missing the just-rolled-over event

const calendarState = { events: FULL_WINDOW, todayEvents: TODAY_SNAPSHOT, configured: true };

vi.mock('@/contexts/CalendarContext', () => ({
  useCalendar: () => calendarState,
}));
vi.mock('@/contexts/RecordingStateContext', () => ({
  useRecordingState: () => ({ isRecording: false }),
}));
vi.mock('@/contexts/RecordingPostProcessingProvider', () => ({
  useRecordingStopControls: () => ({ stopActiveRecording: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn() }),
}));

// Imported AFTER the vi.mock calls above (which vitest hoists), so the hook binds the mocked
// contexts and router.
import { useMeetingReminder } from './useMeetingReminder';

describe('useMeetingReminder: wires the full events window (not todayEvents) into the engine', () => {
  let peekSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Freeze time inside the reminder window so a returned pick (if any) is well-defined, and make
    // peek a no-op that returns null so runTick bails right after the peek call — we only care about
    // the argument the hook hands the engine, not the downstream match/toast side effects.
    vi.useFakeTimers();
    vi.setSystemTime(T0 - 30_000);
    peekSpy = vi.spyOn(MeetingReminderEngine.prototype, 'peek').mockReturnValue(null);
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    peekSpy.mockRestore();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('feeds the full yesterday..+7d events array into engine.peek, never the todayEvents snapshot', () => {
    const { unmount } = renderHook(() => useMeetingReminder());

    // The mount effect runs runTick synchronously up to the peek call.
    expect(peekSpy).toHaveBeenCalled();
    const firstArg = peekSpy.mock.calls[0][0];
    // The exact array reference the hook destructured from useCalendar().events.
    expect(firstArg).toBe(FULL_WINDOW);
    // And categorically NOT the stale per-poll snapshot — a regression to `todayEvents` fails here.
    expect(firstArg).not.toBe(TODAY_SNAPSHOT);
    // Every top-level tick peek uses the full window (the [ev] re-validation peeks pass a single
    // event, but those only happen after a non-null pick, which cannot occur here).
    for (const call of peekSpy.mock.calls) {
      expect(call[0]).toBe(FULL_WINDOW);
    }

    unmount();
  });
});
