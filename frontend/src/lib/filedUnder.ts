/**
 * filedUnder — pure resolver that answers "which project is this meeting filed under?".
 *
 * A meeting is "filed under" a project P when its folder_path lives inside `P/.tandem` (the same
 * layout useProjectRouteActions.fileUnder / relocate_meeting_folder produce). Otherwise it is
 * unfiled (it sits in the default recordings location, or anywhere outside a project's .tandem).
 *
 * Pure, no Tauri, no React — unit-tested in filedUnder.test.ts.
 */

import { normalizeDir } from '@/lib/projectDirHistory';

export interface FiledUnderProject {
  name: string;
  path: string;
}

export interface FiledUnderResult {
  /** True when the folder lives under some project's `.tandem`. */
  filed: boolean;
  /** Name of the matched project (present only when filed). */
  projectName?: string;
  /** Original-cased root path of the matched project (present only when filed). */
  projectPath?: string;
}

/**
 * Resolve which project a meeting folder is filed under. When a folder could match more than one
 * project (nested project roots), the most specific (longest `.tandem` prefix) wins.
 */
export function resolveFiledUnder(
  folderPath: string | null | undefined,
  projects: FiledUnderProject[],
): FiledUnderResult {
  if (!folderPath) return { filed: false };
  const norm = normalizeDir(folderPath);
  let best: { name: string; path: string; len: number } | null = null;
  for (const p of projects) {
    if (!p?.path) continue;
    const tandem = `${normalizeDir(p.path)}/.tandem`;
    // Filed when the folder IS the .tandem dir or lives beneath it (boundary-safe: the trailing
    // slash stops "…/.tandemXYZ" from matching "…/.tandem").
    if (norm === tandem || norm.startsWith(`${tandem}/`)) {
      if (!best || tandem.length > best.len) {
        best = { name: p.name, path: p.path, len: tandem.length };
      }
    }
  }
  return best ? { filed: true, projectName: best.name, projectPath: best.path } : { filed: false };
}
