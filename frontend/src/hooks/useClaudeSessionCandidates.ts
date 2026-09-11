'use client';

/**
 * F055: Poll live Claude Code session candidates for the Solo HUD picker.
 *
 * Refreshes immediately when `enabled` flips true (picker opens), then polls
 * `list_claude_session_candidates` every `pollIntervalMs` (default 3s) while
 * enabled. Does not poll while collapsed. Fails silent-to-manual: invoke errors
 * resolve to [] (handled in the service), so the picker just shows no live
 * sessions rather than erroring.
 *
 * STABLE ROW ORDER: the Rust side re-sorts by last activity every poll, so a
 * naive replace would make rows leapfrog under the cursor and cause misclicks.
 * Instead we FREEZE the order established when the picker opened: each refresh is
 * merged by `session_id` — existing rows are updated in place (times, branch,
 * title, mismatch), genuinely new sessions are appended at the END, and vanished
 * sessions are dropped. The frozen order is reset only when `enabled` flips
 * false→true (the picker reopens).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listClaudeSessionCandidates,
  type ClaudeSessionCandidate,
} from '@/services/claudeSessionService';

const DEFAULT_POLL_INTERVAL_MS = 3_000;

export interface UseClaudeSessionCandidates {
  candidates: ClaudeSessionCandidate[];
  refresh: () => void;
  loading: boolean;
}

export function useClaudeSessionCandidates(
  enabled: boolean,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): UseClaudeSessionCandidates {
  const [candidates, setCandidates] = useState<ClaudeSessionCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const inFlightRef = useRef(false);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    try {
      const list = await listClaudeSessionCandidates();
      if (cancelledRef.current) return;
      // Merge into the frozen order: update existing rows in place, append new
      // sessions at the end, drop vanished ones. This keeps rows from leaping
      // under the cursor between polls.
      setCandidates(prev => {
        const incoming = new Map(list.map(c => [c.session_id, c]));
        const merged: ClaudeSessionCandidate[] = [];
        const kept = new Set<string>();
        for (const existing of prev) {
          const next = incoming.get(existing.session_id);
          if (next) {
            merged.push(next); // update in place, same slot
            kept.add(existing.session_id);
          }
          // else: session vanished → dropped
        }
        for (const c of list) {
          if (!kept.has(c.session_id)) merged.push(c); // genuinely new → append
        }
        return merged;
      });
    } finally {
      inFlightRef.current = false;
      if (!cancelledRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    if (!enabled) {
      setCandidates([]);
      return;
    }

    // Fire immediately on enable, then poll while enabled.
    refresh();
    const timer = setInterval(refresh, pollIntervalMs);
    return () => {
      cancelledRef.current = true;
      clearInterval(timer);
    };
  }, [enabled, pollIntervalMs, refresh]);

  return { candidates, refresh, loading };
}
