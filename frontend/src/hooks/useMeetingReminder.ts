'use client';

/**
 * useMeetingReminder: drives the pre-meeting recording prompt and the mid-recording handover (I5/I5b).
 *
 * Every 15s (and immediately, and whenever the calendar events change) it asks the pure
 * MeetingReminderEngine whether a call is about to start, and in which mode:
 *
 *  - IDLE ('dialog' mode): compute the project match, bring the window forward, fire a backup OS
 *    notification, and surface the in-app dialog. The user chooses Start / Snooze / Dismiss; it never
 *    auto-starts.
 *  - ALREADY RECORDING ('handover' mode, I5b): being mid-call must never be disturbed, so there is no
 *    focus grab and no modal. Instead a calm sonner toast (plus a backup OS notification) offers to
 *    "Wrap up and start next": it stops the current recording through the SAME path as the hotkey/UI
 *    stop, AWAITS the save + auto-summary, then starts the next meeting titled with the calendar
 *    invite and filed under the matched folder. Ignoring it leaves the current recording untouched.
 *
 * It de-dupes per occurrence and mirrors its fired set into sessionStorage so a fast reload inside the
 * window does not re-prompt. All the "which event / which mode / when to stop surfacing" logic lives
 * in lib/meetingReminder.ts (vitest-tested); this hook owns the ticker, the async match, the toast,
 * and the Tauri side effects.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useCalendar } from '@/contexts/CalendarContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useRecordingStopControls } from '@/contexts/RecordingPostProcessingProvider';
import type { CalendarEvent } from '@/lib/ics';
import { Project } from '@/services/projectService';
import { getMatchPool } from '@/services/clientFolderDiscovery';
import { rankEventProjectCandidates, type EventMatchResult } from '@/services/calendarEventMatcher';
import { startRecordingForEvent } from '@/lib/startFromEvent';
import {
  MeetingReminderEngine,
  reminderKey,
  canSurfaceReminder,
  AUTO_DISMISS_AFTER_START_MS,
  PAST_GRACE_MS,
  DEFAULT_LEAD_MS,
  type ReminderMode,
} from '@/lib/meetingReminder';

export const REMINDER_ENABLED_KEY = 'tandem.reminder.enabled';
export const REMINDER_LEAD_SECS_KEY = 'tandem.reminder.leadSecs';
const REMINDER_FIRED_KEY = 'tandem.reminder.fired';
const TICK_MS = 15_000;
/** A handover toast stays visible at least this long even if the call has already started. */
const HANDOVER_MIN_DURATION_MS = 12_000;

