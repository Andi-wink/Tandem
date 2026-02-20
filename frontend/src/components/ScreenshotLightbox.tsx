'use client';

import { useEffect, useCallback } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ScreenshotData } from '@/types';
import { X } from 'lucide-react';

interface ScreenshotLightboxProps {
  screenshot: ScreenshotData;
  onClose: () => void;
}

export function ScreenshotLightbox({ screenshot, onClose }: ScreenshotLightboxProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const imageSrc = convertFileSrc(screenshot.file_path);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative max-w-[90vw] max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute -top-3 -right-3 z-10 rounded-full bg-gray-800 border border-gray-600 p-1.5 hover:bg-gray-700 transition-colors"
        >
          <X className="w-4 h-4 text-gray-300" />
        </button>
        <img
          src={imageSrc}
          alt="Screenshot full size"
          className="max-w-full max-h-[90vh] rounded-lg shadow-2xl object-contain"
        />
        <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/60 to-transparent rounded-b-lg">
          <div className="flex items-center justify-between text-xs text-gray-300">
            <span>{screenshot.timestamp} - {screenshot.capture_mode}</span>
            <span>{screenshot.width} x {screenshot.height}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
