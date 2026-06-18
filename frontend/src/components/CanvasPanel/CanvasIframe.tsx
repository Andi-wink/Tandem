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

  // Flex child (not an absolute overlay): in the panel body it sits left of / above the chat region,
  // so the chat input is never covered. Stays mounted when hidden (display:none) to preserve board +
  // agent state across view switches.
  return (
    <div
      className={canvasVisible ? 'relative min-h-0 min-w-0 flex-1 bg-background' : 'hidden'}
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
