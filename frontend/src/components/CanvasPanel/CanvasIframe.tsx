'use client';

/**
 * The embedded canvas: the agent-whiteboard app loaded in an iframe inside the AI panel. Stays
 * mounted (hidden via CSS, not unmounted) so the board + agent state survive view switches. Registers
 * its contentWindow with CanvasContext so prompts can be postMessage'd in.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useCanvas } from '@/contexts/CanvasContext';

export function CanvasIframe() {
  const { agentUrl, canvasVisible, registerCanvasIframe } = useCanvas();
  const ref = useRef<HTMLIFrameElement | null>(null);

  const register = useCallback(() => {
    registerCanvasIframe(ref.current?.contentWindow ?? null);
  }, [registerCanvasIframe]);

  useEffect(() => {
    // contentWindow exists once mounted; also re-registers on each load() via onLoad.
    register();
    return () => registerCanvasIframe(null);
  }, [register, registerCanvasIframe]);

  // `embed=1` tells the agent app to hide its own ChatPanel — Tandem's input is the single input.
  const src = agentUrl.includes('?') ? `${agentUrl}&embed=1` : `${agentUrl}?embed=1`;

  return (
    <div
      className="absolute inset-0 z-10 bg-background"
      style={{ display: canvasVisible ? 'block' : 'none' }}
      aria-hidden={!canvasVisible}
    >
      <iframe
        ref={ref}
        src={src}
        onLoad={register}
        title="Canvas"
        allow="microphone; clipboard-read; clipboard-write"
        className="h-full w-full border-0"
      />
    </div>
  );
}

export default CanvasIframe;
