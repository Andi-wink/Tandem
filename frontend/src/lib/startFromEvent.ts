/**
 * startFromEvent — turn a calendar event into a seeded recording start (I3 + R1/R2/R3).
 *
 * Flow:
 *  1. Build the match pool (registered projects + discovered client folders).
 *  2. Rank candidates for the event.
 *  3. STRONG match (or an explicit confirmed pick): seed with the project so the recording files
 *     directly into <project>/.tandem at start.
 *     AMBIGUOUS: seed title-only, then open the chooser (non-blocking) so the user picks the folder.
 *     NONE: seed title-only.
 *  4. Always dispatch `tandem:request-start-recording` — the chooser NEVER gates the start (R1).
 *
 * Pure orchestration around setRecordingSeed + a window event; no React.
 */

import type { CalendarEvent } from '@/lib/ics';
import { Project } from '@/services/projectService';
import { rankEventProjectCandidates, type EventProjectCandidate } from '@/services/calendarEventMatcher';
import { getMatchPool, isDiscoveredStub } from '@/services/clientFolderDiscovery';
import { setRecordingSeed } from '@/lib/recordingSeed';

/** A chooser row: what ProjectPicker's `candidates` prop consumes. */
export interface ChooserCandidate {
  dir: string;
  name: string;
  signal: string;
  /** Present only for registered projects; a discovered folder is adopted via createProject at pick. */
  project?: Project;
}

function toChooserCandidate(c: EventProjectCandidate): ChooserCandidate {
  return {
    dir: c.project.path,
    name: c.project.name,
    signal: c.signal,
    project: isDiscoveredStub(c.project) ? undefined : c.project,
  };
}

export interface StartFromEventOpts {
  /** An explicit user pick (e.g. clicking a matched agenda row) — counts as consent, never re-ask. */
  confirmedProject?: Project;
  /** Signal text for the confirmed project (falls back to the ranked signal). */
  confirmedSignal?: string;
}

/**
 * Seed and request a recording start for a calendar event. Returns the match outcome so callers
 * (agenda rows) can reflect it in the UI, but the start is always dispatched regardless.
 */
export async function startRecordingForEvent(
  ev: CalendarEvent,
  opts?: StartFromEventOpts,
): Promise<void> {
  const { pool } = await getMatchPool();
  const { candidates, confidence } = rankEventProjectCandidates(ev, pool);

  const confirmed = opts?.confirmedProject;

  if (confirmed) {
    // Explicit consent: seed straight to the confirmed project.
    setRecordingSeed({
      title: ev.summary,
      eventUid: ev.uid,
      projectId: confirmed.id,
      projectPath: confirmed.path,
      projectName: confirmed.name,
      signal: opts?.confirmedSignal ?? candidates.find(c => c.project.path === confirmed.path)?.signal ?? 'chosen from agenda',
      userConfirmed: true,
    });
  } else if (confidence === 'strong') {
    const top = candidates[0];
    setRecordingSeed({
      title: ev.summary,
      eventUid: ev.uid,
      projectId: top.project.id,
      projectPath: top.project.path,
      projectName: top.project.name,
      signal: top.signal,
    });
  } else if (confidence === 'ambiguous') {
    // Seed title-only; the chooser (opened below) decides filing without blocking the start.
    setRecordingSeed({ title: ev.summary, eventUid: ev.uid });
  } else {
    // No distinctive match — title-only seed; transcript auto-routing takes over later.
    setRecordingSeed({ title: ev.summary, eventUid: ev.uid });
  }

  // Fire the start FIRST so recording never waits on the chooser (R1: chooser never gates start).
  window.dispatchEvent(new CustomEvent('tandem:request-start-recording'));

  // Ambiguous + not explicitly confirmed: open the chooser seeded with the ranked candidates.
  if (!confirmed && confidence === 'ambiguous') {
    window.dispatchEvent(
      new CustomEvent('tandem:open-project-picker', {
        detail: {
          candidates: candidates.map(toChooserCandidate),
          meetingTitle: ev.summary,
        },
      }),
    );
  }
}
