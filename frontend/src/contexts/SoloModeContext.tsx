'use client';

import React, { createContext, useContext, useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { toast } from 'sonner';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Project } from '@/services/projectService';
import { setActiveSoloProject } from '@/services/screenshotService';
import { SoloTask, ProjectHistoryEntry } from '@/types/solo';

/** localStorage key for the "Floating project HUD" toggle (default ON). */
export const SOLO_HUD_ENABLED_KEY = 'tandem-solo-hud-enabled';

function isHudEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  return localStorage.getItem(SOLO_HUD_ENABLED_KEY) !== 'false';
}

/** Show/hide the separate `solo-hud` overlay window. Best-effort; no-ops if the
 *  window doesn't exist (e.g. running in a browser / window not yet created). */
async function setHudWindowVisible(visible: boolean): Promise<void> {
  try {
    const hud = await WebviewWindow.getByLabel('solo-hud');
    if (!hud) return;
    if (visible) await hud.show();
    else await hud.hide();
  } catch (err) {
    console.warn('[SoloMode] HUD window toggle failed:', err);
  }
}

/** Relay an event to the HUD window through the Rust core. JS cross-window
 *  emit/emitTo did not reliably reach the separate `solo-hud` webview, so we
 *  broadcast via Rust `app.emit` (reaches all webviews) instead. */
function relayToHud(event: string, payload: unknown = {}): void {
  invoke('relay_event', { event, payload }).catch(err =>
    console.warn(`[SoloMode] relay '${event}' failed:`, err),
  );
}

/** Push the active project to the HUD window. */
function emitHudActiveProject(id: string | null, name: string | null): void {
  relayToHud('solo-active-project', { id, name });
}

interface SoloModeState {
  isActive: boolean;
  activeProject: Project | null;
  projectHistory: ProjectHistoryEntry[];
  detectedTasks: SoloTask[];
  isProcessing: boolean;
  routingModel: string;
  /** `.tandem`-relative filing subfolder for the CURRENTLY active project. All
   *  Solo Mode artifacts are written under {projectPath}/.tandem/{sessionFolder}/.
   *  Set per active project by the router (useSoloModeRouter.performProjectSwitch):
   *   - plain folder project → "MyMeeting_2026-05-08_14-30-15" (meeting title +
   *     start stamp, computed once per Solo session, shared across plain switches).
   *   - F061 virtual sub-project → "sessions/HH.MM, DD.MM - <name>" (session start
   *     time from the row's created_at) so each chat's artifacts stay isolated.
   *     Null until the first project switch. */
  sessionFolder: string | null;
}

interface SoloModeContextType extends SoloModeState {
  startSoloSession: () => void;
  stopSoloSession: () => void;
  switchProject: (project: Project, transcriptIndex: number, branch?: string | null, displayName?: string | null, screenshotSubfolder?: string | null) => void;
  addTask: (task: SoloTask) => void;
  setRoutingModel: (model: string) => void;
  setSessionFolder: (folder: string) => void;
  getActiveProjectHistory: () => ProjectHistoryEntry | null;
}

const DEFAULT_ROUTING_MODEL = 'gemma4:12b';
// Bumped 2026-06-11 — default routing model switched to gemma4:12b (from gpt-oss:20b).
// Gemma 4 12B (recently released) follows the strict JSON schema reliably for switch/intent
// detection and needs ~7.6GB VRAM vs gpt-oss:20b's ~13GB, leaving more headroom for the
// Whisper/Parakeet GPU engine. The version bump migrates existing users off the old saved default.
const MODEL_VERSION = 'v5';

const SoloModeContext = createContext<SoloModeContextType | null>(null);

export const useSoloMode = () => {
  const context = useContext(SoloModeContext);
  if (!context) {
    throw new Error('useSoloMode must be used within a SoloModeProvider');
  }
  return context;
};

