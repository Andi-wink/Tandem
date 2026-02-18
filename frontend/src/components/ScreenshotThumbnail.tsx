'use client';

import { memo } from 'react';
import { ScreenshotData } from '@/types';
import { Camera } from 'lucide-react';

interface ScreenshotThumbnailProps {
  screenshot: ScreenshotData;
  onClick: (screenshot: ScreenshotData) => void;
}

export const ScreenshotThumbnail = memo(function ScreenshotThumbnail({
  screenshot,
  onClick,
}: ScreenshotThumbnailProps) {
  const timeLabel = screenshot.recording_elapsed_secs != null
    ? formatElapsed(screenshot.recording_elapsed_secs)
    : screenshot.timestamp;

  return (
    <div
      className="group flex items-start gap-3 px-3 py-2 rounded-lg bg-blue-950/30 border border-blue-800/30 hover:border-blue-600/50 cursor-pointer transition-colors"
      onClick={() => onClick(screenshot)}
    >
      {/* Timestamp */}
      <span className="text-[11px] font-mono text-blue-400/70 pt-1 shrink-0 w-[52px]">
        [{timeLabel}]
      </span>

      {/* Thumbnail */}
      <div className="relative shrink-0 rounded overflow-hidden border border-blue-700/30">
        <img
          src={screenshot.thumbnail_base64}
          alt="Screenshot"
          className="h-16 w-auto object-cover"
        />
        <div className="absolute top-1 left-1 bg-black/60 rounded px-1 py-0.5 flex items-center gap-1">
          <Camera className="w-3 h-3 text-blue-300" />
          <span className="text-[9px] text-blue-300 font-medium">
            {screenshot.capture_mode === 'region' ? 'Region' : 'Screen'}
          </span>
        </div>
      </div>

      {/* Info */}
      <div className="flex flex-col min-w-0 pt-1">
        <span className="text-xs text-blue-200/80">
          Screenshot {screenshot.capture_mode === 'region' ? '(region)' : '(fullscreen)'}
        </span>
        <span className="text-[10px] text-blue-400/50 mt-0.5">
          {screenshot.width} x {screenshot.height}
        </span>
      </div>
    </div>
  );
});

function formatElapsed(secs: number): string {
  const total = Math.floor(secs);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
