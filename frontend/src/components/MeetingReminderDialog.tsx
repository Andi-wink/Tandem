'use client';

/**
 * MeetingReminderDialog: the pre-meeting recording prompt (I5).
 *
 * A calm in-app dialog that appears about a minute before a calendar call starts, asking whether
 * to start recording and suggesting the folder it will file under. It never auto-starts: the user
 * chooses Start recording, Snooze 1 min, or Dismiss. Closing by Escape / overlay / the X counts as
 * Dismiss (the occurrence will not prompt again this session).
 *
 * `MeetingReminderHost` wires the pure ticker (useMeetingReminder) to this presentational dialog
 * and is what layout mounts. Rendering the dialog is a no-op until a reminder is active.
 */

import React, { useEffect, useState } from 'react';
import { CalendarClock, Mic } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Project } from '@/services/projectService';
import { useMeetingReminder, type ActiveReminder } from '@/hooks/useMeetingReminder';

/** Sentinel radio value for "don't pre-file, let me choose after starting". */
const CHOOSE_LATER = '__choose_later__';

/** Live "starts in Xs" / "starting now" countdown, tabular so digits don't jitter. */
function useCountdownSeconds(startMs: number): number {
  const [secs, setSecs] = useState(() => Math.round((startMs - Date.now()) / 1000));
  useEffect(() => {
    const update = () => setSecs(Math.round((startMs - Date.now()) / 1000));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startMs]);
  return secs;
}

function CountdownLabel({ startMs }: { startMs: number }) {
  const secs = useCountdownSeconds(startMs);
  const label =
    secs <= 0
      ? 'starting now'
      : secs < 60
        ? `starts in ${secs}s`
        : `starts in ${Math.round(secs / 60)} min`;
  return (
    <span data-testid="reminder-countdown" className="tabular-nums text-muted-foreground">
      {label}
    </span>
  );
}

interface ReminderBodyProps {
  reminder: ActiveReminder;
  onStart: (chosen?: Project, signal?: string) => void;
  onSnooze: () => void;
  onDismiss: () => void;
}

function ReminderBody({ reminder, onStart, onSnooze, onDismiss }: ReminderBodyProps) {
  const { event, match } = reminder;
  const ambiguous = match.confidence === 'ambiguous';
  const strong = match.confidence === 'strong';

  // For an ambiguous match, the radio IS the disambiguation; preselect the top candidate's path.
  const [selected, setSelected] = useState<string>(() =>
    ambiguous ? match.candidates[0]?.project.path ?? CHOOSE_LATER : CHOOSE_LATER,
  );

  const handleStart = () => {
    if (strong) {
      const top = match.candidates[0];
      onStart(top.project, top.signal);
      return;
    }
    if (ambiguous && selected !== CHOOSE_LATER) {
      const chosen = match.candidates.find((c) => c.project.path === selected);
      if (chosen) {
        onStart(chosen.project, chosen.signal);
        return;
      }
    }
    // None, or "choose after starting": start title-only (auto-routing / chooser takes over).
    onStart(undefined, undefined);
  };

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2 text-muted-foreground">
          <CalendarClock className="h-4 w-4" />
          <span className="text-xs font-medium uppercase tracking-wide">Meeting starting</span>
        </div>
        <DialogTitle className="mt-1 text-foreground">{event.summary}</DialogTitle>
        <DialogDescription>
          <CountdownLabel startMs={event.startMs} />. Start recording now?
        </DialogDescription>
      </DialogHeader>

      <div data-testid="reminder-folder" className="rounded-md border border-border bg-muted/40 p-3 text-sm">
        {strong && (
          <p className="text-foreground">
            Will be filed under{' '}
            <span
              className="font-medium"
              title={`Matched ${match.candidates[0].signal}`}
              data-testid="reminder-folder-name"
            >
              {match.candidates[0].project.name}
            </span>
          </p>
        )}

        {match.confidence === 'ambiguous' && (
          <fieldset>
            <legend className="mb-2 text-foreground">Which folder is this call for?</legend>
            <div className="flex flex-col gap-1.5">
              {match.candidates.map((c) => (
                <label
                  key={c.project.path}
                  className="flex items-center gap-2 text-foreground"
                  title={`Matched ${c.signal}`}
                >
                  <input
                    type="radio"
                    name="reminder-folder-choice"
                    value={c.project.path}
                    checked={selected === c.project.path}
                    onChange={() => setSelected(c.project.path)}
                    className="accent-brand"
                  />
                  <span data-testid="reminder-candidate">{c.project.name}</span>
                </label>
              ))}
              <label className="flex items-center gap-2 text-muted-foreground">
                <input
                  type="radio"
                  name="reminder-folder-choice"
                  value={CHOOSE_LATER}
                  checked={selected === CHOOSE_LATER}
                  onChange={() => setSelected(CHOOSE_LATER)}
                  className="accent-brand"
                />
                <span>Choose folder after starting</span>
              </label>
            </div>
          </fieldset>
        )}

        {match.confidence === 'none' && (
          <p className="text-muted-foreground">No folder match. You can pick one after starting.</p>
        )}
      </div>

      <DialogFooter className="gap-2 sm:gap-2">
        <button
          type="button"
          data-testid="reminder-dismiss"
          onClick={onDismiss}
          className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          Dismiss
        </button>
        <button
          type="button"
          data-testid="reminder-snooze"
          onClick={onSnooze}
          className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          Snooze 1 min
        </button>
        <button
          type="button"
          data-testid="reminder-start"
          onClick={handleStart}
          className="flex items-center justify-center gap-1.5 rounded-md bg-brand px-3 py-2 text-sm font-semibold text-brand-foreground transition-colors duration-150 hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <Mic className="h-4 w-4" />
          Start recording
        </button>
      </DialogFooter>
    </>
  );
}

/** Mounted once by layout: owns the ticker and renders the prompt when a call is imminent. */
export function MeetingReminderHost() {
  const { reminder, start, snooze, dismiss } = useMeetingReminder();

  // Radix fires onOpenChange(false) for Escape, overlay click, and the X: all mean "dismiss".
  const handleOpenChange = (open: boolean) => {
    if (!open) dismiss();
  };

  return (
    <Dialog open={!!reminder} onOpenChange={handleOpenChange}>
      {reminder && (
        <DialogContent data-testid="meeting-reminder-dialog" className="max-w-md">
          <ReminderBody reminder={reminder} onStart={start} onSnooze={snooze} onDismiss={dismiss} />
        </DialogContent>
      )}
    </Dialog>
  );
}
