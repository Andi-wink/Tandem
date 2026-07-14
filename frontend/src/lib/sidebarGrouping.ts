/**
 * sidebarGrouping: pure logic that turns the flat, recency-sorted meetings list into
 * project-grouped sections for the "By project" sidebar view.
 *
 * A meeting's group is the project it is filed under (resolved from its folder_path via
 * resolveFiledUnder). Meetings that are not filed under any project fall into a single "Unfiled"
 * group that always sorts last. Non-unfiled groups keep the recency order of their most-recent
 * meeting (the meetings array is assumed already sorted newest-first, the order api_get_meetings
 * returns). Meetings within a group keep that same recency order.
 *
 * Pure, no Tauri, no React: unit-tested in sidebarGrouping.test.ts.
 */

import { resolveFiledUnder, FiledUnderProject } from '@/lib/filedUnder';
import { normalizeDir } from '@/lib/projectDirHistory';

/** localStorage key holding the JSON array of collapsed group keys. */
export const COLLAPSED_GROUPS_KEY = 'tandem.sidebar.collapsedGroups';
/** localStorage key holding the sidebar view mode ('recent' | 'byProject'). */
export const GROUP_MODE_KEY = 'tandem.sidebar.groupMode';
/** Stable group key for the catch-all Unfiled section. */
export const UNFILED_KEY = '__unfiled__';

export type SidebarViewMode = 'recent' | 'byProject';

export interface GroupableMeeting {
  id: string;
  title: string;
  /** Physical folder the meeting is saved to; null/undefined when it has no folder yet. */
  folderPath?: string | null;
}

export interface MeetingGroup {
  /** Stable, localStorage-safe key: the normalized project path, or UNFILED_KEY. */
  key: string;
  /** Display label: the project name, or "Unfiled". */
  label: string;
  isUnfiled: boolean;
  meetings: GroupableMeeting[];
}

/**
 * Group meetings by the project they are filed under.
 *
 * @param meetings Recency-sorted (newest first) meetings.
 * @param projects Registered projects used to resolve which project a folder is filed under.
 */
export function groupMeetingsByProject(
  meetings: GroupableMeeting[],
  projects: FiledUnderProject[],
): MeetingGroup[] {
  const groups = new Map<string, MeetingGroup>();
  // First-seen order of each key mirrors "most-recent meeting first" because meetings is
  // recency-sorted; a group appears the moment its newest meeting is encountered.
  const order: string[] = [];

  for (const m of meetings) {
    const filed = resolveFiledUnder(m.folderPath, projects);
    const key = filed.filed && filed.projectPath ? normalizeDir(filed.projectPath) : UNFILED_KEY;
    const label = filed.filed && filed.projectName ? filed.projectName : 'Unfiled';

    let group = groups.get(key);
    if (!group) {
      group = { key, label, isUnfiled: !filed.filed, meetings: [] };
      groups.set(key, group);
      order.push(key);
    }
    group.meetings.push(m);
  }

  const result = order.map((k) => groups.get(k)!);
  // Array.prototype.sort is stable (ES2019+): Unfiled drops to the end, every other group keeps
  // its recency (first-seen) order.
  result.sort((a, b) => {
    if (a.isUnfiled !== b.isUnfiled) return a.isUnfiled ? 1 : -1;
    return 0;
  });
  return result;
}

// ── Collapse-state persistence ───────────────────────────────────────────────

/** Minimal storage surface so the helpers are testable with a fake in vitest. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Load the set of collapsed group keys. Default: empty set (all groups expanded). */
export function loadCollapsedGroups(storage: KeyValueStorage): Set<string> {
  try {
    const raw = storage.getItem(COLLAPSED_GROUPS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === 'string'));
    return new Set();
  } catch {
    return new Set();
  }
}

/** Persist the set of collapsed group keys as a JSON array. */
export function saveCollapsedGroups(storage: KeyValueStorage, collapsed: Set<string>): void {
  try {
    storage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* storage unavailable: non-fatal, state stays in memory */
  }
}

/** Load the persisted sidebar view mode. Default: 'recent'. */
export function loadGroupMode(storage: KeyValueStorage): SidebarViewMode {
  try {
    return storage.getItem(GROUP_MODE_KEY) === 'byProject' ? 'byProject' : 'recent';
  } catch {
    return 'recent';
  }
}

/** Persist the sidebar view mode. */
export function saveGroupMode(storage: KeyValueStorage, mode: SidebarViewMode): void {
  try {
    storage.setItem(GROUP_MODE_KEY, mode);
  } catch {
    /* non-fatal */
  }
}
