/**
 * Pure, dependency-free ICS (RFC 5545) parser for Tandem's read-only calendar overlay.
 *
 * Design notes / deliberate limitations (MVP):
 * - No Tauri / DOM imports here so this runs under vitest unmodified.
 * - Timezone handling:
 *     * a trailing "Z" means UTC.
 *     * TZID=<IANA zone> (e.g. "Europe/Berlin") is converted wall-time -> UTC via the
 *       Intl.DateTimeFormat offset-probe trick, refined once to stay correct across DST edges.
 *     * TZID=<Windows zone> (Outlook publishes "W. Europe Standard Time" etc.) is mapped through
 *       a small embedded Windows->IANA table. Unmapped zones fall back to LOCAL time and push a
 *       warning rather than throwing.
 *     * A bare date-time with no Z and no TZID is treated as floating/local time.
 * - RRULE expansion supports FREQ=DAILY and FREQ=WEEKLY (with INTERVAL, BYDAY, UNTIL, COUNT) and
 *   honors EXDATE. FREQ=MONTHLY/YEARLY (and anything else) are NOT expanded: only the base
 *   occurrence is emitted, plus a warning. This is intentional for the MVP and surfaced in the
 *   Settings "Test connection" output. A recurring monthly client call therefore shows only its
 *   next base instance.
 */

export interface CalendarEvent {
  uid: string;
  summary: string;
  /** Start as epoch ms (UTC). */
  startMs: number;
  /** End as epoch ms (UTC). */
  endMs: number;
  allDay: boolean;
  location?: string;
  description?: string;
  attendees: string[];
  /** Raw attendee email addresses (from mailto:), used for domain-based project matching. */
  attendeeEmails: string[];
  /** Extracted Zoom/Teams/Meet join link, if any. */
  joinUrl?: string;
  /** Raw RRULE line value, if the event recurs. */
  rrule?: string;
  /** Non-fatal parse notes (e.g. unmapped timezone, unsupported recurrence). */
  warnings?: string[];
}

// ── Windows timezone id -> IANA (the ~30 zones Outlook actually publishes) ──
const WINDOWS_TO_IANA: Record<string, string> = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'UTC-11': 'Etc/GMT+11',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time': 'America/Denver',
  'Central Standard Time': 'America/Chicago',
  'Canada Central Standard Time': 'America/Regina',
  'Eastern Standard Time': 'America/New_York',
  'US Eastern Standard Time': 'America/Indianapolis',
  'Atlantic Standard Time': 'America/Halifax',
  'Argentina Standard Time': 'America/Buenos_Aires',
  'UTC': 'Etc/UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'GTB Standard Time': 'Europe/Bucharest',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Helsinki',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Russian Standard Time': 'Europe/Moscow',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'Singapore Standard Time': 'Asia/Singapore',
  'SE Asia Standard Time': 'Asia/Bangkok',
};

const DAY_TO_INDEX: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Unfold folded ICS content lines. RFC 5545 folds long lines by inserting CRLF followed by a
 * single space or tab. We also tolerate lone LF and CR.
 */
export function unfoldIcsLines(text: string): string[] {
  const rawLines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * Unescape ICS TEXT values (\\n \\N \\, \\; \\\\). Single left-to-right pass per RFC 5545 so each
 * escape is resolved exactly once: an escaped backslash (\\\\) followed by a literal n stays
 * "\\n" instead of the chained-.replace() hazard where \\n matched the injected backslash.
 */
function unescapeText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === 'n' || next === 'N') {
        out += '\n';
        i++;
      } else if (next === ',' || next === ';' || next === '\\') {
        out += next;
        i++;
      } else {
        // Unknown escape: keep the backslash literally and reprocess the next char.
        out += '\\';
      }
    } else {
      out += c;
    }
  }
  return out;
}

/** Offset (zone minus UTC) in ms at a given instant for an IANA zone. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = map.hour === '24' ? 0 : Number(map.hour);
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second),
  );
  return asUTC - utcMs;
}

/**
 * Convert a wall-clock time in a given IANA zone to epoch ms.
 * Uses a two-pass offset probe so it stays correct across DST transitions.
 */
