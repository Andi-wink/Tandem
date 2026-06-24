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

// Tandem auto-starts the whiteboard server, but `node` takes a few seconds to boot — and the iframe
// may have loaded its error page before the port was up. So we silently reload the iframe a few times
// before surfacing the manual "unreachable" card; first launch then self-heals without a click.
const AUTO_RELOAD_MS = 3000;
const MAX_AUTO_RELOADS = 4;

export function CanvasIframe() {
  const { agentUrl, canvasVisible, canvasReady, registerCanvasIframe, boardReadOnly, setBoardReadOnly } = useCanvas();
  const ref = useRef<HTMLIFrameElement | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [autoReloads, setAutoReloads] = useState(0);

  const register = useCallback(() => {
    registerCanvasIframe(ref.current?.contentWindow ?? null);
  }, [registerCanvasIframe]);

  useEffect(() => {
    // contentWindow exists once mounted; also re-registers on each load() via onLoad.
    register();
    return () => registerCanvasIframe(null);
  }, [register, registerCanvasIframe]);

  // Reset the auto-reload budget whenever the canvas connects or is hidden.
  useEffect(() => {
    if (canvasReady || !canvasVisible) setAutoReloads(0);
  }, [canvasReady, canvasVisible]);

  // Auto-recover: while the canvas is visible but not yet ready, reload the iframe on a timer (up to
  // MAX_AUTO_RELOADS) so a just-starting server connects on its own.
  useEffect(() => {
    if (!canvasVisible || canvasReady || autoReloads >= MAX_AUTO_RELOADS) return;
    const t = setTimeout(() => {
      setReloadNonce((n) => n + 1);
      setAutoReloads((n) => n + 1);
    }, AUTO_RELOAD_MS);
    return () => clearTimeout(t);
  }, [canvasVisible, canvasReady, autoReloads]);

  // Only surface the manual "unreachable" card once auto-reloads are exhausted and we're still not
  // connected — give that last reload a beat to land first.
  useEffect(() => {
    if (!canvasVisible || canvasReady || autoReloads < MAX_AUTO_RELOADS) {
      setUnreachable(false);
      return;
    }
    const t = setTimeout(() => setUnreachable(true), AUTO_RELOAD_MS);
    return () => clearTimeout(t);
  }, [canvasVisible, canvasReady, autoReloads]);

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
        // No `microphone`: canvas voice (Alt+Shift+A) is captured in Tandem's own renderer, not the
        // embedded third-party app. Clipboard stays for paste-into-canvas.
        allow="clipboard-read; clipboard-write"
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
            Tandem starts the whiteboard automatically at{' '}
            <span className="font-mono">{agentUrl}</span>. If this persists, make sure Node.js is
            installed and the agent-whiteboard bundle is built (<span className="font-mono">pnpm build:all</span>).
          </p>
          <button
            onClick={() => {
              setUnreachable(false);
              setAutoReloads(0);
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
