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
import {
  writeLiveTranscript,
  writeLiveScreenshots,
  getRecentTranscripts,
  LIVE_TRANSCRIPT_WINDOW_SECS,
  LIVE_TRANSCRIPT_DEBOUNCE_MS,
} from '@/services/handoffService';

const RESPONSE_POLL_MS = 10_000; // poll every 10s

export function useLiveTranscriptWriter() {
  const { transcripts, meetingTitle } = useTranscripts();
  const { projectDir, injectExternalMessage } = useClaude();
  const { isRecording } = useRecordingState();
  const { screenshots } = useScreenshots();

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWrittenCountRef = useRef<number>(0);
  const responsePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // M26: Refs to avoid stale closures in the flush effect
  const projectDirRef = useRef(projectDir);
  projectDirRef.current = projectDir;
  const transcriptsLocalRef = useRef(transcripts);
  transcriptsLocalRef.current = transcripts;
  const meetingTitleLocalRef = useRef(meetingTitle);
  meetingTitleLocalRef.current = meetingTitle;

  // M25: Reset counter when project dir changes
  useEffect(() => {
    lastWrittenCountRef.current = 0;
  }, [projectDir]);

  // Debounced write on transcript changes during recording
  useEffect(() => {
    if (!isRecording || !projectDir || transcripts.length === 0) return;

    // Skip if no new transcripts since last write
    if (transcripts.length === lastWrittenCountRef.current) return;

    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(async () => {
      try {
        const recentTranscripts = getRecentTranscripts(transcripts, LIVE_TRANSCRIPT_WINDOW_SECS);
        await writeLiveTranscript(projectDir, recentTranscripts, meetingTitle || 'Meeting');
        await writeLiveScreenshots(projectDir, screenshots);
        lastWrittenCountRef.current = transcripts.length;
      } catch (err) {
        // Non-blocking — don't toast on every failed write
        console.warn('[F054] Live transcript write failed:', err);
      }
    }, LIVE_TRANSCRIPT_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [transcripts, screenshots, isRecording, projectDir, meetingTitle]);

  // Final flush when recording stops (uses refs to avoid stale closures)
  useEffect(() => {
    if (!isRecording && lastWrittenCountRef.current > 0 && projectDirRef.current && transcriptsLocalRef.current.length > 0) {
      const recentTranscripts = getRecentTranscripts(transcriptsLocalRef.current, LIVE_TRANSCRIPT_WINDOW_SECS);
      if (recentTranscripts.length > 0) {
        writeLiveTranscript(projectDirRef.current, recentTranscripts, meetingTitleLocalRef.current || 'Meeting').catch(() => {});
      }
      lastWrittenCountRef.current = 0;
    }
  }, [isRecording]);

  // Bug 8: Poll .tandem/response.md for Claude Code responses
  useEffect(() => {
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
  }, [projectDir, injectExternalMessage]);
}