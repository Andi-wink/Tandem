import { MutableRefObject, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Transcript } from '@/types';

interface UseAutoMeetingTitleArgs {
  /** Recording duration counted only while NOT paused, in seconds */
  activeDuration: number | null;
  /** True while recording is active (used to reset between sessions) */
  isRecording: boolean;
  /** Current meeting id (resets the trigger when this changes) */
  meetingId: string | null | undefined;
  /** Current meeting title — used to skip auto-rename if the user pre-named it */
  currentTitle: string | null | undefined;
  /** Backend base URL, e.g. http://localhost:5167 */
  serverAddress: string;
  /** LLM provider (claude/groq/openai/ollama) */
  provider: string;
  /** LLM model name */
  modelName: string;
  /** API key for the provider, if applicable */
  apiKey: string | null;
  /** Live transcripts ref (read on trigger; don't subscribe to updates) */
  transcriptsRef: MutableRefObject<Transcript[]>;
  /** Called after the title is updated successfully */
  onRenamed?: (newTitle: string) => void;
  /** Master switch — disable in tests / when user has opted out */
  enabled?: boolean;
  /** Trigger threshold in seconds (default 120) */
  triggerAfterSec?: number;
}

const DEFAULT_TITLE_PATTERN = /^Meeting \d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;
const NEW_CALL_TITLE = '+ New Call';
const MAX_SNIPPET_WORDS = 100;

function formatDateDDMMYYYY(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function isDefaultTitle(title: string | null | undefined): boolean {
  if (!title) return true;
  if (title === NEW_CALL_TITLE) return true;
  return DEFAULT_TITLE_PATTERN.test(title);
}

function buildSnippet(transcripts: Transcript[]): string {
  const text = transcripts.map(t => t.text).join(' ').trim();
  if (!text) return '';
  const words = text.split(/\s+/);
  if (words.length <= MAX_SNIPPET_WORDS) return text;
  return words.slice(0, MAX_SNIPPET_WORDS).join(' ');
}

/**
 * Auto-generates a meeting title via LLM after the first 2 minutes of active
 * recording. Renames the meeting in the database (so the sidebar reflects it
 * on next refetch). Idempotent per meeting — fires at most once.
 *
 * Skips when:
 *  - feature disabled
 *  - meeting already has a non-default title (user renamed it)
 *  - no transcript yet
 *  - LLM call fails (silent — keeps the default name)
 */
export function useAutoMeetingTitle({
  activeDuration,
  isRecording,
  meetingId,
  currentTitle,
  serverAddress,
  provider,
  modelName,
  apiKey,
  transcriptsRef,
  onRenamed,
  enabled = true,
  triggerAfterSec = 120,
}: UseAutoMeetingTitleArgs): void {
  const triggeredRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  // Reset the trigger when the meeting changes or a new recording starts
  useEffect(() => {
    if (!isRecording) {
      triggeredRef.current = null;
    }
  }, [isRecording, meetingId]);

  useEffect(() => {
    if (!enabled) return;
    if (!isRecording) return;
    if (activeDuration === null || activeDuration < triggerAfterSec) return;
    if (!meetingId || meetingId === 'intro-call') return;
    if (triggeredRef.current === meetingId) return;
    if (inFlightRef.current) return;
    if (!isDefaultTitle(currentTitle)) {
      triggeredRef.current = meetingId;
      return;
    }
    if (!serverAddress) return;

    const snippet = buildSnippet(transcriptsRef.current);
    if (!snippet) return;

    triggeredRef.current = meetingId;
    inFlightRef.current = true;

    (async () => {
      try {
        const baseUrl = serverAddress.startsWith('http')
          ? serverAddress
          : `http://${serverAddress}`;

        const response = await fetch(`${baseUrl}/generate-title`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: snippet,
            provider,
            model_name: modelName,
            api_key: apiKey,
          }),
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          console.warn('[auto-title] generate-title failed', response.status, detail);
          return;
        }

        const payload = (await response.json()) as { title?: string };
        const aiTitle = (payload.title || '').trim();
        if (!aiTitle) {
          console.warn('[auto-title] empty title returned');
          return;
        }

        const finalTitle = `${aiTitle} ${formatDateDDMMYYYY(new Date())}`;

        await invoke('api_save_meeting_title', {
          meetingId,
          title: finalTitle,
        });

        console.log('[auto-title] renamed meeting to', finalTitle);
        onRenamed?.(finalTitle);
      } catch (err) {
        console.warn('[auto-title] failed:', err);
      } finally {
        inFlightRef.current = false;
      }
    })();
  }, [
    activeDuration,
    isRecording,
    meetingId,
    currentTitle,
    serverAddress,
    provider,
    modelName,
    apiKey,
    enabled,
    triggerAfterSec,
    onRenamed,
    transcriptsRef,
  ]);
}
