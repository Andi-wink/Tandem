'use client';

/**
 * useMeetingReminder: drives the pre-meeting recording prompt (I5).
 *
 * Every 15s (and immediately, and whenever today's calendar events change) it asks the pure
 * MeetingReminderEngine whether a call is about to start. When one is, it computes the project
 * match, brings the window forward, fires a backup OS notification, and surfaces an in-app dialog.
 * It NEVER auto-starts a recording: the user always chooses Start / Snooze / Dismiss. It never
 * fires while already recording, de-dupes per occurrence, and mirrors its fired set into
 * sessionStorage so a fast reload inside the window does not re-prompt.
 *
 * All the "which event / when to stop" logic lives in lib/meetingReminder.ts (vitest-tested); this
 * hook only owns the ticker, the async match, and the Tauri side effects.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useCalendar } from '@/contexts/CalendarContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import type { CalendarEvent } from '@/lib/ics';
import { Project } from '@/services/projectService';
import { getMatchPool } from '@/services/clientFolderDiscovery';
import { rankEventProjectCandidates, type EventMatchResult } from '@/services/calendarEventMatcher';
import { startRecordingForEvent } from '@/lib/startFromEvent';
import {
  MeetingReminderEngine,
  reminderKey,
  AUTO_DISMISS_AFTER_START_MS,
  DEFAULT_LEAD_MS,
} from '@/lib/meetingReminder';

export const REMINDER_ENABLED_KEY = 'tandem.reminder.enabled';
export const REMINDER_LEAD_SECS_KEY = 'tandem.reminder.leadSecs';
const REMINDER_FIRED_KEY = 'tandem.reminder.fired';
const TICK_MS = 15_000;

export interface ActiveReminder {
  event: CalendarEvent;
  match: EventMatchResult;
}

function readEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(REMINDER_ENABLED_KEY) !== '0';
}

function readLeadMs(): number {
  if (typeof window === 'undefined') return DEFAULT_LEAD_MS;
  const raw = Number(window.localStorage.getItem(REMINDER_LEAD_SECS_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : DEFAULT_LEAD_MS;
}

/** Flash the taskbar/dock when the window is not focused (mirrors NotificationContext). */
async function pingTaskbar(): Promise<void> {
  try {
    const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    if (await win.isFocused()) return;
    await win.requestUserAttention(UserAttentionType.Informational);
  } catch {
    // Not under Tauri: ignore.
  }
}

