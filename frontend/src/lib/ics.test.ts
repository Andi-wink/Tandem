import { describe, it, expect } from 'vitest';
import {
  parseIcs,
  unfoldIcsLines,
  expandOccurrences,
  eventsForToday,
  type CalendarEvent,
} from './ics';

// ── Fixtures ────────────────────────────────────────────────────────────────

// (a) Outlook 365 "Publish calendar" export: Windows TZID, a folded DESCRIPTION line,
//     a Teams join URL, and an ATTENDEE with CN.
const OUTLOOK_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN
BEGIN:VTIMEZONE
TZID:W. Europe Standard Time
END:VTIMEZONE
BEGIN:VEVENT
UID:outlook-1
SUMMARY:Acme discovery call
DTSTART;TZID=W. Europe Standard Time:20260713T140000
DTEND;TZID=W. Europe Standard Time:20260713T143000
LOCATION:Microsoft Teams Meeting
DESCRIPTION:Join the meeting now\\n https://teams.microsoft.com/l/meetup-jo
 in/19%3ameeting_abc/0?context=xyz\\nThanks
ATTENDEE;CN=Jane Client:mailto:jane@acme.com
END:VEVENT
END:VCALENDAR`;

// (b) Proton "share via link" export: UTC "Z" times, an escaped comma, a Zoom link.
const PROTON_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Proton AG//Proton Calendar//EN
BEGIN:VEVENT
UID:proton-1
SUMMARY:Review call\\, part two
DTSTART:20260714T090000Z
DTEND:20260714T093000Z
DESCRIPTION:Dial in via Zoom https://us02web.zoom.us/j/8412345678?pwd=abcd
END:VEVENT
END:VCALENDAR`;

// (c) All-day event.
const ALLDAY_ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:allday-1
SUMMARY:Company holiday
DTSTART;VALUE=DATE:20260715
DTEND;VALUE=DATE:20260716
END:VEVENT
END:VCALENDAR`;

// (d) Weekly recurring (Mondays) with an EXDATE.
const WEEKLY_ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:weekly-1
SUMMARY:Weekly sync
DTSTART:20260713T100000Z
DTEND:20260713T103000Z
RRULE:FREQ=WEEKLY;BYDAY=MO
EXDATE:20260720T100000Z
END:VEVENT
END:VCALENDAR`;

// (d-DST) Weekly recurring Monday 14:00 in Europe/Berlin, spanning the CEST->CET
//         transition (clocks go back on 2026-10-25). Wall time must stay pinned at 14:00
//         every week: 14:00 CEST = 12:00Z before the switch, 14:00 CET = 13:00Z after.
const WEEKLY_DST_ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:weekly-dst
SUMMARY:Berlin weekly
DTSTART;TZID=Europe/Berlin:20261019T140000
DTEND;TZID=Europe/Berlin:20261019T143000
RRULE:FREQ=WEEKLY;BYDAY=MO
END:VEVENT
END:VCALENDAR`;

// (e-COUNT) Daily recurring limited by COUNT.
const DAILY_COUNT_ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:daily-count
SUMMARY:Standup
DTSTART:20260713T080000Z
DTEND:20260713T081000Z
RRULE:FREQ=DAILY;COUNT=3
END:VEVENT
END:VCALENDAR`;

// (e-UNTIL) Daily recurring limited by UNTIL.
const DAILY_UNTIL_ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:daily-until
SUMMARY:Standup
DTSTART:20260713T080000Z
DTEND:20260713T081000Z
RRULE:FREQ=DAILY;UNTIL=20260715T080000Z
END:VEVENT
END:VCALENDAR`;

// (f) Unsupported MONTHLY freq.
const MONTHLY_ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:monthly-1
SUMMARY:Monthly board call
DTSTART:20260713T150000Z
DTEND:20260713T160000Z
RRULE:FREQ=MONTHLY;BYMONTHDAY=13
END:VEVENT
END:VCALENDAR`;

