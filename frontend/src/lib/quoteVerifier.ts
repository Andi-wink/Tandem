/**
 * quoteVerifier: the deterministic (non-model) anti-hallucination backbone for enhanced notes.
 *
 * After the model returns Markdown, every double-quoted span is checked against the actual transcript.
 * A quote passes only if, after light normalization (lowercase, unify quotes/dashes, strip most
 * punctuation, collapse whitespace), it appears as a CONTIGUOUS substring of the normalized transcript.
 * Anything that does not verify is visibly marked "[unverified]" in the saved notes.
 *
 * Why contiguous-substring and not a looser fuzzy score: the threats are (a) paraphrased fake quotes,
 * (b) quotes spliced from two real but separate moments, and (c) quotes lifted from the wrong place.
 * Normalization absorbs the legitimate near-misses (punctuation, casing, smart quotes, spacing) while
 * contiguity defeats splicing and paraphrase, because a spliced or reworded quote is not a single
 * run of words that occurs verbatim in the source. A looser token-overlap score would let both
 * attacks through, so we deliberately avoid it.
 *
 * TIMESTAMP LOCALIZATION (defends attack c): a verbatim quote lifted from an unrelated moment far away
 * in the call and mis-stamped next to the wrong jot must NOT verify. So when the caller supplies the
 * transcript as timestamped segments, a quote that prints an [MM:SS] stamp is checked only against the
 * window of transcript AROUND that claimed stamp, never the whole call. A real quote whose printed
 * stamp points 40 minutes from where it was actually said fails, because it is not contiguous inside
 * the window its own stamp claims. A plain-string source (no timings) falls back to whole-transcript
 * contiguity, which keeps the pure unit tests and any timing-free caller working unchanged.
 *
 * UNSTAMPED QUOTES WITH SEGMENT DATA (closes the localization bypass): the prompt rules require every
 * quote to print its [MM:SS] stamp, so a model that omits the stamp is off-spec. With segment data
 * present we must NOT let such a quote fall back to whole-call contiguity, because that is exactly the
 * un-localized behavior the wrong-moment defense exists to prevent (a model could drop every stamp and
 * quote from anywhere). Instead, an unstamped quote is verified only against the union of the jot
 * windows that were actually put in the prompt (passed in as `jotCentersSec`): it passes if it is a
 * contiguous span of ANY single jot's window, and fails closed ([unverified]) when no jot centers are
 * supplied. Checking each window individually (not one concatenated blob) keeps the anti-splice
 * invariant: a quote can never be stitched across two disjoint windows. The invariant across all paths:
 * when segment data exists, no quote is ever verified against transcript outside its claimed or
 * attributable moment.
 *
 * This module is pure and unit-tested.
 */

/** A transcript segment with its recording-relative start time in SECONDS. */
export interface StampedSegment {
  startSec: number;
  text: string;
}

/**
 * What a quote is verified against. A plain string is the whole transcript with no timing (un-localized,
 * legacy/best-effort). An array of StampedSegment enables timestamp-localized verification.
 */
export type TranscriptSource = string | StampedSegment[];

/**
 * How far (in seconds) from a quote's claimed [MM:SS] stamp we still accept a match. Generous enough to
 * absorb segment-boundary timing drift and a quote that spans a couple of segments, but far tighter than
 * the minutes-apart gap a mis-attributed quote would need, so the wrong-moment attack cannot pass.
 */
const MATCH_TOLERANCE_SEC = 120;

/**
 * Half-width (in seconds) of the per-jot window an UNSTAMPED quote is verified against. Mirrors
 * meetingJots' WINDOW_SEC (the +/-90s window the prompt builds around each jot) so the verifier checks a
 * quote against the same transcript region the model was actually shown for that jot.
 */
const JOT_WINDOW_SEC = 90;

/**
 * Normalize text for verification. Lowercases, converts smart quotes/dashes to plain, removes
 * punctuation that a transcriber or the model might add or drop, and collapses runs of whitespace.
 * Apostrophes inside words are dropped ("don't" -> "dont") so contractions match regardless of the
 * exact glyph used.
 */
