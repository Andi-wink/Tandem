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

/** '1' = anonymize PII on handoff, '0' = raw text. Shared with PreferenceSettings. */
export const HANDOFF_ANONYMIZE_STORAGE_KEY = 'tandem-handoff-anonymize';
/** '1' once the user has made a handoff-anonymize choice (dialog confirm or Settings toggle).
 *  When set, /handoff runs immediately with the remembered choice instead of showing the dialog. */
export const HANDOFF_PREF_SET_STORAGE_KEY = 'tandem-handoff-pref-set';

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

  // ─── Core run (builds timeline, optionally anonymizes, writes HANDOFF.md) ───
  // Reads the snapshot captured at trigger time (survives the clearTranscripts race). Resolves only
  // after the file write completes, so useRecordingStop can await it before navigating away.
  const runHandoff = useCallback(async (anonymize: boolean): Promise<void> => {
    setIsGenerating(true);
    try {
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
      if (anonymize) {
        try {
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
      const filePath = `${folderPathRef.current}/HANDOFF.md`;

      // Capture the previous file content (if any) BEFORE overwriting, so Undo can restore it.
      // read_file_if_exists returns null for a missing/empty file — in that case Undo deletes.
      let prevContent: string | null = null;
      try {
        prevContent = await invoke<string | null>('read_file_if_exists', { path: filePath });
      } catch {
        prevContent = null;
      }

      await invoke('save_transcript', { filePath, content: markdown });

      const undoHandoff = async () => {
        try {
          if (prevContent !== null) {
            await invoke('save_transcript', { filePath, content: prevContent });
          } else {
            // File didn't exist before — remove the one we just wrote.
            // Use the unscoped Rust command, not plugin-fs remove() (fs:scope is $APPDATA-only,
            // but HANDOFF.md lives in the recordings/project folder outside $APPDATA).
            await invoke('delete_file', { path: filePath });
          }
          toast.success('Handoff undone');
        } catch (err) {
          console.error('Failed to undo handoff:', err);
          toast.error('Could not undo the handoff', {
            description: `The write already succeeded but ${prevContent !== null ? 'restoring' : 'deleting'} ${filePath} failed. Open the folder and adjust it by hand.`,
          });
        }
      };

      toast.success('Handoff file saved', {
        description: `${filePath} · ${anonymized ? 'Anonymized PII' : 'Raw text'} · Change in Settings > General`,
        action: {
          label: 'Undo',
          onClick: () => { void undoHandoff(); },
        },
        cancel: {
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
      snapshotRef.current = null;
    }
  }, []);

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

    // Has the user already made an anonymize choice? If so, run fire-and-forget with no dialog.
    let prefSet = false;
    try { prefSet = localStorage.getItem(HANDOFF_PREF_SET_STORAGE_KEY) === '1'; } catch { /* ignore */ }

    if (prefSet) {
      let savedPref = false;
      try { savedPref = localStorage.getItem(HANDOFF_ANONYMIZE_STORAGE_KEY) === '1'; } catch { /* ignore */ }
      // Return runHandoff's promise so callers still await the actual write.
      return (async () => {
        let available = false;
        try {
          const health = await checkAnonymizationHealth();
          available = health.available;
        } catch {
          available = false;
        }
        await runHandoff(savedPref && available);
      })();
    }

    // First-ever use: show the dialog and let the user choose (and remember) the setting.
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
  }, [anonymizationEnabled, runHandoff, transcriptsRef, screenshots, clipboardItems, conversation, recordingDuration, meetingId, entityMap]);

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
    // Persist the choice: touching the dialog counts as making it, so future handoffs run instantly.
    try {
      localStorage.setItem(HANDOFF_ANONYMIZE_STORAGE_KEY, anonymizeChecked ? '1' : '0');
      localStorage.setItem(HANDOFF_PREF_SET_STORAGE_KEY, '1');
    } catch { /* ignore */ }

    try {
      await runHandoff(anonymizeChecked && !!piiAvailable);
    } finally {
      setShowHandoffDialog(false);
      dialogResolveRef.current?.();
      dialogResolveRef.current = null;
    }
  }, [anonymizeChecked, piiAvailable, runHandoff]);

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