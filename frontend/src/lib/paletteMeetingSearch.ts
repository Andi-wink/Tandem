/**
 * paletteMeetingSearch: pure logic for the Ctrl+K command palette's meeting search.
 *
 * The palette merges two signals into one capped, de-duplicated list of meeting rows:
 *   1. transcript matches from the Rust `api_search_transcripts` command (carry a matched snippet),
 *   2. title matches computed locally against the already-loaded meetings list.
 *
 * Transcript matches come first (they are ranked by recency by the backend and carry a snippet),
 * then title-only matches (also recency-ordered because the meetings list is recency-sorted).
 * The project chip for each row is resolved from the meeting's folder_path via resolveFiledUnder,
 * so no per-row async lookup is needed.
 *
 * Pure, no Tauri, no React: unit-tested in paletteMeetingSearch.test.ts.
 */

import { resolveFiledUnder, FiledUnderProject } from '@/lib/filedUnder';

/** Search kicks in past this length (the brief asks for "more than 2 chars"). */
export const MEETING_SEARCH_MIN_CHARS = 3;
/** Max meeting rows shown in the palette; the rest are hinted as "N more in sidebar search". */
export const MEETING_SEARCH_CAP = 8;

export interface PaletteMeetingInput {
  id: string;
  title: string;
  folderPath?: string | null;
}

export interface TranscriptMatch {
  id: string;
  title: string;
  matchContext?: string;
  /** Raw timestamp of the matched transcript segment (used as the row's date when known). */
  timestamp?: string;
}

export interface PaletteMeetingRow {
  id: string;
  title: string;
  /** Matched transcript snippet, when the hit came from transcript search. */
  snippet?: string;
  /** Resolved project name for the chip, when the meeting is filed under a project. */
  projectName?: string;
  /** Raw timestamp for the row, when known (only transcript hits carry one). */
  date?: string;
}

export interface PaletteMeetingResult {
  rows: PaletteMeetingRow[];
  /** How many further matches exist beyond the cap (drives the "N more in sidebar search" row). */
  overflow: number;
}

/** Whether the query is long enough to trigger a meeting search. */
export function shouldSearchMeetings(query: string): boolean {
  return query.trim().length >= MEETING_SEARCH_MIN_CHARS;
}

/**
 * Merge transcript + title matches into a capped, de-duplicated list of palette meeting rows.
 *
 * @param query        Raw query text from the palette input.
 * @param meetings     The loaded meetings list (recency-sorted, carrying folder_path).
 * @param transcripts  Results from api_search_transcripts for the same query.
 * @param projects     Registered projects, for resolving the project chip.
 * @param cap          Max rows to display.
 */
export function buildPaletteMeetingRows(
  query: string,
  meetings: PaletteMeetingInput[],
  transcripts: TranscriptMatch[],
  projects: FiledUnderProject[],
  cap: number = MEETING_SEARCH_CAP,
): PaletteMeetingResult {
  const q = query.trim().toLowerCase();
  if (q.length < MEETING_SEARCH_MIN_CHARS) return { rows: [], overflow: 0 };

  const folderById = new Map(meetings.map((m) => [m.id, m.folderPath ?? null] as const));
  const titleById = new Map<string, string>();
  for (const m of meetings) titleById.set(m.id, m.title);
  for (const t of transcripts) if (!titleById.has(t.id)) titleById.set(t.id, t.title);

  const snippetById = new Map<string, string | undefined>();
  const dateById = new Map<string, string | undefined>();
  for (const t of transcripts) {
    snippetById.set(t.id, t.matchContext);
    dateById.set(t.id, t.timestamp);
  }

  // Ordered id list: transcript hits first (with snippets), then title-only hits.
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      orderedIds.push(id);
    }
  };

  for (const t of transcripts) push(t.id);
  for (const m of meetings) {
    if (m.title.toLowerCase().includes(q)) push(m.id);
  }

  const all: PaletteMeetingRow[] = orderedIds.map((id) => {
    const filed = resolveFiledUnder(folderById.get(id) ?? null, projects);
    return {
      id,
      title: titleById.get(id) ?? id,
      snippet: snippetById.get(id),
      projectName: filed.filed ? filed.projectName : undefined,
      date: dateById.get(id),
    };
  });

  return {
    rows: all.slice(0, cap),
    overflow: Math.max(0, all.length - cap),
  };
}
