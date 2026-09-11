export interface Message {
  id: string;
  content: string;
  timestamp: string;
}

export interface Transcript {
  id: string;
  text: string;
  timestamp: string; // Wall-clock time (e.g., "14:30:05")
  sequence_id?: number;
  chunk_start_time?: number; // Legacy field
  is_partial?: boolean;
  confidence?: number;
  // NEW: Recording-relative timestamps for playback sync
  audio_start_time?: number; // Seconds from recording start (e.g., 125.3)
  audio_end_time?: number;   // Seconds from recording start (e.g., 128.6)
  duration?: number;          // Segment duration in seconds (e.g., 3.3)
  source?: string;            // "Local" (mic) or "Remote" (system audio)
  speaker?: string;           // DB `speaker` column: holds "Local"/"Remote" from the audio channel
  // F022: Speaker diarization
  speaker_label?: string;    // Pyannote label (e.g., "SPEAKER_00") or user-assigned name
}

export interface TranscriptUpdate {
  text: string;
  timestamp: string; // Wall-clock time for reference
  source: string;
  sequence_id: number;
  chunk_start_time: number; // Legacy field
  is_partial: boolean;
  confidence: number;
  // NEW: Recording-relative timestamps for playback sync
  audio_start_time: number; // Seconds from recording start
  audio_end_time: number;   // Seconds from recording start
  duration: number;          // Segment duration in seconds
}

// Revisable partial transcript (Scribe Realtime WS). Volatile: never persisted,
// never enters the committed transcript list. Superseded by a `transcript-update`
// (committed) for the same source.
export interface TranscriptPartial {
  source: string;       // "Local" (mic) or "Remote" (system audio)
  text: string;
  session_seq: number;  // per-source monotonic sequence; used to drop stale/out-of-order partials
}

export interface Block {
  id: string;
  type: string;
  content: string;
  color: string;
}

export interface Section {
  title: string;
  blocks: Block[];
}

export interface Summary {
  [key: string]: Section;
}

export interface ApiResponse {
  message: string;
  num_chunks: number;
  data: any[];
}

export interface SummaryResponse {
  status: string;
  summary: Summary;
  raw_summary?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// BlockNote-specific types
export type SummaryFormat = 'legacy' | 'markdown' | 'blocknote';

export interface BlockNoteBlock {
  id: string;
  type: string;
  props?: Record<string, any>;
  content?: any[];
  children?: BlockNoteBlock[];
}

export interface SummaryDataResponse {
  markdown?: string;
  summary_json?: BlockNoteBlock[];
  // Legacy format fields
  MeetingName?: string;
  _section_order?: string[];
  [key: string]: any; // For legacy section data
}

// Pagination types for optimized transcript loading
export interface MeetingMetadata {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  folder_path?: string;
}

export interface PaginatedTranscriptsResponse {
  transcripts: Transcript[];
  total_count: number;
  has_more: boolean;
}

// Transcript segment data for virtualized display
export interface TranscriptSegmentData {
  id: string;
  timestamp: number; // audio_start_time in seconds
  endTime?: number; // audio_end_time in seconds
  text: string;
  confidence?: number;
  source?: string;           // Audio-channel source: "Local"/"Remote" (from DB `speaker`)
  // F022: Speaker diarization
  speaker_label?: string;
}

// Screenshot capture types
export interface ScreenshotData {
  id: string;
  file_path: string;
  thumbnail_base64: string;
  timestamp: string;              // Wall-clock time (e.g., "14:30:05")
  recording_elapsed_secs?: number; // Seconds from recording start
  width: number;
  height: number;
  capture_mode: 'fullscreen' | 'region';
}

// Clipboard capture types
export interface ClipboardData {
  id: string;
  content_type: 'text' | 'image';
  text?: string;
  file_path?: string;
  thumbnail_base64?: string;
  timestamp: string;
  recording_elapsed_secs?: number;
  width?: number;
  height?: number;
}

// Unified timeline types (transcripts + screenshots + clipboard clips)
export type TimelineItemType = 'transcript' | 'screenshot' | 'clipboard';

export interface TimelineItem {
  type: TimelineItemType;
  id: string;
  recording_elapsed_secs: number;
  timestamp: string;
  data: TranscriptSegmentData | ScreenshotData | ClipboardData;
}

export type TimelineFilter = 'all' | 'transcripts' | 'screenshots' | 'clipboard';

// Transcript chunk for Claude context basket (5-minute windows)
export interface TranscriptChunk {
  id: string;
  startSecs: number;
  endSecs: number;
  label: string;         // e.g. "00:00–05:00"
  preview: string;       // first 60 chars
  fullText: string;      // concatenated segment text
  segmentCount: number;
}
