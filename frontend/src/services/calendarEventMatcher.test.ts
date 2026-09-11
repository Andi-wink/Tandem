import { describe, it, expect, beforeEach } from 'vitest';
import {
  matchEventToProject,
  rankEventProjectCandidates,
  findEventNear,
  findUpcomingEvent,
} from './calendarEventMatcher';
import type { CalendarEvent } from '@/lib/ics';
import { Project } from '@/services/projectService';
import { recordProjectDirUse } from '@/lib/projectDirHistory';

function ev(partial: Partial<CalendarEvent>): CalendarEvent {
  return {
    uid: 'u1',
    summary: 'Meeting',
    startMs: Date.parse('2026-07-13T12:00:00Z'),
    endMs: Date.parse('2026-07-13T12:30:00Z'),
    allDay: false,
    attendees: [],
    attendeeEmails: [],
    ...partial,
  };
}

function proj(name: string, path: string, aliases: string[] = []): Project {
  return { id: name.toLowerCase(), name, path, aliases, auto_discovered: false, session_id: null, created_at: '' };
}

const ACME = proj('Acme', 'C:/clients/acme');
const GLOBEX = proj('Globex', 'C:/clients/globex');

beforeEach(() => {
  // History pass reads localStorage; keep tests independent.
  window.localStorage.clear();
});

describe('matchEventToProject — attendee domain (pass A)', () => {
  it('matches on the client email domain even when a CN masks the address', () => {
    const e = ev({
      summary: 'Weekly sync', // all-generic: only the domain can route this
      attendees: ['Jane Client'],
      attendeeEmails: ['jane@acme.com'],
    });
    const m = matchEventToProject(e, [ACME, GLOBEX]);
    expect(m?.project.name).toBe('Acme');
    expect(m?.signal).toContain('@acme.com');
  });

  it('never routes on a freemail domain', () => {
    const GMAIL = proj('Gmail', 'C:/clients/gmail'); // would match "gmail" if not skipped
    const e = ev({ summary: 'Weekly sync', attendeeEmails: ['someone@gmail.com'] });
    expect(matchEventToProject(e, [GMAIL])).toBeNull();
  });

  it('derives the org label from a co.uk-style domain', () => {
    const e = ev({ summary: 'Weekly sync', attendeeEmails: ['bob@acme.co.uk'] });
    const m = matchEventToProject(e, [ACME, GLOBEX]);
    expect(m?.project.name).toBe('Acme');
    expect(m?.signal).toContain('@acme.co.uk');
  });
});

describe('matchEventToProject — title (pass B)', () => {
  it('matches a distinctive token in the event title', () => {
    const e = ev({ summary: 'Globex discovery call' });
    const m = matchEventToProject(e, [ACME, GLOBEX]);
    expect(m?.project.name).toBe('Globex');
  });

  it('returns null for an all-generic title with only freemail attendees', () => {
    const e = ev({ summary: 'Weekly sync', attendeeEmails: ['me@gmail.com'] });
    expect(matchEventToProject(e, [ACME, GLOBEX])).toBeNull();
  });
});

describe('matchEventToProject — history (pass C)', () => {
  it('reuses a previously-filed folder only when it is a registered project', () => {
    // A prior call titled "Zenith kickoff" was filed under Acme's folder.
    recordProjectDirUse(ACME.path, ACME.name, 'Zenith roadmap');
    const e = ev({ summary: 'Zenith roadmap' });
    const m = matchEventToProject(e, [ACME, GLOBEX]);
    expect(m?.project.name).toBe('Acme');
    expect(m?.signal).toContain('Zenith roadmap');
  });

  it('does not match history when the filed folder is not a registered project', () => {
    recordProjectDirUse('C:/somewhere/unregistered', 'Unregistered', 'Zenith roadmap');
    const e = ev({ summary: 'Zenith roadmap' });
    expect(matchEventToProject(e, [ACME, GLOBEX])).toBeNull();
  });
});

describe('matchEventToProject — single-project confidence', () => {
  it('returns the project when domain AND title point at the SAME project (dedup -> strong)', () => {
    // Title token "acme" and attendee @acme.com both resolve to Acme: one distinct project.
    const e = ev({ summary: 'Acme discovery call', attendeeEmails: ['jane@acme.com'] });
    const m = matchEventToProject(e, [ACME, GLOBEX]);
    expect(m?.project.name).toBe('Acme');
    // Strongest tier (attendee-domain) wins the signal.
    expect(m?.signal).toContain('@acme.com');
  });

  it('returns null when domain and title point at DIFFERENT projects (ambiguous)', () => {
    // Title says Globex, attendees are @acme.com — two rivals, so no silent pick.
    const e = ev({ summary: 'Globex discovery call', attendeeEmails: ['jane@acme.com'] });
    expect(matchEventToProject(e, [ACME, GLOBEX])).toBeNull();
  });
});