export interface ActiveReminder {
  event: CalendarEvent;
  match: EventMatchResult;
  mode: ReminderMode;
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

/** Human "in Xs / in N min / now" for an imminent call, computed once at show time. */
function startsInLabel(startMs: number): string {
  const secs = Math.round((startMs - Date.now()) / 1000);
  if (secs <= 0) return 'now';
  if (secs < 60) return `in ${secs}s`;
  return `in ${Math.round(secs / 60)} min`;
}

export function useMeetingReminder() {
  // Peek over the FULL expanded window (yesterday..+7d), not the per-poll todayEvents snapshot. The
  // engine already scopes eligibility to the lead/grace window around now, so the wider set costs
  // nothing but fixes the local-midnight rollover: an event on the NEW day is present the instant its
  // lead window opens, instead of being absent until the next poll re-snapshots todayEvents (by which
  // point a just-started call is already past PAST_GRACE_MS and lost forever).
  const { events, configured } = useCalendar();
  const { isRecording } = useRecordingState();
  const { stopActiveRecording } = useRecordingStopControls();

  // The handover is mounted app-wide (via MeetingReminderDialog in the root layout), so it can fire
  // from any route. The seeded start only reaches the on-screen controls on the home route; off route
  // we must navigate home and let the auto-start flag drive the start (mirrors the I4 off-route
  // hotkey). Read route + router through refs so the toast action always sees current values without
  // rebuilding the callback (and thus the ticker) on every navigation.
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  const [reminder, setReminder] = useState<ActiveReminder | null>(null);
  const reminderRef = useRef<ActiveReminder | null>(null);
  reminderRef.current = reminder;

  // Mirror isRecording into a ref so runTick / the dequeue effect can re-check it AFTER their async
  // match resolves. Reading the closure-captured `isRecording` would only reflect the value at tick
  // start, missing a recording the user began (or ended) during the getMatchPool() gap.
  const isRecordingRef = useRef(isRecording);
  isRecordingRef.current = isRecording;

  const engineRef = useRef<MeetingReminderEngine | null>(null);
  const pendingRef = useRef(false);
  // Reminders that fired while a DIALOG was open, shown one at a time as it closes. Handover toasts do
  // not use the dialog surface, so they are not gated by this; but a dialog-mode item that was queued
  // while idle converts to a handover if a recording has begun by the time it is dequeued.
  const queueRef = useRef<ActiveReminder[]>([]);
  // Re-entry guard for the handover action: one stop-then-start at a time, even if the user clicks the
  // toast button twice or a duplicate toast exists.
  const handoverInProgressRef = useRef(false);

  /**
   * After a stop resolves, the global recording state does not flip to not-recording synchronously:
   * it updates via the 'recording-stopped' event / state poll, which React then commits and uses to
   * re-register the on-screen controls' start listener. Dispatch the next start before that settles
   * and the controls DROP it (their live listener still believes a recording is active). So wait for
   * the state to read not-recording, then let React flush the listener re-registration, before
   * starting. Bounded so a stuck state never hangs the handover forever.
   */
  const waitForNotRecording = useCallback(async (timeoutMs = 5000): Promise<void> => {
    const started = Date.now();
    while (isRecordingRef.current && Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // One more tick so the controls' listener re-registers with the fresh (not-recording) closure.
    await new Promise((r) => setTimeout(r, 100));
  }, []);

  /**
   * Inverse of waitForNotRecording: after the seeded start is dispatched, block (bounded) until the
   * global isRecording flips back to true. The handover guard (handoverInProgressRef) must stay set
   * across this gap, otherwise a 15s tick landing between "start dispatched" and "isRecording === true"
   * would see idle and surface a focus-stealing DIALOG for a THIRD imminent event during what is still
   * a live-call transition. Bounded so a start that never registers cannot pin the guard forever.
   */
  const waitForRecording = useCallback(async (timeoutMs = 10000): Promise<void> => {
    const started = Date.now();
    while (!isRecordingRef.current && Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }, []);

  // Build the engine once, hydrating the fired/snoozed set from sessionStorage so a reload inside an
  // active window does not re-prompt.
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

  /**
   * Handover action (I5b): stop the current recording through the SAME path as the hotkey/UI stop,
   * AWAIT its post-processing (transcripts saved, auto-summary latch fired), then start the next
   * meeting seeded with the calendar invite title and matched folder. If the stop fails we surface an
   * error and do NOT start, so we never leave the user with the previous call abandoned and no new one.
   */
  const wrapUpAndStartNext = useCallback(async (ev: CalendarEvent) => {
    if (handoverInProgressRef.current) return;
    handoverInProgressRef.current = true;
    // Disable the on-screen Start button for the whole handover. The stop flips isRecording false
    // partway through (before the seeded start fires), which would otherwise re-enable the button and
    // let a manual click race an unrelated, unseeded recording against ours. The seeded start uses the
    // request-start EVENT (left ungated), so this only blocks the physical button, not our own start.
    window.dispatchEvent(new CustomEvent('tandem:recording-transition', { detail: { active: true } }));
    try {
      console.log('[HANDOVER] stopping current recording');
      try {
        await stopActiveRecording();
        console.log('[HANDOVER] stop resolved; waiting for recording state to settle');
      } catch (err) {
        toast.error("Couldn't wrap up the current recording", {
          description: `${err instanceof Error ? err.message : String(err)} It is still running; nothing new was started.`,
        });
        return;
      }
      // Stop resolved: the previous meeting is saved and its summary is underway. Now start the next.
      // No opts: same consent semantics as the dialog's implicit start (strong auto-files, ambiguous
      // opens the picker without blocking, none is title-only). The seed's 2-min TTL is set INSIDE
      // startRecordingForEvent, i.e. after the (possibly long) stop, so it never expires in the gap.
      try {
        // Wait for the global recording state to reflect the stop before dispatching the start, so the
        // on-screen controls (which gate on isRecording) accept it instead of silently dropping it.
        await waitForNotRecording();
        // Defence in depth: if a recording is somehow active again (e.g. the user manually started one
        // despite the disabled button, via the palette, etc.), do NOT dispatch a second start_recording
        // — their recording wins; we simply could not seed it. Prevents a double start.
        if (isRecordingRef.current) {
          toast.dismiss(`handover-${reminderKey(ev)}`);
          return;
        }
        console.log('[HANDOVER] recording state settled; starting next');
        // startRecordingForEvent seeds sessionStorage (title + matched folder) and dispatches the
        // request-start event. On the home route the mounted controls hear that event and start. Off
        // route nobody hears it, so also raise the auto-start flag and navigate home, where the
        // auto-start effect consumes the same seed — mirroring the I4 off-route hotkey start.
        await startRecordingForEvent(ev);
        if (pathnameRef.current !== '/') {
          try {
            sessionStorage.setItem('autoStartRecording', 'true');
          } catch { /* sessionStorage unavailable — navigation below still lands the user on home */ }
          routerRef.current.push('/');
        }
        console.log('[HANDOVER] startRecordingForEvent dispatched');
        toast.dismiss(`handover-${reminderKey(ev)}`);
        // Keep the handover guard set (via the finally below, which only runs after this await) until
        // the NEW recording's global isRecording actually flips true. Clearing the instant the start is
        // DISPATCHED opens a gap where a tick sees isRecording=false and pops a focus-stealing dialog
        // for a third imminent event mid-transition. Bounded so a start that never registers still frees
        // the guard (the finally runs regardless).
        await waitForRecording();
        console.log('[HANDOVER] next recording active; releasing handover guard');
      } catch (err) {
        toast.error("Couldn't start the next recording", {
          description: `${err instanceof Error ? err.message : String(err)} The previous meeting was saved.`,
        });
      }
    } finally {
      handoverInProgressRef.current = false;
      // Re-enable the on-screen Start button. In the finally so a stop/start failure never leaves it
      // stuck disabled. By now our own seeded start has already been dispatched (ungated), so the
      // re-enable cannot let a manual click pre-empt it.
      window.dispatchEvent(new CustomEvent('tandem:recording-transition', { detail: { active: false } }));
    }
  }, [stopActiveRecording, waitForNotRecording, waitForRecording]);

  /** Surface a handover: a calm toast + backup OS notification. No focus grab, no modal (I5b). */
  const showHandover = useCallback((active: ActiveReminder) => {
    const ev = active.event;
    const graceLeft = ev.startMs + PAST_GRACE_MS - Date.now();
    toast(`Next: ${ev.summary}`, {
      id: `handover-${reminderKey(ev)}`,
      description: `Starts ${startsInLabel(ev.startMs)}. Wrap up your current recording to start it.`,
      duration: Math.max(HANDOVER_MIN_DURATION_MS, graceLeft),
      action: {
        label: 'Wrap up and start next',
        onClick: () => { void wrapUpAndStartNext(ev); },
      },
    });
    // pingTaskbar already no-ops when the window is focused, so it only nudges a minimized/background
    // app. Deliberately NO focus_main_window and NO unminimize: a live call must not be disturbed.
    void pingTaskbar();
    void invoke('notify_meeting_starting', {
      title: 'Next meeting starting',
      body: ev.summary,
    }).catch(() => {
      // Notification unavailable: the toast is the primary surface anyway.
    });
  }, [wrapUpAndStartNext]);

  /** Surface a dialog: set the dialog state and run the attention-grabbing side effects (I5). */
  const showDialog = useCallback((active: ActiveReminder) => {
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

  /** Route a committed reminder to its surface by mode. */
  const showReminder = useCallback((active: ActiveReminder) => {
    if (active.mode === 'handover') showHandover(active);
    else showDialog(active);
  }, [showHandover, showDialog]);

  const runTick = useCallback(async () => {
    if (typeof window === 'undefined') return;
    if (!configured || !readEnabled()) return;
    if (pendingRef.current) return;
    // While a handover is stopping the current call and seeding the next, isRecording flips false
    // mid-flow. Surfacing here would (a) fire a focus-stealing DIALOG for a THIRD event that entered
    // its window during the gap — forbidden by the I5b spec during a live call — and (b) compete with
    // the handover itself. Skip; the occurrence is never marked fired, so it re-evaluates on the next
    // tick (once the next recording is active, it correctly surfaces as a calm handover).
    if (!canSurfaceReminder(handoverInProgressRef.current)) return;

    const engine = engineRef.current!;
    engine.setLeadMs(readLeadMs()); // pick up a live lead-time change from Settings

    // Peek WITHOUT marking fired. Events already shown or queued are already marked, so peek skips
    // them: this lets a second back-to-back call surface even while the first dialog is still open.
    // Recording no longer suppresses (I5b): it only flips the mode to 'handover'.
    const pick = engine.peek(events, Date.now(), isRecording);
    if (!pick) return;
    const ev = pick.event;

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
      // Re-check AFTER the async gap. An event that slipped out of its window must not surface; a
      // recording that began (or ended) during the match re-derives the mode. Because we have not
      // marked the occurrence fired yet, bailing here leaves it free to fire on a later tick, and a
      // reload mid-gap cannot lose a prompt the user never saw.
      const fresh = engine.peek([ev], Date.now(), isRecordingRef.current);
      if (!fresh || fresh.event !== ev) return;

      const active: ActiveReminder = { event: ev, match, mode: fresh.mode };
      // A dialog is open: queue WITHOUT marking fired (queueRef is in-memory only; persisting a
      // "fired" state now would permanently lose the reminder on a reload while it waits). markFired +
      // persist happen only when it is dequeued and shown. A handover, being a non-modal toast, is not
      // blocked by an open dialog, but reminderRef is only ever set for a dialog, so an in-flight
      // dialog defers everything until it closes — matching the single-surface intent.
      if (reminderRef.current) {
        const key = reminderKey(ev);
        if (!queueRef.current.some((a) => reminderKey(a.event) === key)) {
          queueRef.current.push(active);
        }
      } else {
        // Commit synchronously so nothing can interleave between marking fired and showing.
        engine.markFired(ev);
        persist();
        showReminder(active);
      }
    } finally {
      pendingRef.current = false;
    }
  }, [configured, isRecording, events, persist, showReminder]);

  // 15s ticker. Re-arming on events / isRecording change means a freshly loaded calendar or a
  // changed recording state is evaluated right away rather than up to 15s later.
  useEffect(() => {
    if (!configured) return;
    void runTick();
    const id = setInterval(() => { void runTick(); }, TICK_MS);
    return () => clearInterval(id);
  }, [configured, runTick]);

  // When a recording BEGINS by any path, an open pre-meeting DIALOG is moot ("start recording?" while
  // already recording) so close it. Its occurrence is already marked fired (persist-at-show), so it
  // will not re-surface. Crucially we do NOT drop the queue (I5b): queued/future items convert to
  // handover mode when the dequeue effect / ticker surfaces them, rather than being silently lost.
  useEffect(() => {
    if (!isRecording) return;
    if (reminderRef.current) setReminder(null);
  }, [isRecording]);

  // When no dialog is open, drain the queue. Queued items were deliberately NOT marked fired when
  // enqueued (see runTick), so commit them here, at the moment they are shown. Re-validate each on
  // dequeue and re-derive its mode from the CURRENT recording state: an item queued while idle becomes
  // a handover if a recording has since begun. A stale item (past its grace window) is dropped WITHOUT
  // marking it fired (harmless: past grace it can never fire again anyway). Handover toasts stack, so
  // we keep draining them; a dialog stops the drain (one modal at a time).
  useEffect(() => {
    if (reminder) return;
    // Same guard as runTick: never drain (and thus never open a focus-stealing dialog) while a
    // handover is mid-flight and isRecording is transiently false. Queued items stay queued and
    // re-surface after the handover, in the correct mode.
    if (!canSurfaceReminder(handoverInProgressRef.current)) return;
    const engine = engineRef.current!;
    let next = queueRef.current.shift();
    while (next) {
      if (reminderRef.current) return; // a dialog opened mid-drain: defer the rest
      const pick = engine.peek([next.event], Date.now(), isRecordingRef.current);
      if (pick && pick.event === next.event) {
        const active: ActiveReminder = { event: next.event, match: next.match, mode: pick.mode };
        engine.markFired(next.event);
        persist();
        showReminder(active);
        if (pick.mode === 'dialog') return; // one dialog at a time; handovers keep draining
      }
      next = queueRef.current.shift();
    }
  }, [reminder, isRecording, showReminder, persist]);

  // Auto-dismiss an unattended DIALOG two minutes after the call's start. Handover toasts self-expire
  // via their sonner duration, so this only governs the dialog surface.
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

  /** Start recording for the prompted call (dialog path). A chosen project counts as consent (R1). */
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
