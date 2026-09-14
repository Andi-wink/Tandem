/**
 * Normalise the whiteboard's flattened text (`whiteboard.md`) for embedding in another document.
 *
 * The canvas writes that file as a standalone document: an H1 "# Whiteboard", a "## Text" heading,
 * and, when the board carries nothing readable, the placeholder
 * `_(no text or HTML content on the board)_`. Dropping it verbatim into HANDOVER.md would put a
 * second H1 in the middle of the file, duplicate the section heading we just wrote, and, on the
 * majority of real boards (four of six in the local recordings folder), print a placeholder that
 * reads as a bug.
 *
 * Structure is flattened rather than trusted: any remaining heading becomes bold text so it can't
 * outrank the handover's own headings, code fences are stripped so an unterminated one can't swallow
 * the rest of the document, and a line that is only punctuation is escaped so it can't render as a
 * thematic break (`---`, `***`, `___`) or as a setext underline (`=` or `-` at any count, which
 * promotes the line above it to a heading).
 *
 * Pure and framework-free, so both the markdown and the HTML export share one normalisation.
 */

/** The exact placeholder the canvas writes when a board has no text or HTML on it. */
const PLACEHOLDER = /^_\(no text or HTML content on the board\)_$/;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const THEMATIC_BREAK = /^\s{0,3}((-\s*){3,}|(\*\s*){3,}|(_\s*){3,})$/;
/**
 * A setext underline: a line of only `=` or only `-` promotes the line ABOVE it to a heading, at any
 * count, so a single `=` under a board line would silently turn it into an H1 in the handover.
 * Escaped for the same reason as a thematic break. This subsumes the `---` case of the rule above.
 */
const SETEXT_UNDERLINE = /^\s{0,3}(=+|-+)\s*$/;

export function normalizeBoardText(raw: string): string {
  if (!raw) return '';

  const out: string[] = [];
  let seenContent = false;

  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) continue;
    if (PLACEHOLDER.test(line.trim())) continue;

    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      // The canvas's own document furniture: its title (only while nothing has been kept yet, so a
      // board that genuinely writes "Whiteboard" later survives) and its section headings.
      if (!seenContent && level === 1 && text.toLowerCase() === 'whiteboard') continue;
      if (level === 2 && (text.toLowerCase() === 'text' || text.toLowerCase() === 'html')) continue;
      if (!text) continue;
      out.push(`**${text}**`);
      seenContent = true;
      continue;
    }

    if (THEMATIC_BREAK.test(line) || SETEXT_UNDERLINE.test(line)) {
      out.push(`\\${line.trim()}`);
      continue;
    }

    out.push(line);
    if (line.trim()) seenContent = true;
  }

  // Collapse the runs of blank lines the removals leave behind, then drop the document entirely if
  // all that survived was whitespace.
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}
