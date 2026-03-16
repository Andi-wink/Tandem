'use client';

import React, { createContext, useContext, useState, useCallback, useRef, useMemo, useEffect } from 'react';
import {
  BACKEND,
  streamClaudeSession,
  getClaudeSession,
  clearClaudeSession,
  cancelClaudeSession,
  ClaudeFrontendEvent,
} from '@/services/claudeService';
import { anonymizeTexts, checkAnonymizationHealth } from '@/services/anonymizationService';
import { toast } from 'sonner';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useContextBasket } from '@/contexts/ContextBasketContext';

// R009: Re-export basket types so existing imports from ClaudeContext still work
export type { ContextBasketItemType, ContextBasketItem } from '@/contexts/ContextBasketContext';
import type { ContextBasketItem } from '@/contexts/ContextBasketContext';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ClaudeMessageRole = 'user' | 'assistant';

export interface ClaudeToolCall {
  name: string;
  input: string;
  output?: string;
}

export interface ClaudeMessage {
  id: string;
  role: ClaudeMessageRole;
  text: string;
  toolCalls?: ClaudeToolCall[];
  contextSummary?: string; // e.g. "[+2 chunks, 1 screenshot]"
  costUsd?: number;
  recording_elapsed_secs?: number; // F020: seconds from recording start, for timeline ordering
}

// R009: ClaudeState no longer includes contextBasket (lives in ContextBasketContext)
interface ClaudeState {
  isPanelOpen: boolean;
  isStreaming: boolean;
  sessionId: string | null;
  projectDir: string | null;
  meetingId: string | null;
  meetingTitle: string | null;
  conversation: ClaudeMessage[];
  apiKey: string | null;
  selectedModel: string;
  // F005: PII Anonymization
  anonymizationEnabled: boolean;
  entityMap: Record<string, string>;
  lastAnonymizedCount: number;  // entities replaced in last send
  piiAvailable: boolean | null; // null = not checked yet, true/false = checked
}

const MODEL_OPTIONS = [
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
] as const;

export { MODEL_OPTIONS };

// R009: The public interface still includes basket fields for backward compat
interface ClaudeContextValue extends ClaudeState {
  // Basket (delegated to ContextBasketContext)
  contextBasket: ContextBasketItem[];
  addToBasket: (item: ContextBasketItem) => void;
  removeFromBasket: (itemId: string) => void;
  clearBasket: () => void;
  // Session
  openPanel: (meetingId: string, meetingTitle: string, defaultProjectDir: string) => void;
  closePanel: () => void;
  sendMessage: (message: string) => Promise<void>;
  clearSession: () => Promise<void>;
  cancelStream: () => void;
  setApiKey: (key: string) => void;
  setModel: (model: string) => void;
  updateMeetingTitle: (newTitle: string) => void;
  setProjectDir: (dir: string) => void;
  // F005: PII Anonymization
  toggleAnonymization: () => void;
  toggleItemAnonymization: (itemId: string) => void;
  clearEntityMap: () => void;
  piiAvailable: boolean | null;
  // Panel resize
  panelWidth: number;
  setPanelWidth: (width: number) => void;
}

const ClaudeContext = createContext<ClaudeContextValue | null>(null);

const MODEL_STORAGE_KEY = 'tandem_claude_model';
const PANEL_WIDTH_STORAGE_KEY = 'tandem_claude_panel_width';
const DEFAULT_MODEL = 'claude-opus-4-6';
const DEFAULT_PANEL_WIDTH = 420;
const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 700;

// ─── Provider ───────────────────────────────────────────────────────────────

