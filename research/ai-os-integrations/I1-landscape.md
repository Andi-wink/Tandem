# I1 Landscape: what adjacent "AI meeting / AI OS" products ship that Tandem lacks

Iteration I1 of the "AI OS features and integrations" loop. Researcher pass, 2026-07-16.

Scope: study the current (2026) state of Granola, Fathom, Fireflies, Cluely, Limitless (ex-Rewind),
Screenpipe, Raycast AI, Wispr Flow, Highlight, Notion AI meetings, Circleback, and newer agentic
entrants. For each relevant feature: what it is, evidence users value it, how it maps onto Tandem's
architecture, and whether it can stay local-first. Output is 8 concrete proposals, deliberately
scoped to things Tandem does NOT already ship or already rank.

Read against [To-do.md](../../To-do.md) and [idea-backlog-ranked.md](../idea-backlog-ranked.md) so
nothing here re-proposes what is built (quick-capture, calendar routing, canvas, video capture,
action-items checklist, auto-summary, Ctrl+K search, @code handoff) or already ranked (action-item
inbox, prep one-pager, ask-my-meetings Q&A, smart titles, post-call review, client dossier, n8n
export, auto-stop, templates, weekly digest, commitment tracker, custom vocab).

---

## What each product ships in 2026 (evidence)

### Granola (raised $125M, $1.5B valuation, March 2026)
- **Human-in-the-loop note enhancement** is the core loved mechanic: you jot rough keywords/bullets
  during the call and Granola "enhances them into structured summaries that reflect your perspective,
  not a generic AI interpretation." Write "pricing concerns" and it finds every pricing discussion in
  the transcript and adds relevant quotes. Users say it lets them "stay focused on the conversation
  instead of frantically typing." A Product Hunt reviewer said it "completely changed how I handle
  client calls." (https://www.granola.ai/, https://wondertools.substack.com/p/granolaguide,
  https://zackproser.com/blog/granola-ai-review)
- **No bot in the call**: transcribes device audio directly, no meeting bot joins, so "participants
  are often more relaxed and transparent." (https://quasa.io/video/granola-review-bot-free-ai-notes-for-back-to-back-meetings)
