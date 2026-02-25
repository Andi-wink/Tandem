'use client';

/**
 * F020: Meeting Handoff Export Hook
 *
 * Orchestrates the handoff pipeline: gathers data from all contexts,
 * manages the PII dialog, optionally anonymizes text, generates HANDOFF.md,
 * and writes it to the meeting folder.
 *
 * Exposes `window.triggerHandoff` so both the auto-trigger (useRecordingStop)
 * and manual trigger (/handoff command) can invoke it.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useScreenshots } from '@/contexts/ScreenshotContext';
import { useClipboard } from '@/contexts/ClipboardContext';
import { useClaude } from '@/contexts/ClaudeContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { anonymizeTexts, checkAnonymizationHealth } from '@/services/anonymizationService';
import { buildTimeline, generateHandoffMarkdown, HandoffData, TimelineItem } from '@/lib/handoffExport';

declare global {
  interface Window {
    triggerHandoff?: (folderPath: string, meetingName: string) => void;
  }
}

export interface UseHandoffExportReturn {
  triggerHandoff: (folderPath: string, meetingName: string) => void;
  isGenerating: boolean;
  showHandoffDialog: boolean;
  anonymizeChecked: boolean;
  setAnonymizeChecked: (v: boolean) => void;
  piiAvailable: boolean | null;
  confirmHandoff: () => Promise<void>;
  cancelHandoff: () => void;
}

export function useHandoffExport(): UseHandoffExportReturn {
  const { transcriptsRef } = useTranscripts();
  const { screenshots } = useScreenshots();
  const { clipboardItems } = useClipboard();
  const { conversation, meetingId, anonymizationEnabled, entityMap } = useClaude();
  const { recordingDuration } = useRecordingState();

  const [isGenerating, setIsGenerating] = useState(false);
  const [showHandoffDialog, setShowHandoffDialog] = useState(false);
  const [anonymizeChecked, setAnonymizeChecked] = useState(false);
  const [piiAvailable, setPiiAvailable] = useState<boolean | null>(null);

  const folderPathRef = useRef<string>('');
  const meetingNameRef = useRef<string>('');

  // ─── Trigger ─────────────────────────────────────────────────────────────

  const triggerHandoff = useCallback(async (folderPath: string, meetingName: string) => {
    folderPathRef.current = folderPath;
    meetingNameRef.current = meetingName;

    // Check PII health
    setPiiAvailable(null);
    setShowHandoffDialog(true);

    try {
      const health = await checkAnonymizationHealth();
      setPiiAvailable(health.available);
      setAnonymizeChecked(health.available && anonymizationEnabled);
    } catch {
      setPiiAvailable(false);
      setAnonymizeChecked(false);
    }
  }, [anonymizationEnabled]);

  // ─── Register window function ────────────────────────────────────────────

  useEffect(() => {
    window.triggerHandoff = triggerHandoff;
    return () => {
      delete window.triggerHandoff;
    };
  }, [triggerHandoff]);

  // ─── Confirm / Cancel ────────────────────────────────────────────────────

  const cancelHandoff = useCallback(() => {
    setShowHandoffDialog(false);
    setPiiAvailable(null);
  }, []);

  const confirmHandoff = useCallback(async () => {
    setIsGenerating(true);

    try {
      const transcripts = transcriptsRef.current;

      // Build unified timeline
      let timeline = buildTimeline(transcripts, screenshots, clipboardItems, conversation);

      // Optionally anonymize text items (transcripts + AI messages)
      let anonymized = false;
      if (anonymizeChecked && piiAvailable) {
        try {
          // Collect all text-bearing items with their indices
          const textEntries: { index: number; text: string }[] = [];
          for (let i = 0; i < timeline.length; i++) {
            const item = timeline[i];
            if (item.type === 'transcript' || item.type === 'ai_user' || item.type === 'ai_assistant') {
              textEntries.push({ index: i, text: item.text });
            }
          }

          if (textEntries.length > 0) {
            const result = await anonymizeTexts(
              textEntries.map(e => e.text),
              meetingId || 'handoff',
              entityMap,
            );

            // Replace texts with sanitized versions
            const updatedTimeline = [...timeline];
            for (let i = 0; i < textEntries.length; i++) {
              updatedTimeline[textEntries[i].index] = {
                ...updatedTimeline[textEntries[i].index],
                text: result.sanitized[i],
              };
            }
            timeline = updatedTimeline;
            anonymized = true;
          }
        } catch (err) {
          console.error('PII anonymization failed, falling back to raw text:', err);
          toast.warning('PII anonymization failed — exporting raw text');
        }
      }

      // Generate markdown
      const data: HandoffData = {
        meetingName: meetingNameRef.current || 'Meeting',
        date: new Date().toISOString(),
        durationSeconds: recordingDuration ?? null,
        timeline,
        anonymized,
      };

      const markdown = generateHandoffMarkdown(data);

      // Write file
      const filePath = `${folderPathRef.current}/HANDOFF.md`;
      await invoke('save_transcript', { filePath, content: markdown });

      toast.success('Handoff file saved', {
        description: filePath,
      });
    } catch (err) {
      console.error('Failed to generate handoff:', err);
      toast.error('Failed to save handoff file', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsGenerating(false);
      setShowHandoffDialog(false);
    }
  }, [
    transcriptsRef, screenshots, clipboardItems, conversation,
    meetingId, entityMap, anonymizeChecked, piiAvailable, recordingDuration,
  ]);

  return {
    triggerHandoff,
    isGenerating,
    showHandoffDialog,
    anonymizeChecked,
    setAnonymizeChecked,
    piiAvailable,
    confirmHandoff,
    cancelHandoff,
  };
}