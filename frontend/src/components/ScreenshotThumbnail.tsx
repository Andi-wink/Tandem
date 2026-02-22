'use client';

import { memo } from 'react';
import { ScreenshotData } from '@/types';
import { Camera, Plus, Check } from 'lucide-react';
import { useClaude, ContextBasketItem } from '@/contexts/ClaudeContext';

interface ScreenshotThumbnailProps {
  screenshot: ScreenshotData;
  onClick: (screenshot: ScreenshotData) => void;
}

export const ScreenshotThumbnail = memo(function ScreenshotThumbnail({
  screenshot,
  onClick,
}: ScreenshotThumbnailProps) {
  const { addToBasket, contextBasket, isPanelOpen } = useClaude();

  const timeLabel = screenshot.recording_elapsed_secs != null
    ? formatElapsed(screenshot.recording_elapsed_secs)
    : screenshot.timestamp;

  const inBasket = contextBasket.some(b => b.id === screenshot.id);

  const handleAddToAI = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (inBasket) return;
    const item: ContextBasketItem = {
      id: screenshot.id,
      type: 'screenshot',
      label: `Screenshot ${timeLabel}`,
      preview: `${screenshot.capture_mode} capture (${screenshot.width}x${screenshot.height})`,
      fullContent: `[Screenshot taken at ${timeLabel} — ${screenshot.capture_mode} capture, ${screenshot.width}x${screenshot.height}]\nImage file path: ${screenshot.file_path}\nPlease use the Read tool to view this image file.`,
      timestamp: screenshot.recording_elapsed_secs,
    };
    addToBasket(item);
  };

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

      {/* Add to AI button — visible when Claude panel is open */}
      {isPanelOpen && (
        <button
          onClick={handleAddToAI}
          disabled={inBasket}
          className={`ml-auto self-center shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium border transition-colors ${
            inBasket
              ? 'bg-blue-500/20 border-blue-500/30 text-blue-300 cursor-default'
              : 'bg-blue-600/20 border-blue-500/30 text-blue-300 hover:bg-blue-500/30 hover:border-blue-400/50'
          }`}
          title={inBasket ? 'Already in context' : 'Add screenshot to AI context'}
        >
          {inBasket ? <Check className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
          {inBasket ? 'Added' : 'AI'}
        </button>
      )}
    </div>
  );
});

function formatElapsed(secs: number): string {
  const total = Math.floor(secs);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
