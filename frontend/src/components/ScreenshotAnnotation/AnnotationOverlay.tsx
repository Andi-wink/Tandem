'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { ReactSketchCanvas, ReactSketchCanvasRef } from 'react-sketch-canvas';
import { Undo2, Redo2, Eraser, Pen, Trash2, Check, X } from 'lucide-react';

const COLORS = ['#ef4444', '#3b82f6', '#000000', '#eab308', '#22c55e', '#ffffff'];
const WIDTHS = [2, 4, 8, 14];

interface AnnotationOverlayProps {
  /** Base64 data URI of the cropped screenshot to annotate */
  imageDataUri: string;
  /** Called with the annotated image as a base64 PNG data URI */
  onSave: (annotatedDataUri: string) => void;
  /** Called when the user cancels annotation */
  onCancel: () => void;
}

export function AnnotationOverlay({ imageDataUri, onSave, onCancel }: AnnotationOverlayProps) {
  const canvasRef = useRef<ReactSketchCanvasRef>(null);
  const [strokeColor, setStrokeColor] = useState('#ef4444');
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [isEraser, setIsEraser] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number } | null>(null);

  // Measure the image and calculate canvas dimensions to fill the window
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const aspectRatio = img.naturalWidth / img.naturalHeight;
      // Available space: full window minus toolbar (~60px) + hint bar (~30px) + padding
      const availW = window.innerWidth - 32;   // 16px padding each side
      const availH = window.innerHeight - 110;  // toolbar + hints + top padding
      let w = availW;
      let h = w / aspectRatio;
      if (h > availH) {
        h = availH;
        w = h * aspectRatio;
      }
      setCanvasSize({ width: Math.round(w), height: Math.round(h) });
    };
    img.src = imageDataUri;
  }, [imageDataUri]);

  const handlePenMode = useCallback(() => {
    setIsEraser(false);
    canvasRef.current?.eraseMode(false);
  }, []);

  const handleEraserMode = useCallback(() => {
    setIsEraser(true);
    canvasRef.current?.eraseMode(true);
  }, []);

  const handleUndo = useCallback(() => {
    canvasRef.current?.undo();
  }, []);

  const handleRedo = useCallback(() => {
    canvasRef.current?.redo();
  }, []);

  const handleClear = useCallback(() => {
    canvasRef.current?.clearCanvas();
  }, []);

  const handleSave = useCallback(async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const dataUri = await canvasRef.current?.exportImage('png');
      if (dataUri) {
        onSave(dataUri);
      }
    } catch (err) {
      console.error('Failed to export annotated image:', err);
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, onSave]);

  return (
    <div className="fixed inset-0 z-[9999] bg-black/90 flex flex-col items-center justify-center select-none">
      {/* Canvas area — fills available space */}
      <div className="relative flex-1 flex items-center justify-center w-full p-4 pb-2">
        {canvasSize ? (
          <div
            className="relative overflow-hidden rounded-lg shadow-2xl border border-white/20"
            style={{ width: canvasSize.width, height: canvasSize.height }}
          >
            <ReactSketchCanvas
              ref={canvasRef}
              backgroundImage={imageDataUri}
              exportWithBackgroundImage={true}
              strokeColor={strokeColor}
              strokeWidth={strokeWidth}
              eraserWidth={strokeWidth * 3}
              canvasColor="transparent"
              width={`${canvasSize.width}px`}
              height={`${canvasSize.height}px`}
              style={{ cursor: 'crosshair' }}
            />
          </div>
        ) : (
          <div className="text-white/50 text-sm">Loading image...</div>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 px-6 py-3 bg-gray-900/95 border-t border-white/10 w-full justify-center">
        {/* Tool selection */}
        <div className="flex items-center gap-1 bg-gray-800 rounded-lg p-1">
          <button
            onClick={handlePenMode}
            className={`p-2 rounded-md transition-colors ${!isEraser ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
            title="Pen"
          >
            <Pen className="w-4 h-4" />
          </button>
          <button
            onClick={handleEraserMode}
            className={`p-2 rounded-md transition-colors ${isEraser ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
            title="Eraser"
          >
            <Eraser className="w-4 h-4" />
          </button>
        </div>

        {/* Separator */}
        <div className="w-px h-6 bg-white/20" />

        {/* Colors */}
        <div className="flex items-center gap-1.5">
          {COLORS.map(color => (
            <button
              key={color}
              onClick={() => { setStrokeColor(color); handlePenMode(); }}
              className={`w-6 h-6 rounded-full border-2 transition-transform ${
                strokeColor === color && !isEraser ? 'border-white scale-110' : 'border-transparent hover:scale-110'
              }`}
              style={{ backgroundColor: color }}
              title={color}
            />
          ))}
        </div>

        {/* Separator */}
        <div className="w-px h-6 bg-white/20" />

        {/* Stroke width */}
        <div className="flex items-center gap-1.5">
          {WIDTHS.map(w => (
            <button
              key={w}
              onClick={() => setStrokeWidth(w)}
              className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
                strokeWidth === w ? 'bg-blue-600' : 'bg-gray-800 hover:bg-gray-700'
              }`}
              title={`${w}px`}
            >
              <div
                className="rounded-full bg-white"
                style={{ width: Math.min(w + 2, 14), height: Math.min(w + 2, 14) }}
              />
            </button>
          ))}
        </div>

        {/* Separator */}
        <div className="w-px h-6 bg-white/20" />

        {/* Undo/Redo/Clear */}
        <div className="flex items-center gap-1 bg-gray-800 rounded-lg p-1">
          <button
            onClick={handleUndo}
            className="p-2 rounded-md text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
            title="Undo"
          >
            <Undo2 className="w-4 h-4" />
          </button>
          <button
            onClick={handleRedo}
            className="p-2 rounded-md text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
            title="Redo"
          >
            <Redo2 className="w-4 h-4" />
          </button>
          <button
            onClick={handleClear}
            className="p-2 rounded-md text-gray-400 hover:text-red-400 hover:bg-gray-700 transition-colors"
            title="Clear all"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>

        {/* Separator */}
        <div className="w-px h-6 bg-white/20" />

        {/* Save / Cancel */}
        <div className="flex items-center gap-2">
          <button
            onClick={onCancel}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white transition-colors text-sm"
          >
            <X className="w-4 h-4" />
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors text-sm disabled:opacity-50"
          >
            <Check className="w-4 h-4" />
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Keyboard hints */}
      <div className="text-xs text-gray-500 py-1.5">
        Escape to cancel &middot; Draw on the screenshot, then Save
      </div>
    </div>
  );
}
