import { useCallback, useState, useRef, DragEvent } from 'react';
import { ContextBasketItem } from '@/contexts/ClaudeContext';

/** Custom MIME type to identify basket-item drags (avoids OS file-drop interference). */
export const BASKET_ITEM_MIME = 'application/x-tandem-basket-item';

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
    e.dataTransfer.setData(BASKET_ITEM_MIME, JSON.stringify(item));
    e.dataTransfer.effectAllowed = 'copy';
    setIsDragging(true);
  }, [item]);

  const onDragEnd = useCallback(() => {
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
    if (e.dataTransfer.types.includes(BASKET_ITEM_MIME)) {
      setIsOver(true);
    }
  }, []);

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes(BASKET_ITEM_MIME)) {
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

    const json = e.dataTransfer.getData(BASKET_ITEM_MIME);
    if (!json) return;

    try {
      const item: ContextBasketItem = JSON.parse(json);
      onDrop(item);
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