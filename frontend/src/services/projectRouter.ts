// Project router — decides which registered Solo project a meeting belongs to, so a call's notes
// file themselves under the right client automatically instead of via a modal. Structured like
// canvasRouter.ts: a fast deterministic pass first (meeting title + transcript keywords vs project
// names/aliases), then an optional one-shot Claude (Haiku) fallback for ambiguous cases. Any
// failure (no key, network, no match) degrades safely to null — the meeting just stays where it is.

import { logger } from '@/lib/logger';
import { Project } from '@/services/projectService';
import { matchProjectByName } from '@/services/soloRoutingService';

export interface ProjectRouteResult {
  project: Project;
  /** Human-readable reason for the match, shown in the "Filed under X (matched …)" toast. */
  signal: string;
  source: 'title' | 'transcript' | 'llm';
}

/** Escape a string for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generic title tokens that carry no client identity. Modeled on projectDirHistory's
 * TITLE_STOPWORDS so a bare "meeting"/"call"/"sync" word can't match a project. The default
 * meeting title is "Meeting 11_07_2026" — all-generic + date, so it yields no distinctive tokens.
 */
const TITLE_STOPWORDS = new Set([
  'sync', 'call', 'calls', 'meeting', 'meetings', 'weekly', 'biweekly', 'monthly',
  'daily', 'review', 'check', 'checkin', 'standup', 'intro', 'demo', 'kickoff',
  'kick', 'follow', 'followup', 'session', 'sessions', 'catch', 'catchup',
  'update', 'updates', 'chat', 'discussion', 'quick', 'onboarding', 'onboard',
  'client', 'project', 'the', 'and', 'with', 'for', 'notes', 'agenda', 'sales',
  'today', 'live', 'recording',
]);

/** Distinctive lowercase tokens (>=3 chars, not a stopword, not starting with a digit). */
function distinctiveTitleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(t => t.length >= 3 && !/^\d/.test(t) && !TITLE_STOPWORDS.has(t));
}

/**
 * Whole-message "file this under X" override grammar. Deliberately narrow so ordinary chat is
 * never swallowed:
 *   - "under" is the one unambiguous filing preposition and may stand alone ("file under Acme")
 *     and carry an article ("file this under the Acme project").
 *   - the overloaded prepositions to/into/in only count when an explicit object word
 *     (this/that/it/everything/the meeting…) anchors the command, AND the tail is NOT a
 *     document-location phrase (a leading article there means ordinary chat).
 *   - the tail must be short and name-like (<= 4 words); a longer tail is a sentence fragment.
 * So "move this to the top of the doc", "put this in the summary", "put that in the appendix"
 * all return null, while "file this under Acme" / "move this to Acme Corp" resolve.
 * Returns the captured project name (still to be resolved fuzzily), or null.
 */
export function parseFileUnderCommand(text: string): string | null {
  const m = text.match(
    /^\s*(?:file|move|put|route)\s+(this|that|it|everything|the\s+(?:meeting|call|session|notes?))?\s*(under|into|in|to)\s+(.+?)\s*[.!?]*\s*$/i,
  );
  if (!m) return null;
  const object = m[1];
  const prep = m[2].toLowerCase();
  let tail = m[3].trim();

  // Weak prepositions (to/into/in) need an explicit object word to count as filing; "under" is
  // unambiguous on its own. ("put in the summary" with no object is just chat.)
  if (prep !== 'under' && !object) return null;

  // "under" may carry an article; for the weak prepositions a leading article signals a
  // document-location phrase ("the top of the doc", "the summary"), not a project name.
  if (prep === 'under') {
    tail = tail.replace(/^(?:the|a|an)\s+/i, '');
  } else if (/^(?:the|a|an)\s+/i.test(tail)) {
    return null;
  }

  // A project name is short. "under" is explicit filing so we allow up to 4 words; the overloaded
  // prepositions get a tighter cap so an article-less fragment ("to top of the doc") can't slip in.
  const words = tail.split(/\s+/).filter(Boolean);
  const maxWords = prep === 'under' ? 4 : 3;
  if (words.length === 0 || words.length > maxWords) return null;

  return tail;
}

