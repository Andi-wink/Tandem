'use client';

/**
 * useMeetingJots: reactive wrapper over the pure meetingJots store for the live jot strip.
 *
 * The pure store (sessionStorage) is the single source of truth; this hook mirrors it into React
 * state and keeps the binding correct across a recording's lifecycle:
 *   - On mount it hydrates from sessionStorage, so a mid-call reload keeps every jot.
 *   - It clears the slot on the genuine `recording-started` event (which never re-fires on reload),
 *     so a fresh recording starts empty and jots never leak from the previous call.
 *
 * The stop path reads the store directly (readJots) and clears it after serializing, so this hook does
 * not need to coordinate the save.
 */

import { useCallback, useEffect, useState } from 'react';
import { recordingService } from '@/services/recordingService';
import { addJot, deleteJot, editJot, readJots, clearJots, type Jot } from '@/lib/meetingJots';
import { rescueJotsToDisk } from '@/lib/jotsRescue';

export interface UseMeetingJotsReturn {
  jots: Jot[];
  add: (content: string, audioMs: number | null) => void;
  edit: (id: string, content: string) => void;
  remove: (id: string) => void;
}

export function useMeetingJots(): UseMeetingJotsReturn {
  const [jots, setJots] = useState<Jot[]>([]);

  // Hydrate from sessionStorage on mount (reload survival).
  useEffect(() => {
    setJots(readJots());
  }, []);

  // Bind to a fresh recording: clear on the genuine start event only.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;
    (async () => {
      try {
        const un = await recordingService.onRecordingStarted(() => {
          // The store is normally empty at a new start (the stop path clears it after persisting). If it
          // still holds jots here, they only survived a failed persist or a crash, and clearing now would
          // silently destroy them: an I5b handover can start a recording with zero user action. Rescue
          // them first (best effort, fire-and-forget), then clear.
          const pending = readJots();
          if (pending.length > 0) {
            void rescueJotsToDisk(pending, 'Recording (rescued at next start)');
          }
          clearJots();
          setJots([]);
        });
        if (!mounted) { un(); return; }
        unlisten = un;
      } catch {
        // Event wiring unavailable: the strip still works, it just won't auto-clear on start.
      }
    })();
    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, []);

  const add = useCallback((content: string, audioMs: number | null) => {
    setJots(addJot(content, audioMs));
  }, []);

  const edit = useCallback((id: string, content: string) => {
    setJots(editJot(id, content));
  }, []);

  const remove = useCallback((id: string) => {
    setJots(deleteJot(id));
  }, []);

  return { jots, add, edit, remove };
}
