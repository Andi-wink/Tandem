'use client';

/**
 * CommandPalette (Ctrl+K) — one keyboard surface to route notes and drive Tandem, so the common
 * actions (file this meeting under a project, start/stop, toggle the AI panel / canvas, hand off)
 * are one action instead of several clicks.
 *
 * Custom overlay (not cmdk's CommandDialog) so Escape is fully ours: it pops ONE drill-down level
 * per press (boards/project page -> root -> close). ProjectPicker is reused as the in-palette
 * project page; its own Escape calls onEscape -> setPage('root'), so it never closes the palette.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { defaultFilter } from 'cmdk';
import { toast } from 'sonner';
import { usePathname, useRouter } from 'next/navigation';
import {
  FolderGit2, FolderKanban, Layers, Mic, Square, User, Users,
  PanelRightOpen, PenTool, Plus, History, FileText, CalendarDays, RefreshCw, NotebookText,
} from 'lucide-react';
import {
  Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandShortcut,
} from '@/components/ui/command';
import {
  buildPaletteMeetingRows,
  shouldSearchMeetings,
  PaletteMeetingRow,
} from '@/lib/paletteMeetingSearch';
import { ProjectPicker, ProjectPickerSelection } from '@/components/ProjectPicker';
import { useClaude } from '@/contexts/ClaudeContext';
import { useCanvas } from '@/contexts/CanvasContext';
import { useCalendar } from '@/contexts/CalendarContext';
import { findEventNear, findUpcomingEvent } from '@/services/calendarEventMatcher';
import { startRecordingForEvent } from '@/lib/startFromEvent';
import { useSoloMode } from '@/contexts/SoloModeContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useProjectRouteActions } from '@/hooks/useProjectRouteActions';
import { listProjects, createProject, Project } from '@/services/projectService';
import {
  getProjectDirHistory, bestHistoryMatch, frecencyScore, normalizeDir,
} from '@/lib/projectDirHistory';

/** A saved whiteboard in a client's library (mirrors the Rust WhiteboardMeta). */
interface WhiteboardMeta {
  id: string;
  title: string;
  saved_at_ms: number;
  json_path: string;
  png_path: string | null;
}

interface ProjectRow {
  key: string;
  name: string;
  path: string;
  project?: Project;
}

type Page = 'root' | 'project' | 'boards';

