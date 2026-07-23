'use client';

/**
 * Solo Mode floating HUD overlay
 * ------------------------------------------------------------------
 * Runs in a SEPARATE, always-on-top, transparent Tauri window labeled
 * `solo-hud` (see tauri.conf.json). It has its OWN minimal React tree and
 * therefore CANNOT read the main window's React context — all communication
 * is via Tauri events + existing Tauri commands.
 *
 * Event contract (must match the main window):
 *   IN  solo-active-project   { id: string | null, name: string | null }
 *       → updates the pill; pulse + chime on change. `name` is the live Claude
 *         session name when the switch came from a session pick, otherwise the
 *         project name.
 *   IN  solo-session-stopped  (no payload) → self-reset to listening.
 *   OUT solo-hud-switch       { projectId?, cwd?, name?, sessionName?, sessionBranch?, headBranch?, branchMismatch? }
 *       → main window (useSoloModeRouter) applies a manual project correction;
 *         payloads without projectId carry a cwd to auto-register first.
 *         sessionName (set for live-session picks) is preferred as the pill
 *         label in the reply, falling back to the project name.
 *
 * The window is shown/hidden by the main window via
 * WebviewWindow.getByLabel('solo-hud').show()/.hide().
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

/** Broadcast an event to the other window via the Rust core (JS cross-window
 *  emit/emitTo is unreliable here; Rust `app.emit` reaches all webviews). */
function relay(event: string, payload: unknown = {}): Promise<void> {
  return invoke('relay_event', { event, payload });
}
import { LogicalSize } from '@tauri-apps/api/dpi';
import { listProjects, type Project } from '@/services/projectService';
import { useClaudeSessionCandidates } from '@/hooks/useClaudeSessionCandidates';
import {
  folderName,
  sessionDisplayName,
  type ClaudeSessionCandidate,
} from '@/services/claudeSessionService';

interface ActiveProjectPayload {
  id: string | null;
  name: string | null;
}

/** Compact relative time ("just now", "2m ago", "3h ago", "5d ago"). */
function relativeTime(ms: number | null): string {
  if (ms == null) return '';
  const delta = Date.now() - ms;
  if (delta < 0) return 'just now';
  const s = Math.floor(delta / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

const COLLAPSED_SIZE = { width: 240, height: 56 };
// Header row (~56) + rows of projects/sessions, capped so the picker never grows
// off-screen. Wider so full Claude session names are readable; the list scrolls.
const EXPANDED_SIZE = { width: 340, height: 480 };

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Short, soft Web Audio chime on project change (no external assets). */
function playChime() {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.26);
    osc.onended = () => ctx.close().catch(() => {});
  } catch {
    /* audio is best-effort */
  }
}