/**
 * Deterministic, no-LLM project route. Two passes:
 *  1. Meeting title — each distinctive token AND the whole title run through matchProjectByName.
 *  2. Transcript — count word-boundary mentions of each project name/alias (length >= 3); the
 *     most-mentioned project wins. Uses EXACT (word-boundary) matching only, never the fuzzy pass,
 *     so a generic transcript word can't silently route a new client into an old project's folder.
 * Returns the match, or null when nothing is distinctive enough.
 */
export function heuristicProjectRoute(
  meetingTitle: string | null,
  transcriptText: string,
  projects: Project[],
): ProjectRouteResult | null {
  if (projects.length === 0) return null;

  // 1. Title pass — distinctive tokens first, then the whole title.
  if (meetingTitle) {
    const tokens = distinctiveTitleTokens(meetingTitle);
    for (const token of tokens) {
      const matched = matchProjectByName(token, projects);
      if (matched) {
        return { project: matched, signal: `"${token}" in the meeting title`, source: 'title' };
      }
    }
    if (tokens.length > 0) {
      const whole = matchProjectByName(meetingTitle, projects);
      if (whole) {
        return { project: whole, signal: `"${meetingTitle}" in the meeting title`, source: 'title' };
      }
    }
  }

  // 2. Transcript pass — word-boundary mentions of each project name/alias.
  const haystack = transcriptText.toLowerCase();
  if (haystack.trim()) {
    let best: { project: Project; name: string; count: number } | null = null;
    for (const p of projects) {
      const names = [p.name, ...p.aliases].filter(n => n.length >= 3);
      for (const name of names) {
        const nameLower = name.toLowerCase();
        const re = new RegExp('\\b' + escapeRegExp(nameLower) + '\\b', 'g');
        const count = (haystack.match(re) ?? []).length;
        if (count > 0 && (!best || count > best.count)) {
          best = { project: p, name, count };
        }
      }
    }
    if (best) {
      return {
        project: best.project,
        signal: `"${best.name}" mentioned in the call`,
        source: 'transcript',
      };
    }
  }

  return null;
}

/** One-shot Claude (Haiku) classification. Returns null on any error / missing key / no match. */
export async function llmProjectRoute(
  meetingTitle: string | null,
  transcriptText: string,
  projects: Project[],
  apiKey?: string | null,
): Promise<ProjectRouteResult | null> {
  if (!apiKey || projects.length === 0) return null;

  const projectLines = projects
    .map(p => {
      const aliases = p.aliases.length > 0 ? ` (aliases: ${p.aliases.map(a => `"${a}"`).join(', ')})` : '';
      return `- ${p.name}${aliases}`;
    })
    .join('\n');

  const system =
    'You route a meeting to the project it belongs to. Registered projects:\n' +
    projectLines +
    '\n\nReply with EXACTLY one project name from the list above, or the word "none" if the ' +
    'conversation clearly does not belong to any of them. Reply with the name only, nothing else.';

  const userContent =
    `Meeting title: ${meetingTitle || '(untitled)'}\n\nTranscript so far:\n` +
    transcriptText.slice(0, 1500);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 16,
        system,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
    if (!res.ok) {
      logger.warn('[ProjectRouter] Claude classify HTTP', res.status);
      return null;
    }
    const data = await res.json();
    const text = String(data?.content?.[0]?.text ?? '').trim();
    if (!text || /^none\b/i.test(text)) return null;
    const matched = matchProjectByName(text, projects);
    if (!matched) return null;
    return { project: matched, signal: 'AI matched the conversation', source: 'llm' };
  } catch (e) {
    logger.warn('[ProjectRouter] Claude classify failed', e);
    return null;
  }
}

/**
 * Decide which project a meeting belongs to. Heuristic first (instant, deterministic); only call
 * Haiku when the heuristic finds nothing, a key is available, and there's enough transcript to
 * classify on. Returns the match, or null (leave the meeting where it is).
 */
export async function routeMeetingToProject(opts: {
  meetingTitle: string | null;
  transcriptText: string;
  projects: Project[];
  anthropicKey?: string | null;
}): Promise<ProjectRouteResult | null> {
  const { meetingTitle, transcriptText, projects, anthropicKey } = opts;
  const fast = heuristicProjectRoute(meetingTitle, transcriptText, projects);
  if (fast) return fast;
  if (anthropicKey && transcriptText.length >= 300) {
    return llmProjectRoute(meetingTitle, transcriptText, projects, anthropicKey);
  }
  return null;
}
