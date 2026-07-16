# AI OS Integrations: synthesized roadmap

Final synthesizer pass for the "AI OS features and integrations" loop, 2026-07-16. Inputs: the four
researched-and-skeptically-filtered iteration files in this folder
([I1-landscape.md](I1-landscape.md), [I2-local-ai.md](I2-local-ai.md),
[I3-own-projects.md](I3-own-projects.md), [I4-agent-eco.md](I4-agent-eco.md)), read in full including
every skeptic verdict. Ranked against the existing
[idea-backlog-ranked.md](../idea-backlog-ranked.md) using the identical criterion: **real productivity
gain for Andrew**, a solo consultant doing 5-15 discovery/advisory calls a week, north star "talk to
the tool, it routes my notes to the right project." Only two things score: minutes saved per week, and
dropped balls / errors prevented. Novelty, coolness, and engineering elegance score nothing.

Seventeen distinct proposals survived the four adversarial passes. Overlapping ones are merged below
(the three "ask my meetings" infrastructure pieces from I2 and I4 collapse into one memory-layer entry;
the local-answer-layer policy folds into it as a non-standalone sub-decision). Effort is S / M / L.
Every entry states what it is, why it survived the skeptic, effort, and dependencies.

---

## Tier 1: Build next

The best gain-to-effort on the board. Four are Small and de-noise or safeguard surfaces that already
ship; one is the single strongest net-new daily feature in the whole category.

