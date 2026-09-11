'use client';

import { useCallback, useRef, useReducer, startTransition, useEffect, useState, memo, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useTranscriptStreaming } from "@/hooks/useTranscriptStreaming";
import { ConfidenceIndicator } from "./ConfidenceIndicator";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { RecordingStatusBar } from "./RecordingStatusBar";
import { motion, AnimatePresence } from "framer-motion";
import { TranscriptSegmentData, ScreenshotData, ClipboardData, TimelineItem, TimelineFilter } from "@/types";
import { getSpeakerColor, formatSpeakerLabel } from "@/lib/speakerColors";
import { resolveSpeaker, getLocalSpeakerName } from "@/lib/speakerNames";
import { isNoteSegment } from "@/lib/transcriptNotes";
import { StickyNote } from "lucide-react";
import { useLocalSpeakerName } from "@/hooks/useLocalSpeakerName";
import { TimelineFilterBar } from "./TimelineFilterBar";
import { ScreenshotThumbnail } from "./ScreenshotThumbnail";
import { Clipboard } from "lucide-react";
import { ContextBasketItem } from "@/contexts/ClaudeContext";
import { useDraggableBasketItem } from "@/hooks/useDragAndDrop";
import { useSelection } from "@/contexts/SelectionContext";
import { useRubberBandSelect, SelectionRect } from "@/hooks/useRubberBandSelect";

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

    /** Callback when a segment's text is edited (double-click to edit) */
    onSegmentEdit?: (segmentId: string, newText: string) => void;

    /**
     * Volatile "live" partial tails, one per source ("Local" / "Remote").
     * Rendered muted/italic below the committed segments, OUTSIDE the virtualized
     * list so rapid partial updates never thrash the virtualizer. Superseded by the
     * next committed segment for that source.
     */
    pendingTails?: Array<{ source: string; text: string }>;
}

/**
 * A single volatile partial tail. Muted, italic, no timestamp chip, with a small
 * pulsing "live" affordance (static under prefers-reduced-motion). Not selectable,
 * not draggable, not persisted.
 */
const LiveTail = memo(function LiveTail({
    source,
    text,
    showSource,
}: {
    source: string;
    text: string;
    showSource: boolean;
}) {
    const trimmed = text.trim();
    if (trimmed === '') return null;

    // aria-live off: partials update many times/sec via RAF and would flood a
    // screen reader. The committed segments are the announced content.
    return (
        <div className="mb-3" data-testid={`live-tail-${source}`} aria-live="off">
            <div className="flex items-start gap-2">
                <span className="text-xs text-muted-foreground mt-1 flex-shrink-0 min-w-[50px] flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse motion-reduce:animate-none" aria-hidden="true" />
                    <span className="uppercase tracking-wide text-[10px]">Live</span>
                </span>
                <div className="flex-1">
                    {showSource && (
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mr-2 align-middle">
                            {source}
                        </span>
                    )}
                    <span className="text-base italic text-muted-foreground leading-relaxed select-text break-words">
                        {text}
                    </span>
                </div>
            </div>
        </div>
    );
});

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
    // Prepend the resolved speaker name so the AI sees "Andrew: ..." / "Client: ..."
    const speaker = resolveSpeaker(seg, getLocalSpeakerName());
    const content = speaker ? `${speaker}: ${seg.text}` : seg.text;
    return {
        id: `segment-${seg.id}`,
        type: 'transcript_chunk',
        label: formatRecordingTime(seg.timestamp),
        preview: content.slice(0, 80) + (content.length > 80 ? '...' : ''),
        fullContent: content,
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
        fullContent: clip.text || `[Clipboard image: .tandem/clipboard/${(clip.file_path || '').split(/[/\\]/).pop() || 'image.png'}]\nPlease use the Read tool to view this image file.`,
        timestamp: clip.recording_elapsed_secs,
    };
}

