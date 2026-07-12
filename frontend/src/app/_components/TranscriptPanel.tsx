import { useCallback, useState } from 'react';
import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { PermissionWarning } from '@/components/PermissionWarning';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Copy, GlobeIcon, Camera, PenLine, Clipboard } from 'lucide-react';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useConfig } from '@/contexts/ConfigContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useScreenshots } from '@/contexts/ScreenshotContext';
import { useClipboard } from '@/contexts/ClipboardContext';
import { usePermissionCheck } from '@/hooks/usePermissionCheck';
import { useTimeline, useTranscriptChunks } from '@/hooks/useTimeline';
import { ModalType } from '@/hooks/useModalState';
import { useIsLinux } from '@/hooks/usePlatform';
import { useMemo } from 'react';
import { TimelineFilter, ScreenshotData } from '@/types';
import { ScreenshotLightbox } from '@/components/ScreenshotLightbox';
import { TranscriptChunks } from '@/components/TranscriptChunks';
import { RegionSelectOverlay } from '@/components/RegionSelectOverlay';
import { TodayAgenda } from '@/components/TodayAgenda';

/**
 * TranscriptPanel Component
 *
 * Displays transcript content with controls for copying and language settings.
 * Uses TranscriptContext, ConfigContext, and RecordingStateContext internally.
 */

interface TranscriptPanelProps {
  // indicates stop-processing state for transcripts; derived from backend statuses.
  isProcessingStop: boolean;
  isStopping: boolean;
  showModal: (name: ModalType, message?: string) => void;
}

export function TranscriptPanel({
  isProcessingStop,
  isStopping,
  showModal
}: TranscriptPanelProps) {
  // Contexts
  const { transcripts, transcriptContainerRef, copyTranscript, updateTranscriptText } = useTranscripts();
  const { transcriptModelConfig } = useConfig();
  const { isRecording, isPaused } = useRecordingState();
  const { checkPermissions, isChecking, hasSystemAudio, hasMicrophone } = usePermissionCheck();
  const {
    screenshots,
    selectedScreenshot,
    isRegionSelecting,
    regionSelectInfo,
    annotateAfterSelect,
    captureRegion,
    captureAnnotatedRegion,
    startRegionSelect,
    cancelRegionSelect,
    openLightbox,
    closeLightbox,
  } = useScreenshots();
  const { clipboardItems, captureClipboard } = useClipboard();
  const isLinux = useIsLinux();

  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>('all');

  // Convert transcripts to segments for virtualized view
  const segments = useMemo(() =>
    transcripts.map(t => ({
      id: t.id,
      timestamp: t.audio_start_time ?? 0,
      endTime: t.audio_end_time,
      text: t.text,
      confidence: t.confidence,
    })),
    [transcripts]
  );

  // Merge into timeline when screenshots or clipboard items exist
  const timelineItems = useTimeline(segments, screenshots, clipboardItems, timelineFilter);
  const transcriptChunks = useTranscriptChunks(segments);
  const hasTimelineContent = screenshots.length > 0 || clipboardItems.length > 0;

  const handleScreenshotClick = (screenshot: ScreenshotData) => {
    openLightbox(screenshot);
  };

  // Handle inline transcript editing during live recording
  const handleSegmentEdit = useCallback((segmentId: string, newText: string) => {
    // Find the original transcript to get its id from TranscriptContext
    const originalTranscript = transcripts.find(t => t.id === segmentId);
    if (originalTranscript) {
      updateTranscriptText(originalTranscript.id, newText);
    }
  }, [transcripts, updateTranscriptText]);

  return (
    <div ref={transcriptContainerRef} className="w-full border-r border-border bg-background flex flex-col overflow-y-auto">
      {/* Title area - Sticky header */}
      <div className="sticky top-0 z-10 bg-background p-4 border-border">
        <div className="flex flex-col space-y-3">
          <div className="flex  flex-col space-y-2">
            <div className="flex justify-center  items-center space-x-2">
              <ButtonGroup>
                {transcripts?.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={copyTranscript}
                    title="Copy Transcript"
                  >
                    <Copy />
                    <span className='hidden md:inline'>
                      Copy
                    </span>
                  </Button>
                )}
                {transcriptModelConfig.provider === "localWhisper" &&
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => showModal('languageSettings')}
                    title="Language"
                  >
                    <GlobeIcon />
                    <span className='hidden md:inline'>
                      Language
                    </span>
                  </Button>
                }
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => startRegionSelect()}
                  title="Screenshot (Alt+Shift+S)"
                >
                  <Camera className="w-4 h-4" />
                  <span className='hidden md:inline'>
                    Screenshot
                  </span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => startRegionSelect(true)}
                  title="Annotate (Alt+Shift+R)"
                >
                  <PenLine className="w-4 h-4" />
                  <span className='hidden md:inline'>
                    Annotate
                  </span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={captureClipboard}
                  title="Capture Clipboard (Alt+Shift+V)"
                >
                  <Clipboard className="w-4 h-4" />
                  <span className='hidden md:inline'>
                    Clip
                  </span>
                </Button>
              </ButtonGroup>
            </div>
          </div>
        </div>
      </div>

      {/* Transcript chunks for AI context basket */}
      <TranscriptChunks chunks={transcriptChunks} />

      {/* Permission Warning - Not needed on Linux */}
      {!isRecording && !isChecking && !isLinux && (
        <div className="flex justify-center px-4 pt-4">
          <PermissionWarning
            hasMicrophone={hasMicrophone}
            hasSystemAudio={hasSystemAudio}
            onRecheck={checkPermissions}
            isRechecking={isChecking}
          />
        </div>
      )}

      {/* Transcript content */}
      <div className="pb-20">
        <div className="flex justify-center">
          <div className="w-2/3 max-w-[750px]">
            {/* Today's agenda: only when idle (invisible-when-active during a call). */}
            {!isRecording && <TodayAgenda />}
            <VirtualizedTranscriptView
              segments={segments}
              isRecording={isRecording}
              isPaused={isPaused}
              isProcessing={isProcessingStop}
              isStopping={isStopping}
              enableStreaming={isRecording}
              showConfidence={true}
              timelineItems={hasTimelineContent ? timelineItems : undefined}
              timelineFilter={timelineFilter}
              onTimelineFilterChange={hasTimelineContent ? setTimelineFilter : undefined}
              screenshotCount={screenshots.length}
              onScreenshotClick={handleScreenshotClick}
              clipboardCount={clipboardItems.length}
              onSegmentEdit={handleSegmentEdit}
            />
          </div>
        </div>
      </div>

      {/* Screenshot Lightbox */}
      {selectedScreenshot && (
        <ScreenshotLightbox
          screenshot={selectedScreenshot}
          onClose={closeLightbox}
        />
      )}

      {/* Region Selection Overlay */}
      {isRegionSelecting && regionSelectInfo && (
        <RegionSelectOverlay
          previewDataUri={regionSelectInfo.previewDataUri}
          monitorWidth={regionSelectInfo.monitorWidth}
          monitorHeight={regionSelectInfo.monitorHeight}
          onSelect={captureRegion}
          onAnnotatedCapture={annotateAfterSelect ? captureAnnotatedRegion : undefined}
          onCancel={cancelRegionSelect}
        />
      )}
    </div>
  );
}
