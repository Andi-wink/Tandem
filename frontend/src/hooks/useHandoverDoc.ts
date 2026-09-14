'use client';

/**
 * Generates the handover document for a finished call and writes it into the meeting folder.
 *
 * The caller supplies the captured streams because meeting-details has already loaded them from the
 * meeting folder (usePaginatedTranscripts reads screenshots.json and clipboard.json alongside the
 * transcript). Reloading them here would duplicate that work and risk the two views disagreeing.
 *
 * Typed notes are not a separate stream: they ride inside the transcript marked `source: 'note'`
 * (lib/transcriptNotes). That is what makes Solo mode work, since Solo files typed lines straight into
 * the transcript and has no note store at all. Meeting mode's jot store is the one thing nothing else
 * loads, so jots.json is read here.
 */

import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Transcript, ScreenshotData, ClipboardData } from '@/types';
import type { Jot, JotsFile } from '@/lib/meetingJots';
import {
  buildHandoverTimeline,
  collectLinks,
  generateHandoverMarkdown,
  type HandoverItem,
  type HandoverWhiteboard,
} from '@/lib/handoverDoc';
import { generateHandoverHtml } from '@/lib/handoverHtml';
import { useCanvas } from '@/contexts/CanvasContext';
import { writeBoardArtifacts, WHITEBOARD_FILE } from '@/hooks/useWhiteboardPersistence';
import { countShapes } from '@/lib/whiteboardSnapshot';

export const HANDOVER_FILENAME = 'HANDOVER.md';
export const HANDOVER_HTML_FILENAME = 'HANDOVER.html';

export interface GenerateHandoverArgs {
  meetingId: string;
  meetingName: string;
  folderPath: string | null | undefined;
  /** Meeting date (ISO, or anything Date parses). Falls back to now. */
  date?: string | null;
  transcripts: Transcript[];
  screenshots?: ScreenshotData[];
  clipboardItems?: ClipboardData[];
}

export interface UseHandoverDocReturn {
  /** Resolves with the written path, or null when it could not be written. */
  generateHandover: (args: GenerateHandoverArgs) => Promise<string | null>;
  isGenerating: boolean;
}

/** Join a folder and filename using whichever separator the folder already uses. */
export function joinPath(folder: string, name: string): string {
  const sep = folder.includes('\\') ? '\\' : '/';
  return `${folder.replace(/[\\/]+$/, '')}${sep}${name}`;
}

/** Longest transcript end time: the closest thing to a duration available without the audio file. */
function durationFromTranscripts(transcripts: Transcript[]): number | null {
  let max = 0;
  for (const t of transcripts) {
    const end = t.audio_end_time ?? t.audio_start_time ?? 0;
    if (Number.isFinite(end) && end > max) max = end;
  }
  return max > 0 ? max : null;
}

export function useHandoverDoc(): UseHandoverDocReturn {
  const [isGenerating, setIsGenerating] = useState(false);
  // The board is read from disk, but it is only written on canvas close / recording stop / quit. If
  // the canvas is still open when the user generates the handover, the newest strokes are only in the
  // iframe, so we ask it to save first. When the canvas isn't mounted (the usual meeting-details case)
  // this reports not-ready and we simply use what is already on disk.
  const { canvasReady, boardReadOnly, saveSnapshot } = useCanvas();

  const generateHandover = useCallback(
    async ({
      meetingId,
      meetingName,
      folderPath,
      date,
      transcripts,
      screenshots = [],
      clipboardItems = [],
    }: GenerateHandoverArgs): Promise<string | null> => {
      if (!folderPath) {
        toast.error('No meeting folder', {
          description: 'This meeting has no folder on disk, so the handover document cannot be saved.',
        });
        return null;
      }

      setIsGenerating(true);
      try {
        // Best effort, never blocking: a board that can't be reached just leaves the on-disk copy.
        if (canvasReady && !boardReadOnly) {
          try {
            const result = await saveSnapshot();
            if (result?.snapshot && countShapes(result.snapshot) > 0) {
              await writeBoardArtifacts(folderPath, 'whiteboard', result);
            }
          } catch (err) {
            console.debug('[handover] Could not refresh the whiteboard before export:', err);
          }
        }

        const jots = await readJots(folderPath);
        const whiteboard = await readWhiteboard(folderPath);
        const timeline = buildHandoverTimeline(transcripts, screenshots, clipboardItems, jots);
        const data = {
          meetingName,
          date: date || new Date().toISOString(),
          durationSeconds: durationFromTranscripts(transcripts),
          timeline,
          links: collectLinks(timeline),
          folderPath,
          whiteboard: whiteboard?.whiteboard,
        };

        // Markdown references its images relatively, so it renders wherever it sits next to the
        // meeting folder's screenshots/ directory and stays small and diff-friendly.
        const filePath = joinPath(folderPath, HANDOVER_FILENAME);
        await invoke('save_transcript', { filePath, content: generateHandoverMarkdown(data) });

        // HTML inlines the images instead, so the single file can be sent to someone else and still
        // render, and prints to a clean PDF. Failing to build it must not lose the markdown, which is
        // already written above.
        try {
          const images = await embedImages(timeline);
          // The board PNG was already read while deciding whether the board exists at all, so it is
          // reused here rather than embedded a second time.
          if (whiteboard) images.set(whiteboard.whiteboard.pngPath, whiteboard.dataUri);
          await invoke('save_transcript', {
            filePath: joinPath(folderPath, HANDOVER_HTML_FILENAME),
            content: generateHandoverHtml(data, images),
          });
        } catch (htmlErr) {
          console.error('[handover] Markdown written but the HTML export failed:', htmlErr);
          toast.warning('Saved the markdown, but not the readable HTML', {
            description: 'HANDOVER.md is in the meeting folder. The HTML version could not be built.',
          });
        }

        const counts = { speech: 0, note: 0, screenshot: 0, clipboard: 0 } as Record<string, number>;
        for (const item of timeline) counts[item.type]++;

        toast.success('Handover document saved', {
          description:
            `${counts.speech} transcript segments, ${counts.note} notes, ${counts.screenshot} screenshots, ` +
            `${counts.clipboard} clipboard items${whiteboard ? ', 1 whiteboard' : ''}. ` +
            `Saved as ${HANDOVER_FILENAME} and ` +
            `${HANDOVER_HTML_FILENAME} (open the HTML and print to PDF).`,
          action: {
            label: 'Open folder',
            onClick: () => {
              void invoke('open_meeting_folder', { meetingId }).catch((err) => {
                console.error('[handover] Failed to open meeting folder:', err);
              });
            },
          },
          duration: 8000,
        });

        return filePath;
      } catch (error) {
        console.error('[handover] Failed to generate handover document:', error);
        toast.error('Could not create the handover document', {
          description: error instanceof Error ? error.message : String(error),
        });
        return null;
      } finally {
        setIsGenerating(false);
      }
    },
    [canvasReady, boardReadOnly, saveSnapshot],
  );

  return { generateHandover, isGenerating };
}

