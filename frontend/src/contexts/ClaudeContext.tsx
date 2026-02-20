'use client';

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import {
  startClaudeSession,
  sendClaudeMessage,
  getClaudeSession,
  clearClaudeSession,
  checkClaudeCliAvailable,
  listenClaudeStreamEvent,
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
  isCliAvailable: boolean | null;
  sessionId: string | null;
  projectDir: string | null;
  meetingId: string | null;
  meetingTitle: string | null;
  conversation: ClaudeMessage[];
  contextBasket: ContextBasketItem[];
}

interface ClaudeContextValue extends ClaudeState {
  openPanel: (meetingId: string, meetingTitle: string, defaultProjectDir: string) => void;
  closePanel: () => void;
  addToBasket: (item: ContextBasketItem) => void;
  removeFromBasket: (itemId: string) => void;
  clearBasket: () => void;
  sendMessage: (message: string) => Promise<void>;
  clearSession: () => Promise<void>;
}

const ClaudeContext = createContext<ClaudeContextValue | null>(null);

// ─── Provider ───────────────────────────────────────────────────────────────

export function ClaudeProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ClaudeState>({
    isPanelOpen: false,
    isStreaming: false,
    isCliAvailable: null,
    sessionId: null,
    projectDir: null,
    meetingId: null,
    meetingTitle: null,
    conversation: [],
    contextBasket: [],
  });

  // Track the current streaming message being assembled
  const streamingTextRef = useRef('');
  const streamingToolCallsRef = useRef<ClaudeToolCall[]>([]);

  // Listen for stream events
  useEffect(() => {
    const unlistenPromise = listenClaudeStreamEvent((event: ClaudeFrontendEvent) => {
      switch (event.event_type) {
        case 'session_init':
          setState(prev => ({ ...prev, sessionId: event.session_id }));
          break;

        case 'text_delta':
          if (event.text) {
            streamingTextRef.current += event.text;
            // Update the last assistant message in conversation
            setState(prev => {
              const conv = [...prev.conversation];
              const lastMsg = conv[conv.length - 1];
              if (lastMsg && lastMsg.role === 'assistant') {
                conv[conv.length - 1] = { ...lastMsg, text: streamingTextRef.current };
              }
              return { ...prev, conversation: conv };
            });
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
              // Find the matching tool call and add output
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
          break;
      }
    });

    return () => {
      unlistenPromise.then(fn => fn());
    };
  }, []);

  // Check CLI availability on mount
  useEffect(() => {
    checkClaudeCliAvailable()
      .then(available => setState(prev => ({ ...prev, isCliAvailable: available })))
      .catch(() => setState(prev => ({ ...prev, isCliAvailable: false })));
  }, []);

  const openPanel = useCallback(async (meetingId: string, meetingTitle: string, defaultProjectDir: string) => {
    setState(prev => ({
      ...prev,
      isPanelOpen: true,
      meetingId,
      meetingTitle,
      projectDir: defaultProjectDir,
    }));

    // Check if there's an existing session
    try {
      const existing = await getClaudeSession(defaultProjectDir);
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
      // Don't add duplicates
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

  const sendMessage = useCallback(async (message: string) => {
    if (!state.projectDir || !state.meetingId || !state.meetingTitle) {
      throw new Error('No active meeting for Claude session');
    }
    if (state.isStreaming) return;

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

    try {
      if (state.sessionId) {
        // Resume existing session
        await sendClaudeMessage(
          state.meetingId,
          state.projectDir,
          message,
          contextBlock,
        );
      } else {
        // Start new session
        await startClaudeSession(
          state.meetingId,
          state.meetingTitle,
          state.projectDir,
          message,
          contextBlock,
        );
      }
    } catch (err) {
      setState(prev => {
        const conv = [...prev.conversation];
        const lastMsg = conv[conv.length - 1];
        if (lastMsg?.role === 'assistant') {
          conv[conv.length - 1] = {
            ...lastMsg,
            text: `**Error:** ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        return { ...prev, conversation: conv, isStreaming: false };
      });
    }
  }, [state.projectDir, state.meetingId, state.meetingTitle, state.sessionId, state.isStreaming, state.contextBasket]);

  const clearSessionAction = useCallback(async () => {
    if (state.projectDir) {
      await clearClaudeSession(state.projectDir);
    }
    setState(prev => ({
      ...prev,
      sessionId: null,
      conversation: [],
      contextBasket: [],
    }));
  }, [state.projectDir]);

  const value: ClaudeContextValue = {
    ...state,
    openPanel,
    closePanel,
    addToBasket,
    removeFromBasket,
    clearBasket,
    sendMessage,
    clearSession: clearSessionAction,
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
