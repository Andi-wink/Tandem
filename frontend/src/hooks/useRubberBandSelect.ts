import { useState, useCallback, useRef, useEffect, PointerEvent as ReactPointerEvent } from 'react';

const DRAG_THRESHOLD = 5; // px before rubber-band activates

export interface SelectionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface UseRubberBandSelectOptions {
  /** CSS selector for selectable items within the container */
  selectableSelector: string;
  /** Called with the IDs of items that intersect the selection rectangle */
  onSelectionChange: (ids: string[]) => void;
  /** Called when rubber-band drag finishes */
  onSelectionEnd?: (ids: string[]) => void;
  /** Whether the feature is enabled */
  enabled?: boolean;
}

/**
 * Hook for rubber-band (lasso) multi-select within a container.
 *
 * Usage:
 * 1. Add `data-selectable-id="itemId"` to each selectable element
 * 2. Spread `containerProps` onto the container element
 * 3. Render `selectionRect` as an absolute-positioned div if non-null
 */
export function useRubberBandSelect({
  selectableSelector,
  onSelectionChange,
  onSelectionEnd,
  enabled = true,
}: UseRubberBandSelectOptions) {
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const isDraggingRef = useRef(false);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const thresholdMetRef = useRef(false);

  const getIntersectingIds = useCallback((rect: SelectionRect): string[] => {
    if (!containerRef.current) return [];

    const items = containerRef.current.querySelectorAll(selectableSelector);
    const ids: string[] = [];

    const containerRect = containerRef.current.getBoundingClientRect();
    // Selection rect is relative to the container
    const absLeft = containerRect.left + rect.left;
    const absTop = containerRect.top + rect.top;
    const absRight = absLeft + rect.width;
    const absBottom = absTop + rect.height;

    items.forEach(el => {
      const id = el.getAttribute('data-selectable-id');
      if (!id) return;

      const elRect = el.getBoundingClientRect();
      // Check intersection
      if (
        elRect.left < absRight &&
        elRect.right > absLeft &&
        elRect.top < absBottom &&
        elRect.bottom > absTop
      ) {
        ids.push(id);
      }
    });

    return ids;
  }, [selectableSelector]);

  const handlePointerDown = useCallback((e: ReactPointerEvent) => {
    if (!enabled) return;
    // Only activate on left mouse button and only on empty space
    if (e.button !== 0) return;
    // Don't start rubber-band if clicking on a selectable item itself
    const target = e.target as HTMLElement;
    if (target.closest(selectableSelector)) return;

    startPosRef.current = { x: e.clientX, y: e.clientY };
    isDraggingRef.current = true;
    thresholdMetRef.current = false;

    // Capture pointer for reliable tracking (important for WebView2)
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [enabled, selectableSelector]);

  const handlePointerMove = useCallback((e: ReactPointerEvent) => {
    if (!isDraggingRef.current || !startPosRef.current || !containerRef.current) return;

    const dx = e.clientX - startPosRef.current.x;
    const dy = e.clientY - startPosRef.current.y;
    const distance = Math.hypot(dx, dy);

    if (!thresholdMetRef.current) {
      if (distance < DRAG_THRESHOLD) return;
      thresholdMetRef.current = true;
    }

    const containerRect = containerRef.current.getBoundingClientRect();

    // Calculate rect relative to container
    const left = Math.min(startPosRef.current.x, e.clientX) - containerRect.left;
    const top = Math.min(startPosRef.current.y, e.clientY) - containerRect.top;
    const width = Math.abs(dx);
    const height = Math.abs(dy);

    const rect: SelectionRect = { left, top, width, height };
    setSelectionRect(rect);

    const ids = getIntersectingIds(rect);
    onSelectionChange(ids);
  }, [getIntersectingIds, onSelectionChange]);

  const handlePointerUp = useCallback((e: ReactPointerEvent) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;

    if (thresholdMetRef.current && selectionRect) {
      const ids = getIntersectingIds(selectionRect);
      onSelectionEnd?.(ids);
    }

    setSelectionRect(null);
    startPosRef.current = null;
    thresholdMetRef.current = false;

    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore if capture was already released
    }
  }, [getIntersectingIds, onSelectionEnd, selectionRect]);

  const setContainerRef = useCallback((el: HTMLElement | null) => {
    containerRef.current = el;
  }, []);

  return {
    containerRef: setContainerRef,
    selectionRect,
    containerProps: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
    },
  };
}
