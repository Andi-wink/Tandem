'use client';

/**
 * F055: Poll live Claude Code session candidates for the Solo HUD picker.
 *
 * Polls `list_claude_session_candidates` every 15s while `enabled`. Fails
 * silent-to-manual: invoke errors resolve to [] (handled in the service), so
 * the picker just shows no live sessions rather than erroring.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listClaudeSessionCandidates,
  type ClaudeSessionCandidate,
} from '@/services/claudeSessionService';

const POLL_INTERVAL_MS = 15_000;

export interface UseClaudeSessionCandidates {
  candidates: ClaudeSessionCandidate[];
  refresh: () => void;
  loading: boolean;
}

export function useClaudeSessionCandidates(enabled: boolean): UseClaudeSessionCandidates {
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

    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(timer);
    };
  }, [enabled, refresh]);

  return { candidates, refresh, loading };
}
