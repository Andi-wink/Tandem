/**
 * The human-readable twin of the handover markdown.
 *
 * The markdown file is the durable, diff-friendly record and references its screenshots as relative
 * paths into the meeting folder's `screenshots/` directory. That renders correctly in any editor
 * sitting in that folder, but it stops rendering the moment the file is moved, copied or emailed on
 * its own, which is exactly what happens when a call is handed to someone else.
 *
 * So this produces a single self-contained HTML file with every image inlined as a data URI. It
 * survives being sent anywhere, opens in any browser with no app, and carries a print stylesheet so
 * Ctrl+P gives a clean PDF without a PDF toolchain in the build.
 *
 * Pure: the caller resolves images to data URIs and passes them in, so this stays unit-testable and
 * free of Tauri.
 */

import type { HandoverData, HandoverItem } from '@/lib/handoverDoc';
import { formatStamp } from '@/lib/handoverDoc';

/** Escape text for HTML body context. Every string here is user content, so nothing is trusted. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Linkify bare URLs in already-escaped text, so a link the user typed is clickable in the export.
 * Runs after escaping, and matches only the character classes escaping leaves untouched.
 */
function linkify(escaped: string): string {
  return escaped.replace(/\b(https?:\/\/|www\.)[^\s<]+/g, (m) => {
    const href = m.startsWith('www.') ? `https://${m}` : m;
    return `<a href="${href}">${m}</a>`;
  });
}

const STYLES = `
:root {
  --ink: #18181b;
  --muted: #71717a;
  --rule: #e4e4e7;
  --accent: #0f766e;
  --surface: #fafafa;
}
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  padding: 48px 32px 96px;
  max-width: 46rem;
  font: 16px/1.65 ui-sans-serif, "Source Sans 3", -apple-system, "Segoe UI", system-ui, sans-serif;
  color: var(--ink);
  background: #fff;
  -webkit-font-smoothing: antialiased;
}
h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 4px; letter-spacing: -0.02em; }
h2 {
  font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--muted); margin: 48px 0 16px; padding-bottom: 8px; border-bottom: 1px solid var(--rule);
}
.meta { color: var(--muted); font-size: 0.9rem; margin: 0 0 32px; }
.meta span + span::before { content: "·"; margin: 0 8px; }

.links { list-style: none; padding: 0; margin: 0; }
.links li { margin-bottom: 8px; padding-left: 20px; position: relative; word-break: break-word; }
.links li::before { content: "↗"; position: absolute; left: 0; color: var(--accent); }
.links .origin { color: var(--muted); font-size: 0.85rem; margin-left: 6px; white-space: nowrap; }

/* One time gutter down the left so the eye can scan the call by when things happened. */
.entry { display: grid; grid-template-columns: 4.5rem 1fr; gap: 16px; margin-bottom: 18px; }
.stamp {
  font: 500 0.8rem/1.9 ui-monospace, "Cascadia Code", Consolas, monospace;
  color: var(--muted); font-variant-numeric: tabular-nums; text-align: right;
}
.body { min-width: 0; }
.speech { margin: 0; }
.note {
  margin: 0; padding: 10px 14px; background: var(--surface);
  border-left: 3px solid var(--accent); border-radius: 0 4px 4px 0; word-break: break-word;
}
.note .label {
  display: block; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--accent); font-weight: 600; margin-bottom: 2px;
}
figure { margin: 0; }
figure img { display: block; width: 100%; border: 1px solid var(--rule); border-radius: 6px; }
figcaption { color: var(--muted); font-size: 0.8rem; margin-top: 6px; }
.missing {
  padding: 12px 14px; border: 1px dashed var(--rule); border-radius: 6px;
  color: var(--muted); font-size: 0.85rem;
}
pre {
  margin: 0; padding: 12px 14px; background: var(--surface); border: 1px solid var(--rule);
  border-radius: 6px; overflow-x: auto;
  font: 0.85rem/1.5 ui-monospace, "Cascadia Code", Consolas, monospace;
  white-space: pre-wrap; word-break: break-word;
}
.clip-label {
  display: block; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--muted); font-weight: 600; margin-bottom: 4px;
}
a { color: var(--accent); }
footer { margin-top: 64px; padding-top: 16px; border-top: 1px solid var(--rule); color: var(--muted); font-size: 0.8rem; }
.empty { color: var(--muted); font-style: italic; }

@media print {
  /* Print is the PDF path, so it gets real attention rather than whatever the browser defaults to. */
  @page { margin: 18mm 16mm; }
  body { padding: 0; max-width: none; font-size: 11pt; }
  h2 { margin-top: 24px; }
  .entry { break-inside: avoid; page-break-inside: avoid; }
  figure { break-inside: avoid; page-break-inside: avoid; }
  figure img { max-height: 17cm; width: auto; max-width: 100%; }
  a { color: inherit; text-decoration: underline; }
  footer { break-before: avoid; }
}
`;

