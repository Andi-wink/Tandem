/**
 * clientFolderDiscovery — surfaces the direct subfolders of the configured "clients root"
 * (default D:/Dev-projects/Client_projects) as candidate projects for the calendar matcher, even
 * when they are not registered as Solo projects. This lets a call route to a client's own folder
 * (e.g. ARO, Openclaw) without the user having pre-registered it: the pick adopts it via the
 * existing createProject path.
 *
 * Pure and vitest-friendly apart from the two Tauri invokes (both guarded to degrade to []).
 */

import { invoke } from '@tauri-apps/api/core';
import { listProjects, Project } from '@/services/projectService';
import { normalizeDir } from '@/lib/projectDirHistory';

export interface ClientFolder {
  name: string;
  path: string;
}

/** Prefix marking a discovered (unregistered) folder stub so callers can adopt it at pick time. */
export const DISCOVERED_PREFIX = 'discovered:';

/** List the clients-root subfolders from Rust. Never throws — returns [] on any error. */
export async function listClientFolders(): Promise<ClientFolder[]> {
  try {
    return (await invoke<ClientFolder[]>('list_client_folders')) ?? [];
  } catch {
    return [];
  }
}

/**
 * Map discovered folders to lightweight Project stubs, dropping any whose normalized path collides
 * with an already-registered project (a registered project always wins — it carries aliases and a
 * stable id). Pure.
 */
export function discoveredAsProjectStubs(
  folders: ClientFolder[],
  registered: Project[],
): Project[] {
  const registeredDirs = new Set(registered.map(p => normalizeDir(p.path)));
  const stubs: Project[] = [];
  const seen = new Set<string>();
  for (const f of folders) {
    const key = normalizeDir(f.path);
    if (registeredDirs.has(key) || seen.has(key)) continue;
    seen.add(key);
    stubs.push({
      id: `${DISCOVERED_PREFIX}${key}`,
      name: f.name,
      path: f.path,
      aliases: [],
      auto_discovered: true,
      // F061: discovered folders are plain projects, not chat-session sub-projects,
      // and have no DB row yet (created_at is filled in once they are registered).
      session_id: null,
      created_at: '',
    });
  }
  return stubs;
}

/** True when a project id refers to a discovered (unregistered) folder stub. */
export function isDiscoveredStub(project: Pick<Project, 'id'>): boolean {
  return typeof project.id === 'string' && project.id.startsWith(DISCOVERED_PREFIX);
}

/**
 * Single entry point every matcher caller uses: registered projects plus discovered stubs.
 * `projects` is the registered list; `pool` is the combined list to match against.
 */
export async function getMatchPool(): Promise<{ projects: Project[]; pool: Project[] }> {
  let projects: Project[] = [];
  try {
    projects = await listProjects();
  } catch {
    projects = [];
  }
  const folders = await listClientFolders();
  const stubs = discoveredAsProjectStubs(folders, projects);
  return { projects, pool: [...projects, ...stubs] };
}
