# Main-driver loop: I7, I8, I9 plan

Planned 2026-07-14 while I5b (handover toast) builds. Loop pattern unchanged: Fable plans,
Opus executes, 2 Sonnet adversarial skeptics re-run gates, Opus fixer, final skeptic verify,
orchestrator re-runs gates and commits. Baselines move forward each iteration; current after
I6: vitest 267, Playwright 44, cargo 16 pre-existing warnings.

## I7: Tandem as an OS resident (autostart, tray-first, retention)

Goal: Tandem is simply always there, like the OS itself. No morning ritual, no data anxiety.

1. Autostart: tauri-plugin-autostart behind a Settings toggle "Start Tandem when Windows
   starts" (General section), off by default, with "start minimized to tray" as part of the
   behavior. Note: a Startup shortcut for the dev launcher already exists (start_tandem.bat /
   create_startup_shortcut.ps1); the plugin path targets the packaged app and must not fight
   the shortcut: mention in the toggle description that the dev shortcut supersedes it in dev.
2. Retention: the 7-day auto-delete default is dangerous for a daily driver. Find the retention
   logic (backend or Rust), change the default to "keep forever", and expose Settings choices
   (Keep forever / 30 / 90 days). Existing users on the old default must migrate to keep-forever
   unless they explicitly chose deletion. Deleting anything requires the setting to be explicit.
3. Tray usefulness: tray menu gains "Start recording next meeting" (enabled when a calendar
   event is within the reminder look-ahead, uses the same seeded start) and "Open today's
   agenda". Keep existing tray items working.
4. Batch of small deferred cosmetics if time is left after gates: dark-mode variants for the
   whiteboard Insert buttons and WebsiteShapeUtil chrome, roving tabindex on the sidebar
   Recent/By-project tablist.

Skeptic focus: autostart registry hygiene (no duplicate entries after toggling, clean removal
on disable), retention migration not deleting anything by surprise (this is user data, default
to fail), tray items with stale calendar state, packaged-vs-dev behavior claims.

## I8: recurring reality + post-meeting flow

Goal: the calendar features work for how real calendars look, and every finished call produces
its follow-through without being asked.

1. MONTHLY/YEARLY RRULE expansion in lib/ics.ts (currently only DAILY/WEEKLY): monthly client
   check-ins are common and currently invisible to the agenda, the reminder popup, and the
   handover flow. BYDAY/BYMONTHDAY basics, DST-safe (reuse the I2 DST fix approach), unit
   tests with real-world Outlook/Proton RRULE strings.
2. Post-meeting follow-up draft: when a summary lands (the stop-driven auto-summary from I4),
   offer "Draft follow-up email" on the meeting details page: generates a client-ready draft
   (recipient guessed from the calendar event's attendees when available) using the existing
   LLM provider plumbing, in Andrew's voice: direct, plain language, ends with a recommended
   next step, no em dashes. Copy-to-clipboard; no sending, no SMTP integration in this
   iteration.
3. "Today" flow polish: Ctrl+K gains "What's next" (jump to next event with its filed-under
   suggestion); TodayAgenda rows for events already recorded link to that meeting's notes.
   The agenda shows a subtle "recorded" check on events whose recording exists (match by
   event uid seed or title+date).

Skeptic focus: RRULE edge cases (5th weekday months, DST transitions, COUNT/UNTIL), follow-up
draft never auto-sends anything, attendee email handling with the PII posture (draft is local,
uses configured provider only), recorded-check matching false positives.

## I9: live-runtime QA + polish debt

Goal: everything the mocked gates cannot prove gets exercised for real, and surviving deferred
items get closed or explicitly parked.

1. Live runtime pass (the orchestrator drives this with the app actually running, backend up,
   real ICS configured, using Playwright against the dev server where possible and scripted
   Tauri where not): Alt+Shift+D from every route; reminder dialog firing at T-60s off a real
   calendar event (short-lead test event); handover toast during a real recording incl. "Wrap
   up and start next" ordering; auto-summary after tray-stop; Ctrl+K meeting search against
   real SQLite content; By-project sidebar with the real folder layout; canvas window basics.
   Every failure becomes a fix-and-verify item inside the iteration.
2. Close deferred debt that survived three iterations, by then including: the double-rendered
   action items in SummaryPanel (needs the read-only render path), "Unfiled (default
   location)" overclaim (needs a real recordings-base signal), frecency not unlearned on
   routing undo, reminderKey dedupe across a rescheduled startMs.
3. Documentation: a short USING.md ("daily driver quickstart": hotkeys, popup, handover,
   Ctrl+K, filing grammar) linked from the README, and updates to feature_list.json for
   F-numbers covering I3-I9.

Skeptic focus: for the runtime pass the skeptics verify evidence artifacts (screenshots, logs,
mock-call dumps) rather than code claims; anything without evidence is not done.
