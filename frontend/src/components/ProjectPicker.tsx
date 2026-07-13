'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FolderOpen, FolderGit2, Clock, Folder } from 'lucide-react';
import { listProjects, Project } from '@/services/projectService';
import {
  getProjectDirHistory,
  bestHistoryMatch,
  frecencyScore,
  normalizeDir,
  ProjectDirHistoryEntry,
} from '@/lib/projectDirHistory';

export type ProjectPickerSelection = {
  dir: string;
  name: string;
  project?: Project;
  source: 'default' | 'project' | 'recent' | 'browse' | 'suggested';
};

/** A ranked suggestion (R1 ambiguity chooser): a candidate folder + why it matched. */
export interface ProjectPickerCandidate {
  dir: string;
  name: string;
  /** Match signal shown as the row's detail line (e.g. "Matched attendee @acme.com"). */
  signal: string;
  /** Present for a registered project; a discovered folder is adopted via createProject at pick. */
  project?: Project;
}

interface ProjectPickerProps {
  /** Meeting folder / current dir, shown as the "default" row when set. */
  defaultDir?: string;
  /** Label for the default row (defaults to "Meeting folder"). */
  defaultLabel?: string;
  /** Meeting title, used to pre-select the best history match. */
  meetingTitle?: string | null;
  /** Ranked candidates pinned as a "Suggested" section above the rest (R1 chooser). */
  candidates?: ProjectPickerCandidate[];
  /** Extra pickable projects merged with the registered list (e.g. discovered client folders). */
  extraProjects?: Project[];
  /** Show the "Browse for folder..." row (default true). */
  allowBrowse?: boolean;
  /** Focus the search input on mount (default true). */
  autoFocus?: boolean;
  onSelect: (sel: ProjectPickerSelection) => void;
  onEscape?: () => void;
}

interface Row {
  key: string;
  dir: string;
  name: string;
  detail: string; // secondary line (path or hint)
  source: ProjectPickerSelection['source'];
  project?: Project;
  score: number;
  browse?: boolean;
}

