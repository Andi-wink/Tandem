import { describe, it, expect } from 'vitest';
import {
  normalizeForMatch,
  extractQuotedSpans,
  verifyQuote,
  markUnverifiedQuotes,
  countUnverifiedQuotes,
  type StampedSegment,
} from './quoteVerifier';

const TRANSCRIPT = [
  'So the budget is tight this quarter, we cannot commit to the full scope.',
  'But the timeline is fine, we can ship the first phase by March.',
  "Honestly, we're worried about the onboarding cost more than anything.",
].join(' ');

describe('normalizeForMatch', () => {
  it('lowercases, unifies smart quotes/dashes, drops punctuation and apostrophes', () => {
    expect(normalizeForMatch('We’re Worried — About, Cost.')).toBe('were worried about cost');
    expect(normalizeForMatch('“the   BUDGET  is tight”')).toBe('the budget is tight');
  });
});

describe('extractQuotedSpans', () => {
  it('finds straight and curly double-quoted spans with correct end offsets', () => {
    const md = 'He said "hello there" and also “goodbye now” to them.';
    const spans = extractQuotedSpans(md);
    expect(spans.map((s) => s.text).sort()).toEqual(['goodbye now', 'hello there']);
    for (const s of spans) {
      // The char just before endIndex must be a closing quote.
      expect(['"', '”']).toContain(md[s.endIndex - 1]);
    }
  });
});

describe('verifyQuote', () => {
  it('passes a verbatim quote', () => {
    expect(verifyQuote('the budget is tight this quarter', TRANSCRIPT)).toBe(true);
  });

  it('passes a legitimate near-miss (case, punctuation, smart quotes)', () => {
    expect(verifyQuote('The Budget Is Tight This Quarter!', TRANSCRIPT)).toBe(true);
    expect(verifyQuote("we're worried about the onboarding cost", TRANSCRIPT)).toBe(true);
    expect(verifyQuote('were worried about the onboarding cost', TRANSCRIPT)).toBe(true);
  });

  it('FLAGS a fabricated quote that never occurs', () => {
    expect(verifyQuote('we guarantee a full refund within thirty days', TRANSCRIPT)).toBe(false);
  });

  it('FLAGS a paraphrased fake (same idea, different words)', () => {
    // Transcript: "the budget is tight this quarter". Paraphrase reworded -> not a contiguous span.
    expect(verifyQuote('the budget is really constrained this quarter', TRANSCRIPT)).toBe(false);
    expect(verifyQuote('they are anxious about the onboarding expense', TRANSCRIPT)).toBe(false);
  });

  it('FLAGS a spliced quote stitched from two separate real spans', () => {
    // Both fragments are verbatim, but they come from different sentences and are not contiguous.
    expect(verifyQuote('the budget is tight but the timeline is fine', TRANSCRIPT)).toBe(false);
  });

  it('does not verify an empty or punctuation-only quote', () => {
    expect(verifyQuote('   ', TRANSCRIPT)).toBe(false);
    expect(verifyQuote('...', TRANSCRIPT)).toBe(false);
  });
});

describe('markUnverifiedQuotes', () => {
  it('marks only the failing quotes and leaves verified ones alone', () => {
    const md =
      'They noted "the budget is tight this quarter" clearly. ' +
      'Then claimed "we guarantee a full refund within thirty days" which is false.';
    const out = markUnverifiedQuotes(md, TRANSCRIPT);
    expect(out).toContain('"the budget is tight this quarter" clearly');
    expect(out).toContain('"we guarantee a full refund within thirty days" [unverified]');
    // Only one marker inserted.
    expect(out.match(/\[unverified\]/g)).toHaveLength(1);
  });

  it('marks a spliced quote', () => {
    const md = 'Summary: "the budget is tight but the timeline is fine".';
    const out = markUnverifiedQuotes(md, TRANSCRIPT);
    expect(out).toContain('the timeline is fine" [unverified]');
  });

  it('is idempotent: a second pass does not double-mark', () => {
    const md = 'Claim "totally made up sentence here".';
    const once = markUnverifiedQuotes(md, TRANSCRIPT);
    const twice = markUnverifiedQuotes(once, TRANSCRIPT);
    expect(once.match(/\[unverified\]/g)).toHaveLength(1);
    expect(twice.match(/\[unverified\]/g)).toHaveLength(1);
  });

  it('countUnverifiedQuotes matches the number of marks', () => {
    const md = '"the budget is tight this quarter" and "fabricated thing" and "another fake claim"';
    expect(countUnverifiedQuotes(md, TRANSCRIPT)).toBe(2);
  });
});

// ── Timestamp-localized verification (the wrong-moment attack) ────────────────

