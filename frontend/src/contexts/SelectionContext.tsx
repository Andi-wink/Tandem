'use client';

import React, { createContext, useContext, useState, useCallback, useRef } from 'react';

interface SelectionContextType {
  /** Set of currently selected element IDs */
  selectedIds: Set<string>;
  /** The last item that was clicked (anchor for Shift+click range select) */
  lastSelectedId: string | null;
  /** Select a single item (clears others unless modifier keys are used) */
  select: (id: string) => void;
  /** Toggle selection of a single item (for Ctrl+click) */
  toggle: (id: string) => void;
  /** Range-select from lastSelectedId to the given id (for Shift+click) */
  rangeTo: (id: string, orderedIds: string[]) => void;
  /** Check if an item is selected */
  isSelected: (id: string) => boolean;
  /** Clear all selections */
  clearSelection: () => void;
  /** Select all given IDs */
  selectAll: (ids: string[]) => void;
  /** Select multiple IDs (additive, for rubber-band) */
  selectMultiple: (ids: string[]) => void;
  /** Replace selection with exactly these IDs (for rubber-band while dragging) */
  replaceSelection: (ids: string[]) => void;
}

const SelectionContext = createContext<SelectionContextType | null>(null);

export function useSelection() {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error('useSelection must be used within SelectionProvider');
  return ctx;
}

export function SelectionProvider({ children }: { children: React.ReactNode }) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);

  const select = useCallback((id: string) => {
    setSelectedIds(new Set([id]));
    setLastSelectedId(id);
  }, []);

  const toggle = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setLastSelectedId(id);
  }, []);

  const rangeTo = useCallback((id: string, orderedIds: string[]) => {
    setSelectedIds(prev => {
      const anchor = lastSelectedId;
      if (!anchor) return new Set([id]);

      const startIdx = orderedIds.indexOf(anchor);
      const endIdx = orderedIds.indexOf(id);
      if (startIdx === -1 || endIdx === -1) return new Set([id]);

      const [min, max] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
      const range = orderedIds.slice(min, max + 1);
      return new Set(range);
    });
    setLastSelectedId(id);
  }, [lastSelectedId]);

  const isSelected = useCallback((id: string) => {
    return selectedIds.has(id);
  }, [selectedIds]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setLastSelectedId(null);
  }, []);

  const selectAll = useCallback((ids: string[]) => {
    setSelectedIds(new Set(ids));
  }, []);

  const selectMultiple = useCallback((ids: string[]) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      ids.forEach(id => next.add(id));
      return next;
    });
  }, []);

  const replaceSelection = useCallback((ids: string[]) => {
    setSelectedIds(new Set(ids));
  }, []);

  return (
    <SelectionContext.Provider
      value={{
        selectedIds,
        lastSelectedId,
        select,
        toggle,
        rangeTo,
        isSelected,
        clearSelection,
        selectAll,
        selectMultiple,
        replaceSelection,
      }}
    >
      {children}
    </SelectionContext.Provider>
  );
}
