'use client';

/**
 * Mounts the Alt+Shift+A push-to-talk voice flow once and renders a small "listening" indicator so
 * voice capture is never invisible mid-call. Also surfaces the transcript-privacy state: when the
 * opt-in is on, it shows that the last few minutes of transcript will be sent as context.
 */

import { Mic } from 'lucide-react';
import { useCanvasVoice } from '@/hooks/useCanvasVoice';
import { useCanvas } from '@/contexts/CanvasContext';

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function CanvasVoiceListener() {
  const { listening } = useCanvasVoice();
  const { transcriptOptIn } = useCanvas();

  if (!inTauri() || !listening) return null;

  return (
    <div className="fixed bottom-20 left-4 z-[1001] flex items-center gap-2 rounded-full border border-border bg-background/95 px-3 py-1.5 shadow-lg backdrop-blur">
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-destructive" />
      </span>
      <Mic className="h-3.5 w-3.5 text-foreground" />
      <span className="text-caption font-medium text-foreground">
        Listening for canvas command…
      </span>
      {transcriptOptIn && (
        <span className="text-caption text-muted-foreground">· sharing last 5 min</span>
      )}
    </div>
  );
}

export default CanvasVoiceListener;
