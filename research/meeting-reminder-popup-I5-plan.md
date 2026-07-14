# I5: pre-meeting recording prompt (plan)

User request (2026-07-14): "would it be possible that the app pops up when a new meeting is about
to start, maybe one minute before, asking if I want to start the recording and suggesting a folder
to do it?" Skeptical QA each iteration.

## Verified ground (from read-only recon, file:line current as of 2026-07-14)

- CalendarContext polls ICS min every 5 min (frontend/src/contexts/CalendarContext.tsx:106-110),
  exposes `todayEvents`, `events`, `configured`. Too coarse for T-60s: needs its own short ticker.
- `rankEventProjectCandidates(ev, projects)` (services/calendarEventMatcher.ts:103) returns
  `{candidates, confidence: strong|ambiguous|none}`; pool comes from `getMatchPool()`
  (clientFolderDiscovery.ts). `findUpcomingEvent(events, nowMs, lookAheadMs)` (:204) is reusable.
- `startRecordingForEvent(ev, {confirmedProject?, confirmedSignal?})` (lib/startFromEvent.ts:51)
  is the full seeded-start API: seeds sessionStorage, dispatches `tandem:request-start-recording`,
  opens the project picker when ambiguous. TodayAgenda.tsx:170-178 shows the consent pattern
  (visible strong chip + click = confirmed).
- Dialog primitive exists (components/ui/dialog.tsx). Native notifications fire from Rust
  (notifications/system.rs, tauri-plugin-notification 2.3.1); capabilities only include
  `notification:default` + `allow-is-permission-granted`.
- Focus patterns: `focus_main_window` (src-tauri/src/tray.rs:530-538: unminimize/show/set_focus)
  and `pingTaskbar()` (NotificationContext.tsx:7-16). No always-on-top precedent; do NOT build a
  separate popup window: in-app Dialog + focus_main_window + native notification is simpler.
- Settings: simple UI toggles use localStorage (PreferenceSettings.tsx pattern); calendar config
  uses Rust `api_get/save_calendar_config`. Reminder prefs are UI-only, so localStorage is fine.

## Build spec

1. NEW `frontend/src/hooks/useMeetingReminder.ts` (or a small MeetingReminderContext mounted in
   the provider tree next to CalendarContext):
   - 15s `setInterval` effect, active only when calendar `configured` and reminders enabled.
   - Each tick: scan `todayEvents` for a non-all-day event with `startMs - now` in
     `(0, leadMs]` (lead default 60s, configurable). Skip if already recording
     (RecordingStateContext), skip UIDs already fired this session (Set in a ref, plus a
     sessionStorage mirror `tandem.reminder.fired` so a fast reload does not re-fire), skip
     events whose start is already past by more than 30s.
   - On fire: compute match via `getMatchPool()` + `rankEventProjectCandidates`, set reminder
     state {event, match}, call `pingTaskbar()`, invoke the Rust focus command, and trigger a
     native notification ("Meeting starting: <title>") as a backup when window is not focused.
2. NEW `frontend/src/components/MeetingReminderDialog.tsx`: shadcn Dialog, calm styling, dark
   variants, data-testids:
   - Title: event summary + "starts in Xs / now" (live countdown, tabular-nums).
   - Folder suggestion line: strong -> "Will be filed under <name>" chip with signal tooltip;
     ambiguous -> small radio/select of top candidates (preselect first) + "Choose another...";
     none -> "No folder match, you can pick after starting".
   - Buttons: primary "Start recording" (calls startRecordingForEvent with
     confirmedProject/confirmedSignal per TodayAgenda consent pattern; ambiguous with a selected
     candidate counts as confirmed), secondary "Snooze 1 min" (re-arm once), ghost "Dismiss"
     (marks UID fired, closes).
   - Auto-dismiss 2 min after event start if unattended (mark fired). Never auto-start.
3. Rust: expose/reuse a `focus_main_window` Tauri command (tray.rs logic already exists; if not
   already an invokable command, add a thin `#[tauri::command]`). Native notification: prefer a
   small Rust command `notify_meeting_starting(title, body)` reusing notifications/system.rs so no
   new JS capability wiring is needed.
4. Settings (PreferenceSettings.tsx, Calendar section): "Meeting reminders" toggle (default ON
   when calendar configured), lead-time select (30s / 1 min / 2 min / 5 min), localStorage keys
   `tandem.reminder.enabled` / `tandem.reminder.leadSecs`.
5. Tests:
   - vitest: pure "which event should fire" selector (fake timers: fires once at T-60s, de-dupes
     by uid, respects lead config, ignores all-day + in-progress + already-recording).
   - Playwright: mock calendar events with one starting in 45s -> dialog appears with suggested
     folder; "Start recording" -> `start_recording` invoke recorded with seeded title; Dismiss ->
     does not reappear.

## Risks the skeptics must attack

- Re-fire loops (tick/dedupe bugs), reminder firing mid-recording, back-to-back meetings (second
  event must still fire while first was dismissed), timezone/DST (startMs already absolute, but
  verify), snooze re-arm not creating a second dialog, stale match pool (refresh pool at fire
  time, not mount time), dialog stealing focus while user is typing elsewhere (focus grab is the
  point, but must not fire when already recording), reload during the fired window.
