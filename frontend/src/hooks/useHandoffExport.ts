'use client';

/**
 * F020: Meeting Handoff Export Hook
 * F048: Enhanced with structured task extraction via Anthropic API
 *
 * Orchestrates the handoff pipeline: gathers data from all contexts,
 * manages the PII dialog, optionally anonymizes text, generates HANDOFF.md
 * with embedded YAML task section, and writes it to the meeting folder.
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
import { useConfig } from '@/contexts/ConfigContext';
import { anonymizeTexts, checkAnonymizationHealth } from '@/services/anonymizationService';
import { buildTimeline, generateHandoffMarkdown, HandoffData, TimelineItem } from '@/lib/handoffExport';
import { extractTasks } from '@/services/taskExtractionService';
import { injectClaudeMdSection } from '@/lib/claudeMdInjector';

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
  const { conversation, meetingId, anonymizationEnabled, entityMap, apiKey } = useClaude();
  const { recordingDuration } = useRecordingState();
  const { handoffSettings } = useConfig();

  const [isGenerating, setIsGenerating] = useState(false);
  const [showHandoffDialog, setShowHandoffDialog] = useState(false);
  const [anonymizeChecked, setAnonymizeChecked] = useState(false);
  const [piiAvailable, setPiiAvailable] = useState<boolean | null>(null);

  const folderPathRef = useRef<string>('');
  const meetingNameRef = useRef<string>('');

  // Snapshot refs — capture data at trigger time to survive clearTranscripts() race
  const snapshotRef = useRef<{
    transcripts: typeof transcriptsRef.current;
    screenshots: typeof screenshots;
    clipboardItems: typeof clipboardItems;
    conversation: typeof conversation;
    recordingDuration: typeof recordingDuration;
    meetingId: typeof meetingId;
    entityMap: typeof entityMap;
    apiKey: typeof apiKey;
  } | null>(null);

  // ─── Trigger ─────────────────────────────────────────────────────────────

  const triggerHandoff = useCallback(async (folderPath: string, meetingName: string) => {
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
      apiKey,
    };

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
  }, [anonymizationEnabled, transcriptsRef, screenshots, clipboardItems, conversation, recordingDuration, meetingId, entityMap, apiKey]);

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
      // Use snapshot data captured at trigger time (survives clearTranscripts race)
      const snap = snapshotRef.current;
      if (!snap) {
        throw new Error('No handoff snapshot available — was triggerHandoff called?');
      }

      const { transcripts, screenshots: snappedScreenshots, clipboardItems: snappedClipboard,
              conversation: snappedConversation, recordingDuration: snappedDuration,
              meetingId: snappedMeetingId, entityMap: snappedEntityMap,
              apiKey: snappedApiKey } = snap;

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

      // F048: Extract structured tasks via Anthropic API
      let tasks;
      if (snappedApiKey) {
        try {
          const transcriptText = timeline
            .filter(item => item.type === 'transcript')
            .map(item => item.text)
            .join('\n');

          const screenshotDescs = snappedScreenshots
            .map(s => `Screenshot at ${s.recording_elapsed_secs ?? 0}s: ${s.file_path}`)
            .filter(Boolean);

          const clipboardTexts = snappedClipboard
            .filter(c => c.content_type === 'text' && c.text)
            .map(c => c.text!);

          tasks = await extractTasks(
            transcriptText,
            snappedApiKey,
            screenshotDescs.length > 0 ? screenshotDescs : undefined,
            clipboardTexts.length > 0 ? clipboardTexts : undefined,
          );
        } catch (err) {
          console.warn('Task extraction failed, handoff will proceed without tasks:', err);
        }
      }

      // Generate markdown
      const data: HandoffData = {
        meetingName: meetingNameRef.current || 'Meeting',
        date: new Date().toISOString(),
        durationSeconds: snappedDuration ?? null,
        timeline,
        anonymized,
        tasks,
      };

      const markdown = generateHandoffMarkdown(data);

      // Write file to meeting folder
      const filePath = `${folderPathRef.current}/HANDOFF.md`;
      await invoke('save_transcript', { filePath, content: markdown });

      // F048: Also write to project directory if configured
      if (handoffSettings.projectDir) {
        try {
          // save_transcript auto-creates parent dirs
          const projectFilePath = `${handoffSettings.projectDir}/.tandem/HANDOFF.md`;
          await invoke('save_transcript', { filePath: projectFilePath, content: markdown });

          // Inject CLAUDE.md section if enabled
          if (handoffSettings.injectClaudeMd) {
            try {
              const injected = await injectClaudeMdSection(handoffSettings.projectDir);
              if (injected) {
                toast.success('Handoff saved + CLAUDE.md updated', {
                  description: `Tasks ready in ${projectFilePath}`,
                });
              } else {
                toast.success('Handoff saved to project', {
                  description: projectFilePath,
                });
              }
            } catch {
              toast.success('Handoff saved to project', {
                description: `${projectFilePath} (CLAUDE.md update skipped)`,
              });
            }
          } else {
            toast.success('Handoff saved to project', {
              description: projectFilePath,
            });
          }
        } catch (err) {
          console.warn('Failed to write handoff to project directory:', err);
          toast.success('Handoff file saved', {
            description: `${filePath} (project dir write failed)`,
          });
        }
      } else {
        toast.success('Handoff file saved', {
          description: filePath,
        });
      }
    } catch (err) {
      console.error('Failed to generate handoff:', err);
      toast.error('Failed to save handoff file', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsGenerating(false);
      setShowHandoffDialog(false);
      snapshotRef.current = null;
    }
  }, [anonymizeChecked, piiAvailable, handoffSettings]);

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