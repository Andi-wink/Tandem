"use client";

import { Transcript, TranscriptSegmentData, ScreenshotData, ClipboardData, TimelineFilter } from '@/types';
import { TranscriptView } from '@/components/TranscriptView';
import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { ScreenshotLightbox } from '@/components/ScreenshotLightbox';
import { TranscriptChunks } from '@/components/TranscriptChunks';
import { TranscriptButtonGroup } from './TranscriptButtonGroup';
import { useCallback, useMemo, useState } from 'react';
import { useTimeline, useTranscriptChunks } from '@/hooks/useTimeline';
import { invoke } from '@tauri-apps/api/core';

interface TranscriptPanelProps {
  transcripts: Transcript[];
  customPrompt: string;
  onPromptChange: (value: string) => void;
  onCopyTranscript: () => void;
  onOpenMeetingFolder: () => Promise<void>;
  isRecording: boolean;
  disableAutoScroll?: boolean;

  // Optional pagination props (when using virtualization)
  usePagination?: boolean;
  segments?: TranscriptSegmentData[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;

  // Screenshot data from meeting folder
  screenshots?: ScreenshotData[];
  // Clipboard items from meeting folder
  clipboardItems?: ClipboardData[];
}

export function TranscriptPanel({
  transcripts,
  customPrompt,
  onPromptChange,
  onCopyTranscript,
  onOpenMeetingFolder,
  isRecording,
  disableAutoScroll = false,
  usePagination = false,
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
  screenshots = [],
  clipboardItems = [],
}: TranscriptPanelProps) {
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>('all');
  const [selectedScreenshot, setSelectedScreenshot] = useState<ScreenshotData | null>(null);

  // Convert transcripts to segments if pagination is not used but we want virtualization
  const convertedSegments = useMemo(() => {
    if (usePagination && segments) {
      return segments;
    }
    // Convert transcripts to segments for virtualization
    return transcripts.map(t => ({
      id: t.id,
      timestamp: t.audio_start_time ?? 0,
      endTime: t.audio_end_time,
      text: t.text,
      confidence: t.confidence,
      speaker_label: t.speaker_label,
    }));
  }, [transcripts, usePagination, segments]);

  // Build timeline items merging transcripts, screenshots, and clipboard items
  const timelineItems = useTimeline(convertedSegments, screenshots, clipboardItems, timelineFilter);
  const transcriptChunks = useTranscriptChunks(convertedSegments);

  // Handle inline transcript editing - persist to SQLite via Tauri command
  const handleSegmentEdit = useCallback((segmentId: string, newText: string) => {
    invoke('api_update_transcript_text', {
      transcriptId: segmentId,
      newText: newText,
    }).catch((err) => {
      console.error('Failed to update transcript text:', err);
    });
  }, []);

  const hasTimelineContent = screenshots.length > 0 || clipboardItems.length > 0;

  return (
    <div className="hidden md:flex md:w-1/4 lg:w-1/3 min-w-0 border-r border-border bg-background flex-col relative shrink-0">
      {/* Title area */}
      <div className="p-4 border-b border-border">
        <TranscriptButtonGroup
          transcriptCount={usePagination ? (totalCount ?? convertedSegments.length) : (transcripts?.length || 0)}
          onCopyTranscript={onCopyTranscript}
          onOpenMeetingFolder={onOpenMeetingFolder}
        />
      </div>

      {/* Transcript chunks for AI context basket */}
      <TranscriptChunks chunks={transcriptChunks} />

      {/* Transcript content - use virtualized view for better performance */}
      <div className="flex-1 overflow-hidden pb-4">
        <VirtualizedTranscriptView
          segments={convertedSegments}
          isRecording={isRecording}
          isPaused={false}
          isProcessing={false}
          isStopping={false}
          enableStreaming={false}
          showConfidence={true}
          disableAutoScroll={disableAutoScroll}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          totalCount={totalCount}
          loadedCount={loadedCount}
          onLoadMore={onLoadMore}
          // Timeline props (screenshots + clipboard)
          timelineItems={hasTimelineContent ? timelineItems : undefined}
          timelineFilter={timelineFilter}
          onTimelineFilterChange={hasTimelineContent ? setTimelineFilter : undefined}
          screenshotCount={screenshots.length}
          onScreenshotClick={setSelectedScreenshot}
          clipboardCount={clipboardItems.length}
          onSegmentEdit={handleSegmentEdit}
        />
      </div>

      {/* Custom prompt input at bottom of transcript section */}
      {!isRecording && convertedSegments.length > 0 && (
        <div className="p-1 border-t border-border">
          <textarea
            placeholder="Add context for AI summary. For example people involved, meeting overview, objective etc..."
            className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring bg-background text-foreground min-h-[80px] resize-y placeholder:text-muted-foreground"
            value={customPrompt}
            onChange={(e) => onPromptChange(e.target.value)}
          />
        </div>
      )}

      {/* Screenshot lightbox */}
      {selectedScreenshot && (
        <ScreenshotLightbox
          screenshot={selectedScreenshot}
          onClose={() => setSelectedScreenshot(null)}
        />
      )}
    </div>
  );
}
