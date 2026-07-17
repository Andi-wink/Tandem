# AI-OS integration ideas, v2 (new, not on any prior list)

Iteration A ideas researcher, 2026-07-17. These are ADDITIONAL ideas that are **not** in
[ROADMAP.md](ROADMAP.md), [idea-backlog-ranked.md](../idea-backlog-ranked.md), or the parked/killed
sets in [To-do.md](../../To-do.md). Everything already shipped, proposed, parked, or killed was read in
full first; where a new idea sits near an existing one, the distinction (and the honest overlap) is
stated so nothing is silently re-proposed.

Ranking criterion is unchanged: **real impact on Andrew's daily experience** as a solo consultant doing
5-15 discovery/advisory calls a week. Only minutes saved per week and dropped balls prevented score.
Novelty scores nothing. The lens this pass is deliberately **the day _outside_ meetings**: morning
startup, context switching between clients, remembering promises, email triage, proposal writing,
invoicing, end-of-day shutdown, content production.

Each idea uses Tandem's already-shipped primitives, so effort stays low: the **router** (project
auto-file + client-folder discovery), the **Ctrl+K palette**, **quick-capture** (Alt+Shift+N, clipboard
chips), **jots** + **enhance-my-notes**, the **action-items checklist**, **stop-driven auto-summary**,
the **calendar/ICS agenda**, the **By-project sidebar**, the **handoff** path, the **PII anonymizer**
(Presidio, on-device), the **AI panel** (SSE), and the **client-communication** voice skill.

