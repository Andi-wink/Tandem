/**
 * Action-items extraction + per-meeting checkbox persistence (I4).
 *
 * The summary pipeline already emits an "Immediate Action Items" section (see
 * backend final_summary), and models that return freeform markdown put the items
 * under an "Action Items"-style heading. Rather than migrate the schema, we PARSE
 * the action items out of whichever summary shape we were handed and render them as
 * a checklist. Checkbox state is persisted in localStorage keyed by meeting id, so
 * there is no schema change.
 *
 * The extraction functions are pure (no DOM / storage) so they can be unit tested.
 */

/** Matches a heading whose text is about action items (or "immediate action items"). */
const ACTION_HEADING_RE = /action items/i;

/** Strips a leading list marker ("-", "*", "+", "1.", "1)") and an optional GFM checkbox. */
function stripListMarker(line: string): string {
  let s = line.trim();
  // Bullet or numbered marker
  s = s.replace(/^([-*+]|\d+[.)])\s+/, '');
  // GFM task checkbox: [ ] or [x]
  s = s.replace(/^\[[ xX]\]\s+/, '');
  return s.trim();
}

/** True if a markdown line is a heading (# .. ######). */
function isMarkdownHeading(line: string): boolean {
  return /^#{1,6}\s+/.test(line.trim());
}

/**
 * Extracts action items from a freeform markdown summary. Finds the first heading
 * matching /action items/i and collects the list items beneath it until the next
 * heading. If no bullet markers are present, non-empty lines are taken verbatim.
 */
export function extractActionItemsFromMarkdown(markdown: string): string[] {
  if (!markdown) return [];
  const lines = markdown.split(/\r?\n/);
  const items: string[] = [];
  let inSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (isMarkdownHeading(line)) {
      if (inSection) break; // reached the next section
      // Heading text without the leading #'s
      const headingText = line.replace(/^#{1,6}\s+/, '');
      if (ACTION_HEADING_RE.test(headingText)) {
        inSection = true;
      }
      continue;
    }
    if (!inSection) continue;
    if (!line) continue;
    const cleaned = stripListMarker(line);
    if (cleaned) items.push(cleaned);
  }

  return items;
}

/** Pulls plain text out of a BlockNote inline-content array (or string). */
function blockNoteText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as any).text ?? '') : ''))
      .join('');
  }
  return '';
}

/**
 * Extracts action items from a BlockNote `summary_json` block array. Finds a heading
 * block whose text matches /action items/i, then collects the list-item blocks that
 * follow until the next heading.
 */
export function extractActionItemsFromBlockNote(blocks: any[]): string[] {
  if (!Array.isArray(blocks)) return [];
  const items: string[] = [];
  let inSection = false;

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const type: string = block.type || '';
    const text = blockNoteText(block.content).trim();

    if (type === 'heading') {
      if (inSection) break;
      if (ACTION_HEADING_RE.test(text)) inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (type === 'bulletListItem' || type === 'numberedListItem' || type === 'checkListItem') {
      if (text) items.push(text);
    } else if (type === 'paragraph' && text) {
      items.push(text);
    }
  }

  return items;
}

/**
 * Extracts action items from a legacy sectioned summary — the common case. Matches a
 * section by its key OR its title against /action items/i and returns its block text.
 */
export function extractActionItemsFromLegacy(summary: Record<string, any>): string[] {
  const items: string[] = [];
  for (const [key, section] of Object.entries(summary)) {
    if (key === 'markdown' || key === 'summary_json' || key === '_section_order' || key === 'MeetingName') continue;
    if (!section || typeof section !== 'object') continue;
    const title = typeof section.title === 'string' ? section.title : '';
    if (!ACTION_HEADING_RE.test(key) && !ACTION_HEADING_RE.test(title)) continue;
    const blocks = Array.isArray(section.blocks) ? section.blocks : [];
    for (const block of blocks) {
      const content = typeof block?.content === 'string' ? block.content.trim() : '';
      if (content) items.push(content);
    }
  }
  return items;
}

/**
 * Top-level extractor: accepts any of the three summary shapes Tandem produces
 * (markdown, BlockNote `summary_json`, or legacy sections) and returns a flat,
 * de-duplicated list of action-item strings.
 */
