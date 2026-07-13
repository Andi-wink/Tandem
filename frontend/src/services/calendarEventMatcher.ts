/**
 * calendarEventMatcher — a pure, deterministic mapper from a calendar event to the registered
 * project it most likely belongs to. No React, no Tauri, no network: vitest-friendly and cheap
 * enough to run per agenda row on every render.
 *
 * Ranked passes (first hit wins — most specific signal first):
 *   A. Attendee email DOMAIN. A client's own domain (@acme.com) is the single strongest signal
 *      that a call belongs to that client, so it beats the title. Consumer/freemail domains are
 *      skipped (they identify a person, not an org). Org tokens are run through matchProjectByName,
 *      whose exact/alias-first ordering keeps a short token from fuzzily misrouting.
 *   B. Event TITLE tokens, via the existing heuristicProjectRoute (title pass only, reusing its
 *      stopword logic so a bare "Weekly Sync" can't match anything).
 *   C. FRECENCY HISTORY: if this exact/near title was filed under a folder before, and that folder
 *      is a registered project, reuse it. Never routes a brand-new client into an old folder,
 *      because bestHistoryMatch itself requires a strong title signal.
 *
 * Returns null when nothing is distinctive enough — the caller then leaves the meeting where it is
 * and lets transcript-based auto-routing take over.
 */

import type { CalendarEvent } from '@/lib/ics';
import { Project } from '@/services/projectService';
import { matchProjectByName } from '@/services/soloRoutingService';
import { heuristicProjectRoute } from '@/services/projectRouter';
import { bestHistoryMatch, normalizeDir } from '@/lib/projectDirHistory';

export interface EventProjectMatch {
  project: Project;
  /** Human-readable reason, surfaced in the "Filed under X — matched …" toast. */
  signal: string;
}

/** One ranked candidate project for an event, with the signal that surfaced it. */
export interface EventProjectCandidate {
  project: Project;
  /** Human-readable reason (e.g. "attendee @acme.com"). */
  signal: string;
  /** Which pass produced the strongest signal for this project. */
  tier: 'attendee-domain' | 'title' | 'history';
}

/**
 * Ranked match result. `confidence` is a deterministic function of the distinct-project count:
 *   0 distinct -> 'none', exactly 1 -> 'strong', 2+ -> 'ambiguous'.
 * `candidates` is ordered attendee-domain > title > history, stable (first-seen) within a tier.
 */
export interface EventMatchResult {
  candidates: EventProjectCandidate[];
  confidence: 'strong' | 'ambiguous' | 'none';
}

const TIER_RANK: Record<EventProjectCandidate['tier'], number> = {
  'attendee-domain': 0,
  title: 1,
  history: 2,
};

/**
 * Consumer / freemail domains that identify a person, not an organisation. An attendee on one of
 * these tells us nothing about which client the call is for, so they must never drive routing.
 * Wildcard families (yahoo.*, gmx.*) are matched by prefix below.
 */
const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'proton.me', 'protonmail.com', 'pm.me', 'icloud.com', 'me.com', 'mac.com',
  'web.de', 't-online.de', 'aol.com', 'gmx.com', 'gmx.net', 'gmx.de', 'yahoo.com',
]);

/** Second-level public-suffix labels (e.g. the "co" in acme.co.uk) — the registrable org label is one further left. */
const SECOND_LEVEL_TLDS = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ltd', 'plc', 'me']);

function isFreemailDomain(domain: string): boolean {
  if (FREEMAIL_DOMAINS.has(domain)) return true;
  // Wildcard families published across many ccTLDs.
  if (domain.startsWith('yahoo.')) return true;
  if (domain.startsWith('gmx.')) return true;
  return false;
}

/**
 * Candidate organisation tokens derived from an email domain, most-specific first.
 * acme.com        -> ['acme']
 * acme.co.uk      -> ['acme', 'co']   (co is a second-level TLD, so acme is the org label)
 * mail.acme.com   -> ['acme']
 */
function orgTokensFromDomain(domain: string): string[] {
  const labels = domain.split('.').filter(Boolean);
  if (labels.length < 2) return [];
  const secondLast = labels[labels.length - 2];
  if (SECOND_LEVEL_TLDS.has(secondLast) && labels.length >= 3) {
    // e.g. acme.co.uk -> registrable label is labels[len-3].
    return [labels[labels.length - 3], secondLast];
  }
  return [secondLast];
}

/**
 * Rank every registered project an event could belong to (R1). Unlike the first-hit-wins
 * `matchEventToProject`, this runs ALL three passes to completion and collects every hit, so a call
 * whose attendee domain points at one project while its title points at another surfaces BOTH as
 * candidates instead of silently picking one. Pure and side-effect free.
 */
