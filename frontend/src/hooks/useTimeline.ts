import { useMemo } from 'react';
import { TranscriptSegmentData, ScreenshotData, ClipboardData, TimelineItem, TimelineFilter, TranscriptChunk } from '@/types';

export function useTimeline(
  segments: TranscriptSegmentData[],
  screenshots: ScreenshotData[],
  clipboardItems: ClipboardData[],
  filter: TimelineFilter,
): TimelineItem[] {
  return useMemo(() => {
    const items: TimelineItem[] = [];

    if (filter !== 'screenshots' && filter !== 'clipboard') {
      for (const seg of segments) {
        items.push({
          type: 'transcript',
          id: seg.id,
          recording_elapsed_secs: seg.timestamp,
          timestamp: formatSecsToTime(seg.timestamp),
          data: seg,
        });
      }
    }

    if (filter !== 'transcripts' && filter !== 'clipboard') {
      for (const ss of screenshots) {
        items.push({
          type: 'screenshot',
          id: ss.id,
          recording_elapsed_secs: ss.recording_elapsed_secs ?? 0,
          timestamp: ss.timestamp,
          data: ss,
        });
      }
    }

    if (filter !== 'transcripts' && filter !== 'screenshots') {
      for (const clip of clipboardItems) {
        items.push({
          type: 'clipboard',
          id: clip.id,
          recording_elapsed_secs: clip.recording_elapsed_secs ?? 0,
          timestamp: clip.timestamp,
          data: clip,
        });
      }
    }

    // Sort by recording elapsed time
    items.sort((a, b) => a.recording_elapsed_secs - b.recording_elapsed_secs);

    return items;
  }, [segments, screenshots, clipboardItems, filter]);
}

function formatSecsToTime(secs: number): string {
  const totalSeconds = Math.floor(secs);
  const minutes = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/**
 * Groups transcript segments into 5-minute chunks for the Claude context basket.
 */
const CHUNK_WINDOW_SECS = 300; // 5 minutes

export function useTranscriptChunks(segments: TranscriptSegmentData[]): TranscriptChunk[] {
  return useMemo(() => {
    if (segments.length === 0) return [];

    const chunks: TranscriptChunk[] = [];
    let chunkStart = 0;
    let chunkSegments: TranscriptSegmentData[] = [];

    for (const seg of segments) {
      const windowEnd = chunkStart + CHUNK_WINDOW_SECS;

      if (seg.timestamp >= windowEnd && chunkSegments.length > 0) {
        // Flush current chunk
        chunks.push(buildChunk(chunkSegments, chunkStart));
        chunkStart = Math.floor(seg.timestamp / CHUNK_WINDOW_SECS) * CHUNK_WINDOW_SECS;
        chunkSegments = [seg];
      } else {
        chunkSegments.push(seg);
      }
    }

    // Flush final chunk
    if (chunkSegments.length > 0) {
      chunks.push(buildChunk(chunkSegments, chunkStart));
    }

    return chunks;
  }, [segments]);
}

function buildChunk(segs: TranscriptSegmentData[], startSecs: number): TranscriptChunk {
  const endSecs = startSecs + CHUNK_WINDOW_SECS;
  const fullText = segs.map(s => s.text).join(' ');
  return {
    id: `chunk-${startSecs}-${endSecs}`,
    startSecs,
    endSecs,
    label: `${formatSecsToTime(startSecs)}–${formatSecsToTime(endSecs)}`,
    preview: fullText.slice(0, 60) + (fullText.length > 60 ? '...' : ''),
    fullText,
    segmentCount: segs.length,
  };
}