function renderEntry(item: HandoverItem, images: Map<string, string>): string {
  const stamp = `<div class="stamp">${formatStamp(item.elapsedSecs)}</div>`;
  let body: string;

  switch (item.type) {
    case 'speech':
      body = `<p class="speech">${linkify(escapeHtml(item.text))}</p>`;
      break;

    case 'note':
      body = `<div class="note"><span class="label">Note</span>${linkify(escapeHtml(item.text))}</div>`;
      break;

    case 'screenshot': {
      const src = item.filePath ? images.get(item.filePath) : undefined;
      const mode = item.captureMode === 'region' ? 'region' : 'full screen';
      body = src
        ? `<figure><img alt="Screenshot at ${formatStamp(item.elapsedSecs)}" src="${src}">` +
          `<figcaption>Screenshot (${mode})</figcaption></figure>`
        // An image that could not be read is called out rather than dropped: a silent gap would
        // misrepresent the call as having no screenshot at this moment.
        : `<div class="missing">Screenshot could not be embedded (${escapeHtml(item.filePath ?? 'unknown path')})</div>`;
      break;
    }

    case 'clipboard': {
      if (item.contentType === 'image') {
        const src = item.filePath ? images.get(item.filePath) : undefined;
        body = src
          ? `<figure><img alt="Clipboard image at ${formatStamp(item.elapsedSecs)}" src="${src}">` +
            `<figcaption>Clipboard image</figcaption></figure>`
          : `<div class="missing">Clipboard image could not be embedded</div>`;
      } else {
        body = `<span class="clip-label">Copied</span><pre>${escapeHtml(item.text)}</pre>`;
      }
      break;
    }
  }

  return `<div class="entry">${stamp}<div class="body">${body}</div></div>`;
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

/**
 * Render the handover document as one self-contained HTML file.
 *
 * `images` maps a capture's absolute file path to a data URI. Any path missing from the map renders
 * as a visible placeholder rather than a broken image.
 */
export function generateHandoverHtml(data: HandoverData, images: Map<string, string>): string {
  const parsed = new Date(data.date);
  const dateLabel = Number.isNaN(parsed.getTime())
    ? data.date
    : parsed.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const meta = [`<span>${escapeHtml(dateLabel)}</span>`];
  if (data.durationSeconds != null) meta.push(`<span>${formatDuration(data.durationSeconds)}</span>`);
  meta.push(`<span>${data.timeline.length} entries</span>`);

  const parts: string[] = [];
  parts.push('<!DOCTYPE html>');
  parts.push('<html lang="en"><head><meta charset="utf-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  parts.push(`<title>Handover: ${escapeHtml(data.meetingName)}</title>`);
  parts.push(`<style>${STYLES}</style>`);
  parts.push('</head><body>');

  parts.push(`<h1>${escapeHtml(data.meetingName)}</h1>`);
  parts.push(`<p class="meta">${meta.join('')}</p>`);

  if (data.links.length > 0) {
    parts.push('<h2>Links</h2><ul class="links">');
    for (const link of data.links) {
      const origin = link.from === 'note' ? 'typed' : 'copied';
      parts.push(
        `<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.url)}</a>` +
        `<span class="origin">${origin} at ${formatStamp(link.elapsedSecs)}</span></li>`,
      );
    }
    parts.push('</ul>');
  }

  parts.push('<h2>Timeline</h2>');
  if (data.timeline.length === 0) {
    parts.push('<p class="empty">Nothing was captured on this call.</p>');
  } else {
    for (const item of data.timeline) parts.push(renderEntry(item, images));
  }

  parts.push('<footer>Generated by Tandem. Verbatim capture, no AI summarisation.</footer>');
  parts.push('</body></html>');

  return parts.join('\n');
}
