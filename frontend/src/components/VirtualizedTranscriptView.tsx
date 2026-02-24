'use client';

import { useCallback, useRef, useReducer, startTransition, useEffect, useState, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useTranscriptStreaming } from "@/hooks/useTranscriptStreaming";
import { ConfidenceIndicator } from "./ConfidenceIndicator";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { RecordingStatusBar } from "./RecordingStatusBar";
import { motion, AnimatePresence } from "framer-motion";
import { TranscriptSegmentData, ScreenshotData, ClipboardData, TimelineItem, TimelineFilter } from "@/types";
import { TimelineFilterBar } from "./TimelineFilterBar";
import { ScreenshotThumbnail } from "./ScreenshotThumbnail";
import { Clipboard } from "lucide-react";
import { ContextBasketItem } from "@/contexts/ClaudeContext";
import { useDraggableBasketItem } from "@/hooks/useDragAndDrop";

export interface VirtualizedTranscriptViewProps {
    /** Transcript segments to display */
    segments: TranscriptSegmentData[];
    /** Whether recording is in progress */
    isRecording?: boolean;
    /** Whether recording is paused */
    isPaused?: boolean;
    /** Whether processing/finalizing transcription */
    isProcessing?: boolean;
    /** Whether stopping */
    isStopping?: boolean;
    /** Enable streaming effect for latest segment */
    enableStreaming?: boolean;
    /** Show confidence indicators */
    showConfidence?: boolean;
    /** Completely disable auto-scroll behavior (for meeting details page) */
    disableAutoScroll?: boolean;

    // Pagination props (infinite scroll)
    hasMore?: boolean;
    isLoadingMore?: boolean;
    totalCount?: number;
    loadedCount?: number;
    onLoadMore?: () => void;

    // Timeline props (screenshots + clipboard integration)
    timelineItems?: TimelineItem[];
    timelineFilter?: TimelineFilter;
    onTimelineFilterChange?: (filter: TimelineFilter) => void;
    screenshotCount?: number;
    onScreenshotClick?: (screenshot: ScreenshotData) => void;
    clipboardCount?: number;
    onClipboardItemClick?: (item: ClipboardData) => void;
}

// Threshold for enabling virtualization (below this, use simple rendering)
const VIRTUALIZATION_THRESHOLD = 10;

