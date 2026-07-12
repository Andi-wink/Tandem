# Main-driver loop: I3 + I4 implementation plan (PLAN ONLY, not built)

Status 2026-07-12: loop paused after I2 at the user's request ("only plan for now").
I1 (discovery) and I2 (calendar foundation) are done and committed (85932e8). This file is the
execution-ready plan for the remaining two iterations. Detailed I3 steps come from the loop's
Fable planner; I4 is planned here from the discovery brief.

## Context recap

- Calendar verdict (from the user's own research in [proton-mail-calendar-integration](proton-mail-calendar-integration/)):
  ICS-URL polling is the MVP. Proton has no CalDAV/API; Microsoft Graph (via n8n or direct)
  needs a one-time interactive OAuth the agents cannot complete, deferred as the later
  write-path track. Outlook Publish ICS preferred (fresher), Proton share-link supported
  (provider-cached up to ~8h).
- One-time user setup: publish/share the calendar, copy the secret .ics URL, paste it into
  Settings -> Calendar, keep the ~15 min poll default. Test connection button exists.
- Already built and unit-tested in I2 (but NOT wired into any UI):
  [calendarEventMatcher.ts](../frontend/src/services/calendarEventMatcher.ts) (attendee-domain >
  title-token > frecency-history project matching) and
  [recordingSeed.ts](../frontend/src/lib/recordingSeed.ts) (sessionStorage seed, 2-min TTL).

## I3 — calendar-driven routing + pre-call prep (frontend-only)

Goal: one click (or one palette Enter) on a calendar event starts a recording with the meeting
name, client project, and folder pre-filled; manual starts near a matched event get the same
auto-filing with the existing inspectable Undo/Change toast; a calm prep line shows the client's
recent meetings. Transcript-based routing stays as the fallback for unmatched calls.

Steps (each file: read immediately before editing):
1. [lib/ics.ts](../frontend/src/lib/ics.ts): add `attendeeEmails: string[]` to CalendarEvent —
   in the ATTENDEE case push the mailto email; leave the display `attendees` list untouched.
   Extend [ics.test.ts](../frontend/src/lib/ics.test.ts) (CN present -> both lists correct;
   missing mailto handled).
2. NEW `lib/startFromEvent.ts`: `startRecordingForEvent(ev)` — listProjects(), match via
   calendarEventMatcher, setRecordingSeed({title: ev.summary, eventUid, project*, signal}),
   dispatch the existing `tandem:request-start-recording` event.
3. [hooks/useRecordingStart.ts](../frontend/src/hooks/useRecordingStart.ts): in
   generateMeetingTitle, return peekRecordingSeed()?.title first, else the timestamp format.
   One edit covers all three start paths.
4. [hooks/useProjectRouteActions.ts](../frontend/src/hooks/useProjectRouteActions.ts): extend
   `fileUnder(project, signal, opts?: {meetingId, meetingTitle})` — opts win over context refs
   (refs are stale in the same effect tick at recording-start; this override is load-bearing).
5. [app/page.tsx](../frontend/src/app/page.tsx): handleBeforeRecord meeting-mode branch — seed
   preRecordDirRef from peekRecordingSeed()?.projectPath (re-arms the dormant suppression guard
   noted in To-do); after start, file under the seeded project via fileUnder(...opts). Manual
   starts within ~10 min of a matched event: same apply-with-undo filing. CAUTION: the
   isRecording effect has eslint-disabled deps; new reads must go through refs, never the dep
   array (re-fires mid-call otherwise).
6. [components/TodayAgenda.tsx](../frontend/src/components/TodayAgenda.tsx): per-row Record
   button (Mic icon, data-testid='agenda-record', aria-label) calling startRecordingForEvent;
   "Filed under X" chip on the matched row (signal visible); prep line under the next matched
   row (data-testid='agenda-prep') listing that client's recent meetings from the sidebar list
   (title-token match; renamed junk titles won't appear — documented limitation).
7. [components/CommandPalette.tsx](../frontend/src/components/CommandPalette.tsx): when not
   recording and calendar configured, "Start recording for <event>" from
   findEventNear(now) ?? findUpcomingEvent(60min).
8. e2e: [tauri-mock.ts](../frontend/e2e/fixtures/tauri-mock.ts) records all invokes
   (`window.__TAURI_MOCK_CALLS__`), add `project_list` mock; NEW start-from-event.spec.ts
   (agenda Record button -> start_recording invoked with seeded title; filing toast shown);
   extend agenda.spec.ts with the prep-line assertion. Existing 29 e2e tests stay green.

Key risks the executor must respect:
- The fileUnder opts override (step 4) is what keeps the toast from filing the wrong/blank
  meeting; without it the whole flow silently misroutes.
- Attendee-domain false positives (colleague/vendor domains): freemail blocklist + exact/alias
  ordering + null result when everything is generic (never route on noise).
- Aborted starts leave a seed for up to 2 min (TTL accepted; an unrelated manual start inside
  that window inherits the event title).

Verification gate: tsc clean; cargo check unchanged; vitest all green (new + existing suites);
Playwright full suite incl. the new spec; keep 29+ green.

## I4 — daily-driver polish + full verify

From the discovery audit (ranked by daily impact), sized to leave real time for gates:
1. Global start/stop hotkey Alt+Shift+D in the existing `.with_shortcuts` handler in
   [lib.rs](../frontend/src-tauri/src/lib.rs) (same pattern as Alt+Shift+Q push-to-talk),
   emitting the already-listened-for `tandem:request-start-recording`; toggle semantics;
   document in Settings.
2. Reliable auto-summary: trigger from the recording-stop event in
   RecordingPostProcessingProvider.tsx instead of the `?source=recording` query param, so
   tray-stopped calls summarize too; "Summarizing... / View" sonner toast; guard against
   double-generation when navigating with the old param.
3. Action items: an Action Items section in the summary rendered as a checklist in
   SummaryPanel.tsx with "Copy action items" and "Send to @code handoff" (reuse
   useHandoffExport + palette plumbing).
4. Stretch only if gates are green with time to spare: tauri-plugin-autostart behind a Settings
   toggle (start minimized to tray). Note: a Windows Startup shortcut for the dev launcher
   already exists (start_tandem.bat); the plugin path is for the packaged app.

Out of scope (deferred, tracked): retention change (7-day auto-delete is too aggressive for a
daily driver — revisit), sidebar project grouping, meeting search in Ctrl+K, follow-up-email
draft via n8n/Proton Bridge, Graph/n8n OAuth write path.

Full gate at the end: tsc, cargo check, vitest, complete Playwright run, and an honest list of
what still needs the physical runtime pass (mic capture, live transcript, canvas window).

## How to resume

Run the loop's remaining iterations with this file as the brief (or resume workflow
wf_ea43eed1-40d whose journal caches I1/I2 + the I3 plan). Executors: Opus; reviewers: Sonnet
(adversarial, re-run gates themselves); fix pass on blockers. No commits from agents; the
orchestrator commits per verified iteration.
