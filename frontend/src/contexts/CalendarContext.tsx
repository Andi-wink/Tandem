'use client';

/**
 * CalendarContext — read-only calendar (ICS) overlay.
 *
 * Privacy-first, no OAuth: the ICS URL is stored locally (Rust SQLite) and fetched in Rust
 * (`fetch_calendar_ics`, CORS-free). We parse it locally with `lib/ics.ts` and expand a small
 * window (yesterday .. +7 days) so today's calls are always available. Polling is fire-and-forget
 * and errors keep the last-good events — the overlay must never block or spam during a call.
 */

import React, {
  createContext, useContext, useState, useCallback, useEffect, useRef,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  parseIcs, expandOccurrences, eventsForToday, type CalendarEvent,
} from '@/lib/ics';

interface CalendarConfig {
  icsUrl: string | null;
  refreshMinutes: number;
}

interface CalendarContextType {
  /** Expanded occurrences across the yesterday..+7d window, sorted by start. */
  events: CalendarEvent[];
  /** Events overlapping today's local day. */
  todayEvents: CalendarEvent[];
  configured: boolean;
  isRefreshing: boolean;
  error: string | null;
  lastRefreshedMs: number | null;
  config: CalendarConfig;
  /** Resolves with the fresh today-count, or null on error (state closures would be stale). */
  refresh: () => Promise<{ todayCount: number } | null>;
  saveConfig: (icsUrl: string | null, refreshMinutes: number) => Promise<void>;
}

const DEFAULT_CONFIG: CalendarConfig = { icsUrl: null, refreshMinutes: 15 };

const CalendarContext = createContext<CalendarContextType | null>(null);

export const useCalendar = (): CalendarContextType => {
  const ctx = useContext(CalendarContext);
  if (!ctx) throw new Error('useCalendar must be used within a CalendarProvider');
  return ctx;
};

export function CalendarProvider({ children }: { children: React.ReactNode }) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [todayEvents, setTodayEvents] = useState<CalendarEvent[]>([]);
  const [config, setConfig] = useState<CalendarConfig>(DEFAULT_CONFIG);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshedMs, setLastRefreshedMs] = useState<number | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const configuredRef = useRef(false);

  const refresh = useCallback(async (): Promise<{ todayCount: number } | null> => {
    if (!configuredRef.current) return null;
    setIsRefreshing(true);
    try {
      const ics = await invoke<string>('fetch_calendar_ics');
      const parsed = parseIcs(ics);
      const now = Date.now();
      const windowStart = now - 24 * 60 * 60 * 1000; // yesterday (catch in-progress)
      const windowEnd = now + 7 * 24 * 60 * 60 * 1000; // +7 days
      const expanded = expandOccurrences(parsed, windowStart, windowEnd);
      const today = eventsForToday(expanded, now);
      setEvents(expanded);
      setTodayEvents(today);
      setLastRefreshedMs(now);
      setError(null);
      return { todayCount: today.length };
    } catch (e) {
      // Keep last-good events; surface a clean, URL-free message.
      const msg = typeof e === 'string' ? e : (e as Error)?.message || 'Could not load the calendar.';
      setError(msg);
      return null;
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  // Load config on mount (guarded for non-Tauri env), then start polling.
  const loadConfig = useCallback(async () => {
    try {
      const cfg = await invoke<{ icsUrl: string | null; refreshMinutes: number }>('api_get_calendar_config');
      const next: CalendarConfig = {
        icsUrl: cfg?.icsUrl ?? null,
        refreshMinutes: cfg?.refreshMinutes ?? 15,
      };
      setConfig(next);
      configuredRef.current = !!(next.icsUrl && next.icsUrl.trim());
      return next;
    } catch {
      // Non-Tauri (e.g. plain browser) or first-run: stay unconfigured, do not throw.
      configuredRef.current = false;
      setConfig(DEFAULT_CONFIG);
      return DEFAULT_CONFIG;
    }
  }, []);

  const startPolling = useCallback((minutes: number) => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    const safeMinutes = Math.max(5, minutes || 15);
    intervalRef.current = setInterval(() => { void refresh(); }, safeMinutes * 60 * 1000);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfg = await loadConfig();
      if (cancelled) return;
      if (configuredRef.current) {
        void refresh();
        startPolling(cfg.refreshMinutes);
      }
    })();
    return () => {
      cancelled = true;
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    };
  }, [loadConfig, refresh, startPolling]);

  const saveConfig = useCallback(async (icsUrl: string | null, refreshMinutes: number) => {
    const trimmed = icsUrl && icsUrl.trim() ? icsUrl.trim() : null;
    await invoke('api_save_calendar_config', { icsUrl: trimmed, refreshMinutes });
    const next: CalendarConfig = { icsUrl: trimmed, refreshMinutes };
    setConfig(next);
    configuredRef.current = !!trimmed;
    if (!trimmed) {
      // Calendar cleared: stop polling and clear state.
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      setEvents([]);
      setTodayEvents([]);
      setError(null);
      setLastRefreshedMs(null);
      return;
    }
    // Config changed: refresh now and restart the timer at the new interval.
    await refresh();
    startPolling(refreshMinutes);
  }, [refresh, startPolling]);

  const value: CalendarContextType = {
    events,
    todayEvents,
    configured: !!(config.icsUrl && config.icsUrl.trim()),
    isRefreshing,
    error,
    lastRefreshedMs,
    config,
    refresh,
    saveConfig,
  };

  return <CalendarContext.Provider value={value}>{children}</CalendarContext.Provider>;
}
