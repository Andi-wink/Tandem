'use client';

/**
 * CanvasContext — Tandem's host-side handle on the embedded canvas.
 *
 * The canvas is the agent-whiteboard kit, loaded in an <iframe> inside the AI panel (see
 * CanvasIframe). Tandem never forks canvas code — it drives the iframe by postMessage, which the
 * app's prompt bridge forwards to `agent.prompt()`. Because the iframe is cross-origin we can't read
 * its readiness flag directly, so the bridge posts `canvas:ready` up to us; until then we queue.
 *
 * This context exposes: the agent URL, the in-panel canvas visibility, iframe registration, the
 * transcript-privacy opt-in, and `sendPrompt` (the one call that draws/edits on the canvas).
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
import { logger } from '@/lib/logger';

const DEFAULT_AGENT_URL = 'http://localhost:5174';
const URL_STORAGE_KEY = 'tandem-canvas-url';
const PRIVACY_STORAGE_KEY = 'tandem-canvas-transcript-optin';

export type CanvasStatus = 'idle' | 'sending' | 'sent' | 'error';

interface CanvasContextType {
  agentUrl: string;
  setAgentUrl: (url: string) => void;
  /** Whether the in-panel canvas view is shown (vs the chat view). */
  canvasVisible: boolean;
  showCanvas: () => void;
  hideCanvas: () => void;
  toggleCanvas: () => void;
  /** Whether the canvas is expanded to fill the whole window (vs the panel width). */
  canvasExpanded: boolean;
  setCanvasExpanded: (v: boolean) => void;
  toggleExpand: () => void;
  /** True once the embedded canvas agent has announced it's ready to receive prompts. */
  canvasReady: boolean;
  status: CanvasStatus;
  lastError: string | null;
  transcriptOptIn: boolean;
  setTranscriptOptIn: (v: boolean) => void;

  /** CanvasIframe calls this with its contentWindow (or null on unmount). */
  registerCanvasIframe: (win: Window | null) => void;
  /** Send a natural-language instruction to the embedded canvas (shows the canvas view). */
  sendPrompt: (message: string) => Promise<boolean>;
}

const CanvasContext = createContext<CanvasContextType | null>(null);

export function CanvasProvider({ children }: { children: React.ReactNode }) {
  const [agentUrl, setAgentUrlState] = useState(DEFAULT_AGENT_URL);
  const [canvasVisible, setCanvasVisible] = useState(false);
  const [canvasExpanded, setCanvasExpanded] = useState(false);
  const [canvasReady, setCanvasReady] = useState(false);
  const [status, setStatus] = useState<CanvasStatus>('idle');
  const [lastError, setLastError] = useState<string | null>(null);
  const [transcriptOptIn, setTranscriptOptInState] = useState(false);

  const iframeWinRef = useRef<Window | null>(null);
  const pendingRef = useRef<string | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const postToCanvas = useCallback((message: string): boolean => {
    const win = iframeWinRef.current;
    if (!win) return false;
    try {
      win.postMessage({ type: 'canvas:prompt', message }, '*');
      return true;
    } catch (e) {
      logger.warn('[Canvas] postMessage to iframe failed', e);
      return false;
    }
  }, []);

  const showCanvas = useCallback(() => setCanvasVisible(true), []);
  const hideCanvas = useCallback(() => setCanvasVisible(false), []);
  const toggleCanvas = useCallback(() => setCanvasVisible((v) => !v), []);
  const toggleExpand = useCallback(() => setCanvasExpanded((v) => !v), []);

  // Listen for the bridge's readiness announcement (and flush any queued prompt).
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const t = ev.data && typeof ev.data === 'object' ? (ev.data as { type?: unknown }).type : undefined;
      if (t === 'canvas:ready') {
        setCanvasReady(true);
        if (pendingRef.current) {
          const msg = pendingRef.current;
          pendingRef.current = null;
          postToCanvas(msg);
          flashStatus('sent');
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      if (statusTimer.current) clearTimeout(statusTimer.current);
    };
  }, [postToCanvas, flashStatus]);

  const registerCanvasIframe = useCallback((win: Window | null) => {
    iframeWinRef.current = win;
    setCanvasReady(false);
    // Ask an already-mounted agent whether it's ready (covers reloads / late host mount).
    if (win) {
      try {
        win.postMessage({ type: 'canvas:ping' }, '*');
      } catch {
        /* ignore */
      }
    }
  }, []);

  const sendPrompt = useCallback(
    async (message: string): Promise<boolean> => {
      const trimmed = message.trim();
      if (!trimmed) return false;
      // Make sure the user can see the result, and ask the host to open the panel.
      setCanvasVisible(true);
      try {
        window.dispatchEvent(new CustomEvent('tandem:canvas-show'));
      } catch {
        /* ignore */
      }
      flashStatus('sending');
      setLastError(null);

      if (!iframeWinRef.current) {
        // Iframe not mounted yet — queue it; it flushes on 'canvas:ready'.
        pendingRef.current = trimmed;
        return true;
      }
      if (canvasReady) {
        const ok = postToCanvas(trimmed);
        flashStatus(ok ? 'sent' : 'error');
        if (!ok) setLastError('Could not reach the canvas.');
        return ok;
      }
      // Mounted but not ready yet — queue + nudge.
      pendingRef.current = trimmed;
      try {
        iframeWinRef.current.postMessage({ type: 'canvas:ping' }, '*');
      } catch {
        /* ignore */
      }
      return true;
    },
    [canvasReady, postToCanvas, flashStatus],
  );

  const value = useMemo<CanvasContextType>(
    () => ({
      agentUrl,
      setAgentUrl,
      canvasVisible,
      showCanvas,
      hideCanvas,
      toggleCanvas,
      canvasExpanded,
      setCanvasExpanded,
      toggleExpand,
      canvasReady,
      status,
      lastError,
      transcriptOptIn,
      setTranscriptOptIn,
      registerCanvasIframe,
      sendPrompt,
    }),
    [
      agentUrl,
      setAgentUrl,
      canvasVisible,
      showCanvas,
      hideCanvas,
      toggleCanvas,
      canvasExpanded,
      setCanvasExpanded,
      toggleExpand,
      canvasReady,
      status,
      lastError,
      transcriptOptIn,
      setTranscriptOptIn,
      registerCanvasIframe,
      sendPrompt,
    ],
  );

  return <CanvasContext.Provider value={value}>{children}</CanvasContext.Provider>;
}

export function useCanvas(): CanvasContextType {
  const ctx = useContext(CanvasContext);
  if (!ctx) throw new Error('useCanvas must be used within a CanvasProvider');
  return ctx;
}
