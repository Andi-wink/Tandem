'use client';

/**
 * MeetingNotesSection: read-only render of enhanced-notes.md on the meeting-details page.
 *
 * Appears only when the meeting has enhanced notes or saved jots (activation is jot-gated: no jots,
 * no section, zero layout impact). Renders the Markdown notes with any "[unverified]" quote markers
 * styled distinctly (the deterministic verifier is the trust backbone, so its verdict must be visible),
 * and offers a calm "Regenerate" that re-runs the same enhance pipeline from the saved jots.json.
 */

import React, { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';
import { invoke } from '@tauri-apps/api/core';
import { RefreshCw, Sparkles } from 'lucide-react';
import type { Transcript, PaginatedTranscriptsResponse } from '@/types';
import { parseJotsFile } from '@/lib/meetingJots';
import { runEnhanceNotes, resetEnhanceNotes, ENHANCED_NOTES_FILENAME } from '@/lib/enhanceNotes';
import { collectAllTranscripts, TRANSCRIPT_PAGE_SIZE } from '@/lib/collectAllTranscripts';

interface MeetingNotesSectionProps {
  meetingId: string;
  folderPath?: string | null;
  provider: string | null;
  model: string | null;
  apiKey: string | null;
  serverAddress: string;
}

const UNVERIFIED = '[unverified]';

/**
 * Load the COMPLETE transcript for a meeting, page by page, by feeding the Tauri command into the pure
 * `collectAllTranscripts` loop (which owns has_more/offset handling and is unit-tested separately).
 */
async function loadAllTranscripts(meetingId: string): Promise<Transcript[]> {
  return collectAllTranscripts(
    (limit, offset) =>
      invoke<PaginatedTranscriptsResponse>('api_get_meeting_transcripts', { meetingId, limit, offset }),
    TRANSCRIPT_PAGE_SIZE,
  );
}

/** Split any direct string children on the [unverified] marker and wrap each hit in a distinct badge. */
function decorate(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (typeof child !== 'string' || !child.includes(UNVERIFIED)) return child;
    const parts = child.split(UNVERIFIED);
    const out: React.ReactNode[] = [];
    parts.forEach((part, i) => {
      if (part) out.push(part);
      if (i < parts.length - 1) {
        out.push(
          <span
            key={`uv-${i}`}
            data-testid="unverified-marker"
            title="This quote could not be matched against the transcript"
            className="inline-flex items-center rounded border border-destructive/40 bg-destructive/10 px-1 py-0.5 mx-0.5 text-caption font-medium text-destructive align-baseline"
          >
            unverified
          </span>,
        );
      }
    });
    return out;
  });
}

function joinPath(dir: string, file: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${sep}${file}`;
}

export function MeetingNotesSection({
  meetingId,
  folderPath,
  provider,
  model,
  apiKey,
  serverAddress,
}: MeetingNotesSectionProps) {
  const [notes, setNotes] = useState<string | null>(null);
  const [hasJots, setHasJots] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);

  const reload = useCallback(async () => {
    if (!folderPath) { setLoaded(true); return; }
    try {
      const md = await invoke<string | null>('read_file_if_exists', {
        path: joinPath(folderPath, ENHANCED_NOTES_FILENAME),
      });
      setNotes(md && md.trim() ? md : null);
    } catch {
      setNotes(null);
    }
    try {
      const jotsRaw = await invoke<string | null>('read_file_if_exists', {
        path: joinPath(folderPath, 'jots.json'),
      });
      setHasJots(parseJotsFile(jotsRaw).length > 0);
    } catch {
      setHasJots(false);
    }
    setLoaded(true);
  }, [folderPath]);

  useEffect(() => { void reload(); }, [reload]);

  // Reload when the stop-path enhance pass (or another tab) finishes writing notes for this meeting.
  useEffect(() => {
    const onUpdated = (e: Event) => {
      const detail = (e as CustomEvent).detail as { meetingId?: string } | undefined;
      if (detail?.meetingId === meetingId) void reload();
    };
    window.addEventListener('tandem:notes-updated', onUpdated);
    return () => window.removeEventListener('tandem:notes-updated', onUpdated);
  }, [meetingId, reload]);

  const handleRegenerate = useCallback(async () => {
    if (!folderPath || !provider) return;
    setIsRegenerating(true);
    try {
      const jotsRaw = await invoke<string | null>('read_file_if_exists', {
        path: joinPath(folderPath, 'jots.json'),
      });
      const jots = parseJotsFile(jotsRaw);
      if (!jots.length) return;

      // Build the prompt and run the verifier from the COMPLETE transcript, not the paginated subset
      // the page renders. Without this a jot flagged past the first page verifies as "(none captured)".
      let fullTranscripts: Transcript[];
      try {
        fullTranscripts = await loadAllTranscripts(meetingId);
      } catch (err) {
        toast.error('Could not load the full transcript', {
          description: `${err instanceof Error ? err.message : String(err)} Regenerate needs the whole call to ground your notes.`,
        });
        return;
      }

      resetEnhanceNotes(meetingId);
      await runEnhanceNotes({
        meetingId,
        jots,
        transcripts: fullTranscripts,
        provider,
        model: model || '',
        apiKey,
        serverAddress,
        resolveFolderPath: async () => folderPath,
        source: 'regenerate',
      });
      await reload();
    } finally {
      setIsRegenerating(false);
    }
  }, [folderPath, provider, model, apiKey, serverAddress, meetingId, reload]);

  // Invisible until we know there is something to show (no jots -> no section).
  if (!loaded) return null;
  if (!notes && !hasJots) return null;

  return (
    <section
      className="border-b border-border bg-muted/30 px-6 py-4"
      data-testid="meeting-notes-section"
    >
      <div className="flex items-center justify-between mb-2">
        <h2 className="flex items-center gap-2 text-body font-semibold text-foreground">
          <Sparkles className="w-4 h-4 text-primary" />
          Notes
        </h2>
        {hasJots && provider && (
          <button
            type="button"
            onClick={handleRegenerate}
            disabled={isRegenerating}
            data-testid="regenerate-notes"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-small text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRegenerating ? 'animate-spin' : ''}`} />
            {isRegenerating ? 'Enhancing...' : 'Regenerate'}
          </button>
        )}
      </div>

      {notes ? (
        <div
          className="max-w-[70ch] text-body text-foreground tabular-nums [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-1.5 [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-2 [&_li]:my-0.5 [&_p]:my-2 [&_p]:leading-relaxed"
          data-testid="notes-markdown"
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => <p>{decorate(children)}</p>,
              li: ({ children }) => <li>{decorate(children)}</li>,
              td: ({ children }) => <td>{decorate(children)}</td>,
              blockquote: ({ children }) => (
                <blockquote className="border-l-2 border-border pl-3 italic text-muted-foreground my-2">
                  {decorate(children)}
                </blockquote>
              ),
            }}
          >
            {notes}
          </ReactMarkdown>
        </div>
      ) : (
        <p className="text-small text-muted-foreground">
          You jotted notes during this call. Regenerate to weave them into the transcript.
        </p>
      )}
    </section>
  );
}