export function ProjectPicker({
  defaultDir,
  defaultLabel = 'Meeting folder',
  meetingTitle,
  candidates,
  extraProjects,
  allowBrowse = true,
  autoFocus = true,
  onSelect,
  onEscape,
}: ProjectPickerProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [history, setHistory] = useState<ProjectDirHistoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    listProjects().then(setProjects).catch(() => setProjects([]));
    setHistory(getProjectDirHistory());
  }, []);

  // Build the canonical (unfiltered) row list.
  const baseRows = useMemo<Row[]>(() => {
    const now = Date.now();
    const rows: Row[] = [];
    const seen = new Set<string>();

    if (defaultDir) {
      const key = normalizeDir(defaultDir);
      seen.add(key);
      rows.push({
        key: `default:${key}`,
        dir: defaultDir,
        name: defaultLabel,
        detail: defaultDir,
        source: 'default',
        score: Number.POSITIVE_INFINITY,
      });
    }

    // R1 chooser: pinned "Suggested" candidates, just below the default row and above everything
    // else. Their match signal is shown as the detail line. Deduped out of the sections below.
    if (candidates && candidates.length > 0) {
      for (const c of candidates) {
        const key = normalizeDir(c.dir);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          key: `suggested:${key}`,
          dir: c.dir,
          name: c.name,
          detail: `Matched ${c.signal}`,
          source: 'suggested',
          project: c.project,
          score: Number.POSITIVE_INFINITY - 1,
        });
      }
    }

    // Registered projects (plus any extra pickable projects, e.g. discovered client folders) —
    // merge in matching history frecency. Deduped by normalized path; registered wins on collision
    // because it is iterated first.
    for (const p of [...projects, ...(extraProjects ?? [])]) {
      const key = normalizeDir(p.path);
      if (seen.has(key)) continue;
      seen.add(key);
      const hist = history.find(h => normalizeDir(h.dir) === key);
      rows.push({
        key: `project:${p.id}`,
        dir: p.path,
        name: p.name,
        detail: p.path,
        source: 'project',
        project: p,
        score: hist ? frecencyScore(hist, now) : 0,
      });
    }

    // Recent dirs not already represented by a project or the default.
    for (const h of history) {
      const key = normalizeDir(h.dir);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        key: `recent:${key}`,
        dir: h.dir,
        name: h.name,
        detail: h.dir,
        source: 'recent',
        score: frecencyScore(h, now),
      });
    }

    // Sort: default first (infinite score), then by frecency desc, then name.
    rows.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    });

    return rows;
  }, [defaultDir, defaultLabel, projects, history, candidates, extraProjects]);

  // Apply the fuzzy filter: every query token must be a substring of name, an alias, or the path.
  const filteredRows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return baseRows;
    const tokens = q.split(/\s+/);
    return baseRows.filter(r => {
      const haystack = [
        r.name.toLowerCase(),
        r.dir.toLowerCase(),
        ...(r.project?.aliases ?? []).map(a => a.toLowerCase()),
      ].join(' ');
      return tokens.every(t => haystack.includes(t));
    });
  }, [baseRows, query]);

  // Rows including the trailing Browse row.
  const rows = useMemo<Row[]>(() => {
    if (!allowBrowse) return filteredRows;
    return [
      ...filteredRows,
      {
        key: 'browse',
        dir: '',
        name: 'Browse for folder...',
        detail: 'Pick any folder on disk',
        source: 'browse',
        score: -1,
        browse: true,
      },
    ];
  }, [filteredRows, allowBrowse]);

  // The highlight is anchored by ROW IDENTITY (normalized dir), not by a raw index.
  // `listProjects()` resolves async, so `rows` is recomputed after mount (project rows
  // displace 'recent' rows, ties re-sort). Re-deriving the index from the anchored dir on
  // every recompute keeps the highlighted (Enter-confirmable) row pointing at the SAME
  // project the user intended, instead of silently sliding onto an unrelated one.
  const BROWSE_ANCHOR = '\0browse';
  const anchorRef = useRef<string | null>(null);
  const didInitAnchor = useRef(false);

  const anchorForRow = (row: Row | undefined): string | null => {
    if (!row) return null;
    if (row.browse) return BROWSE_ANCHOR;
    return row.dir ? normalizeDir(row.dir) : null;
  };

  const rowIndexForAnchor = (anchor: string | null): number => {
    if (!anchor) return -1;
    if (anchor === BROWSE_ANCHOR) return rows.findIndex(r => r.browse);
    return rows.findIndex(r => r.dir && normalizeDir(r.dir) === anchor);
  };

  // Initialize the anchor once we have data, then re-derive the highlight index from it
  // on every rows recompute (async project load, filter change, etc.).
  useEffect(() => {
    if (!didInitAnchor.current && (baseRows.length > 0 || projects.length > 0 || history.length > 0)) {
      didInitAnchor.current = true;
      // R1: when candidates are present, anchor the initial highlight on the top suggestion so Enter
      // confirms the best-ranked folder.
      if (candidates && candidates.length > 0) {
        anchorRef.current = normalizeDir(candidates[0].dir);
      } else {
        const best = bestHistoryMatch(meetingTitle);
        if (best) {
          anchorRef.current = normalizeDir(best.dir);
        } else if (defaultDir) {
          anchorRef.current = normalizeDir(defaultDir);
        } else if (rows[0]?.dir) {
          anchorRef.current = normalizeDir(rows[0].dir);
        }
      }
    }
    const idx = rowIndexForAnchor(anchorRef.current);
    setHighlight(idx >= 0 ? idx : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, meetingTitle, defaultDir, baseRows.length, projects.length, history.length]);

  // Move the highlight AND re-anchor it to that row's identity, so a later rows
  // recompute keeps the user's manual choice.
  const moveHighlight = (idx: number) => {
    setHighlight(idx);
    anchorRef.current = anchorForRow(rows[idx]);
  };

  // Scroll the highlighted row into view.
  useEffect(() => {
    rowRefs.current[highlight]?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const commitRow = async (row: Row | undefined) => {
    if (!row) return;
    if (row.browse) {
      try {
        const result = await invoke<string | null>('select_recording_folder', {
          startingDir: defaultDir || null,
        });
        if (result) {
          const name = result.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || 'Project';
          onSelect({ dir: result, name, source: 'browse' });
        }
      } catch (err) {
        console.error('[ProjectPicker] Browse failed:', err);
      }
      return;
    }
    onSelect({ dir: row.dir, name: row.name, project: row.project, source: row.source });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveHighlight(rows.length ? (highlight + 1) % rows.length : 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveHighlight(rows.length ? (highlight - 1 + rows.length) % rows.length : 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commitRow(rows[highlight]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onEscape?.();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search projects or type to filter..."
        className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      />

      <div className="max-h-64 overflow-y-auto flex flex-col gap-0.5">
        {rows.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            No matches.{allowBrowse ? ' Use Browse for folder... below.' : ''}
          </div>
        )}
        {rows.map((row, i) => {
          const isHigh = i === highlight;
          const Icon = row.browse
            ? FolderOpen
            : row.source === 'suggested'
              ? (row.project ? FolderGit2 : Folder)
              : row.source === 'project'
                ? FolderGit2
                : row.source === 'recent'
                  ? Clock
                  : Folder;
          return (
            <button
              key={row.key}
              ref={(el) => { rowRefs.current[i] = el; }}
              type="button"
              data-highlighted={isHigh ? '' : undefined}
              onMouseEnter={() => moveHighlight(i)}
              onClick={() => commitRow(row)}
              className={`flex items-start gap-2 w-full text-left rounded-md px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                isHigh ? 'bg-muted' : 'hover:bg-muted/60'
              }`}
            >
              <Icon className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-foreground truncate">{row.name}</span>
                  {row.source === 'project' && !row.project?.id.startsWith('discovered:') && (
                    <span className="text-[10px] text-muted-foreground flex-shrink-0">Solo</span>
                  )}
                  {row.source === 'suggested' && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground flex-shrink-0">
                      Suggested
                    </span>
                  )}
                </div>
                {row.detail && (
                  <div className="text-xs text-muted-foreground truncate">{row.detail}</div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
