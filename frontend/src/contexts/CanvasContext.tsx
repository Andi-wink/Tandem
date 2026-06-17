'use client';

/**
 * CanvasContext — Tandem's host-side handle on the voice-driven canvas.
 *
 * Tandem does NOT implement any drawing/agent logic; that lives in the agent-whiteboard `apps/agent`
 * kit, which Tandem opens in a dedicated Tauri window and drives by sending natural-language
 * instructions. All canvas window ops go through Rust commands (see `src-tauri/src/canvas`). This
 * context just exposes them to the React tree plus a little UI state (status, the agent URL, and the
 * transcript-privacy opt-in used by the voice flow).
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { logger } from '@/lib/logger';

const DEFAULT_AGENT_URL = 'http://localhost:5174';
const URL_STORAGE_KEY = 'tandem-canvas-url';
const PRIVACY_STORAGE_KEY = 'tandem-canvas-transcript-optin';

export type CanvasStatus = 'idle' | 'sending' | 'sent' | 'error';

interface CanvasContextType {
  /** URL of the agent app the canvas window loads (dev: http://localhost:5174). */
  agentUrl: string;
  setAgentUrl: (url: string) => void;
  /** Whether the canvas window is currently visible. */
  isOpen: boolean;
  /** Health of the agent app URL (null = unknown/not yet checked). */
  isHealthy: boolean | null;
  status: CanvasStatus;
  lastError: string | null;
  /** Opt-in to sending the rolling transcript window as context to the canvas (voice flow). */
  transcriptOptIn: boolean;
  setTranscriptOptIn: (v: boolean) => void;

  openCanvas: () => Promise<void>;
  hideCanvas: () => Promise<void>;
  toggleCanvas: () => Promise<void>;
  /** Send a natural-language instruction to the canvas agent. */
  sendPrompt: (message: string, opts?: { show?: boolean }) => Promise<boolean>;
  checkHealth: () => Promise<boolean>;
}

const CanvasContext = createContext<CanvasContextType | null>(null);

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function CanvasProvider({ children }: { children: React.ReactNode }) {
  const [agentUrl, setAgentUrlState] = useState(DEFAULT_AGENT_URL);
  const [isOpen, setIsOpen] = useState(false);
  const [isHealthy, setIsHealthy] = useState<boolean | null>(null);
  const [status, setStatus] = useState<CanvasStatus>('idle');
  const [lastError, setLastError] = useState<string | null>(null);
  const [transcriptOptIn, setTranscriptOptInState] = useState(false);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load persisted settings
  useEffect(() => {
    try {
      const u = localStorage.getItem(URL_STORAGE_KEY);
      if (u) setAgentUrlState(u);
      setTranscriptOptInState(localStorage.getItem(PRIVACY_STORAGE_KEY) === '1');
    } catch {
      /* ignore */
    }
  }, []);

  const setAgentUrl = useCallback((url: string) => {
    setAgentUrlState(url);
    try {
      localStorage.setItem(URL_STORAGE_KEY, url);
    } catch {
      /* ignore */
    }
  }, []);

  const setTranscriptOptIn = useCallback((v: boolean) => {
    setTranscriptOptInState(v);
    try {
      localStorage.setItem(PRIVACY_STORAGE_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);

  const flashStatus = useCallback((s: CanvasStatus) => {
    setStatus(s);
    if (statusTimer.current) clearTimeout(statusTimer.current);
    if (s === 'sent' || s === 'error') {
      statusTimer.current = setTimeout(() => setStatus('idle'), 2500);
    }
  }, []);

  const checkHealth = useCallback(async (): Promise<boolean> => {
    if (!inTauri()) return false;
    try {
      const ok = await invoke<boolean>('canvas_health_check', { url: agentUrl });
      setIsHealthy(ok);
      return ok;
    } catch (e) {
      logger.warn('[Canvas] health check failed', e);
      setIsHealthy(false);
      return false;
    }
  }, [agentUrl]);

  const refreshOpen = useCallback(async () => {
    if (!inTauri()) return;
    try {
      setIsOpen(await invoke<boolean>('canvas_is_open'));
    } catch {
      /* ignore */
    }
  }, []);

  const openCanvas = useCallback(async () => {
    if (!inTauri()) return;
    await invoke('canvas_open', { url: agentUrl });
    setIsOpen(true);
  }, [agentUrl]);

  const hideCanvas = useCallback(async () => {
    if (!inTauri()) return;
    await invoke('canvas_hide');
    setIsOpen(false);
  }, []);

  const toggleCanvas = useCallback(async () => {
    if (!inTauri()) return;
    const open = await invoke<boolean>('canvas_toggle', { url: agentUrl });
    setIsOpen(open);
  }, [agentUrl]);

  const sendPrompt = useCallback(
    async (message: string, opts?: { show?: boolean }): Promise<boolean> => {
      const trimmed = message.trim();
      if (!trimmed) return false;
      if (!inTauri()) {
        logger.warn('[Canvas] sendPrompt called outside Tauri');
        return false;
      }
      flashStatus('sending');
      setLastError(null);
      try {
        await invoke('canvas_send_prompt', {
          message: trimmed,
          url: agentUrl,
          show: opts?.show ?? true,
        });
        setIsOpen(true);
        flashStatus('sent');
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error('[Canvas] sendPrompt failed', msg);
        setLastError(msg);
        flashStatus('error');
        return false;
      }
    },
    [agentUrl, flashStatus],
  );

  useEffect(() => {
    void refreshOpen();
    return () => {
      if (statusTimer.current) clearTimeout(statusTimer.current);
    };
  }, [refreshOpen]);

  const value = useMemo<CanvasContextType>(
    () => ({
      agentUrl,
      setAgentUrl,
      isOpen,
      isHealthy,
      status,
      lastError,
      transcriptOptIn,
      setTranscriptOptIn,
      openCanvas,
      hideCanvas,
      toggleCanvas,
      sendPrompt,
      checkHealth,
    }),
    [
      agentUrl,
      setAgentUrl,
      isOpen,
      isHealthy,
      status,
      lastError,
      transcriptOptIn,
      setTranscriptOptIn,
      openCanvas,
      hideCanvas,
      toggleCanvas,
      sendPrompt,
      checkHealth,
    ],
  );

  return <CanvasContext.Provider value={value}>{children}</CanvasContext.Provider>;
}

export function useCanvas(): CanvasContextType {
  const ctx = useContext(CanvasContext);
  if (!ctx) throw new Error('useCanvas must be used within a CanvasProvider');
  return ctx;
}