export function extractActionItems(summary: any): string[] {
  if (!summary || typeof summary !== 'object') return [];

  let items: string[] = [];
  if (typeof summary.markdown === 'string') {
    items = extractActionItemsFromMarkdown(summary.markdown);
  } else if (Array.isArray(summary.summary_json)) {
    items = extractActionItemsFromBlockNote(summary.summary_json);
  } else {
    items = extractActionItemsFromLegacy(summary as Record<string, any>);
  }

  // De-duplicate while preserving order.
  const seen = new Set<string>();
  return items.filter((it) => {
    if (seen.has(it)) return false;
    seen.add(it);
    return true;
  });
}

// ─── Display filtering: hide the action-items section from the summary BODY ──────
// The action items are shown as the interactive checklist, so the editable summary should
// not repeat them. These strippers produce a DISPLAY-only projection; the caller keeps the
// original unfiltered summary as the save source (see BlockNoteSummaryView edit affordance).

/**
 * Removes the action-items heading and the lines beneath it (until the next heading) from a
 * markdown summary. Everything else is preserved verbatim.
 */
export function stripActionItemsFromMarkdown(markdown: string): string {
  if (!markdown) return markdown;
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let inSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (isMarkdownHeading(line)) {
      const headingText = line.replace(/^#{1,6}\s+/, '');
      if (ACTION_HEADING_RE.test(headingText)) {
        inSection = true; // drop this heading + its body
        continue;
      }
      inSection = false; // a different heading ends the action section
      out.push(rawLine);
      continue;
    }
    if (inSection) continue; // drop the action-section body
    out.push(rawLine);
  }

  // Collapse the blank-line run the removed section may leave behind.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * Removes the action-items heading block and every block that follows it, up to the next
 * heading block, from a BlockNote `summary_json` array. Other blocks are preserved.
 */
export function stripActionItemsFromBlockNote(blocks: any[]): any[] {
  if (!Array.isArray(blocks)) return blocks;
  const out: any[] = [];
  let inSection = false;

  for (const block of blocks) {
    if (block && typeof block === 'object' && (block.type || '') === 'heading') {
      const text = blockNoteText(block.content).trim();
      if (ACTION_HEADING_RE.test(text)) {
        inSection = true; // drop this heading + following blocks
        continue;
      }
      inSection = false;
      out.push(block);
      continue;
    }
    if (inSection) continue;
    out.push(block);
  }

  return out;
}

/**
 * Removes the action-items section (matched by key OR title) from a legacy sectioned summary,
 * pruning it from `_section_order` as well. Meta keys are preserved.
 */
export function stripActionItemsFromLegacy(summary: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, section] of Object.entries(summary)) {
    if (key === 'markdown' || key === 'summary_json' || key === '_section_order' || key === 'MeetingName') {
      out[key] = section;
      continue;
    }
    if (section && typeof section === 'object') {
      const title = typeof section.title === 'string' ? section.title : '';
      if (ACTION_HEADING_RE.test(key) || ACTION_HEADING_RE.test(title)) continue; // drop section
    }
    out[key] = section;
  }
  if (Array.isArray(out._section_order)) {
    out._section_order = out._section_order.filter((k: string) => {
      const sec = summary[k];
      const title = sec && typeof sec === 'object' && typeof sec.title === 'string' ? sec.title : '';
      return !(ACTION_HEADING_RE.test(k) || ACTION_HEADING_RE.test(title));
    });
  }
  return out;
}

/** Stable per-item id: index guards against duplicate item text colliding. */
export function actionItemId(index: number, text: string): string {
  return `${index}::${text}`;
}

/** Renders action items as a GFM task-list markdown block (for copy / handoff). */
export function actionItemsToMarkdown(items: string[], checked: Record<string, boolean>): string {
  return items
    .map((text, i) => `- [${checked[actionItemId(i, text)] ? 'x' : ' '}] ${text}`)
    .join('\n');
}

// ─── Persistence (localStorage, keyed by meeting id — no schema change) ──────

export function actionItemsStorageKey(meetingId: string): string {
  return `tandem-action-items-checked-${meetingId}`;
}

export function loadCheckedState(meetingId: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(actionItemsStorageKey(meetingId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveCheckedState(meetingId: string, state: Record<string, boolean>): void {
  try {
    localStorage.setItem(actionItemsStorageKey(meetingId), JSON.stringify(state));
  } catch {
    /* ignore quota / unavailable storage */
  }
}
