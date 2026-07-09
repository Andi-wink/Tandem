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
import { toast } from 'sonner';
import { logger } from '@/lib/logger';

// 127.0.0.1 (not "localhost"): the server binds loopback IPv4, and on dual-stack Windows "localhost"
// can resolve to ::1 first and fail to connect. Using the explicit IPv4 loopback keeps host + client
// in agreement.
const DEFAULT_AGENT_URL = 'http://127.0.0.1:5174';
const LEGACY_AGENT_URL = 'http://localhost:5174';
const URL_STORAGE_KEY = 'tandem-canvas-url';
const PRIVACY_STORAGE_KEY = 'tandem-canvas-transcript-optin';

export type CanvasStatus = 'idle' | 'sending' | 'sent' | 'error';

/** What the board returns when asked to save: the snapshot (for restore) + agent-friendly exports. */
export interface CanvasSaveResult {
  snapshot: unknown;
  /** PNG render of the board as a data URL (so a downstream agent can see it). Null if unavailable. */
  png: string | null;
  /** Markdown flattening: text labels + raw HTML/CSS of built shapes. Null if unavailable. */
  markdown: string | null;
}

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
  /**
   * True while VIEWING a saved board from the client library (the "Previous boards" picker). In this
   * mode persistence is suppressed so a peeked-at past board can never overwrite the live meeting's
   * board on close. "Edit here" clears it to adopt the board into the current meeting.
   */
  boardReadOnly: boolean;
  setBoardReadOnly: (v: boolean) => void;
  status: CanvasStatus;
  lastError: string | null;
  transcriptOptIn: boolean;
  setTranscriptOptIn: (v: boolean) => void;

  /** CanvasIframe calls this with its contentWindow (or null on unmount). */
  registerCanvasIframe: (win: Window | null) => void;
  /** Send a natural-language instruction to the embedded canvas (shows the canvas view). */
  sendPrompt: (message: string) => Promise<boolean>;

  /** Ask the board to save: snapshot (for restore) + PNG + markdown. Null if it can't be reached. */
  saveSnapshot: () => Promise<CanvasSaveResult | null>;
  /** Load a previously saved snapshot into the board (pass null to clear it). */
  loadSnapshot: (snapshot: unknown | null) => Promise<boolean>;
  /** Clear the board (blank canvas for a fresh meeting). */
  clearCanvas: () => Promise<boolean>;
}

const CanvasContext = createContext<CanvasContextType | null>(null);

