import React, { useState } from 'react';
import { ChevronRight, ChevronDown, Download, ExternalLink, Image, Copy, Check, X } from 'lucide-react';
import { ClaudeToolCall } from '@/contexts/ClaudeContext';
import { convertFileSrc } from '@tauri-apps/api/core';

/**
 * DiagramBlock — renders Excalidraw diagram results in the AI chat panel.
 *
 * Detects two patterns in tool call outputs:
 * 1. A Bash tool result referencing a rendered PNG (from render_excalidraw.py)
 * 2. A Write tool result referencing an .excalidraw file
 *
 * Shows the rendered PNG inline with download + open-in-excalidraw buttons.
 * Click the image to view it full-screen in a lightbox.
 */

/**
 * Normalize JSON-escaped backslashes in file paths.
 * Tool inputs come through as serialized JSON, so paths may have \\\\ instead of \\.
 */
function normalizePath(p: string): string {
  return p.replace(/\\\\/g, '\\');
}

/**
 * Extract a file path with the given extension from a string.
 * Tries JSON parse first (tool inputs are serialized JSON dicts), then regex.
 * Handles paths with spaces (common in meeting folder names).
 */
function extractPathByExtension(text: string, ext: string): string | null {
  // Strategy 1: Parse as JSON and look for file_path / file
  try {
    const parsed = JSON.parse(text);
    const candidate = parsed.file_path || parsed.file || parsed.path || '';
    if (typeof candidate === 'string' && candidate.endsWith(ext)) {
      return normalizePath(candidate);
    }
  } catch { /* not JSON, fall through */ }

  // Strategy 2: Match path inside double quotes (handles spaces in path)
  const escapedExt = ext.replace('.', '\\.');
  const quotedRe = new RegExp(`"([^"]+${escapedExt})"`, 'i');
  const quotedMatch = text.match(quotedRe);
  if (quotedMatch) return normalizePath(quotedMatch[1]);

  // Strategy 3: Unquoted path (no spaces — legacy fallback)
  const unquotedRe = new RegExp(`([A-Za-z]:\\\\[^\\s"']+${escapedExt}|\\/[^\\s"']+${escapedExt})`, 'i');
  const unquotedMatch = text.match(unquotedRe);
  if (unquotedMatch) return normalizePath(unquotedMatch[1]);

  return null;
}

/** Extract a file path ending in .png from a tool output string */
function extractPngPath(output: string): string | null {
  // Match "Rendered: <path>" from render_excalidraw.py — path may contain spaces
  const renderedMatch = output.match(/Rendered:\s*"?([^"\n]+\.png)"?/i);
  if (renderedMatch) return normalizePath(renderedMatch[1].trim());

  return extractPathByExtension(output, '.png');
}

/** Extract an .excalidraw file path from a string */
function extractExcalidrawPath(text: string): string | null {
  return extractPathByExtension(text, '.excalidraw');
}

/** Check if a tool call is diagram-related (render script or excalidraw file write) */
export function isDiagramToolCall(call: ClaudeToolCall): boolean {
  const output = call.output || '';
  const input = call.input || '';

  // Bash: render_excalidraw.py output containing a PNG path
  if (call.name === 'Bash' && (
    output.includes('Rendered:') ||
    input.includes('render_excalidraw') ||
    (output.includes('.png') && input.includes('.excalidraw'))
  )) {
    return true;
  }

  // Write: creating an .excalidraw file
  if (call.name === 'Write' && input.includes('.excalidraw') && !output.includes('Error')) {
    return true;
  }

  return false;
}

export function DiagramBlock({ call }: { call: ClaudeToolCall }) {
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [showLightbox, setShowLightbox] = useState(false);

  const output = call.output || '';
  const input = call.input || '';

  const pngPath = extractPngPath(output);
  const excalidrawPath = extractExcalidrawPath(input) || extractExcalidrawPath(output);

  // Convert local file path to Tauri asset URL for rendering
  const pngSrc = pngPath ? convertFileSrc(pngPath) : null;

  const Chevron = collapsed ? ChevronRight : ChevronDown;

  const handleCopyPath = async () => {
    const pathToCopy = pngPath || excalidrawPath || '';
    if (pathToCopy) {
      await navigator.clipboard.writeText(pathToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Derive a title from the excalidraw file name
  const fileName = (excalidrawPath || pngPath || 'diagram')
    .split(/[/\\]/).pop()?.replace(/\.(excalidraw|png)$/, '') || 'Diagram';
  const title = fileName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return (
    <>
      <div className="my-2 border border-border rounded-lg overflow-hidden">
        {/* Header */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-full flex items-center gap-1.5 px-3 py-2 bg-muted hover:bg-accent text-left"
        >
          <Chevron className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          <Image className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
          <span className="text-xs font-medium text-foreground truncate">{title}</span>
          <span className="text-xs text-muted-foreground ml-auto flex-shrink-0">Excalidraw</span>
        </button>

        {!collapsed && (
          <div className="border-t border-border">
            {/* PNG Image */}
            {pngSrc && !imgError ? (
              <div className="p-2 bg-white dark:bg-zinc-900">
                <img
                  src={pngSrc}
                  alt={title}
                  className="w-full h-auto rounded cursor-zoom-in hover:opacity-90 transition-opacity"
                  onClick={() => setShowLightbox(true)}
                  onError={() => setImgError(true)}
                />
              </div>
            ) : pngPath && imgError ? (
              <div className="p-3 text-xs text-muted-foreground text-center">
                Could not load image. File: {pngPath}
              </div>
            ) : (
              <div className="p-3 text-xs text-muted-foreground text-center">
                Diagram written to: {excalidrawPath || 'unknown path'}
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-1 px-2 py-1.5 bg-muted border-t border-border">
              {pngPath && (
                <a
                  href={pngSrc || '#'}
                  download={pngPath.split(/[/\\]/).pop()}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent transition-colors"
                >
                  <Download className="w-3 h-3" />
                  PNG
                </a>
              )}
              {excalidrawPath && (
                <a
                  href={`https://excalidraw.com`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent transition-colors"
                  title="Open excalidraw.com and import the .excalidraw file"
                >
                  <ExternalLink className="w-3 h-3" />
                  Open in Excalidraw
                </a>
              )}
              <button
                onClick={handleCopyPath}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent transition-colors ml-auto"
                title="Copy file path"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                {copied ? 'Copied' : 'Path'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Lightbox overlay for full-screen image viewing */}
      {showLightbox && pngSrc && (
        <div
          className="fixed inset-0 z-[100] bg-black/85 flex items-center justify-center cursor-zoom-out"
          onClick={() => setShowLightbox(false)}
        >
          <img
            src={pngSrc}
            alt={title}
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setShowLightbox(false)}
            className="absolute top-4 right-4 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
            title="Close (Escape)"
          >
            <X className="w-5 h-5" />
          </button>
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/60 text-xs">
            Click outside to close
          </div>
        </div>
      )}
    </>
  );
}