export function rankEventProjectCandidates(ev: CalendarEvent, projects: Project[]): EventMatchResult {
  if (!projects || projects.length === 0) return { candidates: [], confidence: 'none' };

  // Keyed by normalized project path so the same folder reached via two passes dedupes to one
  // candidate carrying its strongest (lowest-rank) signal. `order` preserves first-seen position
  // for stable sorting within a tier.
  const byDir = new Map<string, EventProjectCandidate & { order: number }>();
  let order = 0;

  const add = (project: Project, signal: string, tier: EventProjectCandidate['tier']) => {
    const key = normalizeDir(project.path);
    const existing = byDir.get(key);
    if (!existing) {
      byDir.set(key, { project, signal, tier, order: order++ });
      return;
    }
    // Keep the strongest (lowest-rank) tier's signal for this project.
    if (TIER_RANK[tier] < TIER_RANK[existing.tier]) {
      existing.tier = tier;
      existing.signal = signal;
    }
  };

  // ── Pass A: attendee email domain (strongest signal) — collect EVERY hit ──
  const emails = ev.attendeeEmails || [];
  const seenDomains = new Set<string>();
  for (const email of emails) {
    const at = email.lastIndexOf('@');
    if (at === -1) continue;
    const domain = email.slice(at + 1).trim().toLowerCase();
    if (!domain || seenDomains.has(domain)) continue;
    seenDomains.add(domain);
    if (isFreemailDomain(domain)) continue;
    for (const token of orgTokensFromDomain(domain)) {
      if (token.length < 3) continue; // too short to route on safely
      const matched = matchProjectByName(token, projects);
      if (matched) add(matched, `attendee @${domain}`, 'attendee-domain');
    }
  }

  // ── Pass B: event title tokens ──
  const titleResult = heuristicProjectRoute(ev.summary, '', projects);
  if (titleResult) add(titleResult.project, titleResult.signal, 'title');

  // ── Pass C: frecency history mapped back to a registered project ──
  const hist = bestHistoryMatch(ev.summary);
  if (hist) {
    const project = projects.find(p => normalizeDir(p.path) === normalizeDir(hist.dir));
    if (project) {
      const label = hist.lastMeetingTitle ? `previously filed "${hist.lastMeetingTitle}"` : 'previously filed here';
      add(project, label, 'history');
    }
  }

  const candidates = Array.from(byDir.values())
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.order - b.order)
    .map(({ order: _order, ...c }) => c);

  const confidence: EventMatchResult['confidence'] =
    candidates.length === 0 ? 'none' : candidates.length === 1 ? 'strong' : 'ambiguous';

  return { candidates, confidence };
}

/**
 * Map an event to the registered project it belongs to, or null. Thin wrapper over
 * `rankEventProjectCandidates`: returns the single top candidate only when the match is
 * unambiguous (exactly one distinct project across all passes), else null — preserving the
 * "never route on noise / never silently pick between rivals" contract. Pure and side-effect free.
 */
export function matchEventToProject(ev: CalendarEvent, projects: Project[]): EventProjectMatch | null {
  const { candidates, confidence } = rankEventProjectCandidates(ev, projects);
  if (confidence !== 'strong') return null;
  const top = candidates[0];
  return { project: top.project, signal: top.signal };
}

/**
 * The earliest calendar event "near" now: an event is near when now falls in [start - lookBack, end).
 * All-day events are skipped (they don't anchor a recording start). Used to offer the same
 * calendar match when a recording is started manually around meeting time.
 */
export function findEventNear(
  events: CalendarEvent[],
  nowMs: number,
  lookBackMs = 10 * 60_000,
): CalendarEvent | null {
  let best: CalendarEvent | null = null;
  for (const ev of events) {
    if (ev.allDay) continue;
    if (ev.startMs - lookBackMs <= nowMs && nowMs < ev.endMs) {
      if (!best || ev.startMs < best.startMs) best = ev;
    }
  }
  return best;
}

/**
 * The most relevant upcoming event for a palette label: an in-progress event first, otherwise the
 * next event starting within lookAhead. All-day events are skipped.
 */
export function findUpcomingEvent(
  events: CalendarEvent[],
  nowMs: number,
  lookAheadMs = 60 * 60_000,
): CalendarEvent | null {
  let inProgress: CalendarEvent | null = null;
  let next: CalendarEvent | null = null;
  for (const ev of events) {
    if (ev.allDay) continue;
    if (ev.startMs <= nowMs && nowMs < ev.endMs) {
      if (!inProgress || ev.startMs < inProgress.startMs) inProgress = ev;
    } else if (ev.startMs > nowMs && ev.startMs - nowMs <= lookAheadMs) {
      if (!next || ev.startMs < next.startMs) next = ev;
    }
  }
  return inProgress ?? next;
}
