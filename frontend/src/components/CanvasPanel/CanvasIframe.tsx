'use client';

/**
 * The embedded canvas: the agent-whiteboard app loaded in an iframe inside the AI panel. Stays
 * mounted (hidden via CSS, not unmounted) so the board + agent state survive view switches. Registers
 * its contentWindow with CanvasContext so prompts can be postMessage'd in.
 *
 * If the agent server isn't reachable (dev: not running at :5174), the readiness handshake never
 * arrives — after a short grace period we show a clear message + Retry instead of a blank frame.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCanvas } from '@/contexts/CanvasContext';

const READY_GRACE_MS = 6000;

export function CanvasIframe() {
  const { agentUrl, canvasVisible, canvasReady, registerCanvasIframe, boardReadOnly, setBoardReadOnly } = useCanvas();
  const ref = useRef<HTMLIFrameElement | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const register = useCallback(() => {
    registerCanvasIframe(ref.current?.contentWindow ?? null);
  }, [registerCanvasIframe]);

  useEffect(() => {
    // contentWindow exists once mounted; also re-registers on each load() via onLoad.
    register();
    return () => registerCanvasIframe(null);
  }, [register, registerCanvasIframe]);

  // Surface an unreachable-server state if readiness never arrives while the canvas is on screen.
  useEffect(() => {
    if (!canvasVisible || canvasReady) {
      setUnreachable(false);
      return;
    }
    const t = setTimeout(() => setUnreachable(true), READY_GRACE_MS);
    return () => clearTimeout(t);
  }, [canvasVisible, canvasReady, reloadNonce]);

  // `embed=1` tells the agent app to hide its own ChatPanel — Tandem's input is the single input.
  const base = agentUrl.includes('?') ? `${agentUrl}&embed=1` : `${agentUrl}?embed=1`;
  const src = reloadNonce ? `${base}&_r=${reloadNonce}` : base;

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
      {boardReadOnly && (
        <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-3 border-b border-warning/20 bg-warning-muted px-3 py-1.5">
          <span className="text-xs text-warning-foreground">
            Viewing a saved board · changes won&apos;t be saved
          </span>
          <button
            onClick={() => {
              const ok = window.confirm(
                "Edit here? Changes will be saved into the CURRENT meeting's board, replacing whatever it holds.",
              );
              if (ok) setBoardReadOnly(false);
            }}
            className="flex-shrink-0 rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand-hover"
          >
            Edit here
          </button>
        </div>
      )}
      {unreachable && !canvasReady && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
          <p className="text-sm font-medium text-foreground">Canvas server not reachable</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Couldn&apos;t reach the whiteboard agent at{' '}
            <span className="font-mono">{agentUrl}</span>. In development, start it with{' '}
            <span className="font-mono">pnpm dev</span> in the agent-whiteboard app.
          </p>
          <button
            onClick={() => {
              setUnreachable(false);
              setReloadNonce((n) => n + 1);
            }}
            className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground hover:bg-brand-hover transition-colors"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

export default CanvasIframe;