### 1. Privacy-gating + audit hooks (PreToolUse / PostToolUse)
**What.** Register Claude Agent SDK `hooks` on the AI panel: a PreToolUse hook that intercepts
`Write` / `Edit` / `Bash` and any destructive MCP call touching a confidential client folder and
requires an in-panel confirm; a PostToolUse hook that appends every tool call to a per-meeting
`audit.md`. Turns design principle #3 ("privacy is visible") into a mechanism.
**Why it survived.** Verified directly against the code: `_build_options()` in
[backend/app/claude_agent.py](../../backend/app/claude_agent.py#L226-L257) really does set
`permission_mode="acceptEdits"` with no `hooks=` configured, so the gap is real, not hypothetical.
Hooks fire in the harness, not the model, so they cannot be prompt-injected around
([Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)). The I4 skeptic rated this the
single strongest proposal: purely additive risk reduction with zero redundancy against anything shipped
or parked. It is the safety net that makes every outbound / handoff feature below trustworthy, and it
prevents the worst dropped ball of all (an unintended write or send in a client repo).
**Effort.** S-M. A `hooks=` dict plus a small confirm event over the existing SSE bridge.
**Dependencies.** None. Prerequisite for items 7 (headless handoff) and the whole "Later" agent tier.

### 2. Ollama structured outputs for reliable extraction
**What.** Replace free-text-then-regex parsing of summaries and action items with JSON-schema-
constrained model output, so the action-item checklist and any future inbox get clean typed data.
**Why it survived.** Verified against primary Ollama docs: structured outputs constrain generation to a
JSON schema via a `format` parameter, with first-class Python (Pydantic) and JS (Zod) support
([Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs),
[blog](https://ollama.com/blog/structured-outputs)), release date v0.32.0 / 2026-07-11 confirmed. The
fragility it fixes is real and in-code: action items are currently scraped by a regex over freeform
markdown headings ([actionItems.ts](../../frontend/src/lib/actionItems.ts) line 15). Ollama is already
integrated, so this is additive. It is the cheapest way to de-noise the parsing that the #1 ranked
backlog idea (cross-meeting action-item inbox) depends on, lifting every feature that consumes action
items.
**Effort.** S.
**Dependencies.** None. Unblocks / hardens the ranked backlog's #1 (action-item inbox).

### 3. Custom vocabulary for STT via Scribe v2 keyterm prompting
**What.** Send a per-meeting list of client names, product names, and jargon to ElevenLabs Scribe v2 as
keyterms so they stop being mangled. Tandem already knows the active project and client folder, so it
can auto-assemble the list from project name + past attendees + a small per-project vocab, with zero
user effort.
**Why it survived.** Resolves the exact feasibility gate the ranked backlog left open on idea 15
("does Scribe even support biasing"). It does: verified against primary ElevenLabs docs, batch accepts
**1000 keyterms at 50 chars**, realtime **50 keyterms at 20 chars**
([keyterm prompting guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/batch/keyterm-prompting),
[STT overview](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)). STT errors propagate
into search, summaries, action items, and any dossier, so cutting recurring misrecognitions compounds.
No privacy regression: keyterms ride with audio that already goes to ElevenLabs. Cost note: keyterms
carry a premium per the primary docs (a secondary review cites ~30%, treat as directional), so keep the
list tight.
**Effort.** S. Adds a `keyterms` field to the request the ElevenLabs provider already builds.
**Dependencies.** None. Batch path first; the realtime path can carry the same list capped at 50 if the
Scribe Realtime WS work lands.

### 4. Speaker-aware summarization (channel-split attributed)
**What.** Feed speaker labels into the summary so minutes carry attributed commitments ("Client
committed to $40k by Friday") instead of an unattributed wall of text. Use the free mic-vs-system
channel split for the common 2-party call; invoke pyannote only when 3+ voices share one channel.
**Why it survived.** The skeptic corrected the feasibility framing in Tandem's favour:
[feature_list.json](../../feature_list.json) shows F022 diarization has completed Phases 1-5 (backend
`diarizer.py` with GPU inference and transcript alignment, DB tables, `/api/diarize/*` endpoints,
speaker badges, naming UI), so wiring labels into a summarization prompt is smaller than any doc implied.
This is deliberately narrower and cheaper than the backlog's skip-tier "diarization surfacing" (idea 7):
the free channel split already separates "me" from "them," so attributed action items come at near-zero
cost for most calls. Stays on-device (channel split needs no model; local pyannote Community-1 for 3+),
avoiding the cloud pyannoteAI orchestration API for confidential audio
([pyannoteAI models](https://www.pyannote.ai/md/models)).
**Effort.** S for the channel-split-attributed summary (prompt + label plumbing); M if pyannote is
wired for the 3+-speaker case (the F022 substrate already exists).
**Dependencies.** Pairs naturally with item 2 (structured outputs) so attributed items land as typed data.

### 5. Enhance-my-notes (human-in-the-loop live notes)
**What.** Jot rough keywords / bullets during the call; a local Ollama pass weaves them with the
transcript into structured notes in your voice. Write "pricing concerns" and it finds every pricing
discussion and adds the relevant quotes.
**Why it survived.** This is the most-loved mechanic in the whole category, the reason people adopt
Granola, verified consistent across independent sources
([Granola guide](https://wondertools.substack.com/p/granolaguide),
[review](https://zackproser.com/blog/granola-ai-review)). Checked the codebase: there is no live-notes
pane anywhere in `frontend/src` (only the separate quick-capture window and the post-hoc summary), and
`feature_list.json` has nothing covering it, so it is genuinely net-new. It directly serves "stay
present during the call," the daily spine, without any always-on overlay that would break "invisible
when active." Local Ollama keeps it on-device.
**Effort.** M-L. The skeptic's correction: "weave shorthand into transcript-grounded prose" is a real
prompt-engineering problem plus a live notes pane, not a thin wrapper.
**Dependencies.** Benefits from item 2 (structured outputs) for clean weaving, but not blocked by it.

---

## Tier 2: Strong

Clear value, a notch below: higher effort, higher risk, or narrower audience than Tier 1.

### 6. Docling client-document ingest into meeting context
**What.** When Andrew drops a client's PDF / deck / spreadsheet into a project folder, run
`docling_processor` in its local-embedding mode to chunk it, store chunks in the meeting's `.tandem`,
and retrieve relevant passages into the AI panel context basket and prep card. Makes "what did their
proposal say about scope" answerable from the actual document.
**Why it survived.** All external claims verified: Docling is IBM Research's open toolkit (MIT, LF AI &
Data, 37k+ stars) supporting PDF/DOCX/PPTX/XLSX/images
([docling](https://github.com/docling-project/docling)); `HybridChunker` defaults to on-device
`sentence-transformers/all-MiniLM-L6-v2`
([chunking docs](https://docling-project.github.io/docling/concepts/chunking/)), matching
`d:/docling_processor/README.md`, so "stays on-device" holds. No overlap in To-do.md or the ranked
backlog. `ClaudeContext`'s basket has no document-retrieval hook today, so the M estimate is credible
net-new work. Directly grounds the ranked backlog's top-two (prep one-pager, ask-my-meetings) in
client-supplied documents, which is where discovery / advisory value actually lives.
**Effort.** M. Docling already emits chunk JSON; the work is a local ingest command + a retrieval hook,
keeping embeddings on-device.
**Dependencies.** Flag hard if anyone flips it to the OpenAI embedding provider or the Supabase cloud
path. Complements item 8 (shares the retrieval surface).

### 7. Headless Agent SDK code-handoff session
**What.** Replace the fragile `.tandem/tasks/*.md` drop + external `/loop` with a backend-spawned Claude
Agent SDK `query()` session: `cwd` = the target repo, task + transcript context as the prompt, progress
streamed back into the meeting UI over the existing SSE channel.
**Why it survived.** The file-poll `@code` handoff it replaces is real and already flagged fragile in
[CLAUDE.md](../../CLAUDE.md) ("F054 Handoff"): needs a terminal open, no status flows back, no structured
result. Subagents, hooks, and MCP client wiring are all real, documented SDK features
([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)), and this reuses the exact
`query()` / options-builder pattern already in
[backend/app/claude_agent.py](../../backend/app/claude_agent.py). A genuine reliability fix, not novelty.
**Model correction (load-bearing).** The report's "bump to `claude-opus-4-8`" is already stale: Claude
Fable 5 GA'd 2026-06-09 and Claude Sonnet 5 (agentic-coding-tuned, cheaper) GA'd 2026-06-30
([Introducing Claude Sonnet 5](https://www.anthropic.com/news/claude-sonnet-5)). Do not hand-pick a name
from a research doc; re-derive `_VALID_MODELS` from whatever the `claude-agent-sdk` version in
`requirements.txt` actually accepts, and evaluate Sonnet 5 as the panel default.
**Effort.** M. SDK, options builder, SSE plumbing, and per-meeting session management already exist.
**Dependencies.** Build behind item 1 (privacy/audit hooks) so the repo-write agent is gated.

### 8. Ask-my-meetings memory layer (local RAG + on-device answer + Tandem-as-MCP-server)
**What.** The safe, citation-linked route to "when did we agree the deadline with Acme." Three merged
pieces: (a) a local semantic index over transcripts/summaries using sqlite-vec + Ollama embeddings
(nomic-embed-text / BGE-M3); (b) synthesis that runs on a local Ollama model by default, reserving cloud
Claude for explicit per-query opt-in; (c) a standalone localhost MCP server exposing `search_meetings`,
`get_summary`, `list_action_items`, `get_transcript`, `find_project` so the AI panel and any MCP client
get structured, exact-quote access instead of grepping files.
**Why it survived.** This is the infrastructure under the ranked backlog's #4 (ask-my-meetings, strong
tier) and #7 (client dossier). The whole point is privacy: embeddings, index, and synthesis stay local,
so Tandem can offer meeting-memory that cloud competitors only do remotely. Returning exact transcript
spans with meeting IDs is the concrete answer to the backlog's flagged trust-killer (hallucinated
citations). sqlite-vec and the embedding models are real and verified
([sqlite-vec](https://github.com/asg017/sqlite-vec), on crates.io).
**Two skeptic corrections that change the effort, not the verdict:**
- **RAG is spike-gated.** The claim "sqlite-vec loads into the existing sqlx SQLite" does not verify:
  sqlite-vec's documented Rust path uses `sqlite3_auto_extension()` against rusqlite, and loading it
  through sqlx is an open unresolved issue since Feb 2025
  ([asg017/sqlite-vec#198](https://github.com/asg017/sqlite-vec/issues/198)). Sequence a 30-minute spike
  first: prove `.extension_with_entrypoint()` against `sqlite3_vec_init`, or use a side-channel rusqlite
  connection, or do brute-force cosine in Rust (trivially fast at one user's volume).
- **The MCP server is a separate process, not in-process.** The SDK's in-process "custom tools" only
  serve Tandem's own agent session; exposing meetings to external clients (Claude Desktop, n8n) needs a
  standalone stdio / HTTP MCP process ([SDK MCP doc](https://code.claude.com/docs/en/agent-sdk/mcp)),
  and it must bridge the Rust-sqlx vs Python-aiosqlite database split CLAUDE.md documents. Re-rate to
  medium-high effort.
- The local-answer-layer is a **policy sub-decision inside this item, not a standalone line** (never let
  bulk-transcript synthesis default to cloud); do not double-count its effort.
**Effort.** M-L, spike-gated. Build with exact-quote citations from day one or it corrodes trust.
**Dependencies.** RAG spike before any migration. Item 6 (Docling) shares the retrieval surface.

### 9. ReviewLab prospect dossier in the pre-call prep card
**What.** When a calendar event's attendee domain matches a ReviewLab review, surface that dossier (SEO
grade, top issues, decision-maker name, the outreach angle already used) inside the I5 pre-meeting prep
card, so Andrew walks into a sales call informed. Reverse direction: after the call, bump the ReviewLab
lead state.
**Why it survived.** ReviewLab's per-domain frontmatter is real and the join surfaces already ship (I5
pre-meeting popup e372dba, I3 calendar/attendee routing 482aaf7). Fully local on both sides. Low overlap
with the backlog's riskier client-dossier auto-extraction idea. High-signal when it fires: turns a cold
call into an informed one and closes the outreach loop.
**Field-name fix (required at build).** The write-back must target `outreach_response`
(`none/opened/replied/meeting/converted`), not `status`
(`reviewed/polished/sent/replied/converted/dead`), for the "meeting" value.
**Effort.** S-M. Read frontmatter by exact domain match, render a card; write-back is a frontmatter edit.
Require an exact domain match and let Andrew confirm, so a loose match cannot mix the wrong prospect in.
**Dependencies.** Rides on shipped I5 + I3 surfaces. Only fires for sales calls against reviewed prospects.

### 10. Jump-to-topic chapters (in-meeting, single-call scope)
**What.** Auto chapters so Andrew can jump inside a long advisory call ("jump to the pricing part").
Single-meeting only.
**Why it survived, and what was cut.** Fathom and Fireflies both genuinely ship in-meeting chapters, and
this half is low-risk local LLM segmentation. The skeptic killed the cross-meeting "topic threads" half:
it overlaps the ranked backlog's already-flagged trust risk (ask-my-meetings hallucinated citations) and
F043's planned relationship-topic work, so stacking a third separately-built topic-clustering feature is
scope creep. If cross-meeting topics are ever wanted, design them once under item 8 with exact-quote
citations, not here.
**Effort.** M. Transcript segmentation over a single call.
**Dependencies.** None for the in-meeting half.

---

## Tier 3: Later

Real but modest, situational, revenue-not-minutes, or explicitly build-on-demand. Do not build on spec.

### 11. Discovery call to pitch deck via visual-audio-automation
**What.** From a landed summary + action items, scaffold a `campaigns/<client>/` workspace and generate
a first-draft HTML proposal deck, QA'd with `shoot.py`, ready for Andrew to refine and PIN-gate.
**Why it survived.** The `new_campaign.py` / `shoot.py` toolkit is real and Tandem's own project
CLAUDE.md already mandates it for deck work, so it is a sanctioned path, not a new dependency. Turning a
discovery call into a proposal is the most expensive post-call chore a solo consultant has, so even a
rough auto-draft is a revenue lever (30-60 min per proposal, faster quote turnaround).
**Effort.** M-L. Scaffolding exists; the new work is mapping summary to slide outline and invoking the
toolkit from the post-call flow.
**Dependencies.** Sequence **after** the parked I8 follow-up-draft work so summary-to-artifact generation
is built once. Cloud image/video generation is optional; if used, gate behind opt-in and PII-anonymize
the summary first (Presidio already on-device).

### 12. Make Real: live client mockups on the Tandem canvas
**What.** Port the "Make Real" path (sketch a UI/flow, a vision model returns working HTML) from the
deprecated standalone tldraw app into the embedded canvas, so mid-call Andrew sketches a screen and the
client sees a live mockup.
**Why it survived.** agent-whiteboard's own To-do and README list the port as scoped open work (not
invented scope), and `tldraw/make-real` is a real reference. A deal-shaping capability for sales/discovery
demos. But it is a capability bet, not a chore-saver, so it ranks by that.
**Effort.** M. The port is already scoped; the Tandem work is exposing it in the embedded canvas UI plus
a consent gate.
**Dependencies.** Cloud-vision-gated (sends the sketch image to Claude/Gemini): never send while
confidential meeting content shares the board without consent (the canvas already origin-pins
postMessage). tldraw watermark-free commercial licensing ($6,000/yr per team) is a cost input if it ever
ships beyond local/dev.

### 13. Whiteboard board to proposal deck bridge
**What.** Turn a saved meeting whiteboard into a deck slide/section, so a live workshop sketch becomes a
client artifact without redrawing.
**Why it survived.** Both export artifacts it needs (`whiteboard.md`, `whiteboard.png` per meeting) are
confirmed shipped, and the deck kit consumes exactly that HTML/content input, so the two ends already
speak compatible formats. Low effort, low risk, nearly free given the exports exist.
**Effort.** S-M, layered on item 11. Lowest-priority of the own-project integrations.
**Dependencies.** Build after item 11 (pitch deck) exists.

### 14. n8n MCP write-path bridge
**What.** Stand up an n8n MCP Server Trigger exposing workflows as MCP tools (`create_calendar_event`,
`move_calendar_event`, and, gated, `send_followup_email` / `push_summary_to_crm`) and register it in
`backend/mcp_servers.json`, so the panel can take real outbound actions.
**Why it survived, demoted.** The mechanics verify: n8n's MCP Server Trigger is real, self-hostable,
speaks SSE/streamable HTTP ([n8n docs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger)),
and the `mcp_servers.json` loader already exists. It dissolves the parked OAuth-crossing problem (the
token lives once in n8n, Tandem just calls the tool). **But two skeptic corrections demote it:** (a) the
I8 parked plan already decided follow-up email is copy-only / **never sends**, so `send_followup_email`
and `push_summary_to_crm` must require an explicit confirm-click on **every** send, never an
`acceptEdits`-style remembered approval, keep only the calendar-event tools as free-fire; (b) the ranked
backlog rated the n8n hook marginal "build only when a concrete downstream flow exists, not on spec," and
the I3 skeptic opened the two candidate workflows and found neither actually consumes a Tandem
transcript/summary payload as claimed. **Do not build until a concrete downstream workflow is named.**
The MCP Server Trigger's auth is opt-in, not default: turning auth on is a required setup step, not a
footnote.
**Effort.** M.
**Dependencies.** Item 1 (privacy/audit hooks) first. A named, real downstream workflow before any build.

### 15. Local browser MCP for in-call / post-call web actions
**What.** Add a Playwright MCP or Chrome DevTools MCP server so the panel can drive a local browser: look
up a prospect's site mid-call, fill a form, complete a web action no API covers.
**Why it survived.** Both `microsoft/playwright-mcp` and `ChromeDevTools/chrome-devtools-mcp` verified as
real, maintained projects, no over-claim. The local, cheaper, safer alternative to computer-use for
anything in a browser. WebSearch/WebFetch are already built in, so this is specifically for interacting
with pages.
**Effort.** M, drop-in via `mcp_servers.json`.
**Dependencies.** Behind item 1's gate. Build-on-demand: demand is bursty, build when a concrete flow
needs it.

### 16. Computer-use for post-call desktop actions (narrow, gated)
**What.** Anthropic's computer-use tool for post-call actions in GUI-only apps with no API or MCP (e.g.
logging a call in a legacy desktop CRM).
**Why it survived.** Verified real and current (actively-updated beta,
[computer use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)), scoped
correctly as a fallback only. Prefer items 14 (n8n) and 15 (browser MCP) wherever an API or web UI
exists, they are cheaper and easier to gate.
**Effort.** M. Lowest-priority build-on-demand.
**Dependencies.** Behind item 1's PreToolUse gate; scope screenshots tightly to the target app, never the
whole screen during a confidential session. Build only against a concrete GUI-only target.

---

## Tier 4: Skip (for now)

### 17. Managed Agents for scheduled / overnight handoff
**What.** Anthropic's Managed Agents "deployments" run an agent on a cron in an Anthropic-hosted sandbox,
no terminal open, attractive for "run this `@code` task overnight."
**Why it is a skip.** Defer verdict unchanged from I4. Citation corrected: self-hosted sandboxes are now
public beta so tool execution need not run in Anthropic's cloud, **but** per Anthropic's own docs the
orchestration / session state still lives on Anthropic's infrastructure even with a self-hosted sandbox,
and MCP tunnels (the piece that would let a sandbox reach Tandem's local data) are only research preview
([self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes),
[updates](https://claude.com/blog/claude-managed-agents-updates)). The code and transcript context still
leave the machine, a direct conflict with the confidential-client mandate. Decided "no for confidential
work"; consider only for explicitly non-confidential public-repo tasks.
**Effort.** N/A (do not build for the core use case).

Also formally excluded during synthesis (killed by skeptics, recorded so they are not re-proposed):
People/Companies view (already F043), persistent assistant memory (already F043 Phase 3), scheduled local
recipes/pipes (no cron infra exists, re-solves a deprioritized digest), voice dictation into capture
(Tandem already ships the `canvas_transcribe_clip` primitive; and Andrew runs Whispering system-wide),
local TTS (Kokoro, no consuming feature), local vision for screenshots (no backlog anchor), ambient
screen capture (privacy liability, overlaps parked F061), realtime voice-to-voice panel (TTS-out
re-litigates a near-zero-gain idea; the STT-only Scribe Realtime WS work proceeds under its own existing
plan), subagents in the panel (no demonstrated need, redundant with shipped I3 routing), and the
"repoint existing n8n workflows" framing (the cited workflows do not consume a transcript payload).

---

## Top 5 to build

1. **Ollama structured outputs (S).** The cheapest high-leverage change: typed JSON instead of regex-
   scraped markdown de-noises the action-item parsing that the #1 ranked backlog feature depends on, and
   lifts everything downstream of it.
2. **Custom vocabulary via Scribe v2 keyterms (S).** Auto-built from the project Tandem already knows;
   fewer mangled client/product names compounds into cleaner search, summaries, and action items across
   every call, with no new data leaving the machine.
3. **Speaker-aware summarization, channel-split (S).** Near-free now that F022 diarization is built:
   attributed commitments ("Client committed to $40k by Friday") turn the summary into trustworthy owed-
   work instead of an unattributed wall of text.
4. **Privacy-gating + audit hooks (S-M).** The one purely-additive safety foundation: deterministic
   harness-level gating and a per-meeting audit trail that make the confidential-call promise a mechanism
   and make every outbound/handoff feature safe to build after it.
5. **Enhance-my-notes, human-in-the-loop (M-L).** The strongest net-new daily feature: jot shorthand
   during the call, a local pass weaves it with the transcript into notes in your voice, so you stay
   present in the conversation. The most-loved mechanic in the category, and genuinely absent today.

Build item 6 (Docling client-document ingest) next after these five: it grounds the prep one-pager and
ask-my-meetings in real client documents, fully on-device, and it is the on-ramp to the item 8 memory
layer whose RAG piece needs a 30-minute sqlite-vec-through-sqlx spike before any migration.