function zonedWallTimeToUtcMs(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timeZone: string,
): number {
  const naiveUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset1 = zoneOffsetMs(naiveUtc, timeZone);
  let utcMs = naiveUtc - offset1;
  const offset2 = zoneOffsetMs(utcMs, timeZone);
  if (offset2 !== offset1) {
    utcMs = naiveUtc - offset2;
  }
  return utcMs;
}

interface ParsedDate {
  ms: number;
  dateOnly: boolean;
  warning?: string;
  /** Resolved IANA zone for a TZID date-time, so recurrence can re-resolve DST per occurrence. */
  tzid?: string;
}

/**
 * Parse an ICS date/date-time property value given its parameters.
 * Handles: VALUE=DATE (all-day), trailing Z (UTC), TZID=<IANA|Windows>, and floating local time.
 */
function parseIcsDate(value: string, params: Record<string, string>): ParsedDate | null {
  const v = value.trim();
  const dateOnly = params.VALUE === 'DATE' || /^\d{8}$/.test(v);

  if (dateOnly) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    const [, y, mo, d] = m;
    // All-day: anchor to local midnight so it lands on the right calendar day for the user.
    const ms = new Date(Number(y), Number(mo) - 1, Number(d)).getTime();
    return { ms, dateOnly: true };
  }

  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?/.exec(v);
  if (!m) return null;
  const [, ys, mos, ds, hs, mis, ss, z] = m;
  const y = Number(ys);
  const mo = Number(mos);
  const d = Number(ds);
  const h = Number(hs);
  const mi = Number(mis);
  const s = Number(ss);

  if (z === 'Z') {
    return { ms: Date.UTC(y, mo - 1, d, h, mi, s), dateOnly: false };
  }

  const tzid = params.TZID;
  if (tzid) {
    const iana = WINDOWS_TO_IANA[tzid] || tzid;
    // Validate the zone by trying to build a formatter.
    try {
      // Throws RangeError for an unknown IANA id.
      // eslint-disable-next-line no-new
      new Intl.DateTimeFormat('en-US', { timeZone: iana });
      return { ms: zonedWallTimeToUtcMs(y, mo, d, h, mi, s, iana), dateOnly: false, tzid: iana };
    } catch {
      // Unknown timezone: fall back to local wall time and warn.
      return {
        ms: new Date(y, mo - 1, d, h, mi, s).getTime(),
        dateOnly: false,
        warning: `Unknown timezone "${tzid}" — times shown in your local time.`,
      };
    }
  }

  // Floating time: interpret as the host's local wall time. Anchor the base instant locally AND
  // tag it with the host's IANA zone so recurrence re-resolves each occurrence in that zone. This
  // keeps a floating 09:00 pinned to 09:00 local across a DST transition instead of freezing a UTC
  // offset (which would drift the wall time by an hour for occurrences past the boundary). A true
  // UTC ("Z") value keeps tzid undefined above and legitimately holds a fixed offset (no DST).
  return {
    ms: new Date(y, mo - 1, d, h, mi, s).getTime(),
    dateOnly: false,
    tzid: hostLocalZone(),
  };
}

/** Host's IANA time zone (e.g. "Europe/Berlin"), or undefined if it can't be resolved. */
function hostLocalZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Split a content line into { name, params, value }. */
function splitLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segments = left.split(';');
  const name = segments[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < segments.length; i++) {
    const eq = segments[i].indexOf('=');
    if (eq === -1) continue;
    const pName = segments[i].slice(0, eq).toUpperCase();
    let pVal = segments[i].slice(eq + 1);
    // Strip optional double quotes around a param value (e.g. TZID="…").
    if (pVal.startsWith('"') && pVal.endsWith('"')) pVal = pVal.slice(1, -1);
    params[pName] = pVal;
  }
  return { name, params, value };
}

