'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { convertFileSrc } from '@tauri-apps/api/core';

interface RegionSelectOverlayProps {
  previewPath: string;      // Absolute path to pre-captured JPEG on disk
  monitorWidth: number;     // Physical pixel width of captured image
  monitorHeight: number;    // Physical pixel height of captured image
  onSelect: (x: number, y: number, width: number, height: number) => void;
  onCancel: () => void;
}

export function RegionSelectOverlay({
  previewPath,
  monitorWidth,
  monitorHeight,
  onSelect,
  onCancel,
}: RegionSelectOverlayProps) {
  const [startPos, setStartPos] = useState<{ x: number; y: number } | null>(null);
  const [currentPos, setCurrentPos] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [ready, setReady] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const wasFullscreenRef = useRef(false);

  // Convert local file path to Tauri asset URL
  const previewSrc = convertFileSrc(previewPath);

  // On mount: preload the preview image, then go fullscreen
  // The screen was already captured by the Rust hotkey handler — no capture needed here
  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      try {
        const win = getCurrentWindow();
        wasFullscreenRef.current = await win.isFullscreen();

        // Preload the JPEG from disk via asset protocol (typically ~5-10ms for local file)
        const img = new Image();
        img.onload = async () => {
          if (cancelled) return;
          await win.setDecorations(false);
          await win.setFullscreen(true);
          await win.setFocus();
          if (!cancelled) setReady(true);
        };
        img.onerror = async () => {
          console.error('Failed to load preview image:', previewPath);
          if (!cancelled) {
            await restoreWindow();
            onCancel();
          }
        };
        img.src = previewSrc;
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
    if (startPos && currentPos && isDragging) {
      const viewX = Math.min(startPos.x, currentPos.x);
      const viewY = Math.min(startPos.y, currentPos.y);
      const viewW = Math.abs(currentPos.x - startPos.x);
      const viewH = Math.abs(currentPos.y - startPos.y);

      if (viewW > 10 && viewH > 10) {
        // Map viewport coordinates to physical screen pixels
        const scaleX = monitorWidth / window.innerWidth;
        const scaleY = monitorHeight / window.innerHeight;

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
  }, [startPos, currentPos, isDragging, monitorWidth, monitorHeight, restoreWindow, onSelect, handleCancel]);

  // Calculate selection rectangle in viewport coordinates
  const selectionRect =
    startPos && currentPos
      ? {
          left: Math.min(startPos.x, currentPos.x),
          top: Math.min(startPos.y, currentPos.y),
          width: Math.abs(currentPos.x - startPos.x),
          height: Math.abs(currentPos.y - startPos.y),
        }
      : null;

  // Don't render until fullscreen is ready (prevents flash of windowed content)
  if (!ready) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[9999] cursor-crosshair select-none"
      style={{
        backgroundImage: `url(${previewSrc})`,
        backgroundSize: '100% 100%',     // Stretch full-res JPEG to fill viewport
        backgroundPosition: 'top left',
        backgroundRepeat: 'no-repeat',
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Dark tint when no selection is active */}
      {!selectionRect && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.25)' }}
        />
      )}

      {/* Instructions */}
      {!isDragging && (
        <div className="absolute top-8 left-1/2 -translate-x-1/2 bg-black/80 text-white px-4 py-2 rounded-lg text-sm pointer-events-none z-10">
          Click and drag to select a region. Press Escape to cancel.
        </div>
      )}

      {/* Selection rectangle with CSS cutout effect */}
      {selectionRect && (
        <div
          className="absolute border-2 border-blue-400 pointer-events-none"
          style={{
            left: selectionRect.left,
            top: selectionRect.top,
            width: selectionRect.width,
            height: selectionRect.height,
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.4)',
          }}
        >
          {/* Size indicator showing physical pixel dimensions */}
          <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 bg-black/80 text-white px-2 py-0.5 rounded text-xs whitespace-nowrap">
            {Math.round(selectionRect.width * (monitorWidth / window.innerWidth))} x{' '}
            {Math.round(selectionRect.height * (monitorHeight / window.innerHeight))}
          </div>
        </div>
      )}
    </div>
  );
}
