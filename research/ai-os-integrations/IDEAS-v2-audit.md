# IDEAS v2 — Daily-driver EXPERIENCE audit (iteration A)

Auditor question: where is Tandem's *current* daily-driver experience rough, slow, or annoying,
and what small optimizations make it nicer every day? Every item is grounded in the shipped code
and tracked state. Ranked by real impact on Andrew's day (minutes saved / dropped balls prevented /
friction removed), not novelty.

Reference date: 2026-07-17. Branch: feature/canvas-server-autostart.

---

## 1. Backend-offline is completely silent (empty app, no explanation, no retry)
**Hurts today.** When the FastAPI backend is down (it "has died 3x this session", To-do L99; and dies
on reboot per the brief), the sidebar's fetch just swallows the error and shows an empty list:
[SidebarProvider.tsx#L99-L104](frontend/src/components/Sidebar/SidebarProvider.tsx#L99) catches,
`setMeetings([])`, logs to console, and calls `Analytics.trackBackendConnection(false)`. Nothing
reaches the user. Ctrl+K meeting search ([SidebarProvider.tsx#L180](frontend/src/components/Sidebar/SidebarProvider.tsx#L180))
and summaries silently return nothing too. Andrew reboots, opens Tandem, sees a blank meetings list
with zero signal that the cause is a dead backend he needs to start.
**Fix.** A lightweight health poll (`GET :5167/docs` or a `/health`) surfacing a calm, non-blocking
banner: "Backend not reachable — meetings and summaries are paused" with a Retry button (and, in dev,
a hint to run the start script). Reuse the existing `ComplianceNotification`/banner styling.
**Impact.** Turns a confusing dead-end into a one-glance diagnosis on the exact days Andrew is most
likely to hit it (post-reboot). Prevents "why is everything gone?" panic.
**Effort.** M

## 2. Autostart + the one-click launcher use a window-bound backend that dies on close
**Hurts today.** [start_tandem.bat#L6](start_tandem.bat#L6) launches the backend with `cmd /k` in a
child window; closing that window (or a reboot) kills uvicorn. The Startup-folder shortcut points
straight at it ([create_startup_shortcut.ps1#L5](scripts/create_startup_shortcut.ps1#L5)). Meanwhile
a *resilient* detached, logged, survives-terminal-close launcher already exists and is unused by the
autostart path: [start_backend.ps1](scripts/start_backend.ps1) (Win32_Process Create, logs to
backend.log). So the robust script Andrew wrote isn't the one that actually runs on boot. I7
(autostart/tray) is parked (To-do L61).
**Fix.** Repoint `start_tandem.bat` / the Startup shortcut at the detached `start_backend.ps1` (or
wrap uvicorn so window-close no longer kills it), so a reboot brings the backend back on its own.
Small supervisor loop optional.
**Impact.** Directly kills the recurring "backend died after reboot" failure that makes the daily
driver look broken every morning. Pairs with #1 (banner covers the gap until it is up).
**Effort.** S

## 3. Post-meeting toast pile-up (up to 4 concurrent 10s toasts on one stop)
**Hurts today.** A jotted, auto-summary-on, calendar-filed meeting stop fires, roughly at once:
"Recording saved successfully! N transcript segments saved" (10s,
[useRecordingStop.ts#L654](frontend/src/hooks/useRecordingStop.ts#L654)); "Saved into <project>/.tandem"
(10s, [L557](frontend/src/hooks/useRecordingStop.ts#L557) / [L609](frontend/src/hooks/useRecordingStop.ts#L609));
the auto-summary toast "Summarizing… → Summary ready" ([L134](frontend/src/hooks/useRecordingStop.ts#L134)/[L157](frontend/src/hooks/useRecordingStop.ts#L157));
and enhance-notes "Enhancing your notes… → Notes ready" ([enhanceNotes.ts#L99](frontend/src/lib/enhanceNotes.ts#L99)/[L151](frontend/src/lib/enhanceNotes.ts#L151)).
That is a stack of 3-4 cards, several with competing "View" actions. It contradicts the brand's
"calm / invisible when active" principle at the one moment the user just wants to move on.
**Fix.** Collapse the two save toasts into one ("Saved to <project> — N segments"), and let the
summary and enhance passes share a single evolving toast lane (or drop their success toasts to a
quieter inline badge on the meeting card). One toast, not four.
**Impact.** Removes visual clutter after *every* recorded call, the highest-frequency daily moment.
**Effort.** M

## 4. Sidebar always reopens collapsed; the user's preference is never remembered
**Hurts today.** `isCollapsed` starts hardcoded `true` and is only toggled in memory:
[SidebarProvider.tsx#L71](frontend/src/components/Sidebar/SidebarProvider.tsx#L71),
`toggleCollapse` at [L131](frontend/src/components/Sidebar/SidebarProvider.tsx#L131). Every launch,
a user who lives in the meetings list must re-expand it. Nothing persists the choice.
**Fix.** Read/write `isCollapsed` to localStorage (same pattern already used for the sidebar view
mode in [index.tsx#L107](frontend/src/components/Sidebar/index.tsx#L107)).
**Impact.** One saved click on every single app open for a daily driver.
**Effort.** S

## 5. Meeting list is fully unbounded and un-virtualized
**Hurts today.** `api_get_meetings` returns *every* meeting with no limit
([SidebarProvider.tsx#L91](frontend/src/components/Sidebar/SidebarProvider.tsx#L91)); the sidebar then
renders them all via a recursive `renderItem` map with no virtualization
([index.tsx#L861](frontend/src/components/Sidebar/index.tsx#L861), grouped path
[L847](frontend/src/components/Sidebar/index.tsx#L847)), and search filters client-side over the full
array. A daily driver accumulates hundreds of meetings; the DOM node count and per-render cost climb
unbounded. (The transcript *view* is virtualized via `VirtualizedTranscriptView`, but the meeting
list is not.)
**Fix.** Virtualize the meeting list (react-window, already the pattern elsewhere) or cap the initial
fetch with lazy "load older" + a bounded SQL LIMIT, mirroring the debounced search cap.
**Impact.** Keeps the sidebar snappy months into daily use instead of degrading silently.
**Effort.** M

## 6. Live "recording" bar animation re-renders Home every 250ms and ignores reduced-motion
**Hurts today.** During the entire recording, a `setInterval` regenerates five random bar heights and
calls `setBarHeights` every 250ms, forcing a Home re-render 4x/sec:
[page.tsx#L333-L347](frontend/src/app/page.tsx#L333). It is React state (not CSS), so it also drags
the memoized children, and it never checks `prefers-reduced-motion` (CLAUDE.md design context mandates
a reduced-motion fallback; only globals.css + solo-hud honor it today).
**Fix.** Move the equaliser to a pure CSS keyframe animation (or gate the interval behind
`useReducedMotion()` and drop it out of render state).
**Impact.** Removes a constant 4Hz re-render for the whole call duration and respects the
accessibility rule the design doc already sets. Calmer, cheaper.
**Effort.** S

## 7. Summary-polling cleanup clears ALL intervals on every map mutation
**Hurts today.** The cleanup effect depends on `[activeSummaryPolls]` and its teardown clears *every*
interval whenever the map changes: [SidebarProvider.tsx#L286-L291](frontend/src/components/Sidebar/SidebarProvider.tsx#L286).
Because `startSummaryPolling`/`stopSummaryPolling` also list `activeSummaryPolls` as a dep
([L270](frontend/src/components/Sidebar/SidebarProvider.tsx#L270), [L283](frontend/src/components/Sidebar/SidebarProvider.tsx#L283)),
they are rebuilt on every poll tick that mutates the map. This is needless churn and a real risk of a
concurrent second summary poll being torn down early.
**Fix.** Hold the interval map in a `useRef` and give the unmount cleanup an empty dep array so it
fires once on real unmount.
**Impact.** Removes redundant re-subscription work and a latent "my summary stopped generating" bug
when two summaries overlap.
**Effort.** M

## 8. Auto-summary is OFF by default, against the "handled without being asked" promise
**Hurts today.** `isAutoSummaryEnabled()` defaults to `false`
([autoSummary.ts#L37-L44](frontend/src/lib/autoSummary.ts#L37)). Tandem's whole positioning is "the
senior colleague who takes perfect notes without being asked", yet out of the box every meeting ends
with no summary until the user finds the toggle in Settings and turns it on.
**Fix.** Default auto-summary ON when a summarization model is configured (the code already no-ops
safely when no provider is set, [useRecordingStop.ts#L125](frontend/src/hooks/useRecordingStop.ts#L125)),
or prompt once on first completed recording.
**Impact.** Makes the flagship "it just handles it" behavior the default, not an opt-in most users
never discover.
**Effort.** S

## 9. Action items render twice on the meeting-details page
**Hurts today.** Already tracked as an I4 deferred item (To-do L38): the "Immediate Action Items"
section shows once as the interactive `ActionItemsChecklist` and again as plain text inside
`BlockNoteSummaryView`. Every meeting review shows the same list duplicated, which reads as a bug.
**Fix.** Add a read-only summary render path that excludes the action-items section without stripping
it from the saved payload (the note in To-do L38 flags the save-payload trap to avoid).
**Impact.** Cleans up the single most-visited review surface; removes a "did it double-save?" doubt.
**Effort.** M

## 10. Canvas toolbar buttons hardcode light-mode colors (dark-mode debt)
**Hurts today.** Tracked follow-up (To-do L96): `InsertHtmlButton`, `InsertWebsiteButton`, and
`WebsiteShapeUtil` hardcode light colors, so in the default dark theme they render inconsistently.
CLAUDE.md requires `dark:` variants / semantic tokens on all new UI.
**Fix.** Add dark variants / swap to semantic tokens on those three components.
**Impact.** Removes a jarring light-on-dark patch for anyone who opens the whiteboard in the default
theme.
**Effort.** S

---

### Notes on scope
- Items 1, 2, 8, 9, 10 intersect parked/deferred tracked work (I7 residency, I4 double-render, canvas
  dark mode) but are each a small, standalone daily-experience win that need not wait for the full
  parked iteration.
- Not included (out of "small optimization" scope): the parked I7/I8/I9 feature tracks, Scribe
  Realtime WS, and the prod canvas-server packaging gap — all larger, already-planned efforts.