// Helper function to format seconds as recording-relative time [MM:SS]
function formatRecordingTime(seconds: number | undefined): string {
    if (seconds === undefined) return '[--:--]';

    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;

    return `[${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
}

// Helper function to remove filler words and repetitions
function cleanStopWords(text: string): string {
    const stopWords = ['uh', 'um', 'er', 'ah', 'hmm', 'hm', 'eh', 'oh'];

    let cleanedText = text;
    stopWords.forEach(word => {
        const pattern = new RegExp(`\\b${word}\\b[,\\s]*`, 'gi');
        cleanedText = cleanedText.replace(pattern, ' ');
    });

    return cleanedText.replace(/\s+/g, ' ').trim();
}

function segmentToBasketItem(seg: TranscriptSegmentData): ContextBasketItem {
    return {
        id: `segment-${seg.id}`,
        type: 'transcript_chunk',
        label: formatRecordingTime(seg.timestamp),
        preview: seg.text.slice(0, 80) + (seg.text.length > 80 ? '...' : ''),
        fullContent: seg.text,
        timestamp: seg.timestamp,
    };
}

function clipboardToBasketItem(clip: ClipboardData): ContextBasketItem {
    const timeLabel = clip.recording_elapsed_secs != null
        ? formatRecordingTime(clip.recording_elapsed_secs)
        : clip.timestamp;
    return {
        id: clip.id,
        type: 'clipboard',
        label: `Clipboard ${timeLabel}`,
        preview: (clip.text || '').slice(0, 80) + ((clip.text || '').length > 80 ? '...' : ''),
        fullContent: clip.text || `[Clipboard image: ${clip.file_path}]`,
        timestamp: clip.recording_elapsed_secs,
    };
}

// Draggable clipboard text item
const DraggableClipboardItem = memo(function DraggableClipboardItem({
    clip,
    onClick,
}: {
    clip: ClipboardData;
    onClick?: (clip: ClipboardData) => void;
}) {
    const basketItem = clipboardToBasketItem(clip);
    const { isDragging, dragHandlers } = useDraggableBasketItem(basketItem);

    return (
        <div
            {...dragHandlers}
            className={`flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs ${onClick ? 'cursor-grab hover:bg-amber-100' : ''} ${isDragging ? 'opacity-50' : ''}`}
            onClick={() => onClick?.(clip)}
        >
            <Clipboard className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
            <div className="min-w-0">
                <span className="text-amber-600 font-medium mr-2">{clip.timestamp}</span>
                <span className="text-gray-700 line-clamp-2">{clip.text}</span>
            </div>
        </div>
    );
});

// Memoized transcript segment component
const TranscriptSegment = memo(function TranscriptSegment({
    id,
    timestamp,
    text,
    confidence,
    isStreaming,
    showConfidence,
    basketItem,
}: {
    id: string;
    timestamp: number;
    text: string;
    confidence?: number;
    isStreaming: boolean;
    showConfidence: boolean;
    basketItem?: ContextBasketItem;
}) {
    const { isDragging, dragHandlers } = useDraggableBasketItem(basketItem ?? null);
    const displayText = cleanStopWords(text) || (text.trim() === '' ? '[Silence]' : text);

    return (
        <div id={`segment-${id}`} className="mb-3" {...dragHandlers}>
            <div className={`flex items-start gap-2 ${isDragging ? 'opacity-50' : ''} ${basketItem ? 'cursor-grab' : ''}`}>
                <Tooltip>
                    <TooltipTrigger>
                        <span className="text-xs text-gray-400 mt-1 flex-shrink-0 min-w-[50px]">
                            {formatRecordingTime(timestamp)}
                        </span>
                    </TooltipTrigger>
                    <TooltipContent>
                        {confidence !== undefined && showConfidence && (
                            <ConfidenceIndicator confidence={confidence} showIndicator={showConfidence} />
                        )}
                    </TooltipContent>
                </Tooltip>
                <div className="flex-1">
                    {isStreaming ? (
                        <div className="bg-gray-100 border border-gray-200 rounded-lg px-3 py-2">
                            <p className="text-base text-gray-800 leading-relaxed">{displayText}</p>
                        </div>
                    ) : (
                        <p className="text-base text-gray-800 leading-relaxed">{displayText}</p>
                    )}
                </div>
            </div>
        </div>
    );
});

export const VirtualizedTranscriptView: React.FC<VirtualizedTranscriptViewProps> = ({
    segments,
    isRecording = false,
    isPaused = false,
    isProcessing = false,
    isStopping = false,
    enableStreaming = false,
    showConfidence = true,
    disableAutoScroll = false,
    hasMore = false,
    isLoadingMore = false,
    totalCount = 0,
    loadedCount = 0,
    onLoadMore,
    timelineItems,
    timelineFilter = 'all',
    onTimelineFilterChange,
    screenshotCount = 0,
    onScreenshotClick,
    clipboardCount = 0,
    onClipboardItemClick,
}) => {
    // Create scroll ref first - shared between virtualizer and auto-scroll hook
    const scrollRef = useRef<HTMLDivElement>(null);
    // Ref for infinite scroll trigger element
    const loadMoreTriggerRef = useRef<HTMLDivElement>(null);

    // Force re-render without flushSync (avoids React warning)
    const [, rerender] = useReducer((x: number) => x + 1, 0);

    // Setup virtualizer for efficient rendering of large lists
    const virtualizer = useVirtualizer({
        count: segments.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 60, // Estimated height per segment
        overscan: 10, // Render extra items above/below viewport
        onChange: () => {
            startTransition(() => {
                rerender();
            });
        },
    });

    // Custom hook for auto-scrolling (supports both virtualized and non-virtualized)
    useAutoScroll({
        scrollRef,
        segments,
        isRecording,
        isPaused,
        virtualizer,
        virtualizationThreshold: VIRTUALIZATION_THRESHOLD,
        disableAutoScroll,
    });

    // Streaming text effect hook (typewriter animation for new transcripts)
    const { streamingSegmentId, getDisplayText } = useTranscriptStreaming(
        segments,
        isRecording,
        enableStreaming
    );

    // Infinite scroll: IntersectionObserver to trigger loading more
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording || segments.length === 0) {
            return;
        }

        const triggerElement = loadMoreTriggerRef.current;
        if (!triggerElement) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
            },
            {
                root: null,
                rootMargin: '100px',
                threshold: 0,
            }
        );

        observer.observe(triggerElement);

        return () => observer.disconnect();
    }, [hasMore, isLoadingMore, onLoadMore, isRecording, segments.length]);

    // Scroll-based fallback for fast scrolling
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording) return;

        const scrollElement = scrollRef.current;
        if (!scrollElement) return;

        let ticking = false;

        const handleScroll = () => {
            if (ticking || isLoadingMore || !hasMore) return;

            ticking = true;
            requestAnimationFrame(() => {
                const { scrollTop, scrollHeight, clientHeight } = scrollElement;
                const scrollBottom = scrollHeight - scrollTop - clientHeight;

                // Trigger load when within 200px of bottom
                if (scrollBottom < 200 && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
                ticking = false;
            });
        };

        scrollElement.addEventListener('scroll', handleScroll, { passive: true });
        return () => scrollElement.removeEventListener('scroll', handleScroll);
    }, [onLoadMore, hasMore, isLoadingMore, isRecording]);

    // Use simple rendering for small lists, virtualization for large lists
    // When timeline items are present (has screenshots), use timeline rendering
    const hasTimeline = timelineItems && timelineItems.length > 0;
    const useVirtualization = !hasTimeline && segments.length >= VIRTUALIZATION_THRESHOLD;

    return (
        <div ref={scrollRef} className="flex flex-col h-full overflow-y-auto px-4 py-2">
            {/* Recording Status Bar - Sticky at top, always visible when recording */}
            <AnimatePresence>
                {isRecording && (
                    <div className="sticky top-0 z-10 bg-white pb-2">
                        <RecordingStatusBar isPaused={isPaused} />
                    </div>
                )}
            </AnimatePresence>

            {/* Timeline Filter Bar - shown when screenshots or clipboard clips exist */}
            {onTimelineFilterChange && (
                <TimelineFilterBar
                    filter={timelineFilter}
                    onFilterChange={onTimelineFilterChange}
                    screenshotCount={screenshotCount}
                    clipboardCount={clipboardCount}
                />
            )}

            {/* Content - add padding when recording to prevent overlap */}
            <div className={isRecording ? 'pt-2' : ''}>
            {segments.length === 0 && (!timelineItems || timelineItems.length === 0) ? (
                // Empty state
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-center text-gray-500 mt-8"
                >
                    {isRecording ? (
                        <>
                            <div className="flex items-center justify-center mb-3">
                                <div className={`w-3 h-3 rounded-full ${isPaused ? 'bg-orange-500' : 'bg-blue-500 animate-pulse'}`}></div>
                            </div>
                            <p className="text-sm text-gray-600">
                                {isPaused ? 'Recording paused' : 'Listening for speech...'}
                            </p>
                            <p className="text-xs mt-1 text-gray-400">
                                {isPaused ? 'Click resume to continue recording' : 'Speak to see live transcription'}
                            </p>
                        </>
                    ) : (
                        <>
                            <p className="text-lg font-semibold">Welcome to Tandem!</p>
                            <p className="text-xs mt-1">Start recording to see live transcription</p>
                        </>
                    )}
                </motion.div>
            ) : hasTimeline ? (
                // Timeline rendering (mixed transcripts + screenshots)
                <>
                    <div className="space-y-1">
                        {timelineItems!.map((item) => {
                            if (item.type === 'screenshot' && onScreenshotClick) {
                                const ss = item.data as ScreenshotData;
                                return (
                                    <motion.div
                                        key={item.id}
                                        initial={{ opacity: 0, y: 5 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ duration: 0.15 }}
                                    >
                                        <ScreenshotThumbnail
                                            screenshot={ss}
                                            onClick={onScreenshotClick}
                                        />
                                    </motion.div>
                                );
                            }

                            if (item.type === 'clipboard') {
                                const clip = item.data as ClipboardData;
                                return (
                                    <motion.div
                                        key={item.id}
                                        initial={{ opacity: 0, y: 5 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ duration: 0.15 }}
                                        className="px-3 py-1"
                                    >
                                        {clip.content_type === 'image' && clip.thumbnail_base64 ? (
                                            // Image clip — reuse screenshot thumbnail style (already draggable)
                                            <div
                                                className={`cursor-pointer ${onClipboardItemClick ? 'hover:opacity-90' : ''}`}
                                                onClick={() => onClipboardItemClick?.(clip)}
                                            >
                                                <ScreenshotThumbnail
                                                    screenshot={{
                                                        id: clip.id,
                                                        file_path: clip.file_path ?? '',
                                                        thumbnail_base64: clip.thumbnail_base64,
                                                        timestamp: clip.timestamp,
                                                        recording_elapsed_secs: clip.recording_elapsed_secs,
                                                        width: clip.width ?? 0,
                                                        height: clip.height ?? 0,
                                                        capture_mode: 'fullscreen',
                                                    }}
                                                    onClick={() => onClipboardItemClick?.(clip)}
                                                />
                                            </div>
                                        ) : (
                                            // Text clip — draggable compact preview card
                                            <DraggableClipboardItem
                                                clip={clip}
                                                onClick={onClipboardItemClick}
                                            />
                                        )}
                                    </motion.div>
                                );
                            }

                            // Transcript segment
                            const seg = item.data as TranscriptSegmentData;
                            const isStreamingSeg = streamingSegmentId === seg.id;
                            return (
                                <motion.div
                                    key={item.id}
                                    initial={{ opacity: 0, y: 5 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.15 }}
                                >
                                    <TranscriptSegment
                                        id={seg.id}
                                        timestamp={seg.timestamp}
                                        text={getDisplayText(seg)}
                                        confidence={seg.confidence}
                                        isStreaming={isStreamingSeg}
                                        showConfidence={showConfidence}
                                        basketItem={segmentToBasketItem(seg)}
                                    />
                                </motion.div>
                            );
                        })}
                    </div>

                    {/* Listening indicator when recording */}
                    {!isStopping && isRecording && !isPaused && !isProcessing && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2 mt-4 text-gray-500"
                        >
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            <span className="text-sm">Listening...</span>
                        </motion.div>
                    )}
                </>
            ) : useVirtualization ? (
                // Virtualized rendering for large lists
                <>
                    <div
                        style={{
                            height: virtualizer.getTotalSize(),
                            width: "100%",
                            position: "relative",
                        }}
                    >
                        {virtualizer.getVirtualItems().map((virtualRow) => {
                            const segment = segments[virtualRow.index];
                            const isStreaming = streamingSegmentId === segment.id;

                            return (
                                <div
                                    key={segment.id}
                                    data-index={virtualRow.index}
                                    ref={virtualizer.measureElement}
                                    style={{
                                        position: "absolute",
                                        top: 0,
                                        left: 0,
                                        width: "100%",
                                        transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        confidence={segment.confidence}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                        basketItem={segmentToBasketItem(segment)}
                                    />
                                </div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger and loading indicator */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                    <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">Loading more...</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-gray-400">
                                    Showing {loadedCount} of {totalCount} segments
                                </span>
                            ) : null}
                        </div>
                    )}

                    {/* Listening indicator when recording */}
                    {!isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2 mt-4 text-gray-500"
                        >
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            <span className="text-sm">Listening...</span>
                        </motion.div>
                    )}
                </>
            ) : (
                // Simple rendering for small lists (better animations)
                <>
                    <div className="space-y-1">
                        {segments.map((segment) => {
                            const isStreaming = streamingSegmentId === segment.id;

                            return (
                                <motion.div
                                    key={segment.id}
                                    initial={{ opacity: 0, y: 5 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.15 }}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        confidence={segment.confidence}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                        basketItem={segmentToBasketItem(segment)}
                                    />
                                </motion.div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger (for small lists that grow) */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                    <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">Loading more...</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-gray-400">
                                    Showing {loadedCount} of {totalCount} segments
                                </span>
                            ) : null}
                        </div>
                    )}

                    {/* Listening indicator when recording */}
                    {!isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2 mt-4 text-gray-500"
                        >
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            <span className="text-sm">Listening...</span>
                        </motion.div>
                    )}
                </>
            )}
            </div>
        </div>
    );
};