export function CanvasProvider({ children }: { children: React.ReactNode }) {
  const [agentUrl, setAgentUrlState] = useState(DEFAULT_AGENT_URL);
  const [canvasVisible, setCanvasVisible] = useState(false);
  const [canvasExpanded, setCanvasExpanded] = useState(false);
  const [canvasReady, setCanvasReady] = useState(false);
  const [boardReadOnly, setBoardReadOnly] = useState(false);
  const [status, setStatus] = useState<CanvasStatus>('idle');
  const [lastError, setLastError] = useState<string | null>(null);
  // Default ON: the canvas is a call co-pilot, so drawings should use the call transcript by default.
  // Flipped off only if the user explicitly turned it off before (persisted as '0'). The header
  // toggle + the "sharing…" indicator keep this visible, per the privacy-is-visible design.
  const [transcriptOptIn, setTranscriptOptInState] = useState(true);

  const iframeWinRef = useRef<Window | null>(null);
  const pendingRef = useRef<string | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Armed when we post a prompt; cleared by the bridge's canvas:ack. If it fires, the prompt never
  // reached the canvas (delivery problem) — distinct from canvas:error (the agent ran but failed).
  const ackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Request/response plumbing for save/load round-trips with the cross-origin iframe.
  const canvasReadyRef = useRef(false);
  canvasReadyRef.current = canvasReady;
  const reqIdRef = useRef(0);
  const pendingReqRef = useRef<Map<number, { resolve: (v: Record<string, unknown> | null) => void; timer: ReturnType<typeof setTimeout> }>>(new Map());
  const readyWaitersRef = useRef<Array<() => void>>([]);
  // The canvas iframe's origin — used to pin postMessage targets and validate inbound messages.
  const agentOriginRef = useRef<string>('');
  useEffect(() => {
    try {
      agentOriginRef.current = new URL(agentUrl).origin;
    } catch {
      agentOriginRef.current = '';
    }
  }, [agentUrl]);

  useEffect(() => {
    try {
      const u = localStorage.getItem(URL_STORAGE_KEY);
      // Migrate the old localhost default to the 127.0.0.1 default (loopback bind, see above).
      if (u && u !== LEGACY_AGENT_URL) {
        setAgentUrlState(u);
      } else if (u === LEGACY_AGENT_URL) {
        localStorage.setItem(URL_STORAGE_KEY, DEFAULT_AGENT_URL);
      }
      // Only override the default-on when the user has explicitly stored a choice ('1' or '0').
      const storedOptIn = localStorage.getItem(PRIVACY_STORAGE_KEY);
      if (storedOptIn != null) setTranscriptOptInState(storedOptIn === '1');
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
      win.postMessage({ type: 'canvas:prompt', message }, agentOriginRef.current || '*');
      // Expect a canvas:ack back; if it doesn't arrive, the prompt didn't reach the canvas agent.
      if (ackTimer.current) clearTimeout(ackTimer.current);
      ackTimer.current = setTimeout(() => {
        ackTimer.current = null;
        toast.error("Canvas didn't receive the request. Is the canvas server running?");
        flashStatus('error');
      }, 3000);
      return true;
    } catch (e) {
      logger.warn('[Canvas] postMessage to iframe failed', e);
      return false;
    }
  }, [flashStatus]);

  // Resolve once the embedded agent is ready (it mounts at app start, so this is usually instant);
  // falls back after a timeout so callers never hang forever.
  const awaitReady = useCallback((timeoutMs = 4000): Promise<boolean> => {
    if (canvasReadyRef.current && iframeWinRef.current) return Promise.resolve(true);
    try {
      iframeWinRef.current?.postMessage({ type: 'canvas:ping' }, agentOriginRef.current || '*');
    } catch {
      /* ignore */
    }
    return new Promise((resolve) => {
      let waiter: () => void;
      const to = setTimeout(() => {
        readyWaitersRef.current = readyWaitersRef.current.filter((w) => w !== waiter);
        resolve(!!(canvasReadyRef.current && iframeWinRef.current));
      }, timeoutMs);
      waiter = () => {
        clearTimeout(to);
        resolve(true);
      };
      readyWaitersRef.current.push(waiter);
    });
  }, []);

  // Post a request to the iframe and await its matching reply (by requestId). Null on timeout/no-iframe.
  const postRequest = useCallback(
    async (payload: Record<string, unknown>, timeoutMs = 8000): Promise<Record<string, unknown> | null> => {
      const ready = await awaitReady();
      const win = iframeWinRef.current;
      if (!ready || !win) return null;
      const id = ++reqIdRef.current;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingReqRef.current.delete(id);
          resolve(null);
        }, timeoutMs);
        pendingReqRef.current.set(id, { resolve, timer });
        try {
          win.postMessage({ ...payload, requestId: id }, agentOriginRef.current || '*');
        } catch (e) {
          clearTimeout(timer);
          pendingReqRef.current.delete(id);
          logger.warn('[Canvas] postRequest failed', e);
          resolve(null);
        }
      });
    },
    [awaitReady],
  );

  const saveSnapshot = useCallback(async (): Promise<CanvasSaveResult | null> => {
    const res = await postRequest({ type: 'canvas:save' });
    if (!res || !('snapshot' in res) || res.snapshot == null) return null;
    return {
      snapshot: res.snapshot,
      png: typeof res.png === 'string' ? res.png : null,
      markdown: typeof res.markdown === 'string' ? res.markdown : null,
    };
  }, [postRequest]);

  const loadSnapshot = useCallback(
    async (snapshot: unknown | null): Promise<boolean> => {
      const res = await postRequest({ type: 'canvas:load', snapshot });
      return !!(res && res.ok);
    },
    [postRequest],
  );

  const clearCanvas = useCallback(async (): Promise<boolean> => {
    const res = await postRequest({ type: 'canvas:clear' });
    return !!(res && res.ok);
  }, [postRequest]);

  const showCanvas = useCallback(() => setCanvasVisible(true), []);
  const hideCanvas = useCallback(() => setCanvasVisible(false), []);
  const toggleCanvas = useCallback(() => setCanvasVisible((v) => !v), []);
  const toggleExpand = useCallback(() => setCanvasExpanded((v) => !v), []);

  // Listen for the bridge's readiness announcement (and flush any queued prompt).
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      // Only trust messages from our canvas iframe's origin (drops cross-frame spoofing).
      if (agentOriginRef.current && ev.origin !== agentOriginRef.current) return;
      const data = ev.data && typeof ev.data === 'object' ? (ev.data as Record<string, unknown>) : null;
      const t = data?.type;
      if (t === 'canvas:ready') {
        setCanvasReady(true);
        canvasReadyRef.current = true;
        // Wake anything waiting on readiness (save/load round-trips).
        const waiters = readyWaitersRef.current;
        readyWaitersRef.current = [];
        waiters.forEach((w) => w());
        if (pendingRef.current) {
          const msg = pendingRef.current;
          pendingRef.current = null;
          postToCanvas(msg);
          flashStatus('sent');
        }
      } else if (t === 'canvas:snapshot' || t === 'canvas:loaded') {
        const id = data?.requestId;
        if (typeof id === 'number') {
          const pending = pendingReqRef.current.get(id);
          if (pending) {
            clearTimeout(pending.timer);
            pendingReqRef.current.delete(id);
            pending.resolve(data);
          }
        }
      } else if (t === 'canvas:ack') {
        // The canvas received our prompt — cancel the "didn't arrive" warning.
        if (ackTimer.current) {
          clearTimeout(ackTimer.current);
          ackTimer.current = null;
        }
      } else if (t === 'canvas:error') {
        // The agent ran but failed (model/auth/busy) — surface it so it isn't lost in the iframe.
        if (ackTimer.current) {
          clearTimeout(ackTimer.current);
          ackTimer.current = null;
        }
        const msg = typeof data?.error === 'string' ? data.error : 'Canvas agent error';
        setLastError(msg);
        flashStatus('error');
        toast.error(`Canvas: ${msg}`);
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      if (statusTimer.current) clearTimeout(statusTimer.current);
      if (ackTimer.current) clearTimeout(ackTimer.current);
      // Resolve + clear any in-flight save/load requests so their timers don't leak past unmount.
      pendingReqRef.current.forEach(({ timer, resolve }) => {
        clearTimeout(timer);
        resolve(null);
      });
      pendingReqRef.current.clear();
      readyWaitersRef.current = [];
    };
  }, [postToCanvas, flashStatus]);

  const registerCanvasIframe = useCallback((win: Window | null) => {
    iframeWinRef.current = win;
    setCanvasReady(false);
    // Ask an already-mounted agent whether it's ready (covers reloads / late host mount).
    if (win) {
      try {
        win.postMessage({ type: 'canvas:ping' }, agentOriginRef.current || '*');
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
      if (canvasReadyRef.current) {
        const ok = postToCanvas(trimmed);
        flashStatus(ok ? 'sent' : 'error');
        if (!ok) setLastError('Could not reach the canvas.');
        return ok;
      }
      // Mounted but not ready yet — queue + nudge.
      pendingRef.current = trimmed;
      try {
        iframeWinRef.current.postMessage({ type: 'canvas:ping' }, agentOriginRef.current || '*');
      } catch {
        /* ignore */
      }
      return true;
    },
    [postToCanvas, flashStatus],
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
      boardReadOnly,
      setBoardReadOnly,
      status,
      lastError,
      transcriptOptIn,
      setTranscriptOptIn,
      registerCanvasIframe,
      sendPrompt,
      saveSnapshot,
      loadSnapshot,
      clearCanvas,
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
      boardReadOnly,
      status,
      lastError,
      transcriptOptIn,
      setTranscriptOptIn,
      registerCanvasIframe,
      sendPrompt,
      saveSnapshot,
      loadSnapshot,
      clearCanvas,
    ],
  );

  return <CanvasContext.Provider value={value}>{children}</CanvasContext.Provider>;
}

export function useCanvas(): CanvasContextType {
  const ctx = useContext(CanvasContext);
  if (!ctx) throw new Error('useCanvas must be used within a CanvasProvider');
  return ctx;
}
