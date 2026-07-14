# I5: pre-meeting recording prompt (plan)

## I5b addendum (user feedback 2026-07-14, AUTHORITATIVE, overrides the "never fire while
## recording" rule below)

User: "I might still be in a meeting, so I need it to not conflict with the current meeting I'm
in and kick me out of it. It's just a notification. Have an option where I can click to start the
recording in it. That then closes off the last meeting as done, and then starts in the new
meeting, with the meeting being saved as whatever the calendar invite is called."

Spec:
- When NOT recording: keep I5 behavior exactly (focus + dialog + native notification).
- When ALREADY recording and a new event enters its firing window: fire a HANDOVER notification
  instead of suppressing. Absolutely no focus_main_window call, no modal dialog, no window
  unminimize, nothing that could disturb a live call or screen share. Present:
  1. an in-app sonner toast (persistent until start of event + grace, dismissible) with the text
     "Next: <event summary> starts in <n>" and an action button "Wrap up and start next";
  2. a native Windows notification with the same text (backup for minimized app). pingTaskbar is
     acceptable (subtle) but optional.
- Clicking "Wrap up and start next": stop the current recording through the SAME code path as
  the Stop button / I4 off-route hotkey stop (invoke stop_recording + full handleRecordingStop
  post-processing: transcripts saved, auto-summary latch fires, meeting stays filed where it
  was). AWAIT completion of the stop/save before starting the next one. Then call
  startRecordingForEvent(ev) so the new recording is titled with the calendar invite summary and
  filed under the matched folder (same consent semantics as the dialog: strong match auto,
  ambiguous opens the picker without blocking the start).
- Ignoring the toast: current recording continues untouched; the handover offer auto-expires at
  event start + the same 30s grace; mark fired only when shown (same persist-at-show guarantee
  as the dialog path); it must not re-fire.
- Engine change: isRecording no longer suppresses selection; it selects presentation mode
  (dialog vs handover). The queue semantics stay: only one surface at a time; a recording
  starting mid-queue no longer clears the queue but converts pending items to handover mode when
  they surface. Keep the persist-only-at-show invariant for both modes.
- Settings: reuse the same enabled/lead-time settings; no separate toggle needed.
- Tests: vitest for mode selection (recording -> handover, not suppressed; handover expiry;
  no re-fire), and the stop-then-start sequencing helper if extracted pure (stop must resolve
  before start dispatch). Playwright: mock recording state active + event in window -> toast
  visible, no dialog; click action -> stop_recording invoked then start_recording with seeded
  title (assert ordering via __TAURI_MOCK_CALLS__).

Risks for skeptics: double-stop races (toast click while user simultaneously presses Stop or
Alt+Shift+D; stopInProgressRef must make this safe), start firing before transcripts finished
saving (ordering), handover toast surviving navigation, toast firing during the brief window
between stop and start of a handover (must not offer a second handover for the same event),
auto-summary of the closed meeting still kicking off, seed TTL (2 min) vs long stop times.

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