export function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    // Unify quote and dash glyphs before stripping so nothing survives as a stray symbol.
    .replace(/[‘’′ʼ`]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—‒―]/g, '-')
    // Drop apostrophes entirely so "don't" == "dont".
    .replace(/'/g, '')
    // Everything that is not a letter, digit, or whitespace becomes a space.
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract quoted spans from Markdown. Matches straight ("...") and curly (“...”) double
 * quotes. Returns each with the character index of the closing quote in the ORIGINAL string, so the
 * marker can be inserted right after it without disturbing earlier offsets, plus the [MM:SS] stamp the
 * model printed immediately after the quote (in seconds), if any, so verification can be localized.
 */
export interface QuotedSpan {
  /** The inner text of the quote (without the surrounding quote characters). */
  text: string;
  /** Index in the original string just AFTER the closing quote character. */
  endIndex: number;
  /** The claimed time in seconds parsed from a trailing [MM:SS] stamp, or null if the quote has none. */
  claimedSec: number | null;
}

/** A trailing [MM:SS] stamp (minutes may exceed 59, e.g. [75:30]); [--:--] intentionally does not match. */
const TRAILING_STAMP = /^\s*\[(\d{1,3}):([0-5]?\d)\]/;

export function extractQuotedSpans(markdown: string): QuotedSpan[] {
  const spans: QuotedSpan[] = [];
  // Straight double quotes, then curly pairs. Non-greedy, no newlines inside a quote.
  const patterns = [/"([^"\n]+)"/g, /“([^”\n]+)”/g];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(markdown)) !== null) {
      const endIndex = m.index + m[0].length;
      const stamp = TRAILING_STAMP.exec(markdown.slice(endIndex));
      const claimedSec = stamp ? Number(stamp[1]) * 60 + Number(stamp[2]) : null;
      spans.push({ text: m[1], endIndex, claimedSec });
    }
  }
  return spans;
}

/** True when the normalized quote is a contiguous substring of the normalized haystack. */
function contiguousMatch(nq: string, nHaystack: string): boolean {
  if (!nq) return false;
  // Pad with spaces so a whole-string match still works and word boundaries stay intact.
  return ` ${nHaystack} `.includes(` ${nq} `) || nHaystack.includes(nq);
}

/** Join the text of every segment whose start falls within +/- tolerance of centerSec. */
function windowText(segments: StampedSegment[], centerSec: number, toleranceSec: number): string {
  const lo = centerSec - toleranceSec;
  const hi = centerSec + toleranceSec;
  return segments
    .filter((s) => s.startSec >= lo && s.startSec <= hi)
    .map((s) => s.text)
    .join(' ');
}

/**
 * Does `quote` verify against `source`?
 *
 * - String source: contiguous substring of the whole (un-localized) transcript.
 * - Segment source with a claimed stamp: contiguous substring of ONLY the transcript window around that
 *   stamp, so a real quote mis-stamped far from where it was said does not verify.
 * - Segment source WITHOUT a claimed stamp: contiguous substring of ANY single jot window (from
 *   `jotCentersSec`); fails closed when no jot centers are supplied. Never whole-call (that would be the
 *   localization bypass a stampless model could ride).
 *
 * A quote that normalizes to empty (only punctuation) never verifies.
 */
export function verifyQuote(
  quote: string,
  source: TranscriptSource,
  claimedSec?: number | null,
  jotCentersSec?: readonly number[] | null,
): boolean {
  const nq = normalizeForMatch(quote);
  if (!nq) return false;

  if (typeof source === 'string') {
    return contiguousMatch(nq, normalizeForMatch(source));
  }

  if (claimedSec !== null && claimedSec !== undefined) {
    // Localized: the quote must occur near its own claimed stamp, not merely somewhere in the call.
    return contiguousMatch(nq, normalizeForMatch(windowText(source, claimedSec, MATCH_TOLERANCE_SEC)));
  }

  // No stamp with segment data present: do NOT fall back to whole-call contiguity (the bypass). Verify
  // only against the jot windows actually placed in the prompt, one at a time so a quote cannot be
  // spliced across two windows. No centers -> fail closed so the quote is marked [unverified].
  if (!jotCentersSec || jotCentersSec.length === 0) return false;
  return jotCentersSec.some((c) =>
    contiguousMatch(nq, normalizeForMatch(windowText(source, c, JOT_WINDOW_SEC))),
  );
}

/**
 * Mark every unverified quote in the Markdown by inserting " [unverified]" immediately after the
 * closing quote. Verified quotes and quotes already followed by an [unverified] marker are left
 * alone. Pure: returns a new string. Insertions are applied right-to-left so indices stay valid.
 */
export function markUnverifiedQuotes(
  markdown: string,
  source: TranscriptSource,
  jotCentersSec?: readonly number[] | null,
): string {
  const spans = extractQuotedSpans(markdown)
    .filter((s) => !verifyQuote(s.text, source, s.claimedSec, jotCentersSec))
    .sort((a, b) => b.endIndex - a.endIndex);

  let out = markdown;
  const MARKER = ' [unverified]';
  for (const span of spans) {
    // Skip if a marker is already present right after this quote (idempotent re-runs / regenerate).
    if (out.slice(span.endIndex, span.endIndex + MARKER.length) === MARKER) continue;
    out = out.slice(0, span.endIndex) + MARKER + out.slice(span.endIndex);
  }
  return out;
}

/** Count unverified quotes without mutating: useful for a summary toast or a QA assertion. */
export function countUnverifiedQuotes(
  markdown: string,
  source: TranscriptSource,
  jotCentersSec?: readonly number[] | null,
): number {
  return extractQuotedSpans(markdown).filter((s) => !verifyQuote(s.text, source, s.claimedSec, jotCentersSec)).length;
}