/**
 * Resolve every image in the timeline to a data URI, scaled down for embedding by the Rust side.
 *
 * One image failing (deleted file, unreadable format) must not cost the whole export, so failures are
 * simply left out of the map and render as a visible placeholder in the document.
 */
async function embedImages(timeline: HandoverItem[]): Promise<Map<string, string>> {
  const paths = [
    ...new Set(
      timeline
        .filter(i => i.type === 'screenshot' || (i.type === 'clipboard' && i.contentType === 'image'))
        .map(i => i.filePath)
        .filter((p): p is string => !!p),
    ),
  ];

  const entries = await Promise.all(
    paths.map(async (filePath): Promise<[string, string] | null> => {
      try {
        const dataUri = await invoke<string>('screenshot_embed_data_uri', { filePath });
        return [filePath, dataUri];
      } catch (err) {
        console.warn('[handover] Could not embed image, leaving a placeholder:', filePath, err);
        return null;
      }
    }),
  );

  return new Map(entries.filter((e): e is [string, string] => e !== null));
}

/**
 * Read the meeting's saved whiteboard, and decide whether it is worth putting in the document.
 *
 * Two things must both hold: the snapshot contains at least one shape (the board is written on every
 * canvas close, so an untouched board still has a file), and the PNG render is actually readable
 * (a section promising a picture that can't be shown is worse than no section). The data URI is
 * returned alongside so the HTML export doesn't have to re-read the same image.
 */
async function readWhiteboard(
  folderPath: string,
): Promise<{ whiteboard: HandoverWhiteboard; dataUri: string } | null> {
  try {
    const raw = await invoke<string | null>('read_file_if_exists', {
      path: joinPath(folderPath, WHITEBOARD_FILE),
    });
    if (!raw) return null;

    const shapeCount = countShapes(JSON.parse(raw));
    if (shapeCount === 0) return null;

    const pngPath = joinPath(folderPath, 'whiteboard.png');
    const dataUri = await invoke<string>('screenshot_embed_data_uri', { filePath: pngPath });

    const text = await invoke<string | null>('read_file_if_exists', {
      path: joinPath(folderPath, 'whiteboard.md'),
    }).catch(() => null);

    return { whiteboard: { pngPath, shapeCount, text: text ?? undefined }, dataUri };
  } catch (err) {
    console.debug('[handover] No usable whiteboard for this meeting:', err);
    return null;
  }
}

/**
 * Read jots.json if the meeting has one. Meeting mode writes it on stop; Solo never does, so a missing
 * file is the normal case and must not read as a failure.
 */
async function readJots(folderPath: string): Promise<Jot[]> {
  try {
    const raw = await invoke<string | null>('read_file_if_exists', {
      path: joinPath(folderPath, 'jots.json'),
    });
    if (!raw) return [];
    const parsed = JSON.parse(raw) as JotsFile;
    return Array.isArray(parsed?.jots) ? parsed.jots : [];
  } catch (err) {
    console.warn('[handover] Could not read jots.json, continuing without it:', err);
    return [];
  }
}
