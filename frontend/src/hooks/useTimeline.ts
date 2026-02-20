import { useMemo } from 'react';
import { TranscriptSegmentData, ScreenshotData, ClipboardData, TimelineItem, TimelineFilter } from '@/types';

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
