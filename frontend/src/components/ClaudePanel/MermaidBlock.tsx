import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, Download, Copy, Check, Maximize2, ExternalLink } from 'lucide-react';
import { Lightbox } from './Lightbox';
import { invoke } from '@tauri-apps/api/core';
import { tempDir } from '@tauri-apps/api/path';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';

let mermaidInitialized = false;

function ensureMermaidInit(isDark: boolean) {
  const theme = isDark ? 'dark' : 'default';
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      theme,
      flowchart: { curve: 'basis', padding: 16 },
      sequence: { actorMargin: 50, noteMargin: 10, messageMargin: 35, useMaxWidth: true },
      themeVariables: { fontSize: '14px' },
    });
    mermaidInitialized = true;
  }
}

let mermaidCounter = 0;

interface MermaidBlockProps {
  code: string;
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showLightbox, setShowLightbox] = useState(false);

  const [isDark, setIsDark] = useState(() =>
    typeof document !== 'undefined'
      ? document.documentElement.classList.contains('dark')
      : false
  );

  // Keep isDark in sync with the actual <html> class — prevents stale reads during re-renders
  // that could cause unnecessary mermaid re-renders and visual flickering
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      try {
        ensureMermaidInit(isDark);
        const id = `mermaid-${Date.now()}-${mermaidCounter++}`;
        const { svg: rendered } = await mermaid.render(id, code.trim());
        if (!cancelled) {
          setSvg(DOMPurify.sanitize(rendered, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['foreignObject'] }));
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Mermaid render failed');
        }
      }
    }

    render();
    return () => { cancelled = true; };
  }, [code, isDark]);

  const handleOpenInBrowser = async () => {
    if (!svg) return;
    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${title}</title>
<style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f8fafc;font-family:system-ui}
svg{max-width:95vw;max-height:95vh}</style></head>
<body>${svg}</body></html>`;
    try {
      const dir = await tempDir();
      const filePath = `${dir}tandem-diagram-${Date.now()}.html`;
      await writeTextFile(filePath, html);
      await invoke('open_external_url', { url: filePath });
    } catch {
      // Fallback: open as data URI
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    }
  };

  const handleCopyCode = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadPng = async () => {
    if (!svg) return;
    // Render SVG to canvas then export as PNG
    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const scale = 2; // 2x for retina
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          if (blob) {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `diagram-${Date.now()}.png`;
            a.click();
            URL.revokeObjectURL(a.href);
          }
        }, 'image/png');
      }
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  // Derive a title from the first line of the mermaid code
  const firstLine = code.trim().split('\n')[0] || 'diagram';
  const diagramType = firstLine.replace(/[-_]/g, ' ').split(/\s+/)[0] || 'Diagram';
  const title = diagramType.charAt(0).toUpperCase() + diagramType.slice(1) + ' Diagram';

  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <>
      <div className="my-2 border border-border rounded-lg overflow-hidden">
        {/* Header */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-full flex items-center gap-1.5 px-3 py-2 bg-muted hover:bg-accent text-left"
        >
          <Chevron className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          <svg className="w-3.5 h-3.5 text-success flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3h7v7H3zM14 3h7v7h-7zM8.5 14l5-4 5 4M14 14v7" />
          </svg>
          <span className="text-xs font-medium text-foreground truncate">{title}</span>
          <span className="text-xs text-muted-foreground ml-auto flex-shrink-0">Mermaid</span>
        </button>

        {!collapsed && (
          <div className="border-t border-border">
            {/* SVG render */}
            {svg && !error ? (
              <div
                ref={containerRef}
                className="p-3 bg-background overflow-x-auto cursor-zoom-in"
                onClick={() => setShowLightbox(true)}
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            ) : error ? (
              <div className="p-3 text-xs text-destructive">
                <p className="font-medium mb-1">Mermaid render error:</p>
                <pre className="whitespace-pre-wrap text-muted-foreground">{error}</pre>
                <pre className="mt-2 whitespace-pre-wrap text-muted-foreground bg-muted p-2 rounded text-[11px]">{code}</pre>
              </div>
            ) : (
              <div className="p-3 text-xs text-muted-foreground text-center">Rendering diagram...</div>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-1 px-2 py-1.5 bg-muted border-t border-border">
              {svg && (
                <>
                  <button
                    onClick={handleDownloadPng}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent transition-colors"
                  >
                    <Download className="w-3 h-3" />
                    PNG
                  </button>
                  <button
                    onClick={() => setShowLightbox(true)}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent transition-colors"
                  >
                    <Maximize2 className="w-3 h-3" />
                    Expand
                  </button>
                  <button
                    onClick={handleOpenInBrowser}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent transition-colors"
                    title="Open diagram full-screen in your browser"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Browser
                  </button>
                </>
              )}
              <button
                onClick={handleCopyCode}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent transition-colors ml-auto"
                title="Copy Mermaid source"
              >
                {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                {copied ? 'Copied' : 'Source'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Lightbox */}
      {showLightbox && svg && (
        <Lightbox onClose={() => setShowLightbox(false)}>
          <div
            className="max-w-[90vw] max-h-[90vh] overflow-auto bg-background rounded-lg shadow-2xl p-6"
            onClick={(e) => e.stopPropagation()}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </Lightbox>
      )}
    </>
  );
}