// A call with a jot's own moment early on and a genuinely-spoken line 50 minutes later.
const STAMPED: StampedSegment[] = [
  { startSec: 30, text: 'nothing relevant here about pricing' },
  { startSec: 3000, text: 'we will definitely renew for another year at full price' },
];

describe('extractQuotedSpans (trailing [MM:SS] stamp)', () => {
  it('captures the claimed timestamp printed right after a quote', () => {
    const md = 'They said "we will definitely renew for another year at full price" [00:31].';
    const spans = extractQuotedSpans(md);
    expect(spans).toHaveLength(1);
    expect(spans[0].claimedSec).toBe(31);
  });

  it('handles minutes over 59 and treats [--:--] as no stamp', () => {
    expect(extractQuotedSpans('"x" [75:30]')[0].claimedSec).toBe(75 * 60 + 30);
    expect(extractQuotedSpans('"x" [--:--]')[0].claimedSec).toBeNull();
    expect(extractQuotedSpans('"x" said the client')[0].claimedSec).toBeNull();
  });
});

describe('verifyQuote (timestamp localization)', () => {
  const REAL = 'we will definitely renew for another year at full price';

  it('verifies a real quote stamped at the moment it was actually said', () => {
    expect(verifyQuote(REAL, STAMPED, 3000)).toBe(true);
  });

  it('FLAGS a real quote mis-stamped far from where it was said (the wrong-moment attack)', () => {
    // Verbatim in the call, but its printed stamp claims 00:31 where only unrelated speech occurs.
    expect(verifyQuote(REAL, STAMPED, 31)).toBe(false);
  });

  it('without a claimed stamp AND no jot centers, fails closed (segment data present)', () => {
    // The localization-bypass fix: a stampless quote must NOT get whole-call contiguity when we have
    // segment timings. With no jot windows to attribute it to, it fails closed even though it is
    // verbatim somewhere in the call.
    expect(verifyQuote(REAL, STAMPED, null)).toBe(false);
    expect(verifyQuote(REAL, STAMPED, undefined)).toBe(false);
    expect(verifyQuote(REAL, STAMPED, null, [])).toBe(false);
  });

  it('without a stamp, verifies against a jot window that actually contains the quote', () => {
    // Legitimate unstamped quote: a jot was flagged at 3000s, the quote is verbatim in that window.
    expect(verifyQuote(REAL, STAMPED, null, [3000])).toBe(true);
    // Nearest jot center wins even among several.
    expect(verifyQuote(REAL, STAMPED, null, [30, 1200, 3000])).toBe(true);
  });

  it('without a stamp, FLAGS a quote that matches only a far-away jot window (fail closed)', () => {
    // The only jot is at 30s; REAL is spoken at 3000s, ~49 minutes outside any +/-90s window -> no match.
    expect(verifyQuote(REAL, STAMPED, null, [30])).toBe(false);
    // A line spoken nowhere never verifies regardless of centers.
    expect(verifyQuote('a line never spoken anywhere', STAMPED, null, [30, 3000])).toBe(false);
  });

  it('does not splice a stampless quote across two disjoint jot windows', () => {
    // "pricing" is in the 30s window, "renew for another year" in the 3000s window. Neither window on its
    // own contains this stitched span, so even with both centers supplied it must fail.
    const spliced = 'about pricing we will definitely renew for another year';
    expect(verifyQuote(spliced, STAMPED, null, [30, 3000])).toBe(false);
  });

  it('markUnverifiedQuotes threads jot centers so a legitimate unstamped quote is left alone', () => {
    const md = `They were clear: "${REAL}".`;
    // With the jot center that contains it, no marker.
    expect(countUnverifiedQuotes(md, STAMPED, [3000])).toBe(0);
    expect(markUnverifiedQuotes(md, STAMPED, [3000])).toBe(md);
    // Without centers, the same unstamped quote is marked (fail closed).
    expect(countUnverifiedQuotes(md, STAMPED)).toBe(1);
    expect(markUnverifiedQuotes(md, STAMPED)).toContain(`"${REAL}" [unverified]`);
  });

  it('markUnverifiedQuotes marks a verbatim quote pinned to the wrong timestamp', () => {
    const md = `The client was hesitant. "${REAL}" [00:31] came up near the pricing worry.`;
    const out = markUnverifiedQuotes(md, STAMPED);
    expect(out).toContain(`"${REAL}" [unverified]`);
    expect(countUnverifiedQuotes(md, STAMPED)).toBe(1);
  });

  it('leaves a correctly-stamped quote untouched', () => {
    const md = `Later they committed: "${REAL}" [50:00].`;
    expect(countUnverifiedQuotes(md, STAMPED)).toBe(0);
    expect(markUnverifiedQuotes(md, STAMPED)).toBe(md);
  });
});
