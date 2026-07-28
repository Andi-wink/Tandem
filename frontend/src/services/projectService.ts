/**
 * Project Service — Tauri backend wrappers for Solo Mode project registry
 */

import { invoke } from '@tauri-apps/api/core';

export interface Project {
  id: string;
  name: string;
  path: string;
  aliases: string[];
  auto_discovered: boolean;
  /** F061: null for a plain folder project; the Claude chat session id for a
   *  virtual sub-project. Identity is (path, session_id); a virtual sub-project
   *  files under `<path>/.tandem/sessions/<HH.MM, DD.MM - name>/`. */
  session_id: string | null;
  /** F061: row creation time as a SQLite UTC string ("YYYY-MM-DD HH:MM:SS").
   *  Stable per session (set once at row insert), so it seeds the deterministic
   *  session folder timestamp reconstructed at every call site. */
  created_at: string;
}

export interface ProjectRaw {
  id: string;
  name: string;
  path: string;
  aliases: string;        // JSON string from DB
  auto_discovered: number; // 0 or 1 from SQLite
  session_id: string | null; // F061: nullable session scope
  created_at: string;
  updated_at: string;
}

export interface ScannedProject {
  name: string;
  path: string;
}

function parseProject(raw: ProjectRaw): Project {
  let aliases: string[] = [];
  try {
    aliases = JSON.parse(raw.aliases);
  } catch {
    aliases = [];
  }
  return {
    id: raw.id,
    name: raw.name,
    path: raw.path,
    aliases,
    auto_discovered: raw.auto_discovered === 1,
    session_id: raw.session_id ?? null,
    created_at: raw.created_at ?? '',
  };
}

export async function listProjects(): Promise<Project[]> {
  const raw = await invoke<ProjectRaw[]>('project_list');
  return raw.map(parseProject);
}

export async function createProject(
  name: string,
  path: string,
  aliases: string[] = [],
): Promise<Project> {
  const raw = await invoke<ProjectRaw>('project_create', {
    name,
    path,
    aliases: JSON.stringify(aliases),
  });
  return parseProject(raw);
}

export async function updateProject(
  id: string,
  name: string,
  path: string,
  aliases: string[] = [],
): Promise<void> {
  await invoke('project_update', {
    id,
    name,
    path,
    aliases: JSON.stringify(aliases),
  });
}

export async function deleteProject(id: string): Promise<void> {
  await invoke('project_delete', { id });
}

export async function importScannedProjects(
  projects: ScannedProject[],
): Promise<Project[]> {
  const raw = await invoke<ProjectRaw[]>('project_import_scanned', { projects });
  return raw.map(parseProject);
}

export async function scanDirectory(parentDir: string): Promise<ScannedProject[]> {
  return invoke<ScannedProject[]>('project_scan_directory', { parentDir });
}

export async function pickDirectory(startingDir?: string): Promise<string | null> {
  return invoke<string | null>('project_pick_directory', { startingDir: startingDir ?? null });
}

/**
 * F055: Normalize a filesystem path for identity comparison, mirroring the Rust
 * side's normalize_path (case-insensitive on Windows, `/` vs `\` insensitive,
 * trailing-separator insensitive). Claude session cwds use forward slashes while
 * dir-picker registrations use backslashes; exact string compares create
 * duplicate project rows.
 */
export function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * F055: Ensure a project exists for a Claude session's cwd, registering it as
 * auto-discovered if it isn't already, then return it.
 *
 * Checks the existing project list with normalized path comparison first (the
 * Rust `project_import_scanned` dedupe is an exact SQL match, so a separator or
 * case variant of an already-registered path would otherwise create a duplicate
 * row). Only imports when no normalized match exists, then re-lists and resolves
 * by normalized path. Returns null if it can't be found.
 */
export async function ensureProjectForPath(
  name: string,
  path: string,
): Promise<Project | null> {
  const wanted = normalizeProjectPath(path);
  try {
    const existing = await listProjects();
    const match = existing.find(p => normalizeProjectPath(p.path) === wanted);
    if (match) return match;
  } catch (err) {
    console.warn('[projectService] auto-register pre-list failed:', err);
  }
  try {
    await importScannedProjects([{ name, path }]);
  } catch (err) {
    console.warn('[projectService] auto-register import failed:', err);
  }
  try {
    const all = await listProjects();
    return all.find(p => normalizeProjectPath(p.path) === wanted) ?? null;
  } catch (err) {
    console.warn('[projectService] auto-register re-list failed:', err);
    return null;
  }
}

/**
 * F061: Ensure a virtual sub-project exists for a (path, sessionId) pair,
 * creating it (auto_discovered, session_id set) if absent, then return it.
 *
 * A virtual sub-project shares its folder path with any plain project at the
 * same path but is a distinct row keyed by the chat session id, so notes/tasks/
 * filings from different chats against one folder never mix. Dedupe is done here
 * with normalized-path + session_id comparison (the Rust command also dedupes on
 * the unique (path, COALESCE(session_id,'')) index, so a race just returns the
 * existing row). Returns null if it can't be resolved.
 */
export async function ensureVirtualProject(
  name: string,
  path: string,
  sessionId: string,
): Promise<Project | null> {
  const wanted = normalizeProjectPath(path);
  const matches = (p: Project) =>
    normalizeProjectPath(p.path) === wanted && p.session_id === sessionId;
  try {
    const existing = await listProjects();
    const match = existing.find(matches);
    if (match) return match;
  } catch (err) {
    console.warn('[projectService] virtual pre-list failed:', err);
  }
  try {
    const raw = await invoke<ProjectRaw>('project_create_virtual', {
      name,
      path,
      sessionId,
    });
    return parseProject(raw);
  } catch (err) {
    console.warn('[projectService] project_create_virtual failed:', err);
  }
  try {
    const all = await listProjects();
    return all.find(matches) ?? null;
  } catch (err) {
    console.warn('[projectService] virtual re-list failed:', err);
    return null;
  }
}