export default function SoloHudPage() {
  const [active, setActive] = useState<ActiveProjectPayload>({ id: null, name: null });
  const [pulse, setPulse] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);

  // Live Claude session candidates — polled only while the picker is open.
  const { candidates } = useClaudeSessionCandidates(expanded);

  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = active.id;

  const projectsRef = useRef<Project[]>([]);
  projectsRef.current = projects;
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Resize window to fit collapsed / expanded states ──────────────────
  const resizeWindow = useCallback((toExpanded: boolean) => {
    const size = toExpanded ? EXPANDED_SIZE : COLLAPSED_SIZE;
    getCurrentWebviewWindow()
      .setSize(new LogicalSize(size.width, size.height))
      .catch(err => console.warn('[SoloHUD] resize failed:', err));
  }, []);

  // ── Listen for state from the main window ─────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const unlistenFns: UnlistenFn[] = [];
    // If the effect tears down before a listen() promise resolves, unlisten
    // immediately so we don't leak an orphaned listener.
    const track = (fn: UnlistenFn) => {
      if (cancelled) fn();
      else unlistenFns.push(fn);
    };

    listen<ActiveProjectPayload>('solo-active-project', event => {
      const next = event.payload ?? { id: null, name: null };
      const changed = next.id !== activeIdRef.current;
      setActive(next);
      // Pulse + chime only when switching to a real (named) project, and only
      // when the id actually changed (not on the initial "Listening" emit).
      if (changed && next.id) {
        if (!prefersReducedMotion()) {
          setPulse(true);
          if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
          pulseTimerRef.current = setTimeout(() => setPulse(false), 1500);
        }
        playChime();
      }
    }).then(fn => {
      track(fn);
      // Announce we're mounted ONLY after the active-project listener is live, so
      // the main window's replayed `solo-active-project` reply can't race ahead of
      // our subscription. Without this, a HUD that opens/reloads after a project
      // switch would stay blank (the event is only pushed on change).
      if (!cancelled) {
        relay('solo-hud-ready').catch(err =>
          console.warn('[SoloHUD] failed to announce ready:', err),
        );
      }
    });

    listen('solo-session-stopped', () => {
      setActive({ id: null, name: null });
      setExpanded(false);
      resizeWindow(false);
    }).then(track);

    return () => {
      cancelled = true;
      unlistenFns.forEach(fn => fn());
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    };
  }, [resizeWindow]);

  // ── Esc / click-away collapse ─────────────────────────────────────────
  useEffect(() => {
    if (!expanded) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') collapse();
    };
    const onClickAway = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-hud-root]')) collapse();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClickAway);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClickAway);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const collapse = useCallback(() => {
    setExpanded(false);
    resizeWindow(false);
  }, [resizeWindow]);

  const expand = useCallback(async () => {
    setExpanded(true);
    resizeWindow(true);
    setLoadingProjects(true);
    try {
      const list = await listProjects();
      setProjects(list);
    } catch (err) {
      console.warn('[SoloHUD] failed to load projects:', err);
    } finally {
      setLoadingProjects(false);
    }
  }, [resizeWindow]);

  const togglePicker = useCallback(() => {
    if (expanded) collapse();
    else expand();
  }, [expanded, collapse, expand]);

  const handlePick = useCallback(
    (project: Project) => {
      if (project.id !== activeIdRef.current) {
        relay('solo-hud-switch', { projectId: project.id }).catch(err =>
          console.warn('[SoloHUD] emit switch failed:', err),
        );
      }
      collapse();
    },
    [collapse],
  );

  const handlePickCandidate = useCallback(
    (c: ClaudeSessionCandidate) => {
      const branchMeta = {
        sessionBranch: c.git_branch,
        headBranch: c.head_branch,
        branchMismatch: c.branch_mismatch,
      };
      // Registered → route by project id (identical flow to the rows below).
      // Unregistered → hand the main window the cwd so it can auto-register.
      // Trust registered_project_id as-is: the Rust side matched it against the
      // live projects table with path normalization, whereas our local project
      // snapshot can be stale (loaded when the picker expanded).
      const known = Boolean(c.registered_project_id);
      // sessionName travels alongside so the pill can show the Claude session
      // title (not the project name) when the switch came from a live session.
      const sessionName = sessionDisplayName(c);
      const payload = known
        ? { projectId: c.registered_project_id, sessionName, ...branchMeta }
        : { cwd: c.cwd, name: folderName(c.cwd), sessionName, ...branchMeta };

      // Avoid a no-op switch to the already-active registered project.
      if (known && c.registered_project_id === activeIdRef.current) {
        collapse();
        return;
      }
      relay('solo-hud-switch', payload).catch(err =>
        console.warn('[SoloHUD] emit session switch failed:', err),
      );
      collapse();
    },
    [collapse],
  );

  // Show ALL live sessions (sort order preserved by the service); the list
  // container scrolls, so a large fleet just scrolls within the picker.
  const sessionCandidates = candidates;

  const isListening = active.name === null;

  return (
    <div
      data-hud-root
      className="flex flex-col items-stretch w-screen h-screen select-none p-2"
    >
      {/* Pill */}
      <div
        data-tauri-drag-region
        onClick={togglePicker}
        className="group relative flex items-center gap-2.5 h-10 px-3 rounded-full
                   border border-border bg-card/95 backdrop-blur-md shadow-lg
                   cursor-pointer transition-colors hover:bg-card"
        title={isListening ? 'Solo Mode — listening' : `Active: ${active.name}`}
      >
        {/* Status dot */}
        <span className="relative flex items-center justify-center pointer-events-none">
          {isListening ? (
            <span className="w-2.5 h-2.5 rounded-full border-2 border-muted-foreground/70" />
          ) : (
            <>
              <span className="w-2.5 h-2.5 rounded-full bg-brand" />
              {pulse && (
                <span className="absolute inset-0 -m-1 rounded-full border border-brand animate-hud-pulse" />
              )}
            </>
          )}
        </span>

        {/* Label */}
        <span
          className={`flex-1 truncate text-sm font-medium pointer-events-none ${
            isListening ? 'text-muted-foreground' : 'text-foreground'
          }`}
        >
          {isListening ? 'Listening…' : active.name}
        </span>

        {/* Caret — a real button (NOT pointer-events-none) so the click lands here
            instead of being swallowed by the pill's drag region. `no-drag` keeps
            Tauri from treating it as a window-drag handle. */}
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            togglePicker();
          }}
          aria-label={expanded ? 'Close project picker' : 'Open project picker'}
          className="no-drag pointer-events-auto -mr-1 flex items-center justify-center rounded p-0.5
                     text-muted-foreground hover:text-foreground transition-colors
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>

      {/* Project picker */}
      {expanded && (
        <div
          className="mt-1.5 flex-1 min-h-0 overflow-y-auto rounded-xl border border-border
                     bg-card/95 backdrop-blur-md shadow-lg p-1 custom-scrollbar"
        >
          {sessionCandidates.length > 0 && (
            <div className="mb-1">
              <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                Live sessions ({sessionCandidates.length})
              </p>
              <ul className="flex flex-col">
                {sessionCandidates.map(c => {
                  const branch = c.git_branch;
                  const when = relativeTime(c.last_user_activity_ms ?? c.last_activity_ms);
                  return (
                    <li key={c.session_id}>
                      <button
                        onClick={() => handlePickCandidate(c)}
                        className="flex w-full flex-col gap-0.5 px-2 py-1.5 rounded-lg text-left
                                   hover:bg-muted transition-colors focus-visible:outline-none
                                   focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                      >
                        <span className="flex w-full items-start gap-2">
                          <span className="flex-1 min-w-0 break-words line-clamp-2 text-sm text-foreground">
                            {sessionDisplayName(c)}
                          </span>
                          {when && (
                            <span className="shrink-0 pt-0.5 text-[11px] text-muted-foreground tabular-nums">
                              {when}
                            </span>
                          )}
                        </span>
                        <span className="flex w-full items-center gap-1.5 text-[11px] text-muted-foreground">
                          <span className="min-w-0 flex-1 truncate text-left text-[10px] font-mono text-muted-foreground [direction:rtl]">
                            <bdo dir="ltr">{c.cwd}</bdo>
                          </span>
                          {branch && (
                            <span
                              title={
                                c.branch_mismatch
                                  ? `Session expected ${branch}; checkout is on ${c.head_branch ?? 'unknown'}`
                                  : `Branch ${branch}`
                              }
                              className={`shrink-0 inline-flex min-w-0 max-w-[45%] items-center gap-1 rounded px-1 py-px
                                          font-mono text-[10px] ${
                                            c.branch_mismatch
                                              ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                                              : 'bg-muted text-muted-foreground'
                                          }`}
                            >
                              {c.branch_mismatch && (
                                <svg
                                  width="9"
                                  height="9"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden
                                >
                                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                                  <line x1="12" y1="9" x2="12" y2="13" />
                                  <line x1="12" y1="17" x2="12.01" y2="17" />
                                </svg>
                              )}
                              <span className="truncate max-w-[80px]">{branch}</span>
                            </span>
                          )}
                        </span>
                        {c.branch_mismatch && (
                          <span className="text-[10px] text-amber-600 dark:text-amber-400">
                            checkout on {c.head_branch ?? 'unknown'}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="mx-2 my-1 border-t border-border/60" />
            </div>
          )}
          <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            Route to project
          </p>
          {loadingProjects ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">Loading…</p>
          ) : projects.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              No projects registered.
            </p>
          ) : (
            <ul className="flex flex-col">
              {projects.map(project => {
                const isCurrent = project.id === active.id;
                return (
                  <li key={project.id}>
                    <button
                      onClick={() => handlePick(project)}
                      className="flex w-full items-start gap-2 px-2 py-1.5 rounded-lg text-left
                                 text-sm text-foreground hover:bg-muted transition-colors
                                 focus-visible:outline-none focus-visible:ring-2
                                 focus-visible:ring-ring focus-visible:ring-offset-1"
                    >
                      <span
                        className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                          isCurrent ? 'bg-brand' : 'bg-transparent'
                        }`}
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-sm font-medium">{project.name}</span>
                        <span className="min-w-0 truncate text-left text-[10px] font-mono text-muted-foreground [direction:rtl]">
                          <bdo dir="ltr">{project.path}</bdo>
                        </span>
                      </span>
                      {isCurrent && (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="mt-0.5 text-brand shrink-0"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
