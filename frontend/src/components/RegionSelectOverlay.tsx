'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { captureScreenPreview, ScreenPreview } from '@/services/screenshotService';

interface RegionSelectOverlayProps {
  onSelect: (x: number, y: number, width: number, height: number) => void;
  onCancel: () => void;
}

export function RegionSelectOverlay({ onSelect, onCancel }: RegionSelectOverlayProps) {
  const [startPos, setStartPos] = useState<{ x: number; y: number } | null>(null);
  const [currentPos, setCurrentPos] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [preview, setPreview] = useState<ScreenPreview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const overlayRef = useRef<HTMLDivElement>(null);
  const wasFullscreenRef = useRef(false);

  // On mount: capture desktop immediately (no hide), then go fullscreen with preview
  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      try {
        const win = getCurrentWindow();

        // Remember original fullscreen state
        wasFullscreenRef.current = await win.isFullscreen();

        // Capture the desktop with app visible — viewport-sized JPEG for speed
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const screenPreview = await captureScreenPreview(vw, vh);

        if (cancelled) return;

        setPreview(screenPreview);

        // Go fullscreen with decorations hidden to show overlay
        await win.setDecorations(false);
        await win.setFullscreen(true);
        await win.setFocus();

        setIsLoading(false);
      } catch (err) {
        console.error('Failed to setup region select:', err);
        if (!cancelled) {
          await restoreWindow();
          onCancel();
        }
      }
    };

    setup();

    return () => {
      cancelled = true;
    };
  }, []);

  const restoreWindow = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      await win.setFullscreen(wasFullscreenRef.current);
      await win.setDecorations(true);
    } catch (err) {
      console.error('Failed to restore window:', err);
    }
  }, []);

  const handleCancel = useCallback(async () => {
    await restoreWindow();
    onCancel();
  }, [restoreWindow, onCancel]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancel();
    },
    [handleCancel],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setStartPos({ x: e.clientX, y: e.clientY });
    setCurrentPos({ x: e.clientX, y: e.clientY });
    setIsDragging(true);
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isDragging) {
        setCurrentPos({ x: e.clientX, y: e.clientY });
      }
    },
    [isDragging],
  );

  const handleMouseUp = useCallback(async () => {
    if (startPos && currentPos && isDragging && preview) {
      const viewX = Math.min(startPos.x, currentPos.x);
      const viewY = Math.min(startPos.y, currentPos.y);
      const viewW = Math.abs(currentPos.x - startPos.x);
      const viewH = Math.abs(currentPos.y - startPos.y);

      if (viewW > 10 && viewH > 10) {
        // Map viewport coordinates to actual screen coordinates
        // preview.width/height are the ORIGINAL monitor dimensions
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        const scaleX = preview.width / viewportWidth;
        const scaleY = preview.height / viewportHeight;

        const screenX = Math.round(viewX * scaleX);
        const screenY = Math.round(viewY * scaleY);
        const screenW = Math.round(viewW * scaleX);
        const screenH = Math.round(viewH * scaleY);

        await restoreWindow();
        onSelect(screenX, screenY, screenW, screenH);
      } else {
        await handleCancel();
      }
    }
    setIsDragging(false);
    setStartPos(null);
    setCurrentPos(null);
  }, [startPos, currentPos, isDragging, preview, restoreWindow, onSelect, handleCancel]);

  // Calculate selection rectangle
  const selectionRect =
    startPos && currentPos
      ? {
          left: Math.min(startPos.x, currentPos.x),
          top: Math.min(startPos.y, currentPos.y),
          width: Math.abs(currentPos.x - startPos.x),
          height: Math.abs(currentPos.y - startPos.y),
        }
      : null;

  if (isLoading) {
    return (
      <div className="fixed inset-0 z-[9999] bg-black flex items-center justify-center">
        <div className="text-white text-sm">Capturing screen...</div>
      </div>
    );
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[9999] cursor-crosshair select-none"
      style={{
        backgroundImage: preview ? `url(${preview.image_data})` : undefined,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Dark overlay for non-selected areas */}
      {!isDragging && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.2)' }}
        />
      )}

      {/* Instructions */}
      {!isDragging && (
        <div className="absolute top-8 left-1/2 -translate-x-1/2 bg-black/80 text-white px-4 py-2 rounded-lg text-sm pointer-events-none z-10">
          Click and drag to select a region. Press Escape to cancel.
        </div>
      )}

      {/* Selection rectangle */}
      {selectionRect && (
        <div
          className="absolute border-2 border-blue-400 bg-blue-400/10 pointer-events-none"
          style={{
            left: selectionRect.left,
            top: selectionRect.top,
            width: selectionRect.width,
            height: selectionRect.height,
          }}
        >
          {/* Size indicator */}
          <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 bg-black/80 text-white px-2 py-0.5 rounded text-xs whitespace-nowrap">
            {Math.round(selectionRect.width)} x {Math.round(selectionRect.height)}
          </div>
        </div>
      )}
    </div>
  );
}
