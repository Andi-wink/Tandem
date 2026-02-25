'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AnnotationOverlay } from './ScreenshotAnnotation/AnnotationOverlay';
import { cropPreCapturedPreview } from '@/services/screenshotService';

interface RegionSelectOverlayProps {
  previewDataUri: string;   // Base64 data URI of the pre-captured JPEG
  monitorWidth: number;     // Physical pixel width of captured image
  monitorHeight: number;    // Physical pixel height of captured image
  onSelect: (x: number, y: number, width: number, height: number) => void;
  onAnnotatedCapture?: (annotatedBase64: string) => void;
  onCancel: () => void;
}

export function RegionSelectOverlay({
  previewDataUri,
  monitorWidth,
  monitorHeight,
  onSelect,
  onAnnotatedCapture,
  onCancel,
}: RegionSelectOverlayProps) {
  const [startPos, setStartPos] = useState<{ x: number; y: number } | null>(null);
  const [currentPos, setCurrentPos] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [ready, setReady] = useState(false);
  const [annotationImage, setAnnotationImage] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const wasFullscreenRef = useRef(false);

  // On mount: preload the data URI image, then go fullscreen
  // The screen was already captured by the Rust hotkey handler — no capture needed here
  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      try {
        const win = getCurrentWindow();
        wasFullscreenRef.current = await win.isFullscreen();

        // Preload the base64 data URI (decodes in-process, no asset protocol needed)
        const img = new Image();
        img.onload = async () => {
          if (cancelled) return;
          await win.setDecorations(false);
          await win.setFullscreen(true);
          await win.setFocus();
          if (!cancelled) setReady(true);
        };
        img.onerror = async () => {
          console.error('Failed to decode preview data URI (length:', previewDataUri.length, ')');
          if (!cancelled) {
            await restoreWindow();
            onCancel();
          }
        };
        img.src = previewDataUri;
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
      // In annotation mode, Escape is handled by AnnotationOverlay
      if (e.key === 'Escape' && !annotationImage) handleCancel();
    },
    [handleCancel, annotationImage],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (annotationImage) return; // Don't start new selection during annotation
    setStartPos({ x: e.clientX, y: e.clientY });
    setCurrentPos({ x: e.clientX, y: e.clientY });
    setIsDragging(true);
  }, [annotationImage]);

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

      // Map viewport coords to physical pixel coords
      const scaleX = monitorWidth / window.innerWidth;
      const scaleY = monitorHeight / window.innerHeight;
      const physX = Math.round(viewX * scaleX);
      const physY = Math.round(viewY * scaleY);
      const physW = Math.round(viewW * scaleX);
      const physH = Math.round(viewH * scaleY);

      if (viewW > 10 && viewH > 10) {
        if (onAnnotatedCapture) {
          // Annotation path: crop via Rust (fast JPEG), stay fullscreen
          try {
            const result = await cropPreCapturedPreview(physX, physY, physW, physH);
            // Stay fullscreen — no restoreWindow() here.
            // AnnotationOverlay renders in-place, saving ~200-300ms of window transitions.
            setAnnotationImage(result.data_uri);
          } catch (err) {
            console.error('Failed to crop for annotation:', err);
            // Fallback to normal capture
            await restoreWindow();
            onSelect(physX, physY, physW, physH);
          }
        } else {
          // No annotation: original behavior
          await restoreWindow();
          onSelect(physX, physY, physW, physH);
        }
      } else {
        await handleCancel();
      }
    }
    setIsDragging(false);
    setStartPos(null);
    setCurrentPos(null);
  }, [startPos, currentPos, isDragging, monitorWidth, monitorHeight, restoreWindow, onSelect, onAnnotatedCapture, handleCancel]);

  const handleAnnotationSave = useCallback(async (annotatedDataUri: string) => {
    await restoreWindow();
    setAnnotationImage(null);
    onAnnotatedCapture?.(annotatedDataUri);
  }, [onAnnotatedCapture, restoreWindow]);

  const handleAnnotationCancel = useCallback(async () => {
    await restoreWindow();
    setAnnotationImage(null);
    onCancel();
  }, [onCancel, restoreWindow]);

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

  // Annotation phase: show annotation overlay instead of region selection
  if (annotationImage) {
    return (
      <AnnotationOverlay
        imageDataUri={annotationImage}
        onSave={handleAnnotationSave}
        onCancel={handleAnnotationCancel}
      />
    );
  }

  // Don't render until fullscreen is ready (prevents flash of windowed content)
  if (!ready) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[9999] cursor-crosshair select-none"
      style={{
        backgroundImage: `url(${previewDataUri})`,
        backgroundSize: '100% 100%',     // Stretch JPEG to fill viewport
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