export function ClaudeProvider({ children }: { children: React.ReactNode }) {
  // F020: Access recording duration for timestamping AI messages
  // B040: Also watch isRecording to auto-initialize meeting context for voice commands
  const { recordingDuration, isRecording } = useRecordingState();

  // R009: Basket state now lives in ContextBasketContext
  const { contextBasket, addToBasket, removeFromBasket, clearBasket, updateItem } = useContextBasket();

  // Panel width (resizable)
  const [panelWidth, setPanelWidthRaw] = useState(DEFAULT_PANEL_WIDTH);

  // Hydrate persisted panel width after mount
  useEffect(() => {
    const stored = localStorage.getItem(PANEL_WIDTH_STORAGE_KEY);
    if (stored) {
      const w = parseInt(stored, 10);
      if (!isNaN(w) && w >= MIN_PANEL_WIDTH && w <= MAX_PANEL_WIDTH) {
        setPanelWidthRaw(w);
      }
    }
  }, []);

  const setPanelWidth = useCallback((width: number) => {
    const clamped = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width));
    setPanelWidthRaw(clamped);
    localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(clamped));
  }, []);
  // Keep a ref for basket so sendMessage can read it without stale closures
  const basketRef = useRef(contextBasket);
  basketRef.current = contextBasket;

  const [state, setState] = useState<ClaudeState>(() => ({
    isPanelOpen: false,
    isStreaming: false,
    sessionId: null,
    projectDir: null,
    meetingId: null,
    meetingTitle: null,
    conversation: [],
    apiKey: null,
    selectedModel: DEFAULT_MODEL,
    // F005: PII Anonymization — default ON (cloud provider assumed)
    anonymizationEnabled: true,
    entityMap: {},
    lastAnonymizedCount: 0,
    piiAvailable: null,
  }));

  // Load persisted API key from native Tauri store on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const key = await invoke<string>('api_get_api_key', { provider: 'claude' });
        if (!cancelled && key && key.length > 0) {
          setState(prev => ({ ...prev, apiKey: key }));
        }
      } catch {
        // Tauri not available (e.g. in browser dev), try backend fallback
        try {
          const res = await fetch(`${BACKEND}/get-api-key`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'claude' }),
          });
          if (!cancelled && res.ok) {
            const key = await res.json();
            if (key && typeof key === 'string' && key.length > 0) {
              setState(prev => ({ ...prev, apiKey: key }));
            }
          }
        } catch {
          // Neither available, key stays null
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Hydrate persisted model selection after mount (avoids SSR hydration mismatch)
  useEffect(() => {
    const persisted = localStorage.getItem(MODEL_STORAGE_KEY);
    if (persisted && persisted !== DEFAULT_MODEL) {
      setState(prev => ({ ...prev, selectedModel: persisted }));
    }
  }, []);

  // F005: Check PII anonymization health on mount, retry until available
  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    let attempt = 0;

    const check = () => {
      checkAnonymizationHealth().then(health => {
        if (cancelled) return;
        setState(prev => ({ ...prev, piiAvailable: health.available }));
        // If unavailable, retry with exponential backoff (2s, 4s, 8s… capped at 30s)
        if (!health.available) {
          const delay = Math.min(2000 * Math.pow(2, attempt), 30000);
          attempt++;
          timeoutId = setTimeout(check, delay);
        }
      });
    };
    check();

    return () => { cancelled = true; clearTimeout(timeoutId); };
  }, []);

  // B040: Pre-populate meeting context when recording starts so voice commands work immediately
  useEffect(() => {
    if (!isRecording) return;
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        let folder = await invoke<string | null>('get_meeting_folder_path');
        let meetingName = await invoke<string | null>('get_recording_meeting_name');
        // Retry once after 800ms if folder isn't ready yet (recording may still be initializing)
        if (!folder && !cancelled) {
          await new Promise(r => setTimeout(r, 800));
          if (cancelled) return;
          folder = await invoke<string | null>('get_meeting_folder_path');
          meetingName = meetingName || await invoke<string | null>('get_recording_meeting_name');
        }
        if (!cancelled && folder) {
          setState(prev => ({
            ...prev,
            projectDir: prev.projectDir || folder,
            meetingId: prev.meetingId || 'live-recording',
            meetingTitle: prev.meetingTitle || meetingName || 'Live Recording',
          }));
        }
      } catch {
        // Non-critical — voice commands fall back to handleVoiceCommand's own init path
      }
    })();
    return () => { cancelled = true; };
  }, [isRecording]);

  // B017: Cleanup RAF and abort SSE on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  // Listen for webhook notifications that should appear inline in the AI panel
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      const { level, title, body, source } = detail;
      const prefix = source && source !== 'unknown' ? `**[${source}]** ` : '';
      const heading = title ? `**${title}**\n\n` : '';
      const icon = level === 'success' ? '\u2705 ' : level === 'error' ? '\u274c ' : level === 'warning' ? '\u26a0\ufe0f ' : '';
      const text = `${icon}${prefix}${heading}${body}`;

      const msg: ClaudeMessage = {
        id: `notify-${crypto.randomUUID()}`,
        role: 'assistant',
        text,
      };
      setState(prev => ({
        ...prev,
        conversation: [...prev.conversation, msg],
      }));
    };
    window.addEventListener('tandem-notification', handler);
    return () => window.removeEventListener('tandem-notification', handler);
  }, []);

  // Track the current streaming message being assembled
  const streamingTextRef = useRef('');
  const streamingToolCallsRef = useRef<ClaudeToolCall[]>([]);
  // AbortController for the current SSE stream
  const abortRef = useRef<AbortController | null>(null);
  // RAF batching for text_delta updates (stores RAF handle for cancellation)
  const rafIdRef = useRef<number | null>(null);
  // Track current meeting ID for event filtering
  const meetingIdRef = useRef<string | null>(null);
  // B015: Synchronous guard against double-sends (avoids stale closure)
  const isStreamingRef = useRef(false);
  // B016: Refs for state values read inside sendMessage (reduces dependency array)
  const stateRef = useRef(state);
  stateRef.current = state;

  // Keep meetingIdRef in sync with state
  useEffect(() => {
    meetingIdRef.current = state.meetingId;
  }, [state.meetingId]);

  // Cancel any pending RAF and flush the latest streamed text into state
  const flushPendingRaf = () => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
      // Flush the accumulated text so nothing is lost
      const finalText = streamingTextRef.current;
      if (finalText) {
        setState(prev => {
          const conv = [...prev.conversation];
          const lastMsg = conv[conv.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            conv[conv.length - 1] = { ...lastMsg, text: finalText };
          }
          return { ...prev, conversation: conv };
        });
      }
    }
  };

  // ── Event handler for SSE events ────────────────────────────────────────
  const handleStreamEvent = useCallback((event: ClaudeFrontendEvent) => {
    // Ignore events from other meetings
    if (event.meeting_id && meetingIdRef.current && event.meeting_id !== meetingIdRef.current) {
      return;
    }

    switch (event.event_type) {
      case 'session_init':
        setState(prev => ({ ...prev, sessionId: event.session_id }));
        break;

      case 'text_delta':
        if (event.text) {
          streamingTextRef.current += event.text;
          // Batch UI updates to animation frame rate (~60fps)
          if (rafIdRef.current === null) {
            rafIdRef.current = requestAnimationFrame(() => {
              rafIdRef.current = null;
              setState(prev => {
                const conv = [...prev.conversation];
                const lastMsg = conv[conv.length - 1];
                if (lastMsg && lastMsg.role === 'assistant') {
                  conv[conv.length - 1] = { ...lastMsg, text: streamingTextRef.current };
                }
                return { ...prev, conversation: conv };
              });
            });
          }
        }
        break;

      case 'tool_call':
        streamingToolCallsRef.current.push({
          name: event.tool_name || 'unknown',
          input: event.tool_input || '',
        });
        setState(prev => {
          const conv = [...prev.conversation];
          const lastMsg = conv[conv.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            conv[conv.length - 1] = {
              ...lastMsg,
              toolCalls: [...streamingToolCallsRef.current],
            };
          }
          return { ...prev, conversation: conv };
        });
        break;

      case 'tool_result':
        setState(prev => {
          const conv = [...prev.conversation];
          const lastMsg = conv[conv.length - 1];
          if (lastMsg && lastMsg.role === 'assistant' && lastMsg.toolCalls) {
            const calls = [...lastMsg.toolCalls];
            for (let i = calls.length - 1; i >= 0; i--) {
              if (calls[i].name === event.tool_name && !calls[i].output) {
                calls[i] = { ...calls[i], output: event.tool_output || '' };
                break;
              }
            }
            conv[conv.length - 1] = { ...lastMsg, toolCalls: calls };
          }
          return { ...prev, conversation: conv };
        });
        break;

      case 'done':
        flushPendingRaf();
        isStreamingRef.current = false;
        setState(prev => {
          const conv = [...prev.conversation];
          const lastMsg = conv[conv.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            conv[conv.length - 1] = {
              ...lastMsg,
              costUsd: event.cost_usd ?? undefined,
            };
          }
          return {
            ...prev,
            conversation: conv,
            isStreaming: false,
            sessionId: event.session_id ?? prev.sessionId,
          };
        });
        streamingTextRef.current = '';
        streamingToolCallsRef.current = [];
        abortRef.current = null;
        break;

      case 'error':
        flushPendingRaf();
        isStreamingRef.current = false;
        setState(prev => {
          const conv = [...prev.conversation];
          const lastMsg = conv[conv.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            conv[conv.length - 1] = {
              ...lastMsg,
              text: streamingTextRef.current + (event.text ? `\n\n**Error:** ${event.text}` : ''),
            };
          }
          return { ...prev, conversation: conv, isStreaming: false };
        });
        streamingTextRef.current = '';
        streamingToolCallsRef.current = [];
        abortRef.current = null;
        break;
    }
  }, []);

  const openPanel = useCallback(async (meetingId: string, meetingTitle: string, defaultProjectDir: string) => {
    const isSameMeeting = meetingIdRef.current === meetingId;

    setState(prev => ({
      ...prev,
      isPanelOpen: true,
      meetingId,
      meetingTitle,
      projectDir: defaultProjectDir,
      // Clear conversation and session when switching to a different meeting
      ...(isSameMeeting ? {} : { conversation: [], sessionId: null, isStreaming: false }),
    }));

    // Check if there's an existing session on the backend for this meeting
    try {
      const existing = await getClaudeSession(meetingId);
      if (existing?.session_id) {
        setState(prev => ({ ...prev, sessionId: existing.session_id }));
      }
    } catch {
      // 404 (no session) returns null above; other errors land here — not critical
    }
  }, []);

  const closePanel = useCallback(() => {
    setState(prev => ({ ...prev, isPanelOpen: false }));
  }, []);

  const setApiKey = useCallback((key: string) => {
    setState(prev => ({ ...prev, apiKey: key }));
    // Save via native Tauri command (primary), backend HTTP fallback
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('api_save_api_key', { provider: 'claude', apiKey: key });
      } catch {
        fetch(`${BACKEND}/save-api-key`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'claude', apiKey: key }),
        }).catch(() => {});
      }
    })();
  }, []);

  const setModel = useCallback((model: string) => {
    localStorage.setItem(MODEL_STORAGE_KEY, model);
    setState(prev => ({ ...prev, selectedModel: model }));
  }, []);

  const updateMeetingTitle = useCallback((newTitle: string) => {
    setState(prev => ({ ...prev, meetingTitle: newTitle }));
  }, []);

  const setProjectDir = useCallback((dir: string) => {
    setState(prev => ({ ...prev, projectDir: dir }));
  }, []);

  // ── F005: PII Anonymization controls ──────────────────────────────────────

  const toggleAnonymization = useCallback(() => {
    setState(prev => ({ ...prev, anonymizationEnabled: !prev.anonymizationEnabled }));
  }, []);

  const toggleItemAnonymization = useCallback((itemId: string) => {
    // R009: Uses basket's updateItem + reads anonymizationEnabled from stateRef
    const s = stateRef.current;
    const item = basketRef.current.find(i => i.id === itemId);
    if (item) {
      const newAnonymize = item.anonymize === undefined ? !s.anonymizationEnabled : !item.anonymize;
      updateItem(itemId, { anonymize: newAnonymize });
    }
  }, [updateItem]);

  const clearEntityMapAction = useCallback(() => {
    const mid = stateRef.current.meetingId;
    if (mid) {
      fetch(`${BACKEND}/api/anonymize/entity-map/${encodeURIComponent(mid)}`, {
        method: 'DELETE',
      }).catch(() => {});
    }
    setState(prev => ({ ...prev, entityMap: {}, lastAnonymizedCount: 0 }));
  }, []);

  const sendMessage = useCallback(async (message: string) => {
    // B015: Use ref for synchronous double-send guard
    const s = stateRef.current;
    if (!s.projectDir || !s.meetingId || !s.meetingTitle) {
      throw new Error('No active meeting for AI assistant session');
    }
    if (isStreamingRef.current) return;
    if (!s.apiKey) {
      throw new Error('Anthropic API key not set. Please add your key in settings.');
    }

    // B015: Set synchronous guard immediately
    isStreamingRef.current = true;

    // R009: Read basket from ref (basket state lives in ContextBasketContext)
    const basket = basketRef.current;

    // Build context summary for display
    const typeCounts: Record<string, number> = {};
    for (const item of basket) {
      typeCounts[item.type] = (typeCounts[item.type] || 0) + 1;
    }
    const summaryParts: string[] = [];
    if (typeCounts.transcript_chunk) summaryParts.push(`${typeCounts.transcript_chunk} chunk${typeCounts.transcript_chunk > 1 ? 's' : ''}`);
    if (typeCounts.screenshot) summaryParts.push(`${typeCounts.screenshot} screenshot${typeCounts.screenshot > 1 ? 's' : ''}`);
    if (typeCounts.clipboard) summaryParts.push(`${typeCounts.clipboard} clip${typeCounts.clipboard > 1 ? 's' : ''}`);
    if (typeCounts.highlight) summaryParts.push(`${typeCounts.highlight} highlight${typeCounts.highlight > 1 ? 's' : ''}`);
    if (typeCounts.note) summaryParts.push(`${typeCounts.note} note${typeCounts.note > 1 ? 's' : ''}`);
    const contextSummary = summaryParts.length > 0 ? `[+${summaryParts.join(', ')}]` : undefined;

    // F005: Split basket into items to anonymize vs. raw items
    const itemsToAnonymize = basket.filter(item =>
      item.anonymize ?? s.anonymizationEnabled
    );

    // Anonymize items that need it
    let anonymizedContents: string[] = [];
    let anonymizedCount = 0;
    if (itemsToAnonymize.length > 0) {
      try {
        const result = await anonymizeTexts(
          itemsToAnonymize.map(i => i.fullContent),
          s.meetingId!,
          Object.keys(s.entityMap).length > 0 ? s.entityMap : undefined,
        );
        anonymizedContents = result.sanitized;
        anonymizedCount = result.entitiesFound.length;
        setState(prev => ({
          ...prev,
          entityMap: { ...prev.entityMap, ...result.entityMap },
          lastAnonymizedCount: anonymizedCount,
        }));
      } catch (err) {
        console.error('Anonymization failed, sending raw:', err);
        toast.warning('PII anonymization unavailable — sending context without anonymization');
        // Fallback: use raw content if anonymization service is unavailable
        anonymizedContents = itemsToAnonymize.map(i => i.fullContent);
      }
    }

    // Reassemble context block: anonymized items + raw items (preserve original order)
    const contextBlock = basket.length > 0
      ? basket.map(item => {
        const header = `--- ${item.type}: ${item.label} ---`;
        const shouldAnonymize = item.anonymize ?? s.anonymizationEnabled;
        let content: string;
        if (shouldAnonymize) {
          const idx = itemsToAnonymize.indexOf(item);
          content = idx >= 0 && anonymizedContents[idx] ? anonymizedContents[idx] : item.fullContent;
        } else {
          content = item.fullContent;
        }
        return `${header}\n${content}`;
      }).join('\n\n')
      : undefined;

    // B030: Use crypto.randomUUID() for unique IDs
    const userMsg: ClaudeMessage = {
      id: `user-${crypto.randomUUID()}`,
      role: 'user',
      text: message,
      contextSummary: contextSummary
        ? contextSummary + (anonymizedCount > 0 ? ` (${anonymizedCount} PII entities anonymized)` : '')
        : (anonymizedCount > 0 ? `(${anonymizedCount} PII entities anonymized)` : undefined),
      recording_elapsed_secs: recordingDuration ?? undefined, // F020
    };

    const assistantMsg: ClaudeMessage = {
      id: `assistant-${crypto.randomUUID()}`,
      role: 'assistant',
      text: '',
      recording_elapsed_secs: recordingDuration ?? undefined, // F020
    };

    streamingTextRef.current = '';
    streamingToolCallsRef.current = [];

    // R009: Clear basket via context, update conversation in local state
    clearBasket();
    setState(prev => ({
      ...prev,
      conversation: [...prev.conversation, userMsg, assistantMsg],
      isStreaming: true,
    }));

    // Determine endpoint & body
    const isResume = !!s.sessionId;
    const endpoint = isResume ? '/api/claude/message' : '/api/claude/start';
    const body: Record<string, unknown> = {
      meeting_id: s.meetingId,
      project_dir: s.projectDir,
      message,
      api_key: s.apiKey,
      context_block: contextBlock || null,
      model: s.selectedModel,
    };
    if (!isResume) {
      body.meeting_title = s.meetingTitle;
    }

    // Abort any previous stream before starting new one
    if (abortRef.current) {
      abortRef.current.abort();
    }

    // Start SSE stream
    const controller = streamClaudeSession(
      endpoint as '/api/claude/start' | '/api/claude/message',
      body,
      handleStreamEvent,
      (err) => {
        const msg = err.message === 'Failed to fetch'
          ? 'Could not connect to backend server. Make sure the backend is running on port 5167.'
          : err.message;
        handleStreamEvent({
          event_type: 'error',
          text: msg,
          tool_name: null,
          tool_input: null,
          tool_output: null,
          session_id: null,
          cost_usd: null,
          meeting_id: s.meetingId!,
        });
      },
    );
    abortRef.current = controller;
  }, [handleStreamEvent, clearBasket]);

  const cancelStream = useCallback(() => {
    flushPendingRaf();
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    const mid = stateRef.current.meetingId;
    if (mid) {
      cancelClaudeSession(mid).catch(err => console.error('cancelClaudeSession:', err));
    }
    isStreamingRef.current = false;
    setState(prev => ({ ...prev, isStreaming: false }));
    streamingTextRef.current = '';
    streamingToolCallsRef.current = [];
  }, []);

  const clearSessionAction = useCallback(async () => {
    // Cancel any in-flight stream
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    isStreamingRef.current = false;
    const mid = stateRef.current.meetingId;
    if (mid) {
      try {
        await clearClaudeSession(mid);
      } catch (err) {
        console.error('clearClaudeSession:', err);
      }
    }
    // R009: Clear basket via context
    clearBasket();
    setState(prev => ({
      ...prev,
      sessionId: null,
      conversation: [],
      isStreaming: false,
    }));
  }, [clearBasket]);

  const value = useMemo<ClaudeContextValue>(() => ({
    ...state,
    // R009: Basket fields from ContextBasketContext (backward compat)
    contextBasket,
    addToBasket,
    removeFromBasket,
    clearBasket,
    // Session actions
    openPanel,
    closePanel,
    sendMessage,
    clearSession: clearSessionAction,
    cancelStream,
    setApiKey,
    setModel,
    updateMeetingTitle,
    setProjectDir,
    toggleAnonymization,
    toggleItemAnonymization,
    clearEntityMap: clearEntityMapAction,
    // Panel resize
    panelWidth,
    setPanelWidth,
  }), [state, contextBasket, addToBasket, removeFromBasket, clearBasket, openPanel, closePanel, sendMessage, clearSessionAction, cancelStream, setApiKey, setModel, updateMeetingTitle, setProjectDir, toggleAnonymization, toggleItemAnonymization, clearEntityMapAction, panelWidth, setPanelWidth]);

  return (
    <ClaudeContext.Provider value={value}>
      {children}
    </ClaudeContext.Provider>
  );
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useClaude(): ClaudeContextValue {
  const ctx = useContext(ClaudeContext);
  if (!ctx) throw new Error('useClaude must be used within ClaudeProvider');
  return ctx;
}