describe('rankEventProjectCandidates — confidence matrix', () => {
  it('single domain hit -> strong', () => {
    const e = ev({ summary: 'Weekly sync', attendeeEmails: ['jane@acme.com'] });
    const r = rankEventProjectCandidates(e, [ACME, GLOBEX]);
    expect(r.confidence).toBe('strong');
    expect(r.candidates.map(c => c.project.name)).toEqual(['Acme']);
    expect(r.candidates[0].tier).toBe('attendee-domain');
  });

  it('domain hit + DIFFERENT title hit -> ambiguous, domain ranked first', () => {
    // The "Instagram call: the Instagram project OR the client's own folder?" case.
    const e = ev({ summary: 'Globex discovery call', attendeeEmails: ['jane@acme.com'] });
    const r = rankEventProjectCandidates(e, [ACME, GLOBEX]);
    expect(r.confidence).toBe('ambiguous');
    expect(r.candidates.map(c => c.project.name)).toEqual(['Acme', 'Globex']);
    expect(r.candidates[0].tier).toBe('attendee-domain');
    expect(r.candidates[1].tier).toBe('title');
  });

  it('same project via domain AND title -> strong (dedup, strongest signal kept)', () => {
    const e = ev({ summary: 'Acme discovery call', attendeeEmails: ['jane@acme.com'] });
    const r = rankEventProjectCandidates(e, [ACME, GLOBEX]);
    expect(r.confidence).toBe('strong');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].tier).toBe('attendee-domain');
  });

  it('all-freemail + generic title -> none', () => {
    const e = ev({ summary: 'Weekly sync', attendeeEmails: ['me@gmail.com'] });
    const r = rankEventProjectCandidates(e, [ACME, GLOBEX]);
    expect(r.confidence).toBe('none');
    expect(r.candidates).toHaveLength(0);
  });

  it('title hit + DIFFERENT history hit -> ambiguous, title ranked above history', () => {
    recordProjectDirUse(GLOBEX.path, GLOBEX.name, 'Acme roadmap');
    const e = ev({ summary: 'Acme roadmap' }); // title token "acme" -> Acme; history -> Globex
    const r = rankEventProjectCandidates(e, [ACME, GLOBEX]);
    expect(r.confidence).toBe('ambiguous');
    expect(r.candidates.map(c => c.project.name)).toEqual(['Acme', 'Globex']);
    expect(r.candidates[0].tier).toBe('title');
    expect(r.candidates[1].tier).toBe('history');
  });

  it('discovered-folder stubs participate as candidates', () => {
    // An unregistered client folder surfaced as a stub (Phase B) should rank like any project.
    const stub = proj('Instagram', 'D:/Dev-projects/Client_projects/Instagram');
    const e = ev({ summary: 'Instagram content plan' });
    const r = rankEventProjectCandidates(e, [stub]);
    expect(r.confidence).toBe('strong');
    expect(r.candidates[0].project.path).toContain('Instagram');
    expect(r.candidates[0].tier).toBe('title');
  });
});

describe('findEventNear', () => {
  const now = Date.parse('2026-07-13T12:00:00Z');

  it('matches an event whose start is within the look-back window (inclusive edge)', () => {
    const e = ev({ startMs: now + 10 * 60_000, endMs: now + 40 * 60_000 }); // starts in exactly 10 min
    expect(findEventNear([e], now)?.uid).toBe('u1');
  });

  it('does not match once the event has ended (endMs exclusive)', () => {
    const e = ev({ startMs: now - 60 * 60_000, endMs: now }); // ended exactly now
    expect(findEventNear([e], now)).toBeNull();
  });

  it('does not match an event starting more than 10 min out', () => {
    const e = ev({ startMs: now + 11 * 60_000, endMs: now + 40 * 60_000 });
    expect(findEventNear([e], now)).toBeNull();
  });

  it('skips all-day events', () => {
    const e = ev({ allDay: true, startMs: now - 60_000, endMs: now + 60 * 60_000 });
    expect(findEventNear([e], now)).toBeNull();
  });

  it('returns the earliest of several near events', () => {
    const a = ev({ uid: 'a', startMs: now - 60_000, endMs: now + 30 * 60_000 });
    const b = ev({ uid: 'b', startMs: now - 5 * 60_000, endMs: now + 30 * 60_000 });
    expect(findEventNear([a, b], now)?.uid).toBe('b');
  });
});

describe('findUpcomingEvent', () => {
  const now = Date.parse('2026-07-13T12:00:00Z');

  it('prefers an in-progress event over an upcoming one', () => {
    const running = ev({ uid: 'run', startMs: now - 5 * 60_000, endMs: now + 25 * 60_000 });
    const soon = ev({ uid: 'soon', startMs: now + 20 * 60_000, endMs: now + 50 * 60_000 });
    expect(findUpcomingEvent([soon, running], now)?.uid).toBe('run');
  });

  it('falls back to the next event within the look-ahead window', () => {
    const soon = ev({ uid: 'soon', startMs: now + 20 * 60_000, endMs: now + 50 * 60_000 });
    expect(findUpcomingEvent([soon], now)?.uid).toBe('soon');
  });

  it('returns null when the next event is beyond the look-ahead', () => {
    const later = ev({ startMs: now + 2 * 60 * 60_000, endMs: now + 3 * 60 * 60_000 });
    expect(findUpcomingEvent([later], now)).toBeNull();
  });
});
