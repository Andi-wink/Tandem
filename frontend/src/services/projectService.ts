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
}

export interface ProjectRaw {
  id: string;
  name: string;
  path: string;
  aliases: string;        // JSON string from DB
  auto_discovered: number; // 0 or 1 from SQLite
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