// Join-link patterns, checked against LOCATION + DESCRIPTION (unescaped).
const JOIN_PATTERNS: RegExp[] = [
  /https?:\/\/[a-z0-9.-]*zoom\.us\/(?:j|w|my)\/[^\s>"'<]+/i,
  /https?:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s>"'<]+/i,
  /https?:\/\/teams\.live\.com\/meet\/[^\s>"'<]+/i,
  /https?:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i,
  /https?:\/\/[a-z0-9.-]*webex\.com\/[^\s>"'<]+/i,
];

function extractJoinUrl(...texts: (string | undefined)[]): string | undefined {
  const haystack = texts.filter(Boolean).join('\n');
  for (const re of JOIN_PATTERNS) {
    const match = re.exec(haystack);
    if (match) return match[0];
  }
  return undefined;
}

/**
 * Parse an ICS document into a flat list of base events (recurrence NOT yet expanded).
 * Malformed or empty input returns [] without throwing.
 */
export function parseIcs(text: string): CalendarEvent[] {
  if (!text || typeof text !== 'string') return [];
  const events: CalendarEvent[] = [];
  let lines: string[];
  try {
    lines = unfoldIcsLines(text);
  } catch {
    return [];
  }

  let inEvent = false;
  let cur: Partial<CalendarEvent> & { _dtstart?: ParsedDate; _dtend?: ParsedDate; _exdates?: number[] } = {};

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      cur = { attendees: [], attendeeEmails: [], warnings: [], _exdates: [] };
      continue;
    }
    if (line === 'END:VEVENT') {
      if (inEvent) {
        const built = finalizeEvent(cur);
        if (built) events.push(built);
      }
      inEvent = false;
      cur = {};
      continue;
    }
    if (!inEvent) continue;

    const parsed = splitLine(line);
    if (!parsed) continue;
    const { name, params, value } = parsed;

    switch (name) {
      case 'UID':
        cur.uid = value.trim();
        break;
      case 'SUMMARY':
        cur.summary = unescapeText(value);
        break;
      case 'LOCATION':
        cur.location = unescapeText(value);
        break;
      case 'DESCRIPTION':
        cur.description = unescapeText(value);
        break;
      case 'DTSTART': {
        const pd = parseIcsDate(value, params);
        if (pd) {
          cur._dtstart = pd;
          if (pd.warning) cur.warnings!.push(pd.warning);
        }
        break;
      }
      case 'DTEND': {
        const pd = parseIcsDate(value, params);
        if (pd) {
          cur._dtend = pd;
          if (pd.warning) cur.warnings!.push(pd.warning);
        }
        break;
      }
      case 'RRULE':
        cur.rrule = value.trim();
        break;
      case 'EXDATE': {
        // May be a comma-separated list; each with the property params.
        for (const part of value.split(',')) {
          const pd = parseIcsDate(part, params);
          if (pd) cur._exdates!.push(pd.ms);
        }
        break;
      }
      case 'ATTENDEE': {
        const cn = params.CN;
        const mailto = value.replace(/^mailto:/i, '').trim();
        cur.attendees!.push(cn ? cn : mailto);
        // Always preserve the raw email (when present) for domain-based project matching,
        // regardless of whether a CN display name masks it in `attendees`.
        if (mailto.includes('@')) cur.attendeeEmails!.push(mailto);
        break;
      }
      default:
        break;
    }
  }

  return events;
}

function finalizeEvent(
  cur: Partial<CalendarEvent> & { _dtstart?: ParsedDate; _dtend?: ParsedDate; _exdates?: number[] },
): CalendarEvent | null {
  if (!cur._dtstart) return null;
  const allDay = cur._dtstart.dateOnly;
  const startMs = cur._dtstart.ms;
  let endMs: number;
  if (cur._dtend) {
    endMs = cur._dtend.ms;
  } else if (allDay) {
    endMs = startMs + DAY_MS;
  } else {
    endMs = startMs + 30 * 60 * 1000; // default 30 min
  }

  const joinUrl = extractJoinUrl(cur.location, cur.description);
  const warnings = cur.warnings && cur.warnings.length ? cur.warnings : undefined;

  const ev: CalendarEvent = {
    uid: cur.uid || `no-uid-${startMs}`,
    summary: cur.summary || '(no title)',
    startMs,
    endMs,
    allDay,
    location: cur.location,
    description: cur.description,
    attendees: cur.attendees || [],
    attendeeEmails: cur.attendeeEmails || [],
    joinUrl,
    rrule: cur.rrule,
    warnings,
  };
  // Stash exdates + resolved zone on internal fields for expansion; keep the public type clean.
  (ev as CalendarEvent & { _exdates?: number[] })._exdates = cur._exdates && cur._exdates.length ? cur._exdates : undefined;
  (ev as CalendarEvent & { _tzid?: string })._tzid = cur._dtstart.tzid;
  return ev;
}

function parseRrule(rrule: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of rrule.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return out;
}

/** Parse an RRULE UNTIL value (date or date-time, possibly UTC) to epoch ms. */
function parseUntil(value: string): number | null {
  // parseIcsDate auto-detects VALUE=DATE (8 digits) vs date-time and the trailing Z.
  const pd = parseIcsDate(value.trim(), {});
  return pd ? pd.ms : null;
}

/**
 * Expand recurring events into concrete occurrences within [windowStartMs, windowEndMs).
 * Non-recurring events are passed through if they overlap the window. DAILY/WEEKLY RRULEs are
 * expanded; other FREQs emit only the base occurrence (with a warning).
 */
export function expandOccurrences(
  events: CalendarEvent[],
  windowStartMs: number,
  windowEndMs: number,
): CalendarEvent[] {
  const out: CalendarEvent[] = [];

  for (const ev of events) {
    const exdates = (ev as CalendarEvent & { _exdates?: number[] })._exdates || [];
    const tzid = (ev as CalendarEvent & { _tzid?: string })._tzid;
    const duration = ev.endMs - ev.startMs;

    if (!ev.rrule) {
      if (ev.endMs > windowStartMs && ev.startMs < windowEndMs) {
        out.push(stripInternal(ev));
      }
      continue;
    }

    const rule = parseRrule(ev.rrule);
    const freq = (rule.FREQ || '').toUpperCase();
    const interval = Math.max(1, parseInt(rule.INTERVAL || '1', 10) || 1);
    const count = rule.COUNT ? parseInt(rule.COUNT, 10) : undefined;
    const until = rule.UNTIL ? (parseUntil(rule.UNTIL) ?? undefined) : undefined;

    if (freq !== 'DAILY' && freq !== 'WEEKLY') {
      // Unsupported: emit base occurrence if it overlaps, with a warning.
      if (ev.endMs > windowStartMs && ev.startMs < windowEndMs) {
        const base = stripInternal(ev);
        base.warnings = [
          ...(base.warnings || []),
          `Recurring event (${freq || 'unknown'}) — only the next occurrence is shown.`,
        ];
        out.push(base);
      }
      continue;
    }

    const byday = rule.BYDAY
      ? rule.BYDAY.split(',').map((d) => d.trim().slice(-2).toUpperCase()).filter((d) => d in DAY_TO_INDEX)
      : [];

    const occurrences = generateOccurrences(
      ev.startMs,
      freq,
      interval,
      byday,
      count,
      until,
      windowStartMs,
      windowEndMs,
      tzid,
    );

    let emitted = 0;
    for (const startMs of occurrences) {
      if (exdates.some((ex) => sameInstant(ex, startMs))) continue;
      const occ = stripInternal(ev);
      occ.startMs = startMs;
      occ.endMs = startMs + duration;
      out.push(occ);
      emitted++;
      if (emitted > 500) break; // hard safety cap
    }
  }

  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

function sameInstant(a: number, b: number): boolean {
  // Match exact instant, or same calendar day for all-day exclusions.
  if (a === b) return true;
  return Math.abs(a - b) < 1000;
}

function stripInternal(ev: CalendarEvent): CalendarEvent {
  const copy: CalendarEvent = { ...ev, warnings: ev.warnings ? [...ev.warnings] : undefined };
  delete (copy as CalendarEvent & { _exdates?: number[] })._exdates;
  delete (copy as CalendarEvent & { _tzid?: string })._tzid;
  return copy;
}

interface WallParts {
  y: number;
  mo: number; // 1-based month
  d: number;
  h: number;
  mi: number;
  s: number;
}

/**
 * Decompose an epoch-ms instant into its wall-clock parts in the given zone (or the host's local
 * zone when `tzid` is undefined, i.e. floating time). Used so recurrence can re-resolve each
 * occurrence's wall time for its own calendar date rather than inheriting a fixed UTC offset.
 */
function wallPartsOf(utcMs: number, tzid: string | undefined): WallParts {
  if (!tzid) {
    // No zone (UTC "Z" or floating time): decompose in UTC so recurrence stays a fixed offset,
    // matching the pre-existing additive-days behavior and staying independent of the host zone.
    const d = new Date(utcMs);
    return {
      y: d.getUTCFullYear(),
      mo: d.getUTCMonth() + 1,
      d: d.getUTCDate(),
      h: d.getUTCHours(),
      mi: d.getUTCMinutes(),
      s: d.getUTCSeconds(),
    };
  }
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = map.hour === '24' ? 0 : Number(map.hour);
  return {
    y: Number(map.year),
    mo: Number(map.month),
    d: Number(map.day),
    h: hour,
    mi: Number(map.minute),
    s: Number(map.second),
  };
}

function generateOccurrences(
  baseStartMs: number,
  freq: string,
  interval: number,
  byday: string[],
  count: number | undefined,
  until: number | undefined,
  windowStartMs: number,
  windowEndMs: number,
  tzid: string | undefined,
): number[] {
  const result: number[] = [];
  const hardEnd = until !== undefined ? Math.min(windowEndMs, until + 1) : windowEndMs;
  let produced = 0; // counts toward COUNT (all occurrences, not just in-window)

  // Base wall-clock parts in the event's own zone (or local for floating time). Every occurrence
  // reuses the same time-of-day but is re-resolved to UTC on its own calendar date, so a series
  // that crosses a DST boundary stays pinned to its wall-clock time instead of drifting an hour.
  const base = wallPartsOf(baseStartMs, tzid);

  // Calendar date `base date + n days`, computed via UTC so the day count is DST-agnostic.
  const dateAtOffset = (n: number): { y: number; mo: number; d: number } => {
    const dt = new Date(Date.UTC(base.y, base.mo - 1, base.d + n));
    return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  };

  // Resolve the base time-of-day on a specific calendar date back to epoch ms. Zoned events
  // re-run the DST probe per date (the fix); zoneless events keep a fixed UTC offset.
  const resolve = (y: number, mo: number, d: number): number =>
    tzid !== undefined
      ? zonedWallTimeToUtcMs(y, mo, d, base.h, base.mi, base.s, tzid)
      : Date.UTC(y, mo - 1, d, base.h, base.mi, base.s);

  if (freq === 'DAILY') {
    let k = 0;
    let guard = 0;
    while (guard < 5000) {
      guard++;
      const { y, mo, d } = dateAtOffset(k * interval);
      const t = resolve(y, mo, d);
      if (t >= windowEndMs) break;
      if (until !== undefined && t > until) break;
      if (count !== undefined && produced >= count) break;
      produced++;
      if (t >= windowStartMs && t < hardEnd) result.push(t);
      k++;
    }
    return result;
  }

  // WEEKLY. Weekday is derived from the calendar date (DST-independent), not local getDay().
  const baseDow = new Date(Date.UTC(base.y, base.mo - 1, base.d)).getUTCDay();
  const targetDows = (byday.length ? byday.map((d) => DAY_TO_INDEX[d]) : [baseDow])
    .slice()
    .sort((a, b) => a - b);

  let week = 0;
  let guard = 0;
  while (guard < 5000) {
    guard++;
    // Day offset from the base date to the Sunday that starts this recurrence week.
    const weekStartOffset = -baseDow + week * interval * 7;
    const anchor = dateAtOffset(weekStartOffset);
    const weekStartMs = resolve(anchor.y, anchor.mo, anchor.d);
    if (weekStartMs >= windowEndMs + 7 * DAY_MS) break;
    for (const dow of targetDows) {
      const cd = dateAtOffset(weekStartOffset + dow);
      const t = resolve(cd.y, cd.mo, cd.d);
      if (t < baseStartMs) continue; // never before the series start
      if (until !== undefined && t > until) return result;
      if (count !== undefined && produced >= count) return result;
      produced++;
      if (t >= windowStartMs && t < hardEnd) result.push(t);
    }
    week++;
    if (weekStartMs > windowEndMs) break;
  }
  return result;
}

/** Events that occur on the same local calendar day as `now` (overlapping today's local window). */
export function eventsForToday(events: CalendarEvent[], now: number): CalendarEvent[] {
  const d = new Date(now);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayEnd = dayStart + DAY_MS;
  return events
    .filter((ev) => ev.endMs > dayStart && ev.startMs < dayEnd)
    .sort((a, b) => a.startMs - b.startMs);
}
