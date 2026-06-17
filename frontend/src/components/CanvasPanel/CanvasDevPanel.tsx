'use client';

/**
 * CanvasDevPanel — a small floating control to drive the voice-canvas by hand.
 *
 * This is the Phase 2 manual harness (and a permanent escape hatch): open the canvas window and type
 * an instruction; the agent in the canvas window draws it. Because the kit is scene-aware, follow-up
 * edits ("make that heading red", "add a retry step") work too — just send another instruction.
 *
 * Lives bottom-left so it clears the bottom-center toaster and the right-hand AI panel.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, X, Send, Monitor, EyeOff, Wifi, WifiOff } from 'lucide-react';
import { useCanvas } from '@/contexts/CanvasContext';

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function CanvasDevPanel() {
  const {
    isOpen,
    isHealthy,
    status,
    lastError,
    agentUrl,
    setAgentUrl,
    openCanvas,
    hideCanvas,
    sendPrompt,
    checkHealth,
  } = useCanvas();

  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  // Probe agent health when the panel is opened.
  useEffect(() => {
    if (open) void checkHealth();
  }, [open, checkHealth]);

  const send = useCallback(async () => {
    const ok = await sendPrompt(text);
    if (ok) setText('');
  }, [sendPrompt, text]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void send();
      }
    },
    [send],
  );

  // Only meaningful inside the Tauri shell.
  if (!inTauri()) return null;

  const busy = status === 'sending';

  return (
    <div className="fixed bottom-4 left-4 z-[1000] flex flex-col items-start gap-2">
      {open && (
        <div className="w-80 rounded-xl border border-border bg-background/95 p-3 shadow-2xl backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-small font-semibold text-foreground">Canvas</span>
            <div className="flex items-center gap-2">
              <span
                className="flex items-center gap-1 text-caption text-muted-foreground"
                title={agentUrl}
              >
                {isHealthy === null ? null : isHealthy ? (
                  <Wifi className="h-3 w-3 text-green-500" />
                ) : (
                  <WifiOff className="h-3 w-3 text-destructive" />
                )}
                {isHealthy === false ? 'agent offline' : isHealthy ? 'agent live' : ''}
              </span>
              <button
                aria-label="Close canvas panel"
                onClick={() => setOpen(false)}
                className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <textarea
            ref={textRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
            placeholder="Tell the canvas what to draw or change…  (⌘/Ctrl+Enter to send)"
            className="w-full resize-none rounded-lg border border-border bg-muted/40 px-3 py-2 text-small text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          />

          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={send}
              disabled={busy || !text.trim()}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-small font-semibold text-primary-foreground transition disabled:pointer-events-none disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              {busy ? 'Sending…' : 'Send'}
            </button>
            <button
              onClick={() => (isOpen ? void hideCanvas() : void openCanvas())}
              title={isOpen ? 'Hide canvas window' : 'Open canvas window'}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-small font-medium text-foreground hover:bg-muted"
            >
              {isOpen ? <EyeOff className="h-3.5 w-3.5" /> : <Monitor className="h-3.5 w-3.5" />}
              {isOpen ? 'Hide' : 'Open'}
            </button>
          </div>

          {status === 'sent' && (
            <p className="mt-2 text-caption text-green-500">Sent to canvas.</p>
          )}
          {status === 'error' && (
            <p className="mt-2 text-caption text-destructive">
              {lastError || 'Could not reach the canvas.'}
            </p>
          )}

          <button
            onClick={() => setShowSettings((v) => !v)}
            className="mt-2 text-caption text-muted-foreground hover:text-foreground"
          >
            {showSettings ? 'Hide settings' : 'Settings'}
          </button>
          {showSettings && (
            <div className="mt-1.5">
              <label className="text-caption text-muted-foreground">Agent app URL</label>
              <input
                value={agentUrl}
                onChange={(e) => setAgentUrl(e.target.value)}
                onBlur={() => void checkHealth()}
                className="mt-1 w-full rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-caption text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          )}
        </div>
      )}

      <button
        aria-label={open ? 'Close canvas controls' : 'Open canvas controls'}
        onClick={() => setOpen((v) => !v)}
        title="Canvas"
        className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-lg transition hover:bg-muted"
      >
        {open ? <X className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
      </button>
    </div>
  );
}

export default CanvasDevPanel;
