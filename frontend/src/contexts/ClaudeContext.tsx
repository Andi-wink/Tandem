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
import { anonymizeTexts } from '@/services/anonymizationService';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ContextBasketItemType = 'transcript_chunk' | 'screenshot' | 'clipboard' | 'highlight' | 'note';

export interface ContextBasketItem {
  id: string;
  type: ContextBasketItemType;
  label: string;       // short display label, e.g. "14:00–14:05" or "Screenshot 3"
  preview: string;     // first ~80 chars for display
  fullContent: string; // complete content for sending to Claude
  timestamp?: number;  // recording_elapsed_secs
  anonymize?: boolean; // per-item override: true=force on, false=force off, undefined=follow global
}

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
}

interface ClaudeState {
  isPanelOpen: boolean;
  isStreaming: boolean;
  sessionId: string | null;
  projectDir: string | null;
  meetingId: string | null;
  meetingTitle: string | null;
  conversation: ClaudeMessage[];
  contextBasket: ContextBasketItem[];
  apiKey: string | null;
  selectedModel: string;
  // F005: PII Anonymization
  anonymizationEnabled: boolean;
  entityMap: Record<string, string>;
  lastAnonymizedCount: number;  // entities replaced in last send
}

const MODEL_OPTIONS = [
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
] as const;

export { MODEL_OPTIONS };

interface ClaudeContextValue extends ClaudeState {
  openPanel: (meetingId: string, meetingTitle: string, defaultProjectDir: string) => void;
  closePanel: () => void;
  addToBasket: (item: ContextBasketItem) => void;
  removeFromBasket: (itemId: string) => void;
  clearBasket: () => void;
  sendMessage: (message: string) => Promise<void>;
  clearSession: () => Promise<void>;
  cancelStream: () => void;
  setApiKey: (key: string) => void;
  setModel: (model: string) => void;
  // F005: PII Anonymization
  toggleAnonymization: () => void;
  toggleItemAnonymization: (itemId: string) => void;
  clearEntityMap: () => void;
}

const ClaudeContext = createContext<ClaudeContextValue | null>(null);

const MODEL_STORAGE_KEY = 'tandem_claude_model';
const DEFAULT_MODEL = 'claude-opus-4-6';

// ─── Provider ───────────────────────────────────────────────────────────────