- **People and Companies views**: organizes meetings by the person/organization you met with; select
  a name and search across all your conversations with them. (https://www.granola.ai/updates,
  https://tldv.io/blog/granola-review/)
- **Team Folders / Spaces** and an **MCP server** that lets agents see notes in folders and shared
  notes. (https://www.granola.ai/updates, https://techcrunch.com/2026/03/25/granola-raises-125m-hits-1-5b-valuation-as-it-expands-from-meeting-notetaker-to-enterprise-ai-app/)

### Circleback
- **Automation engine / system-of-record sync**: after a sales call it can update the CRM deal stage,
  add notes to the contact record, log action items, create tasks, send follow-ups, all automatically.
  Syncs to Salesforce, HubSpot, Attio, Zoho; sends to Slack, Notion, Linear, monday.com, Zapier.
- **Action-item detection** that identifies commitments/tasks, assigns owners, tracks deadlines.
- SOC 2 Type II, no-bot in-person capture. (https://circleback.ai/,
  https://circleback.ai/how-to/best-ai-meeting-notes-software-with-crm-integrations,
  https://aigearbase.com/tool/circleback-ai)

### Fathom and Fireflies
- **Ask Fathom / AskFred**: query across all recorded meetings; AskFred also reaches email, Slack, CRM
  context. Fireflies added a Perplexity-powered **web search integration** to pull live web context
  alongside meeting content (early 2026).
- **Conversation analytics**: talk-to-listen ratio, sentiment, topic frequency, and **topics tracked
  across multiple meetings** with trending themes over time.
- Fathom's April 2026 overhaul added bot-free capture, live summaries, account-wide search.
  (https://fireflies.ai/blog/fireflies-vs-fathom/, https://www.avoma.com/blog/fathom-vs-fireflies,
  https://thebusinessdive.com/fireflies-ai-vs-fathom)

### Cluely
- Real-time invisible overlay: transcribes live, reads on-screen content via OCR, feeds LLMs to
  suggest responses/talking points visible only to the user; undetectable to screen-share via
  low-level GPU hooks. **Custom playbooks** (upload PDFs/scripts as a knowledge base), CRM lookups
  during calls, instant follow-up email drafts. (https://cluely.com/, https://tldv.io/blog/cluely-review/,
  https://textify.ai/cluely-ai-review-2026/) Note: the always-on live-assist overlay conflicts with
  Tandem's "invisible when active" principle, so it is not proposed as a headline here.

### Limitless (formerly Rewind)
- Wearable pendant + apps; all-day capture, AI summaries, **ask-anything over your personal memory**
  ("What was the conclusion of my meeting with the client last week?"), and **daily AI insights /
  Lifelog** recaps of your day. (https://www.limitless.ai/new,
  https://help.limitless.ai/en/articles/9124757-pendant-faq,
  https://skywork.ai/skypage/en/Rewind-AI-&-Limitless:-The-Ultimate-Guide-to-Your-Digital-Memory/1976181260991655936)

### Screenpipe (YC S26, open source, local-first)
- 24/7 local screen+audio capture into a local SQLite DB, nothing sent to servers; reads app text via
  accessibility APIs with OCR fallback; natural-language search filterable by app/window/URL/date.
- Runs as an **MCP server** so Claude Desktop / Cursor / VS Code / any MCP client can query your
  history.
- **Pipes**: scheduled AI agents defined as markdown files (a prompt + a schedule); built-in ones
  include meeting-summary, day-recap, standup-update, time-breakdown, ai-prompt-journal. The agent
  queries your data, calls APIs, writes files, takes actions.
  (https://github.com/screenpipe/screenpipe, https://screenpipe.com/,
  https://explainx.ai/blog/screenpipe-yc-s26-local-work-memory-agents-july-2026)

### Raycast AI (v2, now on Windows)
- **Quick AI** floating window one hotkey away; **AI Commands** (quick actions) and Chat; **Agents**
  (reusable presets); **Memory** so chats remember context about you; **Skills** for custom
  instructions/knowledge; **Quicklinks** and **Floating Notes** one hotkey away.
  (https://www.raycast.com/core-features/ai, https://manual.raycast.com/ai,
  https://www.raycast.com/core-features/notes, https://manual.raycast.com/new-in-v2)

### Wispr Flow (dictation)
- Inserts clean, polished text into any app; **context-aware formatting** (detects Slack vs Gmail vs
  Notion vs code editor and adjusts tone), auto-punctuation, filler-word removal. **Command Mode**:
  "rewrite the last paragraph to be more concise." Whisper-quiet speech supported. macOS/Windows/iOS/
  Android, 100+ languages. (https://tldv.io/blog/wisprflow/,
  https://aiproductivity.ai/guides/wispr-flow-voice-dictation-guide/, https://letterly.app/blog/wispr-flow-review/)

### Highlight AI ($40M Series A, March 2026)
- Desktop assistant that reads the current window: "What are the risks in this contract?", "Summarize
  what was just discussed." AI chat **with memory**, auto meeting notes/action items, hands-free voice,
  task tracking, deep integrations (Gmail, Slack, Linear, Notion). **MCP-based user plugins**;
  emphasizes that **screen processing can be done locally**, without uploading.
  (https://highlightai.com/assistant, https://www.theai.tw/en/tools/highlight-ai,
  https://screenpipe.com/blog/screen-assistant-ai-2026)

### Notion AI meetings
- AI Meeting Notes with **custom format instructions** ("decisions, action items with owners, open
  questions" once, applied to every future note). **Enterprise Search** across the workspace plus
  connectors (Slack, Google Drive, GitHub, Jira, Teams, Salesforce, Box) answering plain-English
  questions **always with cited sources**; @-mention pages/people in a query.
  (https://www.notion.com/product/ai-meeting-notes, https://www.notion.com/product/enterprise-search,
  https://www.eesel.ai/blog/notion-ai-review)

### Newer agentic entrants (Sai, alfred_, Tana)
- The 2026 shift is from notetakers to **agentic meeting platforms** that "prep you before the call,
  ship work during it, and feed every conversation into a context graph that compounds over time,"
  drafting follow-ups in your voice and pushing action items to your task list automatically. Gartner:
  40% of enterprise apps will include task-specific AI agents by end of 2026.
  (https://tana.inc/blog/best-ai-meeting-assistants-2026, https://get-alfred.ai/blog/best-ai-meeting-follow-up-tools,
  https://reclaim.ai/blog/ai-meeting-assistants)

---

## Proposals (8)

Ordered by my read of gain-to-effort for Andrew (solo consultant, privacy-critical, north star
"talk to it, it routes my notes to the right project"). All are local-first unless noted.

| # | Proposal | Source inspiration | Productivity case | Privacy fit | Feasibility |
|---|----------|--------------------|--------------------|-------------|-------------|
| 1 | Enhance-my-notes (human-in-the-loop) | Granola | Jot rough keywords live, AI weaves them with transcript into notes in your voice; the single most-loved feature in the category and absent from Tandem | Local Ollama enhancement; no cloud needed | Medium: needs a live notes pane + enhance pass over the transcript |
| 2 | Local MCP server over the meeting corpus | Screenpipe, Granola, Highlight | Exposes meetings/transcripts/summaries/action-items to Claude Code + any MCP client; Andrew already lives in Claude Code and @code handoff | Fully local: MCP server over the existing SQLite, loopback only | Medium: read-only MCP wrapper; reuse existing DB repos |
| 3 | People and Companies view | Granola, Fireflies | A By-person index next to By-project: pick an attendee, see every call and every commitment with them across projects | Local, derived from calendar attendees + transcript | Low-Medium: index attendees, new sidebar view |
| 4 | Jump-to-topic chapters + cross-meeting topic threads | Fathom, Fireflies | Auto chapters to jump inside a long advisory call, and "everything we've said about pricing with Acme" across calls | Local LLM segmentation; no cloud | Medium: transcript segmentation + topic clustering |
| 5 | Scheduled local recipes / pipes | Screenpipe | User-defined markdown prompts on a schedule over the corpus (morning "prep today's calls", evening recap, weekly rollup); generalizes the ranked weekly digest | Local; reuses schedule/cron infra + @code writer | Medium: a recipe runner + schedule wiring |
| 6 | Persistent assistant memory | Raycast, Highlight | AI panel remembers durable facts (Andrew's role/voice, standing client context, preferences) across sessions instead of starting cold each time | Local file/SQLite memory store, on-device | Low-Medium: a memory store injected into the context basket |
| 7 | Voice dictation into capture | Wispr Flow | Dictate a note (or a follow-up) instead of typing; local Whisper cleans filler + formats, then routes via the existing router. Narrow, avoids the rejected "voice control everything" | Local Whisper already in-app | Low: pipe local STT into the quick-capture note field |
| 8 | Typed extraction to system-of-record via n8n | Circleback, Fireflies | Extract typed fields (client, stage, next step, follow-up date) as JSON and POST to Andrew's n8n for CRM/task fan-out; the structured layer above the ranked raw n8n hook | Local extraction; only chosen fields leave, user-gated | Low-Medium: schema + outbound webhook; overlaps ranked n8n export |

### Notes on fit and overlap
- **#1 Enhance-my-notes** is the strongest net-new bet: it is the reason people love Granola, it
  directly serves "stay present during the call," and Tandem today only summarizes from transcript
  with no path to blend the user's own live shorthand. It advances the OS vision without any live
  overlay that would break "invisible when active."
- **#2 MCP server** and **#4 cross-meeting topic threads** partially cover the same ground as the
  ranked "ask-my-meetings Q&A," but from a safer angle: MCP hands the corpus to Claude Code (Andrew's
  existing agent) with exact source rows rather than an in-app RAG that can hallucinate citations, and
  topic threads surface the actual passages rather than a synthesized answer. If ask-my-meetings is
  ever built, do it on top of #2 so citations are exact-quote-linked (the trust problem flagged in the
  backlog).
- **#3 People view** is distinct from the ranked "client dossier": dossier is an editable fact sheet
  (drift-prone); this is a pure derived cross-reference (no maintained facts, low trust risk).
- **#5 recipes** subsumes the ranked "weekly review digest" as one recipe and generalizes it; build
  the runner once.
- **#8** overlaps the ranked "n8n export hook." Its only net-new value is the typed-schema extraction
  layer; sequence it with that item, do not build twice.
- **Deliberately NOT proposed**: Cluely-style always-on live-assist overlay and Limitless-style
  all-day ambient capture. Both conflict with Tandem's "invisible when active" principle and its
  confidential-client privacy posture (continuous ambient recording of everyone nearby). Web-search
  augmentation (Fireflies + Perplexity) is also held back: it would send client-meeting context to a
  cloud search, against the privacy-first stance, unless narrowed to public-entity lookups only.
- **Where Tandem already wins**: bot-free device-audio capture (Granola/Fathom/Cluely tout it; Tandem
  already does it locally), on-device PII anonymization, and local Whisper. Keep leaning on these as
  differentiators, none of the cloud incumbents match the local-first privacy story.

---

## Sources
- Granola: https://www.granola.ai/ , https://www.granola.ai/updates , https://wondertools.substack.com/p/granolaguide , https://zackproser.com/blog/granola-ai-review , https://quasa.io/video/granola-review-bot-free-ai-notes-for-back-to-back-meetings , https://tldv.io/blog/granola-review/ , https://techcrunch.com/2026/03/25/granola-raises-125m-hits-1-5b-valuation-as-it-expands-from-meeting-notetaker-to-enterprise-ai-app/
- Circleback: https://circleback.ai/ , https://circleback.ai/how-to/best-ai-meeting-notes-software-with-crm-integrations , https://aigearbase.com/tool/circleback-ai
- Fathom / Fireflies: https://fireflies.ai/blog/fireflies-vs-fathom/ , https://www.avoma.com/blog/fathom-vs-fireflies , https://thebusinessdive.com/fireflies-ai-vs-fathom
- Cluely: https://cluely.com/ , https://tldv.io/blog/cluely-review/ , https://textify.ai/cluely-ai-review-2026/
- Limitless: https://www.limitless.ai/new , https://help.limitless.ai/en/articles/9124757-pendant-faq , https://skywork.ai/skypage/en/Rewind-AI-&-Limitless:-The-Ultimate-Guide-to-Your-Digital-Memory/1976181260991655936
- Screenpipe: https://github.com/screenpipe/screenpipe , https://screenpipe.com/ , https://explainx.ai/blog/screenpipe-yc-s26-local-work-memory-agents-july-2026
- Raycast: https://www.raycast.com/core-features/ai , https://manual.raycast.com/ai , https://www.raycast.com/core-features/notes , https://manual.raycast.com/new-in-v2
- Wispr Flow: https://tldv.io/blog/wisprflow/ , https://aiproductivity.ai/guides/wispr-flow-voice-dictation-guide/ , https://letterly.app/blog/wispr-flow-review/
- Highlight AI: https://highlightai.com/assistant , https://www.theai.tw/en/tools/highlight-ai , https://screenpipe.com/blog/screen-assistant-ai-2026
- Notion AI: https://www.notion.com/product/ai-meeting-notes , https://www.notion.com/product/enterprise-search , https://www.eesel.ai/blog/notion-ai-review
- Agentic entrants: https://tana.inc/blog/best-ai-meeting-assistants-2026 , https://get-alfred.ai/blog/best-ai-meeting-follow-up-tools , https://reclaim.ai/blog/ai-meeting-assistants

---

## Skeptic verdicts

Adversarial pass, 2026-07-16. Method: re-verified the load-bearing external claims by search, checked
each proposal against the actual codebase (grep/read, not memory), checked `feature_list.json` (the
project's own source of truth, which this research pass never opened), and re-applied the user's stated
ranking criterion (minutes saved / dropped balls prevented, not novelty). Default was to kill on any
unverified or redundant claim. Overall: **1 kept clean, 1 kept with a scope cut, 6 killed** (mostly on
redundancy the researcher missed by not checking `feature_list.json`, plus two false feasibility claims).

### 1. Enhance-my-notes (human-in-the-loop live notes) — **KEEP**
External claim verifies: Granola's enhance-from-shorthand mechanic and the user quotes are real and
consistent across independent sources (wondertools.substack.com/p/granolaguide,
zackproser.com/blog/granola-ai-review). Checked the codebase: there is no existing live-notes-during-a-
call pane anywhere in `frontend/src` (only the separate quick-capture window and the post-hoc summary),
and `feature_list.json` has nothing that covers it, so this is genuinely net-new. Local Ollama makes the
privacy fit clean. The only correction: call the effort **Medium-Large**, not Medium — "weave shorthand
into transcript-grounded prose" is a real prompt-engineering problem, not a thin wrapper. Real,
non-redundant productivity case for the north star. Strongest proposal in the set, keep as-is.

### 2. Local MCP server over the meeting corpus — **KILL (duplicate, not independently proposed)**
This is line-for-line the same feature as **P6 "Tandem-as-an-MCP-server"** in the sibling researcher pass
[I4-agent-eco.md](I4-agent-eco.md#L201-L221) (same tool set: `search_meetings`, `get_summary`,
`list_action_items`, `get_transcript`, `find_project`, same "safe route to ask-my-meetings" framing). I4's
version is materially better grounded: it cites the actual MCP-client loader already wired in
[backend/app/claude_agent.py](../../backend/app/claude_agent.py#L53-L79), confirms `mcp_servers.json` is
read today but empty, and sequences it against real SDK docs. I1's version restates the same idea with
none of that grounding. Shipping both write-ups as independent "proposals" double-counts one idea across
two iterations of the same loop. Kill the I1 copy, keep I4's P6 as the canonical version.

### 3. People and Companies view — **KILL (redundant with a planned feature the researcher didn't check)**
`feature_list.json` already specs this, in more depth, as **F043 "Multi-Call Memory (Relationship
Context)"** (priority `high`, status `planned`, `d:/Dev-projects/Tandem/feature_list.json` lines
1646-1667): Phase 1 is "Contact/company entity extraction... link meetings to contacts automatically,"
Phase 2 is "Relationship timeline: per-contact view showing all meetings, key topics, decisions, action
items." That is this proposal, already tracked, already prioritized. CLAUDE.md's own project-tracking
rule says to check `feature_list.json` first; this research pass checked To-do.md and the idea backlog
but never opened it, and missed a directly overlapping high-priority planned feature as a result. Separately,
Tandem's project/folder model is already client-centric (one project = one client on `D:\Client_projects`),
and I6 already shipped a By-project sidebar grouping (`d:/Dev-projects/Tandem/To-do.md` line 38, commit
d589a74) — so the "Companies" half of this is largely already-shipped under a different name, and the
"People" half (distinguishing individual contacts within a company) is the thin sliver F043 Phase 1
already covers better. Verdict: do not build this as a standalone I1 idea; if it survives at all, it
survives as F043 sequencing, not a new item.

### 4. Jump-to-topic chapters + cross-meeting topic threads — **PARTIAL KILL, cut to in-meeting chapters only**
The external claim needs a correction: Fireflies' cross-meeting tracking is **user-configured topic
trackers** (you define "pricing" or "competitor mentions" as a tracked theme up front), not the automatic
discovery-clustering the proposal implies ("everything we've said about pricing with Acme" with no setup)
- confirmed via the Fireflies/Fathom comparison sources, not just the original Fireflies blog post. The
cross-meeting-thread half also directly overlaps two things already accounted for elsewhere: the ranked
backlog's own caution on idea 1 (ask-my-meetings, "hallucinated citations are a trust-killer" -
`research/idea-backlog-ranked.md` line 42) and F043 Phase 4/5 ("topics that keep recurring," "relationship
insights"). Stacking a third, separately-built topic-clustering feature on top of an already-flagged trust
risk and an already-planned feature is scope creep. Keep only the safe, single-meeting "jump to the pricing
part of this call" chapters half (low risk, Fathom/Fireflies both genuinely ship this); kill the
cross-meeting-thread half here and let it be designed once, under F043 or the ask-my-meetings item, with
exact-quote citations, not twice.

### 5. Scheduled local recipes / pipes — **KILL (feasibility claim is false, and it re-solves an already-deprioritized problem)**
The proposal's own feasibility line says "reuses schedule/cron infra." Verified by grep: there is **no**
scheduling/cron infrastructure anywhere in `backend/` or `frontend/src-tauri/src/` (the one substring hit,
`backend/app/task_extractor.py` line 30, is an unrelated LLM prompt string listing "followup — Schedule a
meeting" as a task category, not a scheduler). Building "recipes" therefore means building a background
daemon or OS-level task runner from zero, plus a markdown recipe format, plus a runner harness - not a
"Medium" lift, and it also depends on the tray/autostart work that is explicitly **parked** in I7
(`To-do.md` line 53, "Parked for later"). The only concrete recipe this proposal names is the weekly
digest, which the ranked backlog already scored low ("largely rehashing ideas 2 and 3... low net-new
value and one more thing to maintain," `idea-backlog-ranked.md` lines 85-89, "build after 2 and 3, and
only as a thin scheduled view over them"). Building a general-purpose scheduled-agent engine to serve one
already-deprioritized use case is exactly the "novelty/engineering elegance over productivity gain" the
user's own ranking criterion rejects. Kill; revisit only as a thin view once I7 autostart lands and only
if 2+3 (already built) turn out insufficient.

### 6. Persistent assistant memory — **KILL (redundant with the same planned feature as #3)**
Verified the Raycast Memory feature is real (manual.raycast.com/ai/personalization). Verified in the
codebase that `ClaudeContext` genuinely has no durable cross-session store today (`ClaudeState` in
[ClaudeContext.tsx](../../frontend/src/contexts/ClaudeContext.tsx#L44-L59) holds only session-scoped
`apiKey`/`selectedModel`/`entityMap`, nothing persisted as "durable facts about Andrew"). But this is
**F043 Phase 3**, already planned: "Context injection: when starting a new meeting, AI panel auto-loads
summary context from previous meetings with same contact. Shown as a 'Previous context' card"
(`feature_list.json` line 1658). Building a second, separately-designed "assistant memory" store next to
an already-planned relationship-context feature risks two competing memory systems in the same panel, and
carries the identical staleness/drift risk the ranked backlog already flagged for the client dossier idea
(idea 10, "the valuable part is the drift-and-hallucination-prone part," `idea-backlog-ranked.md` line
64). Fold into F043 rather than propose separately.

### 7. Voice dictation into capture — **KILL (the capability already exists and is already in daily use, system-wide)**
Feasibility is real (Tandem does ship local Whisper) but the productivity case fails once the actual
environment is checked, which this research pass did not do (the sibling pass did): Andrew already runs
**Whispering**, his own fork of Epicenter, a system-wide push-to-talk dictation app on the same ElevenLabs
Scribe v2 engine, with paste-at-cursor into any text field on the machine
(`d:/Dev-projects/Whispering/To-do.md`, cited in
[I3-own-projects.md](I3-own-projects.md#L66-L72)). That already covers "dictate a note instead of typing"
into Tandem's quick-capture field, today, with no new code. Building a second, Tandem-native voice path
duplicates a tool Andrew already owns and uses, for a plain-text field that is already fast to fill by
typing. This is the exact reasoning the ranked backlog already used to kill idea 20, "voice control
everywhere" ("everything it offers is already faster and more reliable via a hotkey," `idea-backlog-ranked.md`
line 129) - the same logic applies to a narrower voice-into-one-field version. It also ignores the standing
Alt+Shift+D/E hotkey collision between the two apps that the sibling research pass had to solve around.
Kill.

### 8. Typed extraction to system-of-record via n8n — **KILL (unverified need, superseded by a more evidence-backed sibling proposal)**
This overlaps the ranked backlog's idea 9 (n8n export hook), which was scored marginal specifically
because "pushing every summary to a CRM assumes automations that may not exist" (`idea-backlog-ranked.md`
line 70). The sibling research pass found the concrete evidence the backlog demanded - Andrew's n8n
instance already runs 271 workflows including a live `Fireflies -> Drive -> Claude Routine` webhook that
already consumes a meeting-transcript payload
([I3-own-projects.md proposal 3](I3-own-projects.md#L123-L143)) - and proposed the low-effort (S) fix:
repoint that existing webhook at Tandem's own summary text. This I1 proposal instead invents a new typed
JSON schema (client/stage/next step/follow-up date) with no check against what the actual live n8n
workflow expects as input, i.e., it adds speculative structure the researcher never verified is needed
over the plain text the existing webhook already accepts. Kill the typed-extraction framing here; if a
concrete workflow later needs structured fields, add them incrementally to the sibling proposal's plain
webhook, not as a fresh schema-design exercise.

### Net effect
Kept: **#1 Enhance-my-notes** (as-is) and the in-meeting-chapters half of **#4** (cut down from its
original scope). Killed: **#2** (duplicate of I4-P6), **#3** and **#6** (both already planned as F043,
which this research pass never checked), the cross-meeting half of **#4**, **#5** (false "reuses cron
infra" claim + re-solves an already-deprioritized problem), **#7** (duplicates a tool Andrew already runs
system-wide), and **#8** (unverified need, superseded by I3-own-projects' evidence-backed version). The
recurring failure mode across the kills was not checking `feature_list.json` (#3, #6) and not checking
the sibling same-day research passes in this same folder before writing up an "independent" proposal (#2,
#7, #8) - both are now flagged for the next iteration of this loop.