export function SoloModeProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SoloModeState>({
    isActive: false,
    activeProject: null,
    projectHistory: [],
    detectedTasks: [],
    isProcessing: false,
    sessionFolder: null,
    routingModel: (() => {
      if (typeof window === 'undefined') return DEFAULT_ROUTING_MODEL;
      const savedVersion = localStorage.getItem('tandem-solo-routing-model-version');
      if (savedVersion !== MODEL_VERSION) {
        localStorage.setItem('tandem-solo-routing-model-version', MODEL_VERSION);
        localStorage.setItem('tandem-solo-routing-model', DEFAULT_ROUTING_MODEL);
        return DEFAULT_ROUTING_MODEL;
      }
      return localStorage.getItem('tandem-solo-routing-model') ?? DEFAULT_ROUTING_MODEL;
    })(),
  });

  // Keep a ref for the current history index (for closing entries on switch)
  const historyRef = useRef<ProjectHistoryEntry[]>([]);

  // Mirror the live HUD-relevant state into a ref so the `solo-hud-ready`
  // handshake (below) can replay it without re-subscribing on every change.
  const hudStateRef = useRef<{ isActive: boolean; id: string | null; name: string | null }>({
    isActive: false,
    id: null,
    name: null,
  });
  hudStateRef.current = {
    isActive: state.isActive,
    id: state.activeProject?.id ?? null,
    name: state.activeProject?.name ?? null,
  };

  // The Solo HUD runs in a separate window with its own React tree. It only
  // receives `solo-active-project` events emitted AFTER its listener mounts, so
  // a HUD that opens (or hot-reloads in dev) after a project switch would sit
  // blank. The HUD announces itself with `solo-hud-ready`; replay the current
  // state in response so it always reflects reality.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen('solo-hud-ready', () => {
      const { isActive, id, name } = hudStateRef.current;
      if (isActive && isHudEnabled()) {
        setHudWindowVisible(true);
        emitHudActiveProject(id, name);
      } else {
        relayToHud('solo-session-stopped');
      }
    }).then(fn => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const startSoloSession = useCallback(() => {
    console.log('[SoloMode] Starting solo session');
    historyRef.current = [];
    setState(prev => ({
      ...prev,
      isActive: true,
      activeProject: null,
      projectHistory: [],
      detectedTasks: [],
      isProcessing: false,
      sessionFolder: null, // computed lazily on first project switch
    }));
    toast.success('Solo Mode active', {
      description: 'Listening for project switches and tasks',
      duration: 4000,
    });

    // Show the floating HUD (if enabled) and reset it to the "Listening" state.
    if (isHudEnabled()) {
      setHudWindowVisible(true);
      emitHudActiveProject(null, null);
    }
  }, []);

  const stopSoloSession = useCallback(() => {
    console.log('[SoloMode] Stopping solo session');
    // Close the last history entry
    const history = [...historyRef.current];
    if (history.length > 0) {
      const last = history[history.length - 1];
      if (last.endIndex === null) {
        last.endIndex = -1; // Will be set to actual index by the router
      }
    }
    historyRef.current = [];
    setState(prev => ({
      ...prev,
      isActive: false,
      activeProject: null,
      projectHistory: history,
      sessionFolder: null,
    }));
    setActiveSoloProject(null).catch(err =>
      console.warn('[SoloMode] Failed to clear screenshot routing:', err),
    );

    // Hide the floating HUD and notify it to self-reset.
    relayToHud('solo-session-stopped');
    setHudWindowVisible(false);
  }, []);

  const switchProject = useCallback((project: Project, transcriptIndex: number, branch?: string | null, displayName?: string | null, screenshotSubfolder?: string | null) => {
    console.log(`[SoloMode] Switching to project: ${project.name} at index ${transcriptIndex}`);

    // Close previous entry
    const history = [...historyRef.current];
    if (history.length > 0) {
      const last = history[history.length - 1];
      if (last.endIndex === null) {
        last.endIndex = transcriptIndex - 1;
      }
    }

    // Open new entry
    const newEntry: ProjectHistoryEntry = {
      project,
      startIndex: transcriptIndex,
      endIndex: null,
      startTime: Date.now(),
      branch: branch ?? null,
    };
    history.push(newEntry);
    historyRef.current = history;

    setState(prev => ({
      ...prev,
      activeProject: project,
      projectHistory: history,
    }));
    // F061: for a virtual sub-project, screenshotSubfolder ("sessions/<slug>-<id>")
    // routes captured screenshots into that session folder's screenshots/ dir;
    // plain projects pass null and keep the shared .tandem/screenshots/.
    setActiveSoloProject(project.path, screenshotSubfolder ?? null).catch(err =>
      console.warn('[SoloMode] Failed to set screenshot routing:', err),
    );

    // Update the floating HUD with the new active project. When the switch came
    // from a live Claude session pick, prefer that session's name for the pill
    // label; otherwise fall back to the project name. (Note: on a HUD reload the
    // `solo-hud-ready` replay re-emits the project name, since the session name
    // is not persisted in state — an accepted, minor degradation.)
    emitHudActiveProject(project.id, displayName ?? project.name);
  }, []);

  const addTask = useCallback((task: SoloTask) => {
    setState(prev => ({
      ...prev,
      detectedTasks: [...prev.detectedTasks, task],
    }));
  }, []);

  const setRoutingModel = useCallback((model: string) => {
    localStorage.setItem('tandem-solo-routing-model', model);
    setState(prev => ({ ...prev, routingModel: model }));
  }, []);

  const setSessionFolder = useCallback((folder: string) => {
    setState(prev => ({ ...prev, sessionFolder: folder }));
  }, []);

  const getActiveProjectHistory = useCallback((): ProjectHistoryEntry | null => {
    const history = historyRef.current;
    if (history.length === 0) return null;
    const last = history[history.length - 1];
    return last.endIndex === null ? last : null;
  }, []);

  const contextValue = useMemo<SoloModeContextType>(() => ({
    ...state,
    startSoloSession,
    stopSoloSession,
    switchProject,
    addTask,
    setRoutingModel,
    setSessionFolder,
    getActiveProjectHistory,
  }), [state, startSoloSession, stopSoloSession, switchProject, addTask, setRoutingModel, setSessionFolder, getActiveProjectHistory]);

  return (
    <SoloModeContext.Provider value={contextValue}>
      {children}
    </SoloModeContext.Provider>
  );
}
