import { useMemo } from 'react';
import { TranscriptSegmentData, ScreenshotData, TimelineItem, TimelineFilter } from '@/types';

export function useTimeline(
  segments: TranscriptSegmentData[],
  screenshots: ScreenshotData[],
  filter: TimelineFilter,
): TimelineItem[] {
  return useMemo(() => {
    const items: TimelineItem[] = [];

    if (filter !== 'screenshots') {
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

    if (filter !== 'transcripts') {
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

    // Sort by recording elapsed time
    items.sort((a, b) => a.recording_elapsed_secs - b.recording_elapsed_secs);

    return items;
  }, [segments, screenshots, filter]);
}

function formatSecsToTime(secs: number): string {
  const totalSeconds = Math.floor(secs);
  const minutes = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
