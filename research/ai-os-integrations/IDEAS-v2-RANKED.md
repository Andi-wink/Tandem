# IDEAS v2, adversarially merged and ranked (iteration A)

Adversarial ranker pass, 2026-07-17. Inputs: [IDEAS-v2-new.md](IDEAS-v2-new.md) (10 new ideas) and
[IDEAS-v2-audit.md](IDEAS-v2-audit.md) (10 experience optimizations), slotted against the existing open
items in [ROADMAP.md](ROADMAP.md) and [idea-backlog-ranked.md](../idea-backlog-ranked.md).

Ranking criterion, unchanged and enforced: **real impact on Andrew's daily experience** as a solo
consultant doing 5-15 calls/week. Only minutes saved, dropped balls prevented, and friction removed
score. Novelty scores nothing. Every audit claim was checked against the actual code before it earned a
rank; every new idea was checked for duplication, privacy fit, and realistic frequency. What did not
survive is in the Killed section with the reason, so nothing gets silently re-proposed.

Sources are tagged: **[audit N]** = experience optimization, **[new N]** = new idea,
**[ROADMAP #N]** / **[backlog #N]** = an existing open item pulled in as an anchor so the picture is
one coherent priority list, not three.

Verification note: the audit is honest. I opened every cited file. Audit 1, 2, 4, 6, 7, 8 are confirmed
against the current code (line refs held up); audit 9 and 10 match tracked To-do items. Two claims were
softened on inspection (audit 3's "up to 4 toasts" is realistically 3, since the two "Saved into
project" toasts are mutually exclusive by the `!ownedPending` guard; audit 5's cliff is real but not yet
reached). Neither softening changes a verdict.

---

## The merged ranking (most daily impact first)

### 1. Make the backend resilient, then repoint autostart at it, S. **[audit 2]**
The single highest real-daily-impact item on either list. The backend "died 3x this session" and dies on
reboot ([To-do L99](../../To-do.md)); the cause is confirmed in code:
[start_tandem.bat#L6](../../start_tandem.bat#L6) launches uvicorn in a `cmd /k` child window that dies on
close, and the Startup shortcut ([create_startup_shortcut.ps1#L5](../../scripts/create_startup_shortcut.ps1#L5))
points straight at it, while the detached, logged, survives-close [start_backend.ps1](../../scripts/start_backend.ps1)
Andrew already wrote sits unused. This makes the daily driver look broken every morning. The fix is small:
launch the backend detached via the existing resilient script and repoint the autostart path at it. This
is the S subset of parked I7 worth pulling forward now; the rest of I7 (tray UI, retention) stays parked.

### 2. Backend-offline banner with Retry, M. **[audit 1]**
The safety net that pairs with #1. Confirmed: [SidebarProvider.tsx#L99-L104](../../frontend/src/components/Sidebar/SidebarProvider.tsx#L99)
swallows the fetch error, calls `setMeetings([])`, and shows nothing; Ctrl+K search and summaries go
silent too. Until autostart is bulletproof, a calm non-blocking banner ("Backend not reachable, meetings
paused") turns a blank-app panic into a one-glance diagnosis on exactly the post-reboot days it breaks.
Reuse the existing notification/banner styling.

### 3. Ollama structured outputs for extraction, S. **[ROADMAP #2, anchor]**
The cheapest high-leverage foundation. Action items are scraped by regex over freeform markdown today
([actionItems.ts](../../frontend/src/lib/actionItems.ts)); JSON-schema-constrained output makes that
parsing clean and typed. It de-noises the substrate that the action-item inbox (#4) and half the new
ideas depend on, so it lifts everything downstream for near-zero cost. Build before the inbox.

### 4. Cross-meeting action-item inbox, M. **[backlog #1, anchor]**
Still the single biggest dropped-ball preventer: "what do I owe everyone," grouped by project, with
open/done/overdue state. The raw parsing already ships (I4); this is aggregation. It is also the
substrate that new ideas 1 (daily bookends) and 7 (stale-promise nudges) stand on, so it must precede
them. Build on typed data from #3.

### 5. Catch-me-up context-switch card, S. **[new 2]**
The strongest net-new daily idea and the cheapest. "Reload Acme into my head" assembles already-stored,
immutable artifacts (last summary, owed items, their last promise, latest notes, where we left off) with
zero maintenance and zero hallucination surface. Build it as the on-demand face of the prep one-pager
(#6): same assembly, two triggers. Frequency is genuinely high for a multi-client day (temper the "a
dozen times a day" claim to a few real client touches, still a 30-second reload beating 3-5 min of
scrolling each time).

### 6. Meeting prep one-pager, S-M. **[backlog #2, anchor]**
Fires on every single call and rides the shipped I5 prep card plus I3 routing. Share the assembly core
with #5 so the client-context brief is built once and surfaced both calendar-triggered (here) and
on-demand (there). Its only failure mode is a wrong project match surfacing the wrong client, so gate on
a confident match.

### 7. Fix the summary-polling teardown bug, S-M. **[audit 7]**
The only genuine correctness bug in the audit, and confirmed:
[SidebarProvider.tsx#L286-L291](../../frontend/src/components/Sidebar/SidebarProvider.tsx#L286) depends
on `[activeSummaryPolls]`, so every map mutation tears down every interval, and starting a second
overlapping summary poll kills the first. Back-to-back calls are exactly Andrew's pattern, and the
symptom is a silently lost summary. Hold the map in a `useRef` and give the unmount cleanup an empty dep
array. Ranked above the cosmetic items because it drops a ball, it does not just look untidy.

### 8. Project-scoped Q&A, de-risked slice of ask-my-meetings, S-M. **[new 8]**
The clever move: scope the AI panel to one client's folder and brute-force over its handful of
transcripts, which removes the sqlite-vec-through-sqlx spike that blocks the full memory layer
([ROADMAP #8](ROADMAP.md), an M-L open item). Exact-quote citations contain the trust problem because
the corpus is small and known. It ships Granola's most-praised move on-device, now, and informs the
global layer later. Lower frequency than prep (a handful of "what did we agree" moments), so it sits
below the every-call items. Build the citations day one or it corrodes trust.

### 9. Collapse the post-meeting toast pile-up, M. **[audit 3]**
Confirmed: a jotted, auto-summary, calendar-filed stop fires the recording-saved toast
([useRecordingStop.ts#L654](../../frontend/src/hooks/useRecordingStop.ts#L654)), a "Saved into project"
toast ([L557](../../frontend/src/hooks/useRecordingStop.ts#L557)), the summary toast, and the enhance
toast, a stack of three (not four, the two save toasts are mutually exclusive) with competing "View"
actions. It contradicts the calm/invisible-when-active brand at the highest-frequency daily moment. One
evolving toast lane, not three.

### 10. Billable time and activity ledger per client, S-M. **[new 3]**
The one revenue lever here: aggregate meeting date/duration/topic (already recorded) into a monthly
per-client activity log and invoice lines, which stops under-billing forgotten sessions. Data exists, so
it is mostly a rollup + export. Two honest caveats keep it at 10, not higher: it assumes time-based
billing (a fixed-fee consultant gets less from it), and call-hours undercount true billable time (prep,
delivery, async are invisible), so sell it as a narrative activity log first, invoice lines second.
Monthly frequency, high per-event value.

### 11. Fix double-rendered action items on meeting-details, M. **[audit 9]**
Tracked ([To-do L38](../../To-do.md)) and real: the list renders once as the interactive checklist and
again as plain text in the summary view, on the most-visited review surface, reading as a "did it
double-save" bug. Needs a read-only render path that excludes the section without stripping it from the
saved payload (the To-do note flags that trap).

### 12. Privacy-gating + audit hooks, S-M. **[ROADMAP #1, anchor]**
Verified real: [claude_agent.py#L226-L257](../../backend/app/claude_agent.py#L226) sets
`permission_mode="acceptEdits"` with no `hooks=`. On the pure daily-experience axis it is invisible
infrastructure, so it sits here rather than at the very top: it earns its place as the gate that makes
the outbound and drafting features immediately below it (#13, #14) safe to build. Build it just before
them, not before the breakage fixes.

### 13. Grounded reply drafter for inbound messages, exposed as a capture-chip action, M. **[new 4 + new 6]**
Consolidated: [new 4] (paste an inbound client message, route it, draft a reply in Andrew's voice from
real history) and [new 6]'s "Draft reply" chip action are the same capability at two entry points, so
build one drafting core and expose both. Targets email triage, a daily grind. The caveats that keep it
mid-pack: it is M not S (the client-communication voice is a Claude Code skill, not wired into the app
yet), the quality bar for a client-facing draft is high, and it needs the local-Ollama-or-anonymize gate
(hence #12 first). Copy-only, never sends.

### 14. Proposal/SOW text draft from a discovery call, M. **[new 5]**
The most expensive post-call chore (30-60 min/proposal) and a revenue lever via faster turnaround. This
is the lightweight text document, deliberately not the [ROADMAP #11] pitch deck; build the
summary-to-artifact core here and let the deck layer on top. Ranked below the reply drafter because it
fires less often (proposals per week are fewer than inbound threads) and a generic SOW risks being
discarded, so it must be a genuine scaffold from the call, not boilerplate.

### 15. Stale-promise nudges over confirmed action items, S. **[new 7]**
The safe half of commitment-tracking: it nudges only items Andrew already confirmed as owed, so it has
none of the extraction false-positives that made the raw commitment tracker (backlog #12) dangerous.
Real dropped-ball prevention. It stacks on the inbox (#4), or a lite version can scan the shipped
localStorage checkbox state for aged unchecked items without waiting for the full inbox. Below the inbox
it depends on, but a cheap, high-trust layer once it lands.

### 16. Scribe v2 keyterm prompting, S. **[ROADMAP #3, anchor]**
Fewer mangled client and product names, auto-assembled from the project Tandem already knows. STT errors
propagate into search, summaries, and action items, so cutting them compounds across every call for S
effort, no new data leaving the machine. A quiet compounding win that belongs in the same tier as the
other cheap accuracy levers.

### 17. Speaker-aware summarization, channel-split, S. **[ROADMAP #4, anchor]**
Near-free now that F022 diarization is built: attributed commitments ("Client committed to $40k by
Friday") instead of an unattributed wall of text, using the free mic-vs-system split for the common
2-party call. Turns the summary into trustworthy owed-work, which feeds the inbox (#4) quality.

### 18. Recording-bar CSS + reduced-motion fix, S. **[audit 6]**
Confirmed: [page.tsx#L333-L347](../../frontend/src/app/page.tsx#L333) regenerates bar heights via
`setInterval` every 250ms as React state for the whole recording, forcing a 4Hz Home re-render, and it
never checks `prefers-reduced-motion` (a design-doc mandate). Move to a CSS keyframe. Cheap correctness
and a11y hygiene, small real impact, hence low.

### 19. Persist the sidebar collapse preference, S. **[audit 4]**
Confirmed: `isCollapsed` starts hardcoded `true` and toggles in memory only
([SidebarProvider.tsx#L71](../../frontend/src/components/Sidebar/SidebarProvider.tsx#L71)). A user who
lives in the list re-expands it every launch. Trivial fix (mirror the existing localStorage pattern),
trivial impact (a few clicks a week), so it is genuine filler, not a headline.

---

## Killed / hard-demoted (with reasons)

- **[audit 8] Default auto-summary ON.** The fix is correct and cheap, but it scores ~zero on the stated
  axis: Andrew is the daily driver and has almost certainly already enabled it, so it changes nothing
  about *his* day. It is a new-user onboarding default, not a ranked build. Do it as a two-line change
  when convenient; do not spend a slot ranking it for Andrew.

- **[audit 5] Virtualize the meeting list.** The cliff is real (unbounded fetch + un-virtualized render)
  but not yet reached: at 5-15 meetings/week, "hundreds of meetings" is 6-12 months out. Ranking a
  problem that does not exist today over items that hurt today is premature optimization. Revisit at
  ~300 meetings; not on this list.

- **[new 10] Repurpose-an-insight content drafter.** Value is entirely contingent on Andrew actually
  publishing content marketing, which is not part of the daily call/note/follow-up spine. The
  anonymize-then-generate safety design is good, so keep it as a build-on-demand behind the mandatory
  Presidio step, but it is not a scheduled build and does not earn a rank.

- **[new 9] Recurring-call agenda as a standalone feature.** Duplicates the prep one-pager (#6) on the
  same data and is blocked on the parked I8 MONTHLY/YEARLY RRULE expansion for the monthly calls it most
  wants to serve. Fold it in as a "make this an agenda" button on the prep card; do not build a separate
  track.

- **[audit 10] Canvas toolbar dark-mode.** Real tracked debt ([To-do L96](../../To-do.md)) but on an
  occasional secondary surface with near-zero daily impact. Sweep it into the next canvas work as a
  15-minute cleanup; it does not merit a ranked build slot of its own.

**Fold-ins, not kills (call these out so they are not built twice):** #5 and #6 share one client-context
assembly (two triggers); #13 merges [new 4] and [new 6] on one drafting core; #14 and the [ROADMAP #11]
deck share the summary-to-artifact core (text first); #15 stacks on the #4 inbox; #8 is the de-risked
slice of [ROADMAP #8], build it first and let the global layer follow.

---

## If you only build three things

Fix the breakage before the features: **#1, make the backend detached and resilient and point autostart
at it** (with **#2's offline banner riding along**), because an app that looks dead every morning
poisons everything else regardless of how good the features are, and the fix is an afternoon using a
script Andrew already wrote. Then build the owed-work spine: **Ollama structured outputs (#3) feeding the
cross-meeting action-item inbox (#4)**, the single biggest dropped-ball preventer and the substrate half
these ideas stand on. Then the cheapest high-frequency net-new daily win: **the catch-me-up
context-switch card (#5), built as the on-demand face of the prep one-pager**, which reloads a client
into your head in thirty seconds from artifacts that already exist, with no maintenance and no
hallucination risk. Everything else, the drafting features, the Q&A slice, the billable ledger, is real
but waits behind a working app, a trustworthy owed-work list, and a fast way back into a client's head.
