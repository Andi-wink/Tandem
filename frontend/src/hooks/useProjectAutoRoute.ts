'use client';

/**
 * useProjectAutoRoute — fires once per meeting-mode recording, after early transcript accumulates,
 * to auto-file the meeting under the registered project it belongs to (title/transcript heuristic,
 * optional Haiku fallback). The result is applied through the shared fileUnder action, so the user
 * always gets the "Filed under X" toast with a working Undo/Change. Auto-routing must NEVER break
 * the recording flow: every failure is swallowed with a warn.
 *
 * Suppressed when: solo mode is active (it has its own router), a project is already active (the
 * user routed manually), or the user explicitly picked a REGISTERED project before recording.
 */

import { useEffect, useRef } from 'react';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useClaude } from '@/contexts/ClaudeContext';
import { useSoloMode } from '@/contexts/SoloModeContext';
import { useProjectRouteActions } from '@/hooks/useProjectRouteActions';
import { listProjects } from '@/services/projectService';
import { routeMeetingToProject } from '@/services/projectRouter';
import { normalizeDir } from '@/lib/projectDirHistory';

const MIN_TRANSCRIPT_CHARS = 300;
const MIN_SEGMENTS = 8;
const MAX_TRANSCRIPT_CHARS = 4000;

interface Options {
  enabled: boolean;
  preRecordDirRef: React.MutableRefObject<string>;
}

export function useProjectAutoRoute({ enabled, preRecordDirRef }: Options) {
  const { isRecording } = useRecordingState();
  const { transcripts, meetingTitle } = useTranscripts();
  const { apiKey } = useClaude();
  const { activeProject } = useSoloMode();
  const { fileUnder } = useProjectRouteActions();

  const attemptedRef = useRef(false);
  const apiKeyRef = useRef(apiKey);
  apiKeyRef.current = apiKey;
  const meetingTitleRef = useRef(meetingTitle);
  meetingTitleRef.current = meetingTitle;
  const activeProjectRef = useRef(activeProject);
  activeProjectRef.current = activeProject;
  const isRecordingRef = useRef(isRecording);
  isRecordingRef.current = isRecording;

  // Reset the one-shot guard when a recording ends.
  useEffect(() => {
    if (!isRecording) attemptedRef.current = false;
  }, [isRecording]);

  useEffect(() => {
    if (!enabled || !isRecording || attemptedRef.current) return;
    if (activeProject) {
      // User already routed manually — don't auto-route over them.
      attemptedRef.current = true;
      return;
    }

    const joined = transcripts.map(t => t.text).join(' ');
    if (joined.length < MIN_TRANSCRIPT_CHARS && transcripts.length < MIN_SEGMENTS) return;

    attemptedRef.current = true;
    (async () => {
      try {
        const projects = await listProjects();
        if (projects.length === 0) return;

        // If the user explicitly picked a REGISTERED project before recording, their pick wins —
        // never auto-route over an intentional choice.
        const preDir = preRecordDirRef.current;
        if (preDir && projects.some(p => normalizeDir(p.path) === normalizeDir(preDir))) return;

        const result = await routeMeetingToProject({
          meetingTitle: meetingTitleRef.current,
          transcriptText: joined.slice(0, MAX_TRANSCRIPT_CHARS),
          projects,
          anthropicKey: apiKeyRef.current,
        });
        if (!result) return;

        // Guard against a manual switch (or a stop) during the await.
        if (!isRecordingRef.current || activeProjectRef.current) return;
        await fileUnder(result.project, result.signal);
      } catch (err) {
        console.warn('[AutoRoute] project auto-route failed (ignored):', err);
      }
    })();
  }, [enabled, isRecording, transcripts, activeProject, preRecordDirRef, fileUnder]);
}
