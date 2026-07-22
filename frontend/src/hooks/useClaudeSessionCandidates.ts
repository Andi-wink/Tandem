'use client';

/**
 * F055: Poll live Claude Code session candidates for the Solo HUD picker.
 *
 * Refreshes immediately when `enabled` flips true (picker opens), then polls
 * `list_claude_session_candidates` every `pollIntervalMs` (default 3s) while
 * enabled. Does not poll while collapsed. Fails silent-to-manual: invoke errors
 * resolve to [] (handled in the service), so the picker just shows no live
 * sessions rather than erroring.
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
      if (!cancelledRef.current) setCandidates(list);
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