export function CommandPalette() {
  const {
    isPanelOpen, openPanel, closePanel, meetingId, meetingTitle,
  } = useClaude();
  const { canvasVisible, hideCanvas, clearCanvas } = useCanvas();
  const { configured: calendarConfigured, refresh: refreshCalendar, events: calendarEvents } = useCalendar();
  const router = useRouter();
  const pathname = usePathname();
  const { activeProject } = useSoloMode();
  const { isRecording, recordingMode, setRecordingMode } = useRecordingState();
  const { currentMeeting, setCurrentMeeting, meetings } = useSidebar();
  const { fileUnder } = useProjectRouteActions();

  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<Page>('root');
  const [projectRows, setProjectRows] = useState<ProjectRow[]>([]);
  const [boards, setBoards] = useState<WhiteboardMeta[]>([]);
  // Mirrors RecordingControls' handover gate. During an I5b meeting handover, isRecording briefly stays
  // true while the current recording is being stopped and the next is seeded; dispatching a stop from
  // the palette in that window would fire a second, independent stop pipeline. We hide the Stop item for
  // the whole handover (detail.active toggles it), matching RecordingControls' tandem:recording-transition
  // consumer exactly.
  const [handoverActive, setHandoverActive] = useState(false);

  useEffect(() => {
    const onTransition = (e: Event) => {
      const active = (e as CustomEvent<{ active?: boolean }>).detail?.active;
      setHandoverActive(!!active);
    };
    window.addEventListener('tandem:recording-transition', onTransition as EventListener);
    return () => window.removeEventListener('tandem:recording-transition', onTransition as EventListener);
  }, []);

  // ── Meeting search (I6) ────────────────────────────────────────────────────
  // Typing >2 chars searches meetings (debounced) and shows them in a "Meetings" group below the
  // commands. allProjects resolves each row's project chip in one batched pass (no per-row async).
  const [query, setQuery] = useState('');
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  // `query` is the input text that produced these rows. Rendering compares it against the live input
  // so stale rows from a prior query are never shown (or actioned) while a newer search is in flight.
  const [meetingResult, setMeetingResult] = useState<{ rows: PaletteMeetingRow[]; overflow: number; query: string }>({
    rows: [],
    overflow: 0,
    query: '',
  });
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>();
  const searchTokenRef = useRef(0);

  // The most identifying title we have for pinning the likely project (panel context first, then
  // the sidebar's current meeting).
  const titleForMatch = meetingTitle || currentMeeting?.title || null;

  // ── Shared actions (also bound to direct hotkeys) ─────────────────────────
  const toggleAiPanel = useCallback(async () => {
    if (isPanelOpen) { closePanel(); return; }
    let folder = '';
    try { folder = (await invoke<string | null>('get_meeting_folder_path')) || ''; } catch { /* ok */ }
    await openPanel(meetingId || 'live-recording', meetingTitle || 'Live Recording', folder);
  }, [isPanelOpen, closePanel, openPanel, meetingId, meetingTitle]);

  const toggleCanvasView = useCallback(() => {
    if (canvasVisible) hideCanvas();
    else window.dispatchEvent(new CustomEvent('tandem:canvas-show'));
  }, [canvasVisible, hideCanvas]);

  const runHandoff = useCallback(async () => {
    const folder = await invoke<string | null>('get_meeting_folder_path').catch(() => null);
    if (folder && window.triggerHandoff) {
      window.triggerHandoff(folder, meetingTitle || currentMeeting?.title || 'Meeting');
    } else {
      toast.error('No active recording folder. Start a recording first.');
    }
  }, [meetingTitle, currentMeeting]);

  // ── Direct shortcuts: Ctrl+K (palette), Ctrl+. (AI panel), Ctrl+, (canvas) ──
  // No Alt+Shift combos (S/R/V/Q/A are OS-global). preventDefault so no character is inserted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        setOpen(o => !o);
      } else if (e.key === '.') {
        e.preventDefault();
        void toggleAiPanel();
      } else if (e.key === ',') {
        e.preventDefault();
        toggleCanvasView();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleAiPanel, toggleCanvasView]);

  // Reset to the root page and (re)compute the likely-project rows every time the palette opens.
  useEffect(() => {
    if (!open) return;
    setPage('root');
    // Fresh palette each open: no stale query or meeting rows from a prior session.
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchTokenRef.current++;
    setQuery('');
    setMeetingResult({ rows: [], overflow: 0, query: '' });
    let cancelled = false;
    (async () => {
      let projects: Project[] = [];
      try { projects = await listProjects(); } catch { projects = []; }
      if (!cancelled) setAllProjects(projects);
      const history = getProjectDirHistory();
      const now = Date.now();
      const seen = new Set<string>();
      const ranked: Array<ProjectRow & { score: number }> = [];

      for (const p of projects) {
        const key = normalizeDir(p.path);
        if (seen.has(key)) continue;
        seen.add(key);
        const hist = history.find(h => normalizeDir(h.dir) === key);
        ranked.push({ key: `project:${p.id}`, name: p.name, path: p.path, project: p, score: hist ? frecencyScore(hist, now) : 0 });
      }
      for (const h of history) {
        const key = normalizeDir(h.dir);
        if (seen.has(key)) continue;
        seen.add(key);
        ranked.push({ key: `recent:${key}`, name: h.name, path: h.dir, score: frecencyScore(h, now) });
      }
      ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

      // Pin the best title match to the top so a repeat client is the first row.
      const best = bestHistoryMatch(titleForMatch);
      if (best) {
        const bestKey = normalizeDir(best.dir);
        const idx = ranked.findIndex(r => normalizeDir(r.path) === bestKey);
        if (idx > 0) { const [row] = ranked.splice(idx, 1); ranked.unshift(row); }
      }

      if (!cancelled) {
        setProjectRows(ranked.slice(0, 3).map(({ score: _score, ...r }) => r));
      }
    })();
    return () => { cancelled = true; };
  }, [open, titleForMatch]);

  // Load this client's boards when the boards page is entered.
  useEffect(() => {
    if (page !== 'boards' || !activeProject?.path) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await invoke<WhiteboardMeta[]>('list_whiteboards', { projectPath: activeProject.path });
        if (!cancelled) setBoards(list);
      } catch {
        if (!cancelled) setBoards([]);
      }
    })();
    return () => { cancelled = true; };
  }, [page, activeProject?.path]);

  // Debounced meeting search: past 2 chars, hit the transcript index and merge with title matches
  // (both handled by the pure buildPaletteMeetingRows). A token guards against out-of-order results.
  const runMeetingSearch = useCallback((raw: string) => {
    setQuery(raw);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!shouldSearchMeetings(raw)) {
      searchTokenRef.current++;
      setMeetingResult({ rows: [], overflow: 0, query: raw });
      return;
    }
    const token = ++searchTokenRef.current;
    searchDebounceRef.current = setTimeout(async () => {
      let transcripts: Array<{ id: string; title: string; matchContext?: string; timestamp?: string }> = [];
      try {
        transcripts = await invoke('api_search_transcripts', { query: raw });
      } catch {
        transcripts = [];
      }
      if (token !== searchTokenRef.current) return; // a newer keystroke superseded this one
      const result = buildPaletteMeetingRows(
        raw,
        meetings.map((m) => ({ id: m.id, title: m.title, folderPath: m.folderPath })),
        transcripts,
        allProjects.map((p) => ({ name: p.name, path: p.path })),
      );
      setMeetingResult({ ...result, query: raw });
    }, 200);
  }, [meetings, allProjects]);

  const navigateToMeeting = useCallback((row: PaletteMeetingRow) => {
    setCurrentMeeting({ id: row.id, title: row.title });
    setOpen(false);
    router.push(`/meeting-details?id=${row.id}`);
  }, [router, setCurrentMeeting]);

  // Whether the on-screen rows belong to the query currently in the input. A newer keystroke (past
  // the search threshold) whose result has not landed yet is "pending": we suppress the old rows.
  const meetingResultCurrent = meetingResult.query === query;
  const meetingsSearchPending = shouldSearchMeetings(query) && !meetingResultCurrent;

  // cmdk reorders groups by their top item's score during search, so a high-scoring meeting could
  // otherwise float above the commands. Pin meeting rows to a low fixed score so any matching
  // command ranks above them, while keeping them visible (they are already server-filtered).
  const paletteFilter = useCallback(
    (value: string, search: string, keywords?: string[]) =>
      value.startsWith('meeting-result:') ? 0.0001 : defaultFilter(value, search, keywords),
    [],
  );

  // Register an unregistered dir on the fly, then file the meeting under it (copies page.tsx's
  // handleMovePickerSelect so the router learns the correction identically).
  const chooseProject = useCallback(async (row: ProjectRow) => {
    let project = row.project;
    if (!project) {
      try { project = await createProject(row.name, row.path, []); }
      catch (e) { toast.error('Failed to set project', { description: String(e) }); return; }
    }
    await fileUnder(project, 'chosen from palette');
    setOpen(false);
  }, [fileUnder]);

  const onPickerSelect = useCallback(async (sel: ProjectPickerSelection) => {
    let project = sel.project;
    if (!project) {
      if (!sel.dir) { toast.error('No folder to file under'); return; }
      try { project = await createProject(sel.name, sel.dir, []); }
      catch (e) { toast.error('Failed to set project', { description: String(e) }); return; }
    }
    await fileUnder(project, 'chosen from palette');
    setOpen(false);
  }, [fileUnder]);

  const openBoard = useCallback(async (board: WhiteboardMeta) => {
    window.dispatchEvent(new CustomEvent('tandem:canvas-show'));
    try {
      const raw = await invoke<string | null>('read_file_if_exists', { path: board.json_path });
      if (!raw) { toast.error('Could not read that whiteboard.'); return; }
      window.dispatchEvent(
        new CustomEvent('tandem:canvas-view-board', { detail: { snapshot: JSON.parse(raw), title: board.title } }),
      );
      toast.success(`Viewing "${board.title}" (read-only)`);
    } catch (e) {
      console.error('[Palette] open board failed', e);
      toast.error('Failed to load that whiteboard.');
    }
    setOpen(false);
  }, []);

  // Escape pops exactly one level. ProjectPicker's input handles its own Escape (preventDefault +
  // onEscape); if it already did, bail so we don't also pop.
  const handlePanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (e.defaultPrevented) return;
    e.preventDefault();
    if (page !== 'root') setPage('root');
    else setOpen(false);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex justify-center bg-black/50 transition-opacity duration-150"
      onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
    >
      <div
        className="mt-[15vh] self-start w-[560px] max-w-[90vw] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl"
        onKeyDown={handlePanelKeyDown}
      >
        {page === 'project' ? (
          <div className="p-2">
            <div className="flex items-center justify-between px-2 pb-2 text-xs text-muted-foreground">
              <span>Route this meeting to a project</span>
              <span className="flex-shrink-0">Esc to go back</span>
            </div>
            <ProjectPicker
              allowBrowse
              autoFocus
              meetingTitle={titleForMatch}
              onSelect={onPickerSelect}
              onEscape={() => setPage('root')}
            />
          </div>
        ) : page === 'boards' ? (
          <div className="p-2">
            <div className="flex items-center justify-between px-2 pb-2 text-xs text-muted-foreground">
              <span className="min-w-0 truncate">Board history · {activeProject?.name}</span>
              <span className="ml-2 flex-shrink-0">Esc to go back</span>
            </div>
            <div className="flex max-h-[320px] flex-col gap-0.5 overflow-y-auto">
              {boards.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No saved boards for this client yet.
                </div>
              ) : (
                boards.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => openBoard(b)}
                    className="flex flex-col items-start rounded-md px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    <span className="w-full truncate text-sm font-medium text-foreground">{b.title}</span>
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {new Date(b.saved_at_ms).toLocaleString()}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <Command filter={paletteFilter}>
            <CommandInput
              autoFocus
              placeholder="Search meetings, projects and commands…"
              value={query}
              onValueChange={runMeetingSearch}
            />
            <CommandList>
              <CommandEmpty>No results.</CommandEmpty>

              <CommandGroup heading="Projects">
                {projectRows.length === 0 ? (
                  <CommandItem value="route project" onSelect={() => setPage('project')}>
                    <FolderKanban />
                    <span>Route this meeting to a project…</span>
                  </CommandItem>
                ) : (
                  <>
                    {projectRows.map((row) => (
                      <CommandItem
                        key={row.key}
                        value={`project ${row.name} ${row.path}`}
                        onSelect={() => { void chooseProject(row); }}
                      >
                        <FolderGit2 />
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate">File under {row.name}</span>
                          <span className="truncate text-xs text-muted-foreground">{row.path}</span>
                        </div>
                      </CommandItem>
                    ))}
                    <CommandItem value="all projects route" onSelect={() => setPage('project')}>
                      <Layers />
                      <span>All projects…</span>
                    </CommandItem>
                  </>
                )}
              </CommandGroup>

              <CommandGroup heading="Commands">
                <CommandItem value="switch route project" onSelect={() => setPage('project')}>
                  <FolderKanban />
                  <span>Switch / route project…</span>
                </CommandItem>

                {!isRecording && (
                  <CommandItem
                    value="start recording"
                    onSelect={() => { window.dispatchEvent(new CustomEvent('tandem:request-start-recording')); setOpen(false); }}
                  >
                    <Mic />
                    <span>Start recording</span>
                  </CommandItem>
                )}
                {!isRecording && calendarConfigured && (() => {
                  const ev = findEventNear(calendarEvents, Date.now())
                    ?? findUpcomingEvent(calendarEvents, Date.now(), 60 * 60_000);
                  if (!ev) return null;
                  return (
                    <CommandItem
                      value={`start recording for event ${ev.summary}`}
                      onSelect={() => { void startRecordingForEvent(ev); setOpen(false); }}
                    >
                      <CalendarDays />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate">Start recording for “{ev.summary}”</span>
                        <span className="truncate text-xs text-muted-foreground">From your calendar</span>
                      </div>
                    </CommandItem>
                  );
                })()}
                {isRecording && !handoverActive && (
                  <CommandItem
                    value="stop recording"
                    onSelect={() => { window.dispatchEvent(new CustomEvent('tandem:request-stop-recording')); setOpen(false); }}
                  >
                    <Square />
                    <span>Stop recording</span>
                  </CommandItem>
                )}
                {!isRecording && (
                  <CommandItem
                    value="start solo session"
                    onSelect={() => {
                      // Commit the mode first; RecordingControls' handler (via page.tsx handleBeforeRecord)
                      // reads recordingMode when the start event fires, so defer the start a tick.
                      setRecordingMode('solo');
                      setOpen(false);
                      setTimeout(() => window.dispatchEvent(new CustomEvent('tandem:request-start-recording')), 80);
                    }}
                  >
                    <User />
                    <span>Start Solo session</span>
                  </CommandItem>
                )}
                {!isRecording && (
                  <CommandItem
                    value="switch mode meeting solo"
                    onSelect={() => { setRecordingMode(recordingMode === 'solo' ? 'meeting' : 'solo'); setOpen(false); }}
                  >
                    {recordingMode === 'solo' ? <Users /> : <User />}
                    <span>Switch mode to {recordingMode === 'solo' ? 'Meeting' : 'Solo'}</span>
                  </CommandItem>
                )}

                <CommandItem value="ai panel toggle assistant" onSelect={() => { void toggleAiPanel(); setOpen(false); }}>
                  <PanelRightOpen />
                  <span>{isPanelOpen ? 'Close AI panel' : 'Open AI panel'}</span>
                  <CommandShortcut>Ctrl+.</CommandShortcut>
                </CommandItem>

                <CommandItem value="canvas toggle whiteboard chat" onSelect={() => { toggleCanvasView(); setOpen(false); }}>
                  <PenTool />
                  <span>{canvasVisible ? 'Show chat' : 'Show canvas'}</span>
                  <CommandShortcut>Ctrl+,</CommandShortcut>
                </CommandItem>

                <CommandItem
                  value="draw on canvas"
                  onSelect={() => {
                    window.dispatchEvent(new CustomEvent('tandem:canvas-show'));
                    window.dispatchEvent(new CustomEvent('tandem:canvas-draw-next'));
                    setOpen(false);
                  }}
                >
                  <PenTool />
                  <span>Draw on canvas</span>
                </CommandItem>

                <CommandItem
                  value="new whiteboard board"
                  onSelect={() => { window.dispatchEvent(new CustomEvent('tandem:canvas-show')); void clearCanvas(); setOpen(false); }}
                >
                  <Plus />
                  <span>New whiteboard</span>
                </CommandItem>

                {activeProject && (
                  <CommandItem value="board history whiteboards" onSelect={() => setPage('boards')}>
                    <History />
                    <div className="flex min-w-0 flex-col">
                      <span>Board history…</span>
                      <span className="truncate text-xs text-muted-foreground">{activeProject.name}</span>
                    </div>
                  </CommandItem>
                )}

                {calendarConfigured && (
                  <CommandItem
                    value="refresh calendar agenda"
                    onSelect={() => {
                      setOpen(false);
                      void (async () => {
                        const result = await refreshCalendar();
                        if (!result) {
                          toast.error('Could not refresh the calendar', {
                            description: 'Check the calendar URL in Settings.',
                          });
                        } else {
                          const n = result.todayCount;
                          toast.success(`Calendar refreshed — ${n} ${n === 1 ? 'call' : 'calls'} today`);
                        }
                      })();
                    }}
                  >
                    <RefreshCw />
                    <span>Refresh calendar</span>
                  </CommandItem>
                )}

                <CommandItem
                  value="show today agenda calendar"
                  onSelect={() => {
                    setOpen(false);
                    if (pathname !== '/') router.push('/');
                    setTimeout(() => window.dispatchEvent(new CustomEvent('tandem:show-agenda')), 120);
                  }}
                >
                  <CalendarDays />
                  <span>Show today&apos;s agenda</span>
                </CommandItem>

                <CommandItem value="generate handoff claude code" onSelect={() => { void runHandoff(); setOpen(false); }}>
                  <FileText />
                  <span>Generate handoff</span>
                  <CommandShortcut>/handoff</CommandShortcut>
                </CommandItem>
              </CommandGroup>

              {shouldSearchMeetings(query) && (meetingsSearchPending || (meetingResultCurrent && meetingResult.rows.length > 0)) && (
                <CommandGroup heading="Meetings">
                  {meetingsSearchPending ? (
                    // A newer query is debouncing / in flight: show a searching hint rather than the
                    // previous query's rows, so no stale row can be arrow-selected or Enter-navigated.
                    <CommandItem value="meeting-result:searching" disabled className="text-xs text-muted-foreground">
                      <NotebookText />
                      <span>Searching…</span>
                    </CommandItem>
                  ) : (
                    <>
                      {meetingResult.rows.map((row) => (
                        <CommandItem
                          key={row.id}
                          data-testid="palette-meeting-row"
                          // Value is unique per meeting id (never the title) so two meetings sharing a
                          // title get distinct cmdk selection state; the title rides along as a keyword.
                          // paletteFilter pins any `meeting-result:` row below the commands regardless.
                          value={`meeting-result:${row.id}`}
                          keywords={[row.title]}
                          onSelect={() => navigateToMeeting(row)}
                        >
                          <NotebookText />
                          <div className="flex min-w-0 flex-col">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate">{row.title}</span>
                              {row.projectName && (
                                <span className="flex-shrink-0 inline-flex items-center gap-1 rounded bg-brand-muted px-1.5 py-0.5 text-[10px] font-medium text-brand-muted-foreground">
                                  <FolderGit2 className="!h-3 !w-3" />
                                  {row.projectName}
                                </span>
                              )}
                            </div>
                            {row.snippet ? (
                              <span className="truncate text-xs text-muted-foreground">{row.snippet}</span>
                            ) : row.date ? (
                              <span className="truncate text-xs text-muted-foreground tabular-nums">
                                {new Date(row.date).toLocaleDateString()}
                              </span>
                            ) : null}
                          </div>
                        </CommandItem>
                      ))}
                      {meetingResult.overflow > 0 && (
                        <CommandItem
                          value="meeting-result:more-in-sidebar"
                          disabled
                          className="text-xs text-muted-foreground"
                        >
                          <Layers />
                          <span>{meetingResult.overflow} more in sidebar search</span>
                        </CommandItem>
                      )}
                    </>
                  )}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        )}
      </div>
    </div>
  );
}