// (g) Google Meet join link.
const MEET_ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:meet-1
SUMMARY:Intro chat
DTSTART:20260713T110000Z
DTEND:20260713T113000Z
LOCATION:https://meet.google.com/abc-defg-hij
END:VEVENT
END:VCALENDAR`;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

describe('unfoldIcsLines', () => {
  it('joins continuation lines that start with a space', () => {
    const folded = 'DESCRIPTION:Join the meeting now\r\n https://example.com/room';
    const lines = unfoldIcsLines(folded);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('DESCRIPTION:Join the meeting nowhttps://example.com/room');
  });
});

describe('parseIcs — Outlook (Windows TZID)', () => {
  const events = parseIcs(OUTLOOK_ICS);
  it('parses exactly one event', () => {
    expect(events).toHaveLength(1);
  });
  it('converts W. Europe Standard Time wall time to correct UTC (summer = +2)', () => {
    // 2026-07-13 14:00 Europe/Berlin (DST) === 12:00 UTC
    expect(new Date(events[0].startMs).toISOString()).toBe('2026-07-13T12:00:00.000Z');
    expect(new Date(events[0].endMs).toISOString()).toBe('2026-07-13T12:30:00.000Z');
  });
  it('extracts the Teams join URL from the folded DESCRIPTION', () => {
    expect(events[0].joinUrl).toContain('teams.microsoft.com/l/meetup-join');
  });
  it('captures the attendee CN', () => {
    expect(events[0].attendees).toContain('Jane Client');
  });
  it('preserves the raw attendee email even when a CN masks it', () => {
    // The display list shows "Jane Client", but the email must survive for domain matching.
    expect(events[0].attendees).toContain('Jane Client');
    expect(events[0].attendeeEmails).toContain('jane@acme.com');
  });
});

describe('attendeeEmails extraction', () => {
  it('captures the email when there is no CN (bare mailto)', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:no-cn
SUMMARY:Bare attendee
DTSTART:20260713T090000Z
DTEND:20260713T093000Z
ATTENDEE:mailto:bob@globex.io
END:VEVENT
END:VCALENDAR`;
    const events = parseIcs(ics);
    expect(events[0].attendees).toContain('bob@globex.io');
    expect(events[0].attendeeEmails).toContain('bob@globex.io');
  });

  it('ignores an ATTENDEE with no email address', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:no-mail
SUMMARY:Room booking
DTSTART:20260713T090000Z
DTEND:20260713T093000Z
ATTENDEE;CN=Conference Room A:invalid-no-at
END:VEVENT
END:VCALENDAR`;
    const events = parseIcs(ics);
    // Display list still records the CN, but no email is added.
    expect(events[0].attendees).toContain('Conference Room A');
    expect(events[0].attendeeEmails).toEqual([]);
  });

  it('collects multiple attendee emails in order', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:multi
SUMMARY:Group call
DTSTART:20260713T090000Z
DTEND:20260713T093000Z
ATTENDEE;CN=Jane:mailto:jane@acme.com
ATTENDEE;CN=Me:mailto:me@gmail.com
END:VEVENT
END:VCALENDAR`;
    const events = parseIcs(ics);
    expect(events[0].attendeeEmails).toEqual(['jane@acme.com', 'me@gmail.com']);
  });

  it('defaults to an empty attendeeEmails array when there are no attendees', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:none
SUMMARY:Solo block
DTSTART:20260713T090000Z
DTEND:20260713T093000Z
END:VEVENT
END:VCALENDAR`;
    const events = parseIcs(ics);
    expect(events[0].attendeeEmails).toEqual([]);
  });
});

describe('parseIcs — Proton (UTC Z, escaped comma)', () => {
  const events = parseIcs(PROTON_ICS);
  it('unescapes the comma in the summary', () => {
    expect(events[0].summary).toBe('Review call, part two');
  });
  it('parses UTC times directly', () => {
    expect(new Date(events[0].startMs).toISOString()).toBe('2026-07-14T09:00:00.000Z');
  });
  it('extracts the Zoom join URL', () => {
    expect(events[0].joinUrl).toContain('zoom.us/j/');
  });
});

describe('parseIcs — all-day', () => {
  it('flags VALUE=DATE events as all-day', () => {
    const events = parseIcs(ALLDAY_ICS);
    expect(events).toHaveLength(1);
    expect(events[0].allDay).toBe(true);
  });
});

describe('parseIcs — join URLs', () => {
  it('extracts a Google Meet link from LOCATION', () => {
    const events = parseIcs(MEET_ICS);
    expect(events[0].joinUrl).toBe('https://meet.google.com/abc-defg-hij');
  });
});

describe('parseIcs — malformed / empty input', () => {
  it('returns [] for empty string', () => {
    expect(parseIcs('')).toEqual([]);
  });
  it('returns [] for garbage', () => {
    expect(parseIcs('not a calendar at all')).toEqual([]);
  });
  it('does not throw on a truncated VEVENT', () => {
    expect(() => parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:x')).not.toThrow();
  });
});

describe('expandOccurrences — weekly with EXDATE', () => {
  it('expands Mondays and skips the excluded one', () => {
    const events = parseIcs(WEEKLY_ICS);
    const windowStart = Date.parse('2026-07-13T00:00:00Z');
    const windowEnd = Date.parse('2026-08-04T00:00:00Z'); // covers 07-13,20,27,08-03
    const occ = expandOccurrences(events, windowStart, windowEnd);
    const isoStarts = occ.map((e) => new Date(e.startMs).toISOString());
    expect(isoStarts).toEqual([
      '2026-07-13T10:00:00.000Z',
      '2026-07-27T10:00:00.000Z',
      '2026-08-03T10:00:00.000Z',
    ]);
  });
});

describe('expandOccurrences — weekly across a DST boundary', () => {
  it('keeps the wall-clock time pinned (14:00 Berlin) as the offset shifts CEST->CET', () => {
    const events = parseIcs(WEEKLY_DST_ICS);
    // Window spans the 2026-10-25 Europe/Berlin transition: 3 Mondays (10-19, 10-26, 11-02).
    const windowStart = Date.parse('2026-10-19T00:00:00Z');
    const windowEnd = Date.parse('2026-11-03T00:00:00Z');
    const occ = expandOccurrences(events, windowStart, windowEnd);
    expect(occ.map((e) => new Date(e.startMs).toISOString())).toEqual([
      '2026-10-19T12:00:00.000Z', // 14:00 CEST (+2)
      '2026-10-26T13:00:00.000Z', // 14:00 CET  (+1) — would be 12:00Z if the offset drifted
      '2026-11-02T13:00:00.000Z', // 14:00 CET  (+1)
    ]);
  });
});

describe('expandOccurrences — COUNT termination', () => {
  it('emits exactly COUNT occurrences', () => {
    const events = parseIcs(DAILY_COUNT_ICS);
    const windowStart = Date.parse('2026-07-13T00:00:00Z');
    const windowEnd = Date.parse('2026-07-20T00:00:00Z');
    const occ = expandOccurrences(events, windowStart, windowEnd);
    expect(occ.map((e) => new Date(e.startMs).toISOString())).toEqual([
      '2026-07-13T08:00:00.000Z',
      '2026-07-14T08:00:00.000Z',
      '2026-07-15T08:00:00.000Z',
    ]);
  });
});

describe('expandOccurrences — UNTIL termination', () => {
  it('stops at the UNTIL bound (inclusive)', () => {
    const events = parseIcs(DAILY_UNTIL_ICS);
    const windowStart = Date.parse('2026-07-13T00:00:00Z');
    const windowEnd = Date.parse('2026-07-20T00:00:00Z');
    const occ = expandOccurrences(events, windowStart, windowEnd);
    expect(occ.map((e) => new Date(e.startMs).toISOString())).toEqual([
      '2026-07-13T08:00:00.000Z',
      '2026-07-14T08:00:00.000Z',
      '2026-07-15T08:00:00.000Z',
    ]);
  });
});

describe('expandOccurrences — unsupported MONTHLY freq', () => {
  it('emits only the base occurrence with a warning', () => {
    const events = parseIcs(MONTHLY_ICS);
    const windowStart = Date.parse('2026-07-13T00:00:00Z');
    const windowEnd = Date.parse('2026-07-20T00:00:00Z');
    const occ = expandOccurrences(events, windowStart, windowEnd);
    expect(occ).toHaveLength(1);
    expect(occ[0].warnings?.some((w) => /only the next occurrence/i.test(w))).toBe(true);
  });
});

describe('expandOccurrences — non-recurring window filter', () => {
  it('includes an event inside the window and excludes one outside', () => {
    const inside = parseIcs(PROTON_ICS); // 2026-07-14T09:00Z
    const windowStart = Date.parse('2026-07-14T00:00:00Z');
    const windowEnd = windowStart + WEEK_MS;
    expect(expandOccurrences(inside, windowStart, windowEnd)).toHaveLength(1);

    const laterWindowStart = Date.parse('2026-08-01T00:00:00Z');
    expect(
      expandOccurrences(inside, laterWindowStart, laterWindowStart + WEEK_MS),
    ).toHaveLength(0);
  });
});

describe('eventsFortoday', () => {
  it('returns only events overlapping the local day of `now`', () => {
    const events: CalendarEvent[] = [
      { uid: 'a', summary: 'Today', startMs: Date.parse('2026-07-13T12:00:00Z'), endMs: Date.parse('2026-07-13T12:30:00Z'), allDay: false, attendees: [], attendeeEmails: [] },
      { uid: 'b', summary: 'Tomorrow', startMs: Date.parse('2026-07-14T12:00:00Z'), endMs: Date.parse('2026-07-14T12:30:00Z'), allDay: false, attendees: [], attendeeEmails: [] },
    ];
    const now = Date.parse('2026-07-13T15:00:00Z');
    const today = eventsForToday(events, now);
    expect(today).toHaveLength(1);
    expect(today[0].summary).toBe('Today');
  });
});
