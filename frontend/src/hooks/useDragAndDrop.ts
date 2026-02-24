import { useCallback, useState, useRef, DragEvent, useSyncExternalStore } from 'react';
import { ContextBasketItem } from '@/contexts/ClaudeContext';

/** Custom MIME type to identify basket-item drags (avoids OS file-drop interference). */
export const BASKET_ITEM_MIME = 'application/x-tandem-basket-item';

/**
 * Module-level flag tracking whether an internal basket drag is in progress.
 * WebView2 on Windows doesn't reliably expose custom MIME types in
 * dataTransfer.types during dragenter/dragover, so we use this flag
 * as the primary detection mechanism.
 */
let _internalDragActive = false;
const _dragListeners = new Set<() => void>();

function _notifyDragListeners() {
  _dragListeners.forEach(cb => cb());
}

/** Subscribe to whether an internal basket drag is currently in progress. */
export function useDragActive(): boolean {
  return useSyncExternalStore(
    (cb) => { _dragListeners.add(cb); return () => { _dragListeners.delete(cb); }; },
    () => _internalDragActive,
    () => _internalDragActive,
  );
}

/** Check if the current drag is an internal basket-item drag. */
function isBasketDrag(e: DragEvent): boolean {
  return _internalDragActive || Array.from(e.dataTransfer.types).includes(BASKET_ITEM_MIME);
}

/**
 * Makes an element draggable as a ContextBasketItem.
 * Pass `null` to disable dragging (e.g. when the item is already in the basket).
 */
export function useDraggableBasketItem(item: ContextBasketItem | null) {
  const [isDragging, setIsDragging] = useState(false);

  const onDragStart = useCallback((e: DragEvent) => {
    if (!item) {
      e.preventDefault();
      return;
    }
    const json = JSON.stringify(item);
    e.dataTransfer.setData(BASKET_ITEM_MIME, json);
    e.dataTransfer.setData('text/plain', json); // fallback for restrictive webviews
    e.dataTransfer.effectAllowed = 'copy';
    _internalDragActive = true;
    _notifyDragListeners();
    setIsDragging(true);
  }, [item]);

  const onDragEnd = useCallback(() => {
    _internalDragActive = false;
    _notifyDragListeners();
    setIsDragging(false);
  }, []);

  return {
    isDragging,
    dragHandlers: {
      draggable: !!item,
      onDragStart,
      onDragEnd,
    },
  };
}

/**
 * Makes an element a drop zone that accepts ContextBasketItems.
 * Returns `isOver` for visual highlight and `dropHandlers` to spread onto the element.
 */
export function useDropZone(onDrop: (item: ContextBasketItem) => void) {
  const [isOver, setIsOver] = useState(false);
  const dragCounterRef = useRef(0);

  const onDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (isBasketDrag(e)) {
      setIsOver(true);
    }
  }, []);

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isBasketDrag(e)) {
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const onDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsOver(false);

    // Try custom MIME first, fall back to text/plain
    const json = e.dataTransfer.getData(BASKET_ITEM_MIME) || e.dataTransfer.getData('text/plain');
    if (!json) return;

    try {
      const item: ContextBasketItem = JSON.parse(json);
      if (item.id && item.type && item.fullContent) {
        onDrop(item);
      }
    } catch (err) {
      console.error('Failed to parse dropped basket item:', err);
    }
  }, [onDrop]);

  return {
    isOver,
    dropHandlers: {
      onDragEnter,
      onDragOver,
      onDragLeave,
      onDrop: handleDrop,
    },
  };
}
