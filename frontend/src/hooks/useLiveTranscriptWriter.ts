'use client';

/**
 * F054: Live Transcript Writer
 *
 * Writes the live transcript to {projectDir}/.tandem/live-transcript.md
 * every 10 seconds during recording. Claude Code's /loop reads this file
 * to detect spoken task requests like "Tandem, start working on..."
 */

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useClaude } from '@/contexts/ClaudeContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useScreenshots } from '@/contexts/ScreenshotContext';
import { useSoloMode } from '@/contexts/SoloModeContext';
import { useClipboard } from '@/contexts/ClipboardContext';
import {
  writeLiveTranscript,
  writeLiveScreenshots,
  syncScreenshotsToTandemDir,
  writeLiveClipboard,
  getRecentTranscripts,
  LIVE_TRANSCRIPT_WINDOW_SECS,
  LIVE_TRANSCRIPT_DEBOUNCE_MS,
} from '@/services/handoffService';

const RESPONSE_POLL_MS = 10_000; // poll every 10s

export function useLiveTranscriptWriter() {
  const { transcripts, meetingTitle } = useTranscripts();
  const { projectDir, injectExternalMessage } = useClaude();
  const { isRecording, recordingMode } = useRecordingState();
  const { screenshots } = useScreenshots();
  const soloMode = useSoloMode();
  const { clipboardItems } = useClipboard();

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWrittenCountRef = useRef<number>(0);
  const responsePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // In Solo mode, useSoloModeRouter handles per-project transcript writing.
  // This hook only runs for Meeting mode.

  // Debounced write on transcript changes during recording
  useEffect(() => {
    if (recordingMode === 'solo') return; // Solo mode handled by useSoloModeRouter
    if (!isRecording || !projectDir || transcripts.length === 0) return;

    // Skip if no new transcripts since last write
    if (transcripts.length === lastWrittenCountRef.current) return;

    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(async () => {
      try {
        const recentTranscripts = getRecentTranscripts(transcripts, LIVE_TRANSCRIPT_WINDOW_SECS);
        await writeLiveTranscript(projectDir, recentTranscripts, meetingTitle || 'Meeting', screenshots);
        await writeLiveScreenshots(projectDir, screenshots);
        await syncScreenshotsToTandemDir(projectDir, screenshots);
        await writeLiveClipboard(projectDir, clipboardItems);
        lastWrittenCountRef.current = transcripts.length;
      } catch (err) {
        // Non-blocking — don't toast on every failed write
        console.warn('[F054] Live transcript write failed:', err);
      }
    }, LIVE_TRANSCRIPT_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [transcripts, screenshots, clipboardItems, isRecording, projectDir, meetingTitle, recordingMode]);

  // Final flush when recording stops
  useEffect(() => {
    if (recordingMode === 'solo') return; // Solo mode handled by useSoloModeRouter
    if (!isRecording && lastWrittenCountRef.current > 0 && projectDir && transcripts.length > 0) {
      const recentTranscripts = getRecentTranscripts(transcripts, LIVE_TRANSCRIPT_WINDOW_SECS);
      if (recentTranscripts.length > 0) {
        writeLiveTranscript(projectDir, recentTranscripts, meetingTitle || 'Meeting', screenshots).catch(() => {});
      }
      lastWrittenCountRef.current = 0;
    }
    // Only react to isRecording going from true→false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording]);

  // Bug 8: Poll .tandem/response.md for Claude Code responses (Meeting mode only)
  useEffect(() => {
    if (recordingMode === 'solo') return; // Solo mode polls per-project in useSoloModeRouter
    if (!projectDir) return;

    const sep = projectDir.includes('\\') ? '\\' : '/';
    const responsePath = `${projectDir}${sep}.tandem${sep}response.md`;

    responsePollRef.current = setInterval(async () => {
      try {
        const content = await invoke<string | null>('read_file_if_exists', { path: responsePath });
        if (content) {
          injectExternalMessage(content);
          // Clear the file so we don't re-inject the same response
          await invoke('save_transcript', { filePath: responsePath, content: '' });
        }
      } catch {
        // Non-blocking — file may not exist yet
      }
    }, RESPONSE_POLL_MS);

    return () => {
      if (responsePollRef.current) clearInterval(responsePollRef.current);
    };
  }, [projectDir, injectExternalMessage, recordingMode]);
}