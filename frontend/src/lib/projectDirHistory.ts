/**
 * projectDirHistory — a lightweight frecency store for recently used project
 * directories, persisted in localStorage. Powers the ProjectPicker's "recents"
 * so a repeat client's folder is one keystroke away instead of several clicks.
 *
 * Pure TypeScript, no React. Every localStorage access is guarded for SSR.
 */

const STORAGE_KEY = 'tandem.projectDirHistory';
const MAX_ENTRIES = 30;
const HALF_LIFE_MS = 14 * 24 * 3600 * 1000; // 14-day half-life

export interface ProjectDirHistoryEntry {
  /** Original-cased directory path as the user selected it (display value). */
  dir: string;
  /** Human label, usually the last path segment. */
  name: string;
  /** Epoch ms of the most recent use. */
  lastUsed: number;
  /** How many times this dir has been confirmed. */
  count: number;
  /** Title of the meeting it was last used for (drives title-aware matching). */
  lastMeetingTitle?: string;
}

/** Normalize a path for equality/dedupe: forward slashes, no trailing slash, lowercased. */
export function normalizeDir(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
}

function readRaw(): ProjectDirHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is ProjectDirHistoryEntry =>
        e && typeof e.dir === 'string' && typeof e.name === 'string',
    );
  } catch {
    // Corrupt key — degrade to empty, never throw during render.
    return [];
  }
}

function writeRaw(entries: ProjectDirHistoryEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage full / disabled — silently ignore.
  }
}

/** Frecency score: usage count weighted by an exponential recency decay. */
export function frecencyScore(entry: ProjectDirHistoryEntry, now: number = Date.now()): number {
  const age = Math.max(0, now - entry.lastUsed);
  return entry.count * Math.pow(0.5, age / HALF_LIFE_MS);
}

/** All history entries, highest frecency first. */
export function getProjectDirHistory(): ProjectDirHistoryEntry[] {
  const now = Date.now();
  return readRaw().sort((a, b) => frecencyScore(b, now) - frecencyScore(a, now));
}

/** Record (or bump) a directory use. Dedupes by normalized path. */
export function recordProjectDirUse(dir: string, name: string, meetingTitle?: string | null): void {
  if (!dir || !dir.trim()) return;
  const key = normalizeDir(dir);
  const entries = readRaw();
  const now = Date.now();
  const existing = entries.find(e => normalizeDir(e.dir) === key);
  if (existing) {
    existing.count += 1;
    existing.lastUsed = now;
    existing.dir = dir; // keep the freshest original casing
    existing.name = name || existing.name;
    if (meetingTitle) existing.lastMeetingTitle = meetingTitle;
  } else {
    entries.push({ dir, name, lastUsed: now, count: 1, lastMeetingTitle: meetingTitle ?? undefined });
  }
  // Cap the list at MAX_ENTRIES by lowest frecency.
  entries.sort((a, b) => frecencyScore(b, now) - frecencyScore(a, now));
  writeRaw(entries.slice(0, MAX_ENTRIES));
}

/**
 * Undo one recorded use of a directory. Decrements the frecency count and removes the entry when
 * it reaches zero, so a mis-routed auto-file the user Undoes does not leave a permanent +1 boost on
 * the wrong folder (which would then out-rank the correct folder in the picker recents). A plain
 * decrement-by-one is correct even when other real uses contributed: their counts remain. No-op
 * when the dir is not tracked. Dedupes by normalized path, matching recordProjectDirUse.
 */
export function forgetProjectDirUse(dir: string): void {
  if (!dir || !dir.trim()) return;
  const key = normalizeDir(dir);
  const entries = readRaw();
  const idx = entries.findIndex(e => normalizeDir(e.dir) === key);
  if (idx === -1) return;
  entries[idx].count -= 1;
  if (entries[idx].count <= 0) entries.splice(idx, 1);
  writeRaw(entries);
}

/**
 * Generic meeting words that carry no client identity. Two unrelated clients
 * routinely share these ("Weekly Sync — Acme" vs "Weekly Sync — Globex"), so a
 * bare overlap on them must NOT be treated as a match — that would silently
 * route a new client's session into a prior, unrelated client's folder.
 */
const TITLE_STOPWORDS = new Set([
  'sync', 'call', 'calls', 'meeting', 'meetings', 'weekly', 'biweekly', 'monthly',
  'daily', 'review', 'check', 'checkin', 'standup', 'intro', 'demo', 'kickoff',
  'kick', 'follow', 'followup', 'session', 'sessions', 'catch', 'catchup',
  'update', 'updates', 'chat', 'discussion', 'quick', 'onboarding', 'onboard',
  'client', 'project', 'the', 'and', 'with', 'for', 'notes', 'agenda', 'sales',
]);

/** Tokenize a title into lowercase word tokens (>=3 chars). */
function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(t => t.length >= 3);
}

/** Distinctive (non-stopword) tokens — the ones that actually identify a client. */
function meaningfulTokens(title: string): string[] {
  return titleTokens(title).filter(t => !TITLE_STOPWORDS.has(t));
}

/** Whole-title equality after lowercasing and collapsing non-alphanumerics. */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/gi, ' ').trim();
}

/**
 * Best history entry for a given meeting title. Requires a STRONG title signal before
 * claiming a match, so a new client is never silently routed into an old client's folder:
 *   1. exact/near-exact whole-title match, or
 *   2. a distinctive single token (client name) shared, or
 *   3. two or more shared distinctive tokens, or
 *   4. null when the title carries no matching signal.
 *
 * There is deliberately NO "highest-frecency neutral default" fallback: callers use this to
 * pre-select / auto-confirm a picker row, and defaulting to an unrelated prior client's folder
 * would let a single Enter file a brand-new client's notes under a stale project. On a null the
 * callers anchor to the always-safe meeting-folder row instead.
 */
export function bestHistoryMatch(meetingTitle?: string | null): ProjectDirHistoryEntry | null {
  const entries = getProjectDirHistory(); // already frecency-sorted
  if (entries.length === 0) return null;

  if (meetingTitle) {
    // 1. Exact/near-exact whole-title match (strongest possible signal).
    const wantedNorm = normalizeTitle(meetingTitle);
    if (wantedNorm) {
      const exact = entries.find(
        e => e.lastMeetingTitle && normalizeTitle(e.lastMeetingTitle) === wantedNorm,
      );
      if (exact) return exact;
    }

    // 2/3. Distinctive-token overlap (stopwords stripped, so generic words can't match).
    const wanted = new Set(meaningfulTokens(meetingTitle));
    if (wanted.size > 0) {
      // A single distinctive token (e.g. a client name) is enough; a match on
      // two or more distinctive tokens is even stronger. Generic words never reach here.
      const required = wanted.size === 1 ? 1 : 2;
      const tokenMatch = entries.find(e => {
        if (!e.lastMeetingTitle) return false;
        const shared = meaningfulTokens(e.lastMeetingTitle).filter(t => wanted.has(t));
        return shared.length >= required;
      });
      if (tokenMatch) return tokenMatch;
    }
  }

  // No title signal — return null so the caller falls back to the safe meeting-folder row
  // rather than pre-selecting an unrelated high-frecency client folder.
  return null;
}