export function useMeetingReminder() {
  const { todayEvents, configured } = useCalendar();
  const { isRecording } = useRecordingState();

  const [reminder, setReminder] = useState<ActiveReminder | null>(null);
  const reminderRef = useRef<ActiveReminder | null>(null);
  reminderRef.current = reminder;

  // Mirror isRecording into a ref so runTick can re-check it AFTER its async match resolves.
  // Reading the closure-captured `isRecording` would only reflect the value at tick start, missing
  // a recording the user began during the getMatchPool() gap.
  const isRecordingRef = useRef(isRecording);
  isRecordingRef.current = isRecording;

  const engineRef = useRef<MeetingReminderEngine | null>(null);
  const pendingRef = useRef(false);
  // Reminders that fired while another dialog was open, shown one at a time as each closes. Without
  // this, a second back-to-back call's whole window can elapse while the first prompt sits open.
  const queueRef = useRef<ActiveReminder[]>([]);

  // Build the engine once, hydrating the fired/snoozed set from sessionStorage so a reload inside
  // an active window does not re-prompt.
  if (engineRef.current === null) {
    const engine = new MeetingReminderEngine({ leadMs: readLeadMs() });
    try {
      const raw = typeof window !== 'undefined' ? window.sessionStorage.getItem(REMINDER_FIRED_KEY) : null;
      if (raw) engine.hydrate(JSON.parse(raw));
    } catch {
      // Corrupt mirror: start clean.
    }
    engineRef.current = engine;
  }

  const persist = useCallback(() => {
    try {
      window.sessionStorage.setItem(REMINDER_FIRED_KEY, JSON.stringify(engineRef.current!.serialize()));
    } catch {
      // Storage disabled/full: the in-memory engine still de-dupes for this session.
    }
  }, []);

  /** Surface a reminder: set the dialog state and run the attention-grabbing side effects. */
  const showReminder = useCallback((active: ActiveReminder) => {
    setReminder(active);
    void pingTaskbar();
    void invoke('focus_main_window').catch(() => {
      // Not under Tauri: ignore.
    });
    void invoke('notify_meeting_starting', {
      title: 'Meeting starting',
      body: active.event.summary,
    }).catch(() => {
      // Notification unavailable: the in-app dialog is the primary surface anyway.
    });
  }, []);

  const runTick = useCallback(async () => {
    if (typeof window === 'undefined') return;
    if (!configured || !readEnabled()) return;
    if (pendingRef.current) return;

    const engine = engineRef.current!;
    engine.setLeadMs(readLeadMs()); // pick up a live lead-time change from Settings

    // Peek WITHOUT marking fired. Events already shown or queued are already marked, so peek skips
    // them: this lets a second back-to-back call surface even while the first dialog is still open.
    const ev = engine.peek(todayEvents, Date.now(), isRecording);
    if (!ev) return;

    pendingRef.current = true;
    try {
      // Refresh the match pool at fire time (not at mount) so a project registered mid-session is
      // reflected. Fall back to "no match" if discovery fails: the prompt still shows.
      let match: EventMatchResult = { candidates: [], confidence: 'none' };
      try {
        const { pool } = await getMatchPool();
        match = rankEventProjectCandidates(ev, pool);
      } catch {
        // keep 'none'
      }
      // Re-check AFTER the async gap. A recording that began during the match (isRecordingRef),
      // or an event that slipped out of its window, must not surface a prompt. Because we have not
      // marked the occurrence fired yet, bailing here leaves it free to fire on a later tick (e.g.
      // once the recording stops), and a reload mid-gap cannot lose a prompt the user never saw.
      if (isRecordingRef.current) return;
      if (engine.peek([ev], Date.now(), isRecordingRef.current) !== ev) return;

      const active: ActiveReminder = { event: ev, match };
      if (reminderRef.current) {
        // A dialog is already open. Queue this one WITHOUT marking it fired: queueRef is in-memory
        // only, so persisting a "fired" state now would permanently lose the reminder on a reload
        // while it waits (the first dialog can sit unattended up to ~120s). We markFired+persist
        // only when it is actually dequeued and shown. Because it is not yet suppressed, peek keeps
        // returning it every tick, so de-dupe against the queue to avoid piling up copies.
        const key = reminderKey(ev);
        if (!queueRef.current.some((a) => reminderKey(a.event) === key)) {
          queueRef.current.push(active);
        }
      } else {
        // Commit synchronously so nothing can interleave between marking fired and showing: no
        // reload can persist a "fired" state for a dialog that was never rendered.
        engine.markFired(ev);
        persist();
        showReminder(active);
      }
    } finally {
      pendingRef.current = false;
    }
  }, [configured, isRecording, todayEvents, persist, showReminder]);

  // 15s ticker. Re-arming on todayEvents / isRecording change means a freshly loaded calendar or a
  // stopped recording is evaluated right away rather than up to 15s later.
  useEffect(() => {
    if (!configured) return;
    void runTick();
    const id = setInterval(() => { void runTick(); }, TICK_MS);
    return () => clearInterval(id);
  }, [configured, runTick]);

  // If a recording begins by any other path, close any open prompt and drop the queue: nothing
  // should surface a "start recording?" prompt while a recording is already running.
  useEffect(() => {
    if (!isRecording) return;
    queueRef.current = [];
    if (reminderRef.current) setReminder(null);
  }, [isRecording]);

  // When a prompt closes (start / snooze / dismiss / auto-dismiss), surface the next queued one.
  // Queued items were deliberately NOT marked fired when enqueued (see runTick), so commit them
  // here, at the moment they are shown, mirroring the primary path's guarantee. Re-validate first:
  // a recording that started, or an item that went stale (past its grace window) while it waited,
  // must not surface. A stale item is dropped WITHOUT marking it fired (harmless: past grace it can
  // never fire again anyway, and we avoid persisting junk).
  useEffect(() => {
    if (reminder || isRecording) return;
    const engine = engineRef.current!;
    let next = queueRef.current.shift();
    while (next) {
      if (isRecordingRef.current) return; // recording began: leave the rest for the drop effect
      if (engine.peek([next.event], Date.now(), false) === next.event) {
        engine.markFired(next.event);
        persist();
        showReminder(next);
        return;
      }
      // Stale (or otherwise no longer eligible): skip without marking fired, try the next queued.
      next = queueRef.current.shift();
    }
  }, [reminder, isRecording, showReminder, persist]);

  // Auto-dismiss an unattended prompt two minutes after the call's start.
  useEffect(() => {
    if (!reminder) return;
    const dueIn = reminder.event.startMs + AUTO_DISMISS_AFTER_START_MS - Date.now();
    const id = setTimeout(() => {
      engineRef.current!.dismiss(reminder.event);
      persist();
      setReminder(null);
    }, Math.max(0, dueIn));
    return () => clearTimeout(id);
  }, [reminder, persist]);

  /** Start recording for the prompted call. A chosen project counts as explicit consent (R1). */
  const start = useCallback((chosen?: Project, signal?: string) => {
    const active = reminderRef.current;
    if (!active) return;
    void startRecordingForEvent(active.event, {
      confirmedProject: chosen,
      confirmedSignal: signal,
    });
    engineRef.current!.dismiss(active.event);
    persist();
    setReminder(null);
  }, [persist]);

  /** Snooze one minute (re-arms exactly once). */
  const snooze = useCallback(() => {
    const active = reminderRef.current;
    if (!active) return;
    engineRef.current!.snooze(active.event, Date.now());
    persist();
    setReminder(null);
  }, [persist]);

  /** Dismiss for good this session. */
  const dismiss = useCallback(() => {
    const active = reminderRef.current;
    if (!active) return;
    engineRef.current!.dismiss(active.event);
    persist();
    setReminder(null);
  }, [persist]);

  return { reminder, start, snooze, dismiss };
}