// Draggable clipboard text item
const DraggableClipboardItem = memo(function DraggableClipboardItem({
    clip,
    onClick,
    isSelected,
    selectedItems,
}: {
    clip: ClipboardData;
    onClick?: (clip: ClipboardData) => void;
    isSelected?: boolean;
    selectedItems?: ContextBasketItem[];
}) {
    const basketItem = clipboardToBasketItem(clip);
    const { isDragging, dragHandlers } = useDraggableBasketItem(basketItem, selectedItems);

    return (
        <div
            {...dragHandlers}
            data-selectable-id={clip.id}
            className={`flex items-start gap-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 rounded-lg px-3 py-2 text-xs select-none transition-all ${onClick ? 'cursor-grab hover:bg-amber-100' : ''} ${isDragging ? 'opacity-60 ring-2 ring-blue-400 shadow-[0_0_12px_rgba(59,130,246,0.4)] scale-[0.97]' : ''} ${isSelected ? 'ring-2 ring-blue-400 bg-blue-50 dark:bg-blue-900/30' : ''}`}
            onClick={() => onClick?.(clip)}
        >
            <Clipboard className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
            <div className="min-w-0">
                <span className="text-amber-600 dark:text-amber-400 font-medium mr-2">{clip.timestamp}</span>
                <span className="text-foreground line-clamp-2">{clip.text}</span>
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
    isSelected,
    selectedItems,
    isEditing,
    editText,
    onEditStart,
    onEditChange,
    onEditSave,
    onEditCancel,
    onEditKeyDown,
    speakerName,
    isNote = false,
}: {
    id: string;
    timestamp: number;
    text: string;
    confidence?: number;
    isStreaming: boolean;
    showConfidence: boolean;
    basketItem?: ContextBasketItem;
    isSelected?: boolean;
    selectedItems?: ContextBasketItem[];
    isEditing?: boolean;
    editText?: string;
    onEditStart?: () => void;
    onEditChange?: (text: string) => void;
    onEditSave?: () => void;
    onEditCancel?: () => void;
    onEditKeyDown?: (e: React.KeyboardEvent) => void;
    // Resolved speaker name (pyannote label or channel name), already precedence-resolved
    speakerName?: string;
    // True when this segment is a typed note (source === "note"): distinct badge, verbatim text
    isNote?: boolean;
}) {
    const { isDragging, dragHandlers } = useDraggableBasketItem(basketItem ?? null, selectedItems);
    // Notes are shown verbatim (links must survive; no filler-word stripping, no [Silence]).
    const displayText = isNote ? text : (cleanStopWords(text) || (text.trim() === '' ? '[Silence]' : text));
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Auto-focus and auto-resize when editing starts
    useEffect(() => {
        if (isEditing && textareaRef.current) {
            const textarea = textareaRef.current;
            textarea.focus();
            textarea.selectionStart = textarea.value.length;
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';
        }
    }, [isEditing]);

    return (
        <div id={`segment-${id}`} data-selectable-id={`segment-${id}`} className="mb-3" {...(isEditing ? {} : dragHandlers)}>
            <div className={`flex items-start gap-2 select-none transition-all ${isDragging ? 'opacity-60 ring-2 ring-blue-400 shadow-[0_0_12px_rgba(59,130,246,0.4)] scale-[0.97] rounded-lg' : ''} ${isSelected && !isEditing ? 'bg-blue-50 dark:bg-blue-900/30 ring-1 ring-blue-300 rounded-lg px-1' : ''} ${basketItem && !isEditing ? 'cursor-grab' : ''}`}>
                {isNote ? (
                    <span
                        title="Note"
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold mt-1 flex-shrink-0 bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300"
                    >
                        <StickyNote className="w-3 h-3" aria-hidden="true" />
                        Note
                    </span>
                ) : speakerName && (
                    <span
                        title={speakerName}
                        className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold mt-1 flex-shrink-0 max-w-[12ch] truncate ${getSpeakerColor(speakerName)}`}
                    >
                        {formatSpeakerLabel(speakerName)}
                    </span>
                )}
                <Tooltip>
                    <TooltipTrigger>
                        <span className="text-xs text-muted-foreground mt-1 flex-shrink-0 min-w-[50px]">
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
                    {isEditing ? (
                        <div className="relative">
                            <textarea
                                ref={textareaRef}
                                value={editText ?? ''}
                                onChange={(e) => {
                                    onEditChange?.(e.target.value);
                                    e.target.style.height = 'auto';
                                    e.target.style.height = e.target.scrollHeight + 'px';
                                }}
                                onKeyDown={onEditKeyDown}
                                onBlur={onEditSave}
                                className="w-full text-base text-foreground leading-relaxed bg-blue-50 dark:bg-blue-900/20 border border-blue-300 dark:border-blue-700 rounded-md px-2 py-1 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                                rows={1}
                            />
                            <span className="text-[10px] text-muted-foreground mt-0.5 block">
                                Enter to save · Esc to cancel
                            </span>
                        </div>
                    ) : isStreaming ? (
                        <div className="bg-muted border border-border rounded-lg px-3 py-2">
                            <p className="text-base text-foreground leading-relaxed select-text">{displayText}</p>
                        </div>
                    ) : (
                        <p
                            className={`text-base leading-relaxed select-text cursor-text break-words ${isNote
                                ? 'text-foreground border-l-2 border-indigo-300 dark:border-indigo-500/40 pl-2'
                                : 'text-foreground'}`}
                            onDoubleClick={onEditStart}
                            onMouseDown={(e) => e.stopPropagation()}
                        >
                            {displayText}
                        </p>
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
    onSegmentEdit,
    pendingTails,
}) => {
    const { selectedIds, isSelected, replaceSelection, toggle, rangeTo } = useSelection();

    // Local speaker name for channel-based labels ("Andrew" by default, "Client" for remote).
    // Reactive so badges update immediately when the "Your Name" setting changes.
    const localName = useLocalSpeakerName();

    // Inline editing state
    const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
    const [editText, setEditText] = useState('');

    const handleEditStart = useCallback((segmentId: string, originalText: string) => {
        setEditingSegmentId(segmentId);
        setEditText(originalText);
    }, []);

    const handleEditSave = useCallback(() => {
        if (editingSegmentId && editText.trim() && onSegmentEdit) {
            onSegmentEdit(editingSegmentId, editText.trim());
        }
        setEditingSegmentId(null);
        setEditText('');
    }, [editingSegmentId, editText, onSegmentEdit]);

    const handleEditCancel = useCallback(() => {
        setEditingSegmentId(null);
        setEditText('');
    }, []);

    const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleEditSave();
        } else if (e.key === 'Escape') {
            handleEditCancel();
        }
    }, [handleEditSave, handleEditCancel]);

    // Build ordered IDs for Shift+click range selection
    const orderedIds = useMemo(() => {
        if (timelineItems && timelineItems.length > 0) {
            return timelineItems.map(item => {
                if (item.type === 'transcript') {
                    const seg = item.data as TranscriptSegmentData;
                    return `segment-${seg.id}`;
                }
                return item.id;
            });
        }
        return segments.map(seg => `segment-${seg.id}`);
    }, [timelineItems, segments]);

    // Build selected basket items for multi-drag
    const selectedBasketItems: ContextBasketItem[] = useMemo(() => {
        if (selectedIds.size === 0) return [];
        const items: ContextBasketItem[] = [];
        if (timelineItems && timelineItems.length > 0) {
            timelineItems.forEach(item => {
                const id = item.type === 'transcript'
                    ? `segment-${(item.data as TranscriptSegmentData).id}`
                    : item.id;
                if (!selectedIds.has(id)) return;
                if (item.type === 'transcript') {
                    items.push(segmentToBasketItem(item.data as TranscriptSegmentData));
                } else if (item.type === 'clipboard') {
                    items.push(clipboardToBasketItem(item.data as ClipboardData));
                }
            });
        } else {
            segments.forEach(seg => {
                if (selectedIds.has(`segment-${seg.id}`)) {
                    items.push(segmentToBasketItem(seg));
                }
            });
        }
        return items;
    }, [selectedIds, timelineItems, segments]);

    // Ctrl+click to toggle, Shift+click to range-select
    const handleItemClick = useCallback((e: React.MouseEvent, itemId: string) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            e.stopPropagation();
            toggle(itemId);
        } else if (e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            rangeTo(itemId, orderedIds);
        }
    }, [toggle, rangeTo, orderedIds]);

    // Rubber-band selection for the transcript container
    const { containerRef: setRubberBandRef, selectionRect, containerProps: rubberBandProps } = useRubberBandSelect({
        selectableSelector: '[data-selectable-id]',
        onSelectionChange: replaceSelection,
        onSelectionEnd: replaceSelection,
    });

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
        <div
            ref={(el) => { (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = el; setRubberBandRef(el); }}
            className="flex flex-col h-full overflow-y-auto px-4 py-2 relative"
            {...rubberBandProps}
        >
            {/* Recording Status Bar - Sticky at top, always visible when recording */}
            <AnimatePresence>
                {isRecording && (
                    <div className="sticky top-0 z-10 bg-background pb-2">
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
                    className="text-center text-muted-foreground mt-8"
                >
                    {isRecording ? (
                        <>
                            <div className="flex items-center justify-center mb-3">
                                <div className={`w-3 h-3 rounded-full ${isPaused ? 'bg-orange-500' : 'bg-blue-500 animate-pulse'}`}></div>
                            </div>
                            <p className="text-sm text-muted-foreground">
                                {isPaused ? 'Recording paused' : 'Listening for speech...'}
                            </p>
                            <p className="text-xs mt-1 text-muted-foreground/70">
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
                                        onClickCapture={(e) => handleItemClick(e, ss.id)}
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
                                        onClickCapture={(e) => handleItemClick(e, clip.id)}
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
                                                isSelected={isSelected(clip.id)}
                                                selectedItems={selectedBasketItems}
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
                                    onClickCapture={(e) => handleItemClick(e, `segment-${seg.id}`)}
                                >
                                    <TranscriptSegment
                                        id={seg.id}
                                        timestamp={seg.timestamp}
                                        text={getDisplayText(seg)}
                                        confidence={seg.confidence}
                                        isStreaming={isStreamingSeg}
                                        showConfidence={showConfidence}
                                        basketItem={segmentToBasketItem(seg)}
                                        isSelected={isSelected(`segment-${seg.id}`)}
                                        selectedItems={selectedBasketItems}
                                        isEditing={editingSegmentId === seg.id}
                                        editText={editingSegmentId === seg.id ? editText : undefined}
                                        onEditStart={onSegmentEdit ? () => handleEditStart(seg.id, seg.text) : undefined}
                                        onEditChange={setEditText}
                                        onEditSave={handleEditSave}
                                        onEditCancel={handleEditCancel}
                                        onEditKeyDown={handleEditKeyDown}
                                        speakerName={resolveSpeaker(seg, localName)}
                                        isNote={isNoteSegment(seg)}
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
                            className="flex items-center gap-2 mt-4 text-muted-foreground"
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
                                    onClickCapture={(e) => handleItemClick(e, `segment-${segment.id}`)}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        confidence={segment.confidence}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                        basketItem={segmentToBasketItem(segment)}
                                        isSelected={isSelected(`segment-${segment.id}`)}
                                        selectedItems={selectedBasketItems}
                                        isEditing={editingSegmentId === segment.id}
                                        editText={editingSegmentId === segment.id ? editText : undefined}
                                        onEditStart={onSegmentEdit ? () => handleEditStart(segment.id, segment.text) : undefined}
                                        onEditChange={setEditText}
                                        onEditSave={handleEditSave}
                                        onEditCancel={handleEditCancel}
                                        onEditKeyDown={handleEditKeyDown}
                                        speakerName={resolveSpeaker(segment, localName)}
                                        isNote={isNoteSegment(segment)}
                                    />
                                </div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger and loading indicator */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-muted-foreground">
                                    <div className="w-4 h-4 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
                                    <span className="text-sm">Loading more...</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-muted-foreground/70">
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
                            className="flex items-center gap-2 mt-4 text-muted-foreground"
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
                                    onClickCapture={(e) => handleItemClick(e, `segment-${segment.id}`)}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        confidence={segment.confidence}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                        basketItem={segmentToBasketItem(segment)}
                                        isSelected={isSelected(`segment-${segment.id}`)}
                                        selectedItems={selectedBasketItems}
                                        isEditing={editingSegmentId === segment.id}
                                        editText={editingSegmentId === segment.id ? editText : undefined}
                                        onEditStart={onSegmentEdit ? () => handleEditStart(segment.id, segment.text) : undefined}
                                        onEditChange={setEditText}
                                        onEditSave={handleEditSave}
                                        onEditCancel={handleEditCancel}
                                        onEditKeyDown={handleEditKeyDown}
                                        speakerName={resolveSpeaker(segment, localName)}
                                        isNote={isNoteSegment(segment)}
                                    />
                                </motion.div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger (for small lists that grow) */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-muted-foreground">
                                    <div className="w-4 h-4 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
                                    <span className="text-sm">Loading more...</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-muted-foreground/70">
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
                            className="flex items-center gap-2 mt-4 text-muted-foreground"
                        >
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            <span className="text-sm">Listening...</span>
                        </motion.div>
                    )}
                </>
            )}

            {/* Volatile "live" partial tails — rendered OUTSIDE the virtualized list,
                below all committed segments, so partial churn never re-measures rows. */}
            {pendingTails && pendingTails.length > 0 && (
                <div className="mt-1">
                    {pendingTails.map((tail) => (
                        <LiveTail
                            key={`live-tail-${tail.source}`}
                            source={tail.source}
                            text={tail.text}
                            showSource={pendingTails.length > 1}
                        />
                    ))}
                </div>
            )}
            </div>

            {/* Rubber-band selection rectangle */}
            {selectionRect && (
                <div
                    className="absolute border-2 border-dashed border-blue-500 bg-blue-500/10 pointer-events-none z-10 rounded"
                    style={{
                        left: selectionRect.left,
                        top: selectionRect.top,
                        width: selectionRect.width,
                        height: selectionRect.height,
                    }}
                />
            )}
        </div>
    );
};