export function ClaudeProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ClaudeState>(() => ({
    isPanelOpen: false,
    isStreaming: false,
    sessionId: null,
    projectDir: null,
    meetingId: null,
    meetingTitle: null,
    conversation: [],
    contextBasket: [],
    apiKey: null,
    selectedModel: typeof window !== 'undefined'
      ? (localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_MODEL)
      : DEFAULT_MODEL,
    // F005: PII Anonymization — default ON (cloud provider assumed)
    anonymizationEnabled: true,
    entityMap: {},
    lastAnonymizedCount: 0,
  }));

  // Load persisted API key from backend on mount (B033: cleanup on unmount)
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${BACKEND}/get-api-key`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'claude' }),
          signal: controller.signal,
        });
        if (res.ok) {
          const key = await res.json();
          if (key && typeof key === 'string' && key.length > 0) {
            setState(prev => ({ ...prev, apiKey: key }));
          }
        }
      } catch {
        // Backend not available or aborted, key stays null
      }
    })();
    return () => controller.abort();
  }, []);

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
    setState(prev => ({
      ...prev,
      isPanelOpen: true,
      meetingId,
      meetingTitle,
      projectDir: defaultProjectDir,
    }));

    // Check if there's an existing session on the backend
    try {
      const existing = await getClaudeSession(meetingId);
      if (existing?.session_id) {
        setState(prev => ({ ...prev, sessionId: existing.session_id }));
      }
    } catch {
      // No existing session, that's fine
    }
  }, []);

  const closePanel = useCallback(() => {
    setState(prev => ({ ...prev, isPanelOpen: false }));
  }, []);

  const addToBasket = useCallback((item: ContextBasketItem) => {
    setState(prev => {
      if (prev.contextBasket.some(b => b.id === item.id)) return prev;
      return { ...prev, contextBasket: [...prev.contextBasket, item] };
    });
  }, []);

  const removeFromBasket = useCallback((itemId: string) => {
    setState(prev => ({
      ...prev,
      contextBasket: prev.contextBasket.filter(b => b.id !== itemId),
    }));
  }, []);

  const clearBasket = useCallback(() => {
    setState(prev => ({ ...prev, contextBasket: [] }));
  }, []);

  const setApiKey = useCallback((key: string) => {
    setState(prev => ({ ...prev, apiKey: key }));
    // Persist API key only — do NOT overwrite user's model preferences
    fetch(`${BACKEND}/save-model-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key }),
    }).catch(() => {});
  }, []);

  const setModel = useCallback((model: string) => {
    localStorage.setItem(MODEL_STORAGE_KEY, model);
    setState(prev => ({ ...prev, selectedModel: model }));
  }, []);

  // ── F005: PII Anonymization controls ──────────────────────────────────────

  const toggleAnonymization = useCallback(() => {
    setState(prev => ({ ...prev, anonymizationEnabled: !prev.anonymizationEnabled }));
  }, []);

  const toggleItemAnonymization = useCallback((itemId: string) => {
    setState(prev => ({
      ...prev,
      contextBasket: prev.contextBasket.map(item =>
        item.id === itemId
          ? { ...item, anonymize: item.anonymize === undefined ? !prev.anonymizationEnabled : !item.anonymize }
          : item
      ),
    }));
  }, []);

  const clearEntityMapAction = useCallback(() => {
    if (state.meetingId) {
      fetch(`${BACKEND}/api/anonymize/entity-map/${encodeURIComponent(state.meetingId)}`, {
        method: 'DELETE',
      }).catch(() => {});
    }
    setState(prev => ({ ...prev, entityMap: {}, lastAnonymizedCount: 0 }));
  }, [state.meetingId]);

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

    const basket = s.contextBasket;

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
    const rawItems = basket.filter(item =>
      !(item.anonymize ?? s.anonymizationEnabled)
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
    };

    const assistantMsg: ClaudeMessage = {
      id: `assistant-${crypto.randomUUID()}`,
      role: 'assistant',
      text: '',
    };

    streamingTextRef.current = '';
    streamingToolCallsRef.current = [];

    setState(prev => ({
      ...prev,
      conversation: [...prev.conversation, userMsg, assistantMsg],
      contextBasket: [], // Clear basket after send
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

    // Start SSE stream
    const controller = streamClaudeSession(
      endpoint as '/api/claude/start' | '/api/claude/message',
      body,
      handleStreamEvent,
      (err) => {
        handleStreamEvent({
          event_type: 'error',
          text: err.message,
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
  }, [handleStreamEvent]);

  const cancelStream = useCallback(() => {
    flushPendingRaf();
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    const mid = stateRef.current.meetingId;
    if (mid) {
      cancelClaudeSession(mid).catch(() => {});
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
      await clearClaudeSession(mid);
    }
    setState(prev => ({
      ...prev,
      sessionId: null,
      conversation: [],
      contextBasket: [],
      isStreaming: false,
    }));
  }, []);

  const value = useMemo<ClaudeContextValue>(() => ({
    ...state,
    openPanel,
    closePanel,
    addToBasket,
    removeFromBasket,
    clearBasket,
    sendMessage,
    clearSession: clearSessionAction,
    cancelStream,
    setApiKey,
    setModel,
    toggleAnonymization,
    toggleItemAnonymization,
    clearEntityMap: clearEntityMapAction,
  }), [state, openPanel, closePanel, addToBasket, removeFromBasket, clearBasket, sendMessage, clearSessionAction, cancelStream, setApiKey, setModel, toggleAnonymization, toggleItemAnonymization, clearEntityMapAction]);

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
