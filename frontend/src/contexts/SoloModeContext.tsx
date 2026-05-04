'use client';

import React, { createContext, useContext, useState, useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { Project } from '@/services/projectService';
import { setActiveSoloProject } from '@/services/screenshotService';
import { SoloTask, ProjectHistoryEntry } from '@/types/solo';

interface SoloModeState {
  isActive: boolean;
  activeProject: Project | null;
  projectHistory: ProjectHistoryEntry[];
  detectedTasks: SoloTask[];
  isProcessing: boolean;
  routingModel: string;
}

interface SoloModeContextType extends SoloModeState {
  startSoloSession: () => void;
  stopSoloSession: () => void;
  switchProject: (project: Project, transcriptIndex: number) => void;
  addTask: (task: SoloTask) => void;
  setRoutingModel: (model: string) => void;
  getActiveProjectHistory: () => ProjectHistoryEntry | null;
}

const DEFAULT_ROUTING_MODEL = 'gemma4:26b';
// Bumped 2026-04-15 — reset to default on this version to pick up gemma4:26b again
const MODEL_VERSION = 'v2';

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
    }));
    toast.success('Solo Mode active', {
      description: 'Listening for project switches and tasks',
      duration: 4000,
    });
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
    }));
    setActiveSoloProject(null).catch(err =>
      console.warn('[SoloMode] Failed to clear screenshot routing:', err),
    );
  }, []);

  const switchProject = useCallback((project: Project, transcriptIndex: number) => {
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
    };
    history.push(newEntry);
    historyRef.current = history;

    setState(prev => ({
      ...prev,
      activeProject: project,
      projectHistory: history,
    }));
    setActiveSoloProject(project.path).catch(err =>
      console.warn('[SoloMode] Failed to set screenshot routing:', err),
    );
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
    getActiveProjectHistory,
  }), [state, startSoloSession, stopSoloSession, switchProject, addTask, setRoutingModel, getActiveProjectHistory]);

  return (
    <SoloModeContext.Provider value={contextValue}>
      {children}
    </SoloModeContext.Provider>
  );
}
