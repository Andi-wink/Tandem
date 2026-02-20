'use client';

import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import {
  streamClaudeSession,
  getClaudeSession,
  clearClaudeSession,
  cancelClaudeSession,
  ClaudeFrontendEvent,
} from '@/services/claudeService';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ContextBasketItemType = 'transcript_chunk' | 'screenshot' | 'clipboard' | 'highlight' | 'note';

export interface ContextBasketItem {
  id: string;
  type: ContextBasketItemType;
  label: string;       // short display label, e.g. "14:00–14:05" or "Screenshot 3"
  preview: string;     // first ~80 chars for display
  fullContent: string; // complete content for sending to Claude
  timestamp?: number;  // recording_elapsed_secs
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
}

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
}

const ClaudeContext = createContext<ClaudeContextValue | null>(null);

const API_KEY_STORAGE_KEY = 'tandem_anthropic_api_key';

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
    apiKey: typeof window !== 'undefined' ? localStorage.getItem(API_KEY_STORAGE_KEY) : null,
  }));

  // Track the current streaming message being assembled
  const streamingTextRef = useRef('');
  const streamingToolCallsRef = useRef<ClaudeToolCall[]>([]);
  // AbortController for the current SSE stream
  const abortRef = useRef<AbortController | null>(null);
  // RAF batching for text_delta updates
  const rafPendingRef = useRef(false);

  // ── Event handler for SSE events (same logic as before) ────────────────
  const handleStreamEvent = useCallback((event: ClaudeFrontendEvent) => {
    switch (event.event_type) {
      case 'session_init':
        setState(prev => ({ ...prev, sessionId: event.session_id }));
        break;

      case 'text_delta':
        if (event.text) {
          streamingTextRef.current += event.text;
          // Batch UI updates to animation frame rate (~60fps)
          if (!rafPendingRef.current) {
            rafPendingRef.current = true;
            requestAnimationFrame(() => {
              rafPendingRef.current = false;
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
        rafPendingRef.current = false;
        break;

      case 'error':
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
        rafPendingRef.current = false;
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
    localStorage.setItem(API_KEY_STORAGE_KEY, key);
    setState(prev => ({ ...prev, apiKey: key }));
  }, []);

  const sendMessage = useCallback(async (message: string) => {
    if (!state.projectDir || !state.meetingId || !state.meetingTitle) {
      throw new Error('No active meeting for AI assistant session');
    }
    if (state.isStreaming) return;
    if (!state.apiKey) {
      throw new Error('Anthropic API key not set. Please add your key in settings.');
    }

    const basket = state.contextBasket;

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

    // Assemble context block from basket items
    const contextBlock = basket.length > 0
      ? basket.map(item => {
        const header = `--- ${item.type}: ${item.label} ---`;
        return `${header}\n${item.fullContent}`;
      }).join('\n\n')
      : undefined;

    // Add user message to conversation
    const userMsg: ClaudeMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: message,
      contextSummary,
    };

    // Prepare empty assistant message for streaming
    const assistantMsg: ClaudeMessage = {
      id: `assistant-${Date.now()}`,
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
    const isResume = !!state.sessionId;
    const endpoint = isResume ? '/api/claude/message' : '/api/claude/start';
    const body: Record<string, unknown> = {
      meeting_id: state.meetingId,
      project_dir: state.projectDir,
      message,
      api_key: state.apiKey,
      context_block: contextBlock || null,
    };
    if (!isResume) {
      body.meeting_title = state.meetingTitle;
    }

    // Start SSE stream
    const controller = streamClaudeSession(
      endpoint as '/api/claude/start' | '/api/claude/message',
      body,
      handleStreamEvent,
      (err) => {
        // onError callback
        handleStreamEvent({
          event_type: 'error',
          text: err.message,
          tool_name: null,
          tool_input: null,
          tool_output: null,
          session_id: null,
          cost_usd: null,
          meeting_id: state.meetingId!,
        });
      },
    );
    abortRef.current = controller;
  }, [state.projectDir, state.meetingId, state.meetingTitle, state.sessionId, state.isStreaming, state.contextBasket, state.apiKey, handleStreamEvent]);

  const cancelStream = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (state.meetingId) {
      cancelClaudeSession(state.meetingId).catch(() => {});
    }
    setState(prev => ({ ...prev, isStreaming: false }));
    streamingTextRef.current = '';
    streamingToolCallsRef.current = [];
  }, [state.meetingId]);

  const clearSessionAction = useCallback(async () => {
    // Cancel any in-flight stream
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (state.meetingId) {
      await clearClaudeSession(state.meetingId);
    }
    setState(prev => ({
      ...prev,
      sessionId: null,
      conversation: [],
      contextBasket: [],
      isStreaming: false,
    }));
  }, [state.meetingId]);

  const value: ClaudeContextValue = {
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
  };

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
