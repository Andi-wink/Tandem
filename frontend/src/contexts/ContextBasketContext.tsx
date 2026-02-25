'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';

// ─── Types (R009: extracted from ClaudeContext) ─────────────────────────────

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

interface ContextBasketContextValue {
  contextBasket: ContextBasketItem[];
  addToBasket: (item: ContextBasketItem) => void;
  removeFromBasket: (itemId: string) => void;
  clearBasket: () => void;
  /** Update a single item's fields (e.g. toggle anonymize flag) */
  updateItem: (itemId: string, updates: Partial<ContextBasketItem>) => void;
}

const ContextBasketContext = createContext<ContextBasketContextValue | null>(null);

// ─── Provider ───────────────────────────────────────────────────────────────

export function ContextBasketProvider({ children }: { children: React.ReactNode }) {
  const [contextBasket, setContextBasket] = useState<ContextBasketItem[]>([]);

  const addToBasket = useCallback((item: ContextBasketItem) => {
    setContextBasket(prev => {
      if (prev.some(b => b.id === item.id)) return prev;
      return [...prev, item];
    });
  }, []);

  const removeFromBasket = useCallback((itemId: string) => {
    setContextBasket(prev => prev.filter(b => b.id !== itemId));
  }, []);

  const clearBasket = useCallback(() => {
    setContextBasket([]);
  }, []);

  const updateItem = useCallback((itemId: string, updates: Partial<ContextBasketItem>) => {
    setContextBasket(prev => prev.map(item =>
      item.id === itemId ? { ...item, ...updates } : item
    ));
  }, []);

  return (
    <ContextBasketContext.Provider value={{ contextBasket, addToBasket, removeFromBasket, clearBasket, updateItem }}>
      {children}
    </ContextBasketContext.Provider>
  );
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useContextBasket(): ContextBasketContextValue {
  const ctx = useContext(ContextBasketContext);
  if (!ctx) throw new Error('useContextBasket must be used within ContextBasketProvider');
  return ctx;
}
