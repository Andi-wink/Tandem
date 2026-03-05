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
    triggerHandoff?: (folderPath: string, meetingName: string) => Promise<void>;
  }
}

export interface UseHandoffExportReturn {
  triggerHandoff: (folderPath: string, meetingName: string) => Promise<void>;
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

  // Resolve function for the Promise returned by triggerHandoff —
  // called when the dialog is confirmed or cancelled so callers can await it.
  const dialogResolveRef = useRef<(() => void) | null>(null);

  // Snapshot refs — capture data at trigger time to survive clearTranscripts() race
  const snapshotRef = useRef<{
    transcripts: typeof transcriptsRef.current;
    screenshots: typeof screenshots;
    clipboardItems: typeof clipboardItems;
    conversation: typeof conversation;
    recordingDuration: typeof recordingDuration;
    meetingId: typeof meetingId;
    entityMap: typeof entityMap;
  } | null>(null);

  // ─── Trigger ─────────────────────────────────────────────────────────────

  const triggerHandoff = useCallback((folderPath: string, meetingName: string): Promise<void> => {
    folderPathRef.current = folderPath;
    meetingNameRef.current = meetingName;

    // Snapshot all data NOW — before clearTranscripts() wipes it after 2s
    snapshotRef.current = {
      transcripts: [...transcriptsRef.current],
      screenshots: [...screenshots],
      clipboardItems: [...clipboardItems],
      conversation: [...conversation],
      recordingDuration,
      meetingId,
      entityMap: entityMap ? { ...entityMap } : entityMap,
    };

    // Check PII health
    setPiiAvailable(null);
    setShowHandoffDialog(true);

    // Kick off async PII check (non-blocking)
    (async () => {
      try {
        const health = await checkAnonymizationHealth();
        setPiiAvailable(health.available);
        setAnonymizeChecked(health.available && anonymizationEnabled);
      } catch {
        setPiiAvailable(false);
        setAnonymizeChecked(false);
      }
    })();

    // Return a Promise that resolves when the dialog is closed (confirm or cancel).
    // This lets useRecordingStop await it before navigating away.
    return new Promise<void>((resolve) => {
      dialogResolveRef.current = resolve;
    });
  }, [anonymizationEnabled, transcriptsRef, screenshots, clipboardItems, conversation, recordingDuration, meetingId, entityMap]);

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
    dialogResolveRef.current?.();
    dialogResolveRef.current = null;
  }, []);

  const confirmHandoff = useCallback(async () => {
    setIsGenerating(true);

    try {
      // Use snapshot data captured at trigger time (survives clearTranscripts race)
      const snap = snapshotRef.current;
      if (!snap) {
        throw new Error('No handoff snapshot available — was triggerHandoff called?');
      }

      const { transcripts, screenshots: snappedScreenshots, clipboardItems: snappedClipboard,
              conversation: snappedConversation, recordingDuration: snappedDuration,
              meetingId: snappedMeetingId, entityMap: snappedEntityMap } = snap;

      // Build unified timeline
      let timeline = buildTimeline(transcripts, snappedScreenshots, snappedClipboard, snappedConversation);

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
              snappedMeetingId || 'handoff',
              snappedEntityMap,
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
        durationSeconds: snappedDuration ?? null,
        timeline,
        anonymized,
      };

      const markdown = generateHandoffMarkdown(data);

      // Write file
      const filePath = `${folderPathRef.current}/HANDOFF.md`;
      await invoke('save_transcript', { filePath, content: markdown });

      toast.success('Handoff file saved', {
        description: filePath,
        action: {
          label: 'Show File',
          onClick: () => { invoke('show_in_folder', { path: filePath }); },
        },
        duration: 10000,
      });
    } catch (err) {
      console.error('Failed to generate handoff:', err);
      toast.error('Failed to save handoff file', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsGenerating(false);
      setShowHandoffDialog(false);
      snapshotRef.current = null;
      dialogResolveRef.current?.();
      dialogResolveRef.current = null;
    }
  }, [anonymizeChecked, piiAvailable]);

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