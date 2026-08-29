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
import { buildHandoverTimeline, collectLinks, generateHandoverMarkdown } from '@/lib/handoverDoc';

export const HANDOVER_FILENAME = 'HANDOVER.md';

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
        const jots = await readJots(folderPath);
        const timeline = buildHandoverTimeline(transcripts, screenshots, clipboardItems, jots);
        const markdown = generateHandoverMarkdown({
          meetingName,
          date: date || new Date().toISOString(),
          durationSeconds: durationFromTranscripts(transcripts),
          timeline,
          links: collectLinks(timeline),
          folderPath,
        });

        const filePath = joinPath(folderPath, HANDOVER_FILENAME);
        await invoke('save_transcript', { filePath, content: markdown });

        const counts = { speech: 0, note: 0, screenshot: 0, clipboard: 0 } as Record<string, number>;
        for (const item of timeline) counts[item.type]++;

        toast.success('Handover document saved', {
          description:
            `${HANDOVER_FILENAME}: ${counts.speech} transcript segments, ${counts.note} notes, ` +
            `${counts.screenshot} screenshots, ${counts.clipboard} clipboard items.`,
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
    [],
  );

  return { generateHandover, isGenerating };
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