Landscape check (2026): every general-purpose assistant is converging on the same three moves Tandem is
positioned to beat on privacy: (a) **cross-note folder chat with inline citations** (Granola 2.0's
folder-level chat cites the exact conversation each answer came from,
[Granola chat-with-folders](https://www.granola.ai/blog/chat-with-meetings-search-analyze-ai-2026)),
(b) **act-on-anything-on-screen** (Windows 11 **Click to Do** sends selected text/images to AI actions,
[Windows Central](https://www.windowscentral.com/software-apps/windows-11/what-is-new-on-recall-click-to-do-search-for-copilot-pcs-running-windows-11);
Highlight AI "see what you're looking at, ask about anything,"
[highlightai.com/chatgpt](https://highlightai.com/chatgpt)), and (c) **local-model, zero-cloud AI**
(Raycast runs 100+ models locally through Ollama, free, offline,
[Raycast local models](https://x.com/raycastapp/status/1925174766337753114)). All three are cloud-first
in the incumbents. Tandem's edge is doing them on-device over confidential client data. Separately, the
consultant-workflow literature is explicit that the biggest time sinks are **not** the call itself:
consultants report 45-90 min per client per week on note-taking + follow-up drafting, and 8-15 hrs/week
across notes, email, proposals and content when the whole post-call chain is automated
([KenzNote consultant guide](https://kenznote.com/blog/ai-meeting-notes-for-consultants),
[Every: run a consulting practice with AI](https://every.ai/blog/ai-for-consultants/)). Tandem already
owns the call; the gain is in the hours around it.

---

## Tier 1: strongest daily impact

### 1. Daily bookends: a morning brief and an evening shutdown card
**What.** Two palette commands (and a first-launch-of-the-day auto-card): **"Start my day"** renders one
card with today's agenda, every open + overdue action item grouped by project, and any promise still
owed from yesterday's calls, each linking to its meeting. **"Wrap my day"** (evening) shows what you
touched today, what is still open/owed, and pre-stages tomorrow's first prep card so the morning is warm.
**Composed from.** calendar/ICS agenda + action-items checklist + router (project grouping) + notes +
Ctrl+K palette + notification.
**Impact.** The single orientation ritual a multi-client consultant lacks. Fires every working day (not
weekly), cross-project, and is the delivery surface for "morning startup" and "end-of-day shutdown"
named as pain. Realistic 10-20 min/week of "what am I on top of / what did I drop" scanning, plus it is
the daily net that stops an owed item from aging silently.
**Privacy fit.** Fully on-device: reads local meeting metadata + the local action-items store. No model
call needed for the base card (a local Ollama one-line "what changed" is optional).
**Effort.** S-M.
**Honest overlap.** This is the daily-ritual _surface_, not new data; it depends on the cross-meeting
action-item inbox (backlog #1) to be non-redundant, and it must stay distinct from the weekly digest
(backlog #11, rated marginal for rehashing) by being the once-a-day launch ritual rather than a Monday
rollup. Build it as the thin daily view _over_ the inbox, never as a second aggregation engine.

### 2. Catch-me-up context-switch card ("Reload &lt;client&gt; into my head")
**What.** A palette command **"Catch me up on Acme"** (or a button on any By-project group) that instantly
reloads a client into working memory mid-day: last meeting summary, open action items you owe them,
their last promise to you, your latest notes, and the one-line "where we left off." On-demand, not
calendar-triggered.
**Composed from.** By-project sidebar + stop-driven summary + action-items checklist + enhance-my-notes +
Ctrl+K palette.
**Impact.** Directly targets **context switching between clients**, the tax a solo consultant pays a
dozen times a day. A 30-second reload beats 3-5 min of scrolling the folder and re-reading a summary,
and it prevents the "wait, what did we agree with them" fumble at the top of an unplanned call. Several
switches a day makes this high-frequency.
**Privacy fit.** Fully local; assembles already-stored artifacts, no cloud call required.
**Effort.** S. It is a composition of surfaces that already exist, keyed by project.
**Honest overlap.** Distinct from the meeting prep one-pager (backlog #2, which is _calendar-event_
triggered before a specific call) and from the client dossier (backlog #7 / F043, a maintained _facts_
sheet that is drift-prone). This one is on-demand, assembled fresh from immutable artifacts, so it has no
maintenance chore and no hallucination surface.

### 3. Billable time and activity ledger per client
**What.** Auto-build a per-project ledger from data Tandem already records: every meeting's date,
duration, and topic. Surface a **monthly billable summary per client** (meetings, total hours, topic
line per session, deliverables from action items) that exports as invoice line items or a plain-text
`activity-log.md` in the client folder. The log is append-only and dated, so it is an immutable
narrative CRM, not a drift-prone facts sheet.
**Composed from.** By-project sidebar + meeting metadata (duration/date already stored) + stop-driven
summary + action-items checklist.
**Impact.** Hits **invoicing** and monthly reporting, the most-avoided admin a solo consultant has.
"How many hours on Acme this month, on what" is currently a manual reconstruction; here the data already
exists and just needs aggregation + an export. Plausibly 20-40 min saved per invoicing cycle per client
and, more importantly, it stops under-billing (forgotten sessions) which is direct revenue.
**Privacy fit.** Fully on-device: pure aggregation of local metadata, no model call.
**Effort.** S-M. The durations and dates are in the DB today; the work is a per-project rollup view and
a CSV/markdown export.
**Honest overlap.** None on any list. Adjacent to the weekly digest only in that both aggregate, but the
axis (billable hours per client) and the artifact (invoice lines) are new.

---

## Tier 2: strong, one lever each

### 4. Grounded reply drafter for inbound client messages
**What.** Paste an inbound client email / WhatsApp / Slack message into quick-capture (or a "Draft
reply" surface); Tandem routes it to the right project, pulls the relevant meeting history + the open
action items with that client, and drafts a reply **in Andrew's voice** via the client-communication
skill. Copy-only, never sends.
**Composed from.** quick-capture (clipboard chips) + router + ask-my-meetings context + AI panel +
client-communication voice skill + PII anonymizer.
**Impact.** Targets **email triage**, the daily grind. The reply is grounded in what was actually agreed,
so it answers "did we say Friday or next week" correctly instead of a generic acknowledgement. Industry
reports put follow-up/reply drafting at 15-20 min per client that AI cuts to a 2-min review
([Fireflies via KenzNote](https://kenznote.com/blog/ai-meeting-notes-for-consultants)). Several inbound
threads a day.
**Privacy fit.** Content stays local; run on local Ollama by default, or PII-anonymize the pasted
message + retrieved context before any cloud call. Copy-only, so no accidental send.
**Effort.** M. Reuses quick-capture ingest, the router, and the client-communication voice; the new work
is the retrieval-into-draft prompt.
**Honest overlap.** Distinct from the parked I8 "draft follow-up email" (which drafts a _new_ proactive
follow-up _from a summary_). This _replies_ to an _inbound_ message and answers its specific question
from history. Build the two on one drafting core if I8 lands first.

### 5. Scope-of-work / proposal text draft from a discovery call
**What.** After a discovery summary lands, a **"Draft proposal"** action produces a lightweight text SOW
(objectives, scope, deliverables, assumptions, timeline, a price placeholder) into the client folder,
grounded in the summary + action items + any prior calls with that client.
**Composed from.** stop-driven summary + action-items checklist + By-project history + client-
communication voice + PII anonymizer.
**Impact.** **Proposal writing** is the most expensive post-call chore a consultant has (30-60 min per
proposal; the Tana/Every write-ups cite one-click meeting-to-proposal as the headline consultant win,
[Every](https://every.ai/blog/ai-for-consultants/)). Even a rough first draft that Andrew refines is a
revenue lever: faster quote turnaround wins deals.
**Privacy fit.** Local Ollama or PII-anonymized before a cloud model. Draft-only, lands as an editable
file.
**Effort.** M. Summary-to-outline prompt + a file write into the client folder.
**Honest overlap.** Deliberately **not** the same as ROADMAP #11 "discovery call to pitch deck via
visual-audio-automation" (a branded HTML _slide deck_, heavier, lower frequency). This is the
lightweight _text document_ that is actually the first artifact most engagements need, and it should be
built first / share the summary-to-artifact core so ROADMAP #11 layers on top.

### 6. Clipboard smart-actions on quick-capture chips (Click-to-Do, done locally)
**What.** Extend the existing quick-capture clipboard chips with one-tap AI actions: **Summarize**,
**Extract tasks**, **Draft reply**, **Route to project + open in AI panel**. Select-and-act on any text
you copied, grounded in the active project's context.
**Composed from.** clipboard capture (Alt+Shift+V) + quick-capture chips + router + AI panel.
**Impact.** This is the incumbent "act on anything on screen" move (Windows 11 Click to Do; Highlight;
Raycast Quick AI) but done **locally and project-grounded**. Removes the copy-paste-into-a-chatbot round
trip several times a day. Small per-use saving, high frequency, and it makes the already-shipped chips
do real work instead of just filing text.
**Privacy fit.** Local-capable via Ollama; nothing leaves the machine for the summarize/extract actions.
**Effort.** S. The chips and the AI panel exist; this adds action buttons + a couple of prompt presets.
**Honest overlap.** None. Quick-capture today only _files_ chips as notes; this adds the act-on-it layer
the incumbents ship cloud-only.

### 7. Stale-promise nudges on confirmed action items
**What.** A proactive layer over the **already-confirmed** action-items checklist: if an item Andrew
checked as owed has been open longer than a threshold (default configurable), a gentle nudge surfaces on
the daily brief and optionally as a muted-respecting notification ("You owe Acme the revised scope, 4
days open").
**Composed from.** action-items checklist (user-confirmed items) + notification (mute toggle already
ships) + the daily brief (idea 1).
**Impact.** Targets **remembering promises**, the trust-critical failure mode: one dropped commitment to
a paying client costs more than any weekly minute count. Because it nudges only on items Andrew already
confirmed as owed, the false-positive rate is low.
**Privacy fit.** Fully local.
**Effort.** S.
**Honest overlap.** This is why it is safe where the commitment tracker (backlog #12) was flagged
dangerous: that idea extracts commitments from raw _speech_ (error-prone, trains you to ignore nudges).
This operates only on the _confirmed_ checklist, so it has no extraction false-positives. It depends on
the action-item inbox (backlog #1) and should ship as a thin layer on it, not a separate parser.

---

## Tier 3: real but narrower or more overlapping

### 8. Project-scoped Q&A (the no-RAG-spike slice of ask-my-meetings)
**What.** Scope the AI panel to a single client's folder: every question is answered **only** from that
client's meetings, with exact-quote citations and jump-to-source. "What did we agree on scope with Acme?"
returns the line and the meeting.
**Composed from.** By-project sidebar (the scope) + AI panel + stop-driven summaries/transcripts +
enhance-my-notes.
**Impact.** This is Granola 2.0's most-praised 2026 move (folder-level chat with inline citations,
[Granola](https://www.granola.ai/blog/chat-with-meetings-search-analyze-ai-2026)) but on-device and
project-bounded. The scoping is the point: a single client has a handful of transcripts, so a
**brute-force pass over that folder needs no vector index and no sqlite-vec-through-sqlx spike**, and the
citation trust problem is contained because the corpus is small and known.
**Privacy fit.** Local synthesis on Ollama; exact-quote citations, no cloud needed.
**Effort.** S-M.
**Honest overlap.** This is a deliberately **de-risked, shippable-now subset** of ROADMAP #8
(ask-my-meetings global RAG + MCP server), not a rediscovery of it. The new insight is that scoping to
one project removes the RAG infrastructure entirely, so this can land before, and inform, the global
memory layer. Flag hard if it ever grows toward global scope: at that point it _is_ ROADMAP #8 and needs
the spike.

### 9. Recurring-call agenda auto-draft
**What.** For a recurring client meeting on the calendar, draft a proposed **agenda** (not just a passive
brief) before the next occurrence: open action items to close out, unfinished topics from last time, and
your own notes, as editable talking points you can share.
**Composed from.** calendar/ICS recurring events + action-items checklist + enhance-my-notes + the
pre-meeting prep card (shipped I5).
**Impact.** Recurring advisory relationships are where a solo consultant's revenue lives; walking in with
a ready agenda (vs improvising) both saves 5-10 min of prep and makes the call tighter. Fires on every
recurring call.
**Privacy fit.** Fully local.
**Effort.** S-M. Rides the shipped I5 pre-meeting card as the delivery surface.
**Honest overlap.** Adjacent to the prep one-pager (backlog #2), which is a _passive_ brief (history +
open items). This produces an _active_, editable, shareable agenda artifact. If backlog #2 ships first,
add the agenda as its "make this actionable" button rather than a separate feature. Requires the parked
I8 MONTHLY/YEARLY RRULE expansion to fire for monthly client calls (currently invisible to the agenda).

### 10. Repurpose-an-insight drafter (content production, anonymized)
**What.** Turn a de-identified insight from a call into a short LinkedIn post / newsletter paragraph:
select a summary point or note, Tandem **PII-anonymizes it first** (client and personal details stripped
via Presidio), then drafts shareable content in a chosen voice.
**Composed from.** stop-driven summary + enhance-my-notes + PII anonymizer (mandatory first step) +
client-communication / content voice + AI panel.
**Impact.** **Content production** is a named consultant time sink and a pipeline driver (the connected-
stack write-ups include content among the 8-15 hrs/week saved,
[KenzNote](https://kenznote.com/blog/ai-meeting-notes-for-consultants)). Turning what you already learned
on a call into thought-leadership without re-typing is a real lever, and it is marketing that feeds new
business.
**Privacy fit.** This is the privacy-sensitive one, so it is gated hard: PII anonymization runs
on-device _before_ any generation, and the output is draft-only for Andrew to vet. Never auto-post.
**Effort.** M.
**Honest overlap.** None on any list. The anonymize-then-generate order is the whole safety design and
must not be optional.

---

## Ranked shortlist (by real daily impact per unit effort)

1. **Catch-me-up context-switch card (idea 2, S).** Highest frequency win: reloads a client into your
   head in 30 seconds, several times a day, from immutable artifacts with zero hallucination surface.
2. **Clipboard smart-actions on capture chips (idea 6, S).** Cheapest high-frequency lever; makes shipped
   chips do real work and matches the incumbents' headline move locally.
3. **Billable time and activity ledger (idea 3, S-M).** Direct revenue (stops under-billing), and the
   data already exists, so it is mostly a rollup view.
4. **Daily bookends (idea 1, S-M).** The morning/evening ritual surface, best built as a thin view over
   the action-item inbox.
5. **Stale-promise nudges (idea 7, S).** The safe half of commitment-tracking: nudges only confirmed
   owed items, so it prevents dropped balls without training you to ignore it.
6. **Grounded reply drafter (idea 4, M)** and **proposal draft (idea 5, M)** are the two biggest
   absolute time-savers (email triage, proposal writing) but cost a notch more and want the
   anonymize-or-local-model gate; sequence them on one drafting core.

Ideas 8 (project-scoped Q&A) and 9 (recurring agenda) are genuine but each is a de-risked subset of an
already-proposed item (ROADMAP #8; backlog #2 + parked I8 RRULEs), so build them as slices of those, not
as separate tracks. Idea 10 (content repurpose) is the one revenue-adjacent bet whose value depends on
Andrew actually publishing, so build on demand behind the mandatory anonymize step.
