/**
 * F022: Speaker Diarization Service
 *
 * HTTP client for backend diarization endpoints.
 */

const BACKEND = 'http://localhost:5167';

export interface DiarizationStatus {
  meeting_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress_pct: number;
  num_speakers?: number;
  error?: string;
  processing_time?: number;
}

export interface RawSpeakerSegment {
  speaker: string;
  start: number;
  end: number;
}

export interface AlignedSegment {
  text?: string;
  audio_start_time: number;
  audio_end_time?: number;
  duration?: number;
  speaker_label: string;
  speaker_display_name?: string;
}

export interface DiarizationResult {
  raw_segments: RawSpeakerSegment[];
  aligned_segments: AlignedSegment[];
  num_speakers: number;
  duration: number;
  speaker_names: Record<string, string>;
}

export interface DiarizationHealth {
  installed: boolean;
  available: boolean;
  device: string | null;
}

export async function startDiarization(
  meetingId: string,
  audioPath: string,
  opts?: { num_speakers?: number; min_speakers?: number; max_speakers?: number },
): Promise<{ message: string; meeting_id: string }> {
  const res = await fetch(`${BACKEND}/api/diarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      meeting_id: meetingId,
      audio_path: audioPath,
      ...opts,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'Failed to start diarization');
  }
  return res.json();
}

export async function getDiarizationStatus(meetingId: string): Promise<DiarizationStatus> {
  const res = await fetch(`${BACKEND}/api/diarize/status/${meetingId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'Failed to get diarization status');
  }
  return res.json();
}

export async function getDiarizationResult(meetingId: string): Promise<DiarizationResult> {
  const res = await fetch(`${BACKEND}/api/diarize/result/${meetingId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'No diarization result found');
  }
  return res.json();
}

export async function setupDiarizationModel(
  hfToken: string,
): Promise<{ status: string; message: string; device: string }> {
  const res = await fetch(`${BACKEND}/api/diarize/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hf_token: hfToken }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'Failed to setup diarization model');
  }
  return res.json();
}

export async function getDiarizationHealth(): Promise<DiarizationHealth> {
  const res = await fetch(`${BACKEND}/api/diarize/health`);
  if (!res.ok) return { installed: false, available: false, device: null };
  return res.json();
}

export async function updateSpeakerNames(
  meetingId: string,
  speakerNames: Record<string, string>,
): Promise<void> {
  const res = await fetch(`${BACKEND}/api/diarize/speakers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meeting_id: meetingId, speaker_names: speakerNames }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'Failed to update speaker names');
  }
}

export async function getSpeakerNames(
  meetingId: string,
): Promise<Record<string, string>> {
  const res = await fetch(`${BACKEND}/api/diarize/speakers/${meetingId}`);
  if (!res.ok) return {};
  const data = await res.json();
  return data.speaker_names || {};
}
