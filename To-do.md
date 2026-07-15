# To-do

## Open

### Optional video capture during meetings (F061, 2026-07-13) — BUILT + adversarially reviewed, on `feature/video-capture`
Opt-in continuous screen + webcam recording alongside audio, using the ffmpeg sidecar already bundled for audio encoding. Built in worktree `D:\Dev-projects\Tandem-video-capture`. Plan: [dynamic-dazzling-bachman.md](C:\Users\andre\.claude\plans\dynamic-dazzling-bachman.md). Two independent adversarial review passes (real ffmpeg smoke tests, not just code reading) both initially FAILED; all confirmed blockers fixed (CSP `media-src` gap, dshow colon device-name corruption, orphaned-ffmpeg-on-force-kill via Windows Job Object, verified with a real negative-control test). Committed at `4271a46`, not merged/pushed.
- [ ] No live "recording video" indicator during the call — `get_video_recording_status` command exists but has no frontend caller yet; video state is only visible post-hoc in meeting review.
- [ ] `webcam_device_name` in settings isn't reconciled if the previously selected camera disconnects/changes — stale name silently persists until the user re-picks.
- [ ] macOS avfoundation capture path is unverified — no Mac available in this dev environment; screen device index defaults to `"1:none"` which isn't guaranteed across machines.
- [ ] No retention/disk-usage policy or UI (explicitly deferred per user decision) — revisit once real usage data exists, video is far larger than audio.
- [ ] Pre-existing, NOT caused by this feature but blocks building the branch: 15 baseline `cargo check` errors (`E0433` in `summary`/`summary_engine` Tauri command macros), confirmed via `git stash` isolation to predate this work.
- [ ] Pre-existing, NOT caused by this feature: a `start_recording` TOCTOU race (two near-simultaneous start calls can both pass the `IS_RECORDING` check before it's set) already existed for audio; video capture doubles the number of stray ffmpeg processes a race hit would spawn.

### Main-driver 4-iteration loop (2026-07-12) — PAUSED AFTER I2 (user: plan only for now)
Goal: make Tandem the daily main driver; headline feature = calendar integration (build on [research/proton-mail-calendar-integration/](research/proton-mail-calendar-integration/)).
I1+I2 done and committed (85932e8). I3+I4 are PLANNED, NOT BUILT — execution-ready plan in [research/main-driver-I3-I4-plan.md](research/main-driver-I3-I4-plan.md) (workflow wf_ea43eed1-40d journal caches I1/I2 for resume).
- [x] I1 discovery: digest the existing Proton/Outlook calendar research + audit daily-driver gaps -> briefs
- [x] I2 calendar foundation: read-only ICS (paste-a-URL, Outlook Publish preferred, Proton share-link supported), fetched CORS-free in Rust ([calendar_ics.rs](frontend/src-tauri/src/calendar_ics.rs)), parsed locally ([ics.ts](frontend/src/lib/ics.ts), 19 vitest cases incl. Windows-TZID + DAILY/WEEKLY RRULE), config in Rust SQLite ([migration](frontend/src-tauri/migrations/20260712000000_add_calendar_settings.sql)), Today agenda card on home ([TodayAgenda.tsx](frontend/src/components/TodayAgenda.tsx)), Calendar section in [PreferenceSettings](frontend/src/components/PreferenceSettings.tsx) with Test connection, 2 Ctrl+K commands. Gates green: cargo check + 7 new Rust tests, tsc, vitest 146/146, Playwright 29/29.
- [x] I3 calendar-driven routing — DONE, committed 482aaf7. Skeptics caught 3 real blockers first pass (stale pending-relocation slot could misfile a later unrelated meeting; seeded-recording fallback never re-filed; NUL byte in ProjectPicker source) — all fixed, final review pass. Gates independently re-run at commit: tsc clean, cargo clean, vitest 194/194, Playwright 32/32. NEEDS FULL APP RESTART (Rust changes: base-dir override, relocate_meeting_folder, list_client_folders, app_settings migration).
- [x] I3b misfile correction — DONE, committed 0cd8498. First QA failed with 2 real blockers (dead-code live-recording guard; stale folder_path on details page after a move) — fixed, final skeptic mutation-tested the guard. Gates at commit: tsc clean, cargo clean, vitest 202/202, Playwright 35/35. Rejected alternatives logged: per-project bulk cleanup view (deferred as the future "all Acme calls" surface), palette-only "move last meeting" (transient).

#### I3/I3b deferred (non-blocking QA findings, 2026-07-13)
- [ ] relocate_meeting_folder's collision rename ("<leaf> (2)") changes the folder leaf the whiteboard mirror keys on, and makes Undo restore to a renamed folder rather than the exact prior state ([lib.rs relocate](frontend/src-tauri/src/lib.rs), [useWhiteboardPersistence.ts](frontend/src/hooks/useWhiteboardPersistence.ts)).
- [ ] Non-atomic move+DB-update: if the fs move succeeds but the SQLite folder_path update fails, they diverge until the meeting is reopened; error copy says "reopen to refresh" instead of self-healing.
- [ ] A meeting in a genuine ad-hoc folder (neither a project's .tandem nor the default recordings base) is labeled "Unfiled (default location)" by [filedUnder.ts](frontend/src/lib/filedUnder.ts) — overclaims the physical location.
- [x] I4 daily-driver polish + full verify — DONE, committed f9daa9b (2026-07-14). Alt+Shift+D global record hotkey ([lib.rs](frontend/src-tauri/src/lib.rs) emits `global-record-toggle`; frontend listener in [RecordingPostProcessingProvider.tsx](frontend/src/contexts/RecordingPostProcessingProvider.tsx) dispatches the same `tandem:request-start-recording`/`tandem:request-stop-recording` the buttons use, 1s debounce via [recordToggle.ts](frontend/src/lib/recordToggle.ts)); stop-driven auto-summary from the recording-stop path for tray/hotkey/UI stops, idempotent per meeting id ([autoSummary.ts](frontend/src/lib/autoSummary.ts) + [useRecordingStop.ts](frontend/src/hooks/useRecordingStop.ts), page guard + `tandem:summary-updated` refetch in [meeting-details/page.tsx](frontend/src/app/meeting-details/page.tsx)); action-items checklist parsed from the existing "Immediate Action Items" section ([actionItems.ts](frontend/src/lib/actionItems.ts) + [ActionItemsChecklist.tsx](frontend/src/components/MeetingDetails/ActionItemsChecklist.tsx) in [SummaryPanel.tsx](frontend/src/components/MeetingDetails/SummaryPanel.tsx)) with localStorage-persisted checkboxes, Copy, and Send-to-handoff; shortcuts documented in [PreferenceSettings.tsx](frontend/src/components/PreferenceSettings.tsx). Stretch autostart intentionally skipped (later iteration). Gates: tsc clean, cargo check clean (warnings only), vitest 228/228, Playwright 36/36.

#### I4 deferred / known limitations (2026-07-14)
- [x] ~~Alt+Shift+D only fires on the home page~~ — RESOLVED in the same iteration's fix pass (commit f9daa9b): the provider is now route-aware; off the home route it invokes `stop_recording` directly (+ full post-processing) or navigates home with the `autoStartRecording` flag. The Settings copy's "works in the background" claim is now true.
- [ ] Action items render twice on meeting details: once in the interactive checklist, once as plain text inside BlockNoteSummaryView. Safe fix needs a read-only render path that excludes the section without touching the save payload (stripping it before the editable view would delete it from the stored summary on next save).
- [ ] "Send to handoff" on the action-items checklist writes `action-items.md` into the meeting folder via `save_transcript` (the same command the handoff export uses); it does NOT invoke the full `window.triggerHandoff` PII pipeline because that hook is only registered on the home route. Revisit if action items should flow through PII anonymization.
- [ ] Auto-summary needs a real mic + backend to verify end-to-end: parsing/guard/toasts are unit- and e2e-tested with mocks, but the actual generate+poll round-trip against Ollama/Claude was not exercised in this headless pass.

### Main-driver continuation loop (2026-07-14) — I4/I5/I6 DONE, I5b in flight, I7-I9 PARKED
Same pattern: Fable plans, Opus builds, 2 Sonnet adversarial skeptics + fixer + final verify per iteration, orchestrator re-runs gates and commits.
- [x] I4 (see above, f9daa9b): Alt+Shift+D global record toggle, stop-driven auto-summary, action-items checklist. Gates: vitest 228, Playwright 36.
- [x] I5 pre-meeting recording prompt — DONE, committed e372dba. Dialog ~1 min before a calendar event (lead 30s-5min in Settings) with suggested folder, focus + native notification, snooze/dismiss, never auto-starts. Both skeptics failed the first build (mid-recording race, persist-before-render reload loss, back-to-back second event swallowed, discovered-folder consent gap); all fixed, plus a second targeted pass for a queued-reminder persist race the first fix introduced. Plan: [research/meeting-reminder-popup-I5-plan.md](research/meeting-reminder-popup-I5-plan.md). Gates: vitest 251, Playwright 39.
- [x] I6 instant navigation — DONE, committed d589a74. Meeting search (title+transcript) in Ctrl+K with Enter-to-navigate; sidebar Recent/By-project toggle with collapsible per-project groups. Skeptic catches: cmdk duplicate-title selection collision, stale actionable search rows, stale project registry hiding new projects in Unfiled. Gates: vitest 267, Playwright 44.
- [x] I5b handover mode — DONE, committed 41adecd + follow-up (2026-07-15). Reminder during a live recording = non-intrusive toast + native notification only (no focus steal), "Wrap up and start next" stops+saves+summarizes the current meeting, then starts the next named after the calendar invite; works on and off the home route. Hard-won QA: 2 skeptics failed the build (off-route start dispatched into the void, per-instance stop guard allowing double-save, Start button live mid-handover, dialog leak); round-2 verify failed again (Stop button/hotkey ungated, unawaited sibling save, dialog gap, off-route picker lost); round 3 closed the last gap (Ctrl+K stop path). Final adversarial verify PASS. Gates: tsc clean, cargo clean, vitest 274/274, Playwright 48/48.

#### I5b deferred (non-blocking, 2026-07-15)
- [ ] Palette "Start recording" items are gated on !isRecording but not !handoverActive: mid-handover a user-initiated start can win over the seeded one (benign: Rust rejects a double start; worst case the next meeting runs untitled/unfiled). Gate them on !handoverActive for symmetry.
- [ ] handleRecordingStop schedules navigateToMeeting ~2s after resolving, so a handover can navigate away from the freshly started next recording (pre-existing, also affects the I4 off-route hotkey stop path).
- [ ] waitForNotRecording/waitForRecording are bounded (5s/10s); a stop that silently never stops degrades safely (no double recording) but deserves a live-runtime check (I9 scope).

- [x] Global quick-capture — DONE, committed a02126b (2026-07-15). Alt+Shift+N always-on-top capture bar: last 3 copied text items as chips, note input, route-to-project chip, Enter saves to <project>/.tandem/notes (path-validated Rust command), Ctrl+Enter also loads the AI panel, Esc discards. Record hotkey renamed Alt+Shift+D -> Alt+Shift+E same day (user conflict). Spec: [research/quick-capture-plan.md](research/quick-capture-plan.md). QA: privacy skeptic caught a boot-window watcher race (now fail-closed), a junction escape, clipboard contention, and a frecency note leak; final verify PASS. Gates: tsc clean, cargo clean (+4 Rust tests), vitest 291/291, Playwright 54/54 (workers pinned to 1 in playwright.config.ts due to dev-server route-compile contention).
- [ ] Quick-capture deferred: bare digit 1/2/3 toggles chips even while typing in the note field (tested, intentional; a real fix needs a UX decision like Alt+digit). Needs live-runtime pass: real window creation/placement/DPI, OS hotkey, blur-close, watcher polling, Ctrl+Enter ask-flow without an active meeting, packaged-build /capture export (I9 scope).

#### Idea backlog (2026-07-14): 20 ideas skeptically ranked by productivity gain
20 candidates in [research/idea-backlog-20.md](research/idea-backlog-20.md), adversarially ranked by a separate skeptic in [research/idea-backlog-ranked.md](research/idea-backlog-ranked.md). Skeptic's top 3: cross-meeting action-item inbox, meeting prep one-pager, global quick-capture. Bottom tier (skip): snippet clipping, search operators, encrypted backup (insurance not productivity), diarization surfacing, live in-call flags, voice-control-everywhere, mini HUD.

#### Parked for later (user 2026-07-14: "I'll come and revisit them later") — plan in [research/main-driver-I7-I9-plan.md](research/main-driver-I7-I9-plan.md)
- [ ] I7 OS residency: autostart-with-Windows toggle (tray-first), fix the dangerous 7-day retention default (keep-forever + explicit 30/90d options, safe migration), tray "Start recording next meeting" + "Open today's agenda", small dark-mode/a11y debt.
- [ ] I8 recurring reality + post-meeting flow: MONTHLY/YEARLY RRULE expansion (monthly client calls are currently invisible to agenda/reminders), "Draft follow-up email" from a landed summary (Andrew's voice, copy-only, never sends), Ctrl+K "What's next", recorded-check on agenda rows linking to notes.
- [ ] I9 live-runtime QA + debt closure: exercise everything mocked gates cannot prove on the real running app (hotkey per route, reminder off a real ICS event, handover mid-recording, tray-stop auto-summary, real-DB Ctrl+K search); close surviving deferred items (double-rendered action items, Unfiled overclaim, frecency unlearn, reminderKey reschedule dedupe); USING.md quickstart + feature_list.json updates.

#### I2 deferred (calendar foundation, 2026-07-12)
- [ ] **Calendar -> routing pre-seed (I3 work):** feed matched event attendees/title into [projectRouter](frontend/src/services/projectRouter.ts) so a call auto-files under its client; seed the meeting name from the matched event; add a pre-call prep card. Not started this pass (I3 scope).
- [ ] **MONTHLY/YEARLY RRULE** not expanded in [ics.ts](frontend/src/lib/ics.ts) — only DAILY/WEEKLY. A monthly recurring client call shows only its next base occurrence (surfaced as a warning in Settings Test-connection output). Add BYMONTHDAY/BYSETPOS expansion when needed.
- [ ] **Two-way / write path (Graph or n8n):** creating/moving events, and any Outlook Graph or n8n Microsoft-Graph node, needs a one-time interactive OAuth consent by the user (agents cannot complete it). Deferred as the later OAuth-crossing track per [research/proton-mail-calendar-integration/01-ADDENDUM-n8n-docker-outlook.md](research/proton-mail-calendar-integration/01-ADDENDUM-n8n-docker-outlook.md).
- [ ] **Proton staleness:** Proton share-link ICS feeds are provider-cached up to ~8h, so same-day changes can lag. Surfaced in Settings copy; no code fix possible (provider-side). Outlook Publish is the fresher feed.
- [ ] **Retention / sidebar grouping** of past calendar days and "join from a past meeting" not built; agenda is today-only (yesterday..+7d window internally). Revisit if the user wants an upcoming-week view.

### UX friction 5-iteration loop (2026-07-10) — DONE (needs one manual runtime pass, see I5 deferred)
North star: talk to Tandem like an OS; notes auto-route to the correct client project. Reported pain: the project/save-location modal costs several clicks per meeting.
All four build iterations initially FAILED adversarial review; each got a fix pass that closed the blockers with verified gates (tsc clean, cargo clean, vitest 127/127, Playwright e2e 23/23).
- [x] I1 research (Granola/Fathom/Wispr/Raycast-class patterns) + click-path audit + 13-item ranked friction synthesis
- [x] I2 project routing memory: ProjectPicker (searchable, frecency recents-first, Enter-to-confirm), per-client dir memory, mid-call modal downgraded to silent default + banner
- [x] I3 AI auto-routing: projectRouter (heuristic + Haiku fallback), auto-file with "Filed under X" undo/change toast, "file this under X" typed+spoken grammar, post-hoc move
- [x] I4 click-reduction: Ctrl+K command palette, handoff fire-and-forget with real undo (new Rust delete_file cmd; anonymize remembered as pref), explicit draw-on-canvas affordance
- [x] I5 verify + polish: Playwright e2e suite added (23/23), 7 stale-locator fixes, before/after click walk

#### I5 deferred (found during verify+polish, 2026-07-11)
- [ ] Frecency is not unlearned on a "Filed under X" Undo: undo restores the project but the wrong dir keeps its +1 frecency count in [projectDirHistory](frontend/src/lib/projectDirHistory.ts), so one bad auto-route slightly boosts the wrong folder's ranking. Accepted for now.
- [ ] Weak-preposition filing grammar deliberately rejects a leading article: "move this to the X" returns null by design (a leading article after to/into/in reads as a document-location phrase). "file this under the X" and "move this to X" work. See [parseFileUnderCommand](frontend/src/services/projectRouter.ts#L58). Revisit only if the user actually hits it.
- [x] Deterministic UI drive now run (2026-07-11 fixer pass): Playwright e2e suite (23 tests, Tauri-mocked, real React UI at :3118) drives home/recording controls/AI-panel open+close+model-selector+type/sidebar+search/settings+tabs+back/meeting-details — **23/23 pass**. Fixed 7 pre-existing stale-locator failures (renamed placeholders, model picker moved behind Settings popover, `getByText('Back')` also matched "backend" in the PII warning) and gave the panel close button an `aria-label`. Gates: vitest 127/127, `tsc --noEmit` clean, `cargo check --features cuda` clean.
- [ ] STILL NOT machine-verified (needs a physical run, cannot be driven headless): native-Rust flows the Tauri mock cannot exercise — actual audio capture/recording start-stop with a mic, live Whisper/Scribe transcript flow, the canvas Tauri window + board history (Solo vs meeting manual switcher), @code HANDOFF.md write+undo against the real filesystem, first-run API-key + recovered-transcript startup after an unclean exit. The Playwright drive proves the frontend renders/wires/opens/closes correctly; it does not prove the Rust audio pipeline records real audio. Schedule a manual runtime pass on the target machine.
- [ ] `preRecordDirRef` suppression guard in [useProjectAutoRoute](frontend/src/hooks/useProjectAutoRoute.ts#L74) is dormant (always '') now that recording starts straight into the meeting folder. Harmless; re-wire if a pre-record pick surface returns.

### Whiteboard 4-iteration improvement loop (2026-07-10) — Fable plan / Opus build / Sonnet review — DONE
Ran as an orchestrated workflow (14 subagents). Changes uncommitted in the working tree, across Tandem + the shared `agent-whiteboard` repo. Bundle rebuilt (`pnpm build:all`) + canvas server restarted so all of this is live.
- [x] **I1 — Crash fix.** Real root cause (my earlier v4/v5-MCP + dual-tldraw guesses were BOTH wrong): tldraw 5's `getIndicatorPath` is abstract and the `HtmlShapeUtil` didn't implement it, so any HTML shape (which my mockup-steering prompt started producing) crashed on select/hover and persisted → endless reload. Fixed by implementing the method (+ a forward-compat copy in shared canvas-core; standalone tldraw-4 build verified intact).
- [x] **I2 — AI↔user conversation in the panel** (canvas agent `message` replies forwarded via new `canvas:message` bridge + user request injected as a chat message) + **Settings toggle** to mute Tandem/"Claude Code" notices (does not mute the real conversation). Tandem tsc + cargo clean.
- [x] **I3 — Image paste** into the board + **"</> Insert HTML"** quick-insert button. (Also fixed a pre-existing `pnpm build:all` hang by splitting the dev `/stream` middleware into `vite.config.dev.ts` — tldraw leaked a MessagePort under Node and blocked the build from exiting.)
- [x] **I4 — Live website shape** ("Insert Website" → `WebsiteShapeUtil`, iframes a URL to draw on top, with an `/api/frame-check` + screenshot fallback for sites that block framing) + perf pass. SSRF guard added to the new frame endpoints (DNS-resolve + private-range denylist + redirect re-validation).

**Follow-ups (non-blocking, from the adversarial reviews):**
- [ ] Dark mode: the new `InsertHtmlButton` / `InsertWebsiteButton` / `WebsiteShapeUtil` toolbar UI hardcodes light-mode colors — add dark variants.
- [ ] Self-heal gap: `CanvasCrashFallback`'s "Reset board data" only clears the local IndexedDB scratch store, not a per-meeting `.tldr.json`; a genuinely foreign shape type in a saved board could still re-crash on open (low risk now the html bug is fixed at root).
- [ ] Canvas request bubble can be left with no reply if `canvas.sendPrompt()` rejects (ClaudePanel ~262/419) — show an error tied to the bubble.
- [ ] Backend (uvicorn :5167) has died 3× this session — find why (unhandled exception / terminal-close) and make it resilient.
- [ ] Changes span two repos and are uncommitted; agent-whiteboard `dist/` is gitignored (rebuild needed on other machines).

### Voice-driven canvas (feat/canvas-voice) — built, needs a runtime test
Tandem hosts the agent-whiteboard tldraw Agent kit in a Tauri window and drives it. The canvas/agent
code lives ONLY in agent-whiteboard (`apps/agent`, branch `feat/canvas-voice`); Tandem never forks it.

Built + compile-verified (`cargo check` + `tsc --noEmit` both clean), NOT yet runtime-tested:
- agent-whiteboard `apps/agent`: prompt bridge ([canvasPromptBridge.ts](../visual-work/agent-whiteboard/apps/agent/client/bridge/canvasPromptBridge.ts)) + prod `serve` server. Bridge proven in a headless browser (qa-bridge.mjs).
- Tandem Rust [canvas module](frontend/src-tauri/src/canvas/) — window open/hide/toggle, `canvas_send_prompt` (eval-injects a postMessage), `canvas_transcribe_clip`, `canvas_health_check`; Alt+Shift+A global push-to-talk in [lib.rs](frontend/src-tauri/src/lib.rs).
- Tandem frontend — [CanvasContext](frontend/src/contexts/CanvasContext.tsx), [CanvasDevPanel](frontend/src/components/CanvasPanel/CanvasDevPanel.tsx) (manual drive), [useCanvasVoice](frontend/src/hooks/useCanvasVoice.ts) + listening indicator.

**Runtime test plan (needs the GUI + a mic — couldn't be run headless):**
1. agent-whiteboard: `pnpm dev` (serves the agent at http://localhost:5174). Confirm it loads in a browser.
2. Tandem (this worktree): start the app (`cd frontend && pnpm run tauri:dev:cuda`) + backend.
3. Phase 1-2: open the canvas panel (bottom-left) -> **Open** -> a "Tandem Canvas" window loads :5174. Type "draw a 3-step onboarding flow" -> **Send** -> it draws. Then "make the middle box blue" -> it edits (scene-aware).
4. Phase 3: hold **Alt+Shift+A**, say "draw a login screen with email and password", release -> it draws. The "Listening..." pill should show while held.
5. Privacy/context: tick "Share last 5 min of transcript" in the panel, start a recording, discuss an automation, then Alt+Shift+A "build the last automation we discussed" -> it should use the transcript as context.

**Done since the first build (per-meeting boards + save/view):**
- [x] Per-meeting board: the board is no longer one global store. On opening the canvas during a meeting it loads that meeting's saved board (or a blank one); switching meetings swaps boards. ([useWhiteboardPersistence.ts](frontend/src/hooks/useWhiteboardPersistence.ts), bridge `canvas:load`/`canvas:clear`).
- [x] Save + view like notes: the board auto-saves to `<meeting folder>/whiteboard.tldr.json` on canvas close, recording-stop, and app exit. Meeting-details shows a Whiteboard button (when a saved board exists) that reopens it ([page-content.tsx](frontend/src/app/meeting-details/page-content.tsx), `tandem:canvas-open-saved`).
- [x] Agent-friendly exports: each save also writes `whiteboard.png` (render, via `editor.toImage`) and `whiteboard.md` (text labels + raw HTML/CSS of built shapes) next to the JSON, so a separate agent can pick up what was drawn. New Rust `save_base64_file` command writes the PNG bytes.
- [x] Live agent access: "Connect MCP" button kept visible in embed mode so an MCP-capable agent (Claude Code) can drive/read the live board. (Complementary to the saved files.)
- [x] Solo HUD overlap: [CanvasHudGuard](frontend/src/components/CanvasPanel/CanvasHudGuard.tsx) hides the floating Solo HUD window while the canvas is open, restores it only if a Solo session is active.
- [x] Canvas-not-reachable state: [CanvasIframe](frontend/src/components/CanvasPanel/CanvasIframe.tsx) shows a message + Retry (instead of a blank frame) if the agent server readiness handshake never arrives.
- [x] Mic-contention error messages: `useCanvasVoice` now distinguishes "mic in use by another app" vs "permission denied".
- [x] Two-pass review fixes: wrong-meeting board load/save (stale folder ref), single-flight saves, `sendPrompt` stale-ready read, unmount timer cleanup, completed the `.canvas-chat-light` token set.
- [x] Save-on-quit: intercepts the Tauri window close, finishes the async save, then destroys the window (beforeunload couldn't await the IPC round-trip).
- [x] Multi-page boards: `clearBoard` wipes all pages + drops extras; `extractMarkdown` walks all pages.
- [x] postMessage hardening: both sides origin-pin replies and validate inbound source/origin (snapshots can carry confidential meeting content).
- [x] Previous-boards picker (reuse across meetings with the same client): each save mirrors into a per-client library `{project}/.tandem/whiteboards/{meeting}.{tldr.json,md,png}` + `.meta.json`; new Rust `list_whiteboards` + a History dropdown in the canvas header (shown when a Solo project is active). Client anchor = Solo project. Today's board stays separate (saves keyed to the current meeting).

**Known caveats / follow-ups:**
- [ ] Collaboration (multi-user, same board): deferred by decision. Needs tldraw `@tldraw/sync` + a sync server (self-hosted on LAN to keep data local). Revisit later.
- [x] Auto-start the whiteboard server with Tandem (dev): `canvas::server::CanvasServerManager` spawns + supervises `node dist-server/serve.js` on startup (loopback :5174), health-logs, reuses an already-healthy port (no EADDRINUSE crash-loop / adopts orphans + 2nd instances), restarts on crash, and is killed on `RunEvent::Exit`. The iframe auto-reloads a few times so first launch self-heals without a Retry click. Server binds 127.0.0.1 only and `/stream` rejects non-loopback Origins (was 0.0.0.0 + unauthenticated). Client + CSP pinned to 127.0.0.1:5174.
- [ ] Prod packaging of the canvas server (the remaining half of #3): `resolve_serve_js()` only finds the bundle via `TANDEM_CANVAS_DIR` or the dev sibling path, and `apps/agent/dist`+`dist-server` are gitignored — so a packaged build or a fresh clone has no server and the canvas is dead. Bundle `serve.js`+`dist/`+a node runtime as a Tauri resource (externalBin) and add a resource-dir candidate to `resolve_serve_js()`, OR port `/stream` into Tandem's Python backend and serve `dist/` from Rust (drops the node dependency). Until then the canvas only works where the bundle is built.
- [ ] Canvas server hardening follow-ups (post-QA, deferred): (a) per-spawn shared-secret token (Tandem generates it, passes via env, injects on iframe `/stream` requests, server rejects mismatch) — defence-in-depth beyond the loopback bind + Origin check; (b) Windows Job Object (kill-on-close) so a force-killed Tandem can't orphan the node child (currently relies on child-of-parent + `kill_on_drop` + the reuse-if-healthy adopt path); (c) tighten the iframe `sandbox` attribute (currently none) once verified it doesn't break the tldraw app.
- [ ] Mic contention: runtime-verify on the target machine that the 2nd getUserMedia stream coexists with the recording pipeline under WASAPI shared mode (error handling is now graceful either way).
- [ ] Alt+Shift+A registration can fail silently if another app owns it (same exposure as the existing Alt+Shift+S/R/V). Add detection + a configurable override if it bites.
- [ ] Voice + auto-routing need a proper runtime pass (only lightly exercised).
- [ ] (Backlog) Production CSP: `connect-src` has no `ws:`/`127.0.0.1` entries and the agent app ships no CSP, so a hardened/packaged build would block the MCP WebSocket (`ws://127.0.0.1:3000`). Works in dev (same-origin from the iframe, Vite-proxied). Fix alongside the prod sidecar: add `ws://localhost:* ws://127.0.0.1:* http://127.0.0.1:*` to connect-src + a CSP on the agent app.
- [ ] Worktree setup drift (hit during this build): Cargo.lock is gitignored, so a fresh worktree resolved tauri 2.11.3 vs main's 2.10.2 and failed to compile. Copied main's Cargo.lock to pin. Also copied `binaries/llama-helper-*.exe` and several untracked frontend source files (NotificationContext, MermaidBlock, etc.) that committed code imports but which are uncommitted on main — commit those on main so worktrees build cleanly.

### Scribe-path accuracy + latency loop (2026-07-11) — done, follow-ups queued
Two iterations run (Fable plan / Opus build / adversarial Opus QA), both committed
(72e64f5, 1565ce5). Live provider is ElevenLabs Scribe v2 (cloud), not Parakeet.
Fresh held-out benchmark: clips 11-16 from July meetings + Scribe ground truth
([make_ground_truth.py](audio_testing/make_ground_truth.py)); live-path replica
[run_scribe_meeting_wer.py](audio_testing/run_scribe_meeting_wer.py). Results:
pipeline WER penalty +2.3pp -> +0.3pp (timestamp overlap trim), pooled 7.6% -> 5.6%;
then latency profile: median block wait 16.7s -> 7.7s for +0.71pp (5.6% -> 6.3%).
Retry + timeouts added to the ElevenLabs provider (a failed POST used to silently
drop a 12-35s chunk — likely the user-perceived word drops). Research report:
[stt-improvement-ideas.md](research/stt-improvement-ideas.md).
- [ ] **ElevenLabs Scribe v2 Realtime WebSocket** (top lever, M effort): partial +
  committed transcripts at ~100-150ms; kills both remaining latency (VAD-segment
  floor: a 35s monologue still arrives as one block) and boundary artifacts.
  Needs a frontend partial/volatile rendering layer (TranscriptContext is
  append-only by sequence_id) + live-mic runtime testing.
  **PLANNED 2026-07-12**: full 4-phase implementation plan in
  [scribe-realtime-ws-plan.md](research/scribe-realtime-ws-plan.md) (Phase 0 API
  spike + pricing gate, Phase 1 frontend partial layer, Phase 2 Rust WS session
  engine behind a `scribe_v2_realtime` model setting, Phase 3 harness
  measurement with keep-or-kill gates, Phase 4 manual runtime pass). Not started.
- [ ] VAD-level mid-segment partial emit: silero holds a monologue as one 13-35s
  segment; no buffer knob can subdivide it. Needed if we stay on batch HTTP.
- [ ] Consider min 5s instead of 4s for the CLOUD profile (QA: 6.21% @ 9.1s median
  vs 6.31% @ 7.7s) if the +2.1pp worst-clip cost bites in practice.
- [ ] Retry-loop behavior (backoff capping, budget break) is pinned by trace, not
  by tests; add coverage if the provider code is touched again.
- [ ] German + local streaming: spike sherpa-onnx + Kroko streaming Zipformer
  (ships a German model) per the research report.
- [ ] Worker `transcription-error` + outer `transcription-warning` double-emit on
  provider failure (pre-existing, flagged by QA).

### Transcription WER regression gate (#10) — follow-ups to make it CI-grade
The local gate is done ([wer_gate.py](audio_testing/wer_gate.py), [README](audio_testing/README_wer_gate.md), baseline [wer_baseline.json](audio_testing/wer_baseline.json)). Before wiring into PR CI:
- [ ] Expand the benchmark clip set to ~20-30 balanced clips (more speakers, more English, fewer single-language outliers). 5 clips with one German clip is statistically noisy.
- [ ] Add a Rust `transcribe_file` entry point (e.g. `cargo run --bin transcribe_file <wav>`) so the gate scores the actual shipped engine, not the Python replica/mirror.
- [ ] Wire into [.github/workflows/pr-main-check.yml](.github/workflows/) with model download + cache (int8 encoder is 652MB, can't be committed). Until then, run locally / nightly.

### Transcription accuracy loop (2026-07-08) — deferred items
Iteration 1 done (phrase-level "n a n" -> n8n fix, pooled WER 22.03% -> 21.54%, log: [accuracy_loop_log.md](audio_testing/results/accuracy_loop_log.md)). Loop stopped by user after iteration 1; queued aspects + review-mandated follow-ups:
- [ ] Held-out clips: current WER gains are measured on the same 5 clips corrections are derived from (adversarial review flagged train/test contamination). Validate future corrections on clips they were not authored against.
- [ ] User-editable custom vocabulary (SQLite settings) instead of growing the compiled alias tables in [parakeet_engine.rs](frontend/src-tauri/src/parakeet_engine/parakeet_engine.rs); reviewers rejected hardcoding one user's domain terms globally.
- [ ] Casing of corrected terms: corrections emit lowercase; WER scoring is case-insensitive so casing regressions are invisible to the gate.
- [ ] Deletions aspect (iteration 2, not run): clip_02 drops a whole phrase block (D=13, "go back go back home...") — investigate VAD segment/buffer coverage for that region.
- [ ] Scoring-normalization fairness (iteration 5, not run): "ah"/"uh", "kinda"/"kind of", "i'm"/"i am" count as errors; consider a Whisper-style English text normalizer for scoring only.
- [ ] Rust/Python fuzzy tie-break divergence (Iterator::max_by returns last on tie, Python max() returns first) — theoretical, flagged by review.

### Transcription quality — larger levers not yet explored (from the WER review)
- [ ] #6 Benchmark fp32 Parakeet vs int8 on the same clips to quantify the quantization WER cost (RTX 3090 makes the speed hit likely irrelevant).
- [ ] #7 Language routing: the German clip is ~65% WER. Detect language and route non-English to a stronger model or surface a low-confidence warning.
- [ ] #8 Evaluate the installed Canary models (canary-qwen-2.5b, canary-1b) through the same harness for an accuracy comparison.
- [ ] #9 Optional second-pass LLM transcript cleanup (Ollama/Claude already configured).

### Security
- [ ] Anthropic API key is stored in plaintext in the Rust `settings` table (meeting_minutes.sqlite), contradicting CLAUDE.md's "localStorage only / never stored server-side" claim. Decide on encryption-at-rest or removal.

## Done
- Established transcription WER baseline for the current engine (Parakeet TDT v3 int8) vs ElevenLabs ground truth: 31.4% pooled (exact meeting pipeline).
- Implemented engine improvements #1 (de-stutter), #3 (domain correction), #4 (sensitive VAD, ~99.5% word coverage), #5 (12s context window): pooled WER 31.4% -> 26.0%. `cargo check` passes.
- Built the WER measurement harness (real Silero VAD + buffer assembly + Parakeet replica) and the local regression gate.
