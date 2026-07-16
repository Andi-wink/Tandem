# I3 own-projects: integrating Tandem with Andrew's other D: projects

Researcher pass for the "AI OS features and integrations" loop, iteration I3-own-projects.
Scope: deeper integrations between Tandem and Andrew's OWN code on D:. Every proposal below is
grounded in the actual files of the target project (READMEs, entry scripts, workflow JSON, To-do
logs), not guessed. Dated 2026-07-16.

## What I actually inspected

| Path | State on disk | Verdict |
|---|---|---|
| d:/docling_processor | Real, working Python tool (main.py, document_processor.py, send_to_n8n.py, supabase_uploader.py) | Strong integration target |
| d:/Dev-projects/visual-work/visual-audio-automation | Real toolkit (new_campaign.py, image_gen.py, video_gen.py, deck kit, shoot.py) | Strong integration target |
| d:/Dev-projects/visual-work/agent-whiteboard | Real (already embedded as Tandem's canvas); Make Real path still unported | Deeper-integration target |
| d:/Dev-projects/n8n_projects | Real: 271 migrated workflows, 57 webhooks incl. a Fireflies meeting-transcript routine | Strong integration target |
| d:/Dev-projects/Whispering | Real: Andrew's fork of Epicenter/Whispering, a push-to-talk dictation app on Scribe v2 | Medium integration target |
| d:/Dev-projects/ReviewLab | Real: markdown lead-gen KB, per-domain reviews with rich frontmatter | Medium (sales-call) target |
| d:/Dev-projects/Transcription | Single README.md: an analysis of Tandem's own upstream (Meetily) | Not a separate target (self-referential) |
| d:/Dev-projects/CRM | Empty directory | Nothing to integrate |
| d:/Dev-projects/Animation-generator | Empty directory | Nothing to integrate |
| d:/Dev-projects/Video to document creator | Empty directory | Nothing to integrate |

Note on overlap with the ranked backlog: the existing backlog has "n8n export hook (idea 9)" ranked
marginal precisely because "the valuable part depends on whether Andrew wires real downstream
automations" (see research/idea-backlog-ranked.md, item 8). Proposal 3 below is deliberately narrower
and answers that objection with evidence: the downstream flows already exist and already consume a
meeting-transcript feed today (Fireflies). None of the other proposals here duplicate a ranked idea;
they are cross-project integrations, which the idea backlog did not cover.

---

## The six live targets, in their own words

### docling_processor
A working document-to-RAG pipeline. From its README.md and main.py: it ingests PDF, DOCX, XLSX, PPTX
and images, preserves structure (headings, tables, reading order), does semantic chunking with
Docling's HybridChunker, and can either upload embeddings to Supabase pgvector or POST chunks
straight to an n8n webhook (send_to_n8n.py). Critically for a privacy-first app, it defaults to
LOCAL embeddings: `EMBEDDING_PROVIDER=sentence-transformers`, model `all-MiniLM-L6-v2`
(README.md config table), so documents never have to leave the machine to become searchable.

### visual-audio-automation
A command-line toolkit that turns a brand brief into decks, marketing stills and short reels
(README.md). `new_campaign.py <brand> --target <project>` scaffolds a `campaigns/<brand>/` workspace
(research/ ideas/ assets/ web/ qa/), copies in a self-scaling HTML deck kit, and appends a toolkit
pointer to that project's CLAUDE.md. Deck QA is `shoot.py` (headless-Chrome screenshots). Tandem's
own project CLAUDE.md already mandates this toolkit for any deck or pitch work, so the wiring is a
sanctioned path, not a new dependency.

### agent-whiteboard
Already embedded in Tandem as the tldraw canvas (canvas-core is linked in, boards save to
`<meeting folder>/whiteboard.tldr.json` plus `.png` and `.md` exports, per Tandem To-do.md). Its
README lists one high-value path still UNPORTED: "Make Real" (draw a sketch, a vision model turns it
into working HTML), which currently lives only in the deprecated tldraw-4 standalone app. That is the
deeper integration this iteration is asked to find.

### n8n_projects
Andrew runs a self-hosted n8n with, per n8n Migration/migration_report.md, 271 imported workflows and
57 webhooks. Two are directly meeting-shaped: `Fireflies -> Drive -> Claude Routine`
(`/webhook/fireflies-transcription`) and `Client Presentation Generator`
(`/webhook/client-presentation`). The Fireflies routine proves Andrew already pipes meeting
transcripts into an automation, using a cloud transcription service (Fireflies) that contradicts
Tandem's privacy-first premise.

### Whispering
Andrew's fork of Epicenter/Whispering (https://github.com/epicenter-so/epicenter, formerly
github.com/braden-w/whispering), a Tauri push-to-talk dictation app. From its To-do.md: it does
tap-vs-hold hotkey handling, paste-at-cursor with a clipboard sandwich, optional Ollama transcript
polishing, and it now runs on ElevenLabs Scribe v2, the same STT engine Tandem moved to
(Tandem MEMORY: "live STT is ElevenLabs Scribe v2 (cloud) since Jul 2026"). Both apps have fought
over the same Alt+Shift+D hotkey (Tandem renamed its record toggle to Alt+Shift+E on 2026-07-15 to
avoid Andrew's other use; Whispering's To-do.md is full of Alt+Shift+D dictation bug fixes).

### ReviewLab
A markdown lead-generation knowledge base for Automation Matters (CLAUDE.md). Each `reviews/` file
carries structured YAML frontmatter: `domain`, `contact_name`, `contact`, `company_size`,
`revenue_signals`, `issues_count`, `seo_grade`, `lead_score`, `status`
(reviewed -> polished -> sent -> replied -> converted), and free-form outreach `notes`. It is,
in effect, a prospect dossier store keyed by domain.

---

## Proposals

### 1. Docling client-document ingest into meeting context (docling_processor)
**What:** When Andrew drops a client's PDF, deck or spreadsheet into a meeting/project folder, run
docling_processor in its LOCAL-embedding mode to chunk it, and store the chunks in the meeting's
`.tandem` so Tandem's AI panel (ClaudeContext basket) and any prep card can retrieve the relevant
passages during and after the call. This makes "what did their proposal say about scope" answerable
from the actual document, not just the transcript.
**Grounded in:** docling_processor supports PDF/DOCX/XLSX/PPTX/images with structure-preserving
HybridChunker (README.md), and defaults to on-device sentence-transformers embeddings
(`all-MiniLM-L6-v2`, README config table) so nothing leaves the machine. Docling itself is IBM's
open document-conversion library (https://github.com/docling-project/docling). Supabase pgvector is
its default vector store (https://supabase.com/docs/guides/database/extensions/pgvector), but a local
JSON/sqlite chunk store avoids the cloud round-trip entirely.
**Productivity case:** directly advances the ranked backlog's top-two (prep one-pager, ask-my-meetings)
by grounding them in client-supplied documents, which is where discovery/advisory value actually lives.
Est. 5-10 min saved per document-heavy call, and fewer "let me check their doc" context switches.
**Privacy fit:** excellent if run in local-embedding mode; the whole point of docling here is on-device
RAG. Flag clearly if anyone flips it to the OpenAI embedding provider or the Supabase cloud path.
**Effort:** M. Docling already emits the chunk JSON; the work is a local ingest command + a retrieval
hook into the context basket, plus keeping embeddings on-device.

### 2. Discovery call to pitch deck via visual-audio-automation (visual-audio-automation)
**What:** From a landed meeting summary plus action items, scaffold a `campaigns/<client>/` workspace
and generate a first-draft HTML proposal/pitch deck (problem, findings, proposed automation, next
steps), QA'd with shoot.py, ready for Andrew to refine and PIN-gate for the client.
**Grounded in:** `new_campaign.py <brand> --target <project>` scaffolds the workspace and copies the
deck kit (README.md); deck QA is `shoot.py`; Tandem's project CLAUDE.md already routes all deck work
through this exact toolkit. The stills/reels tools (image_gen.py on OpenAI gpt-image, video_gen.py on
Google Veo 3.1, per README) are optional add-ons, not required for a text deck.
**Productivity case:** turning a discovery call into a proposal deck is the single most expensive
post-call chore a solo consultant has. Even a rough auto-draft saves 30-60 min per proposal and
shortens the quote turnaround, which is a revenue lever, not just a time saver.
**Privacy fit:** medium. The summary text feeds a deck; if image/video generation is used it calls
OpenAI/Google cloud APIs, so gate those behind explicit opt-in and PII-anonymize the summary first
(Tandem already has Presidio on-device, https://microsoft.github.io/presidio/).
**Effort:** M-L. Scaffolding and the deck kit exist; the new work is mapping summary -> slide outline
and invoking the toolkit from Tandem's post-call flow. Sequence AFTER the parked I8 follow-up-draft
work so summary-to-artifact generation is built once.

### 3. Repoint the existing n8n meeting workflows at Tandem (n8n_projects)
**What:** Have Tandem POST its final, PII-anonymized summary + transcript to Andrew's already-running
n8n webhooks (`/webhook/fireflies-transcription`, `/webhook/client-presentation`) so the 271 existing
workflows fire on a Tandem call. This replaces Fireflies (a cloud transcription service) as the
trigger with Tandem (local capture), keeping the automation Andrew already built while removing the
privacy-hostile front end.
**Grounded in:** n8n Migration/migration_report.md lists 271 imported workflows and the two named
meeting webhooks; the `Fireflies -> Drive -> Claude Routine` name proves a meeting-transcript
automation already exists and already consumes this shape of payload. docling_processor's
send_to_n8n.py already demonstrates the outbound-webhook pattern against this same n8n instance.
**Productivity case:** this is the honest answer to the ranked backlog's objection to a generic n8n
export (idea 9, ranked marginal because "the downstream may not exist"). Here it demonstrably exists,
so the payoff is real reuse: every downstream that fires off Fireflies today fires off Tandem instead,
0-to-30 min/week depending on which routines Andrew keeps live.
**Privacy fit:** good on the Tandem side (send the anonymized summary), but note the downstream
`Claude Routine` and any cloud nodes in n8n are outside Tandem's local boundary; document that the
payload leaves the machine once it hits the webhook. Outbound webhook needs no OAuth (unlike the
parked two-way calendar write path).
**Effort:** S. An outbound HTTP POST with a configurable webhook URL and a "send on summary" toggle.
The n8n MCP connector in this session needs interactive OAuth before it can be driven programmatically,
so wiring is via plain webhook, not the connector.

### 4. Voice dictation for quick-capture, borrowed from Whispering (Whispering)
**What:** Tandem's global quick-capture (Alt+Shift+N) is text-only today. Add a push-to-talk voice
path so Andrew speaks a note between calls and it is transcribed, optionally polished, and filed to
the routed project. Reuse Whispering's already-hardened dictation pipeline rather than reinventing it.
**Grounded in:** Whispering's To-do.md documents a mature push-to-talk implementation (tap vs hold
decided by hold duration, paste-at-cursor via a Rust clipboard sandwich behind a tokio Mutex, ordered
delivery gate, Ollama polish with a 30s timeout and raw fallback), and it now runs on ElevenLabs
Scribe v2, the same engine Tandem uses. Both are Tauri apps, so a shared provider module or a small
IPC handoff is realistic. This also forces a resolution of the recurring Alt+Shift+D collision between
the two apps.
**Productivity case:** the purest expression of Tandem's north star ("I talk to it and it routes my
notes"). Quick-capture already shipped (Tandem To-do.md, commit a02126b); voice removes the last bit
of friction. 10-20 min/week plus captured thoughts that would otherwise evaporate.
**Privacy fit:** medium. Scribe v2 is cloud STT (already accepted for Tandem's live path); the Ollama
polish step is local. Keep the polish local and reuse the retry/timeout hardening Whispering already
wrote so a dropped chunk does not silently lose a note.
**Effort:** M. Two separate codebases; simplest is to lift the dictation service into a shared library
or shell out to Whispering. Do not fork Whispering's UI; only borrow the capture-to-text-to-cursor core.

### 5. Make Real: live client mockups on the Tandem canvas (agent-whiteboard, DEEPER)
**What:** The canvas is embedded, but the "Make Real" path (sketch a UI/flow, a vision model returns
working HTML you can then draw on) is still only in the deprecated standalone app. Port it into
apps/agent so that mid-call Andrew can sketch a screen or an automation flow and Tandem renders a live
mockup the client sees on the shared canvas. A discovery-call superpower for a consultant selling
software/automation.
**Grounded in:** agent-whiteboard README explicitly lists "Port Make Real (draw -> vision model ->
HTML) + the /api/generate-html // /api/import backend from the deprecated standalone into apps/agent"
as open work, and notes retiring the standalone also clears the dual-tldraw tsc debt. The canvas
already saves whiteboard.png + whiteboard.md exports (Tandem To-do.md), so the render surface exists.
tldraw's own Make Real is the reference (https://github.com/tldraw/make-real).
**Productivity case:** medium-high for sales/discovery calls specifically. Converting a live sketch to
a working artifact in front of a prospect is a strong conversion moment; harder to quantify in
minutes, but it is a deal-shaping capability, not a chore-saver.
**Privacy fit:** medium. Make Real sends the sketch (an image) to a vision model; if that is Claude or
Gemini cloud, gate it and never send it while confidential meeting content is on the same board without
consent (the canvas already origin-pins postMessage because snapshots can carry confidential content,
per Tandem To-do.md).
**Effort:** M. The port is already scoped in agent-whiteboard's own To-do; the incremental Tandem work
is exposing it in the embedded canvas UI and the consent gate. tldraw production licensing
(watermark-free is $6,000/yr per team, README) is a cost input if this ever ships beyond local/dev.

### 6. ReviewLab prospect dossier in the pre-call prep card (ReviewLab)
**What:** When a calendar event's attendee email domain matches a ReviewLab review, surface that
dossier (SEO grade, top issues, decision-maker name, the outreach angle Andrew already used) inside
the I5 pre-meeting prep card, so he walks into a sales call already knowing the prospect's website
problems and his own hook. Reverse direction: after the call, bump the ReviewLab `status`
(replied/meeting/converted) from Tandem.
**Grounded in:** ReviewLab's CLAUDE.md defines exactly this structured, per-domain frontmatter
(`domain`, `contact_name`, `contact`, `revenue_signals`, `seo_grade`, `lead_score`, `status`, `notes`)
and a status lifecycle. Tandem already has calendar-event matching and a pre-meeting popup (I5, commit
e372dba) and project routing keyed off attendees/title (I3, commit 482aaf7), so the join key and the
delivery surface both exist.
**Productivity case:** medium, and only for sales calls against reviewed prospects, but high-signal
when it fires: it turns a cold call into an informed one and closes the outreach loop by updating lead
status without a manual edit. 5-10 min/week of "who is this and what did I pitch" lookups.
**Privacy fit:** excellent. Both stores are local markdown/sqlite on Andrew's machine; no data leaves
the boundary. The only care is not mixing a prospect's dossier into the wrong meeting if the domain
match is loose, so require an exact domain match and let Andrew confirm.
**Effort:** S-M. Read ReviewLab frontmatter by domain (grep-able, per its CLAUDE.md examples) and
render a card; the write-back is a frontmatter status edit.

### 7. Whiteboard board to proposal deck bridge (agent-whiteboard + visual-audio-automation)
**What:** Connect two of Andrew's own tools: take a saved meeting whiteboard and generate a deck slide
(or a full deck) from it, so a live sketch on a call becomes a client artifact without redrawing.
**Grounded in:** each canvas save already writes `whiteboard.md` (text labels + raw HTML/CSS of built
shapes) and `whiteboard.png` next to the board JSON (Tandem To-do.md, "Agent-friendly exports"), and
visual-audio-automation's deck kit consumes exactly this kind of HTML/content input (README, the
self-scaling HTML deck is "the most faithful implement-this-design source"). So the two ends already
speak compatible formats.
**Productivity case:** low-medium and situational, but nearly free given both exports already exist:
it removes the "recreate the whiteboard as a slide" step after a workshop-style call.
**Privacy fit:** same as proposal 2 (text/HTML into a local deck build; only cloud if image generation
is invoked, which it need not be).
**Effort:** S-M layered on top of proposals 2 and 5; mostly a mapping from whiteboard.md to a deck
section. Lowest priority of the seven; build only after 2 exists.

---

## Ranked recommendation

1. **Docling client-document ingest (proposal 1)** — highest payoff-to-privacy fit; feeds the two
   top-ranked backlog features with real client documents, fully on-device.
2. **Repoint existing n8n workflows (proposal 3)** — cheapest real win because the downstream already
   exists and already runs off a meeting feed; a small outbound POST reuses 271 workflows.
3. **ReviewLab dossier in prep (proposal 6)** — cheap, fully local, high-signal for sales calls, joins
   cleanly onto shipped calendar+routing surfaces.
4. **Voice quick-capture from Whispering (proposal 4)** — north-star aligned and resolves the standing
   hotkey collision, but spans two codebases.
5. **Discovery call to deck (proposal 2)** — high revenue leverage, sequence after the parked I8
   follow-up-draft work so summary-to-artifact is built once.
6. **Make Real on canvas (proposal 5)** — deal-shaping for sales demos, but its value is a capability,
   not saved minutes, and it touches cloud vision + tldraw licensing.
7. **Whiteboard to deck bridge (proposal 7)** — nearly free but situational; build last, on top of 2.

## Skeptic verdicts

Adversarial pass, 2026-07-16. Method: read the actual target files/workflow JSON on D:, re-verified
every external claim by web search/fetch (not taken on the researcher's word), checked feasibility
against Tandem's actual code, and re-applied the ranking criterion from
[research/idea-backlog-ranked.md](../idea-backlog-ranked.md): real minutes saved or dropped-balls
prevented for a solo consultant, not novelty. Default to kill where a central claim does not verify.

### 1. Docling client-document ingest into meeting context — KEEP
All external claims verify. Docling is IBM Research's real open-source toolkit (MIT-licensed, hosted
by LF AI & Data Foundation, 37k+ GitHub stars) supporting PDF/DOCX/PPTX/XLSX/images
(https://github.com/docling-project/docling, https://research.ibm.com/blog/docling-generative-AI).
`HybridChunker` is real and defaults to tokenizer-aligning against `sentence-transformers/all-MiniLM-L6-v2`
(https://docling-project.github.io/docling/concepts/chunking/), matching `d:/docling_processor/README.md`'s
config table exactly, so the "stays on-device" claim holds. Supabase pgvector docs URL is valid. No
overlap found in [To-do.md](../../To-do.md) or the ranked backlog (grepped both, zero hits for
docling/document-ingest/PDF). Feasibility: real gap in Tandem today, `ClaudeContext`'s context basket
(`frontend/src/contexts/ClaudeContext.tsx`) has no document-retrieval hook, so the M estimate is
credible net-new work, not a duplicate of anything shipped. Directly extends the ranked backlog's #1
and #4 items (action-item inbox, ask-my-meetings) with real client documents. Kept as proposed.

### 2. Discovery call to pitch deck via visual-audio-automation — KEEP
`new_campaign.py`/`shoot.py` toolkit is real and Tandem's own project CLAUDE.md already mandates it for
deck work (confirmed in the loaded project instructions), so this isn't a new dependency. Cloud image/video
providers (OpenAI images, Google Veo) are correctly gated as optional and behind PII anonymization.
No redundancy kill: researcher already flags sequencing after the parked I8 follow-up-draft work so
summary-to-artifact logic is built once — that's the correct call, not a reason to kill. Kept as proposed.

### 3. Repoint the existing n8n meeting workflows at Tandem — KILLED
The proposal's central claim is that the downstream "demonstrably exists and already consumes this
shape of payload," which is offered as the rebuttal to idea-backlog item 9 (n8n export hook, ranked
marginal because "the downstream may not exist"). I opened both cited workflow JSONs directly instead
of trusting the workflow names:
- `Fireflies → Drive → Claude Routine` (`d:/Dev-projects/n8n_projects/Job/Fireflies → Drive → Claude
  Routine.json`): node 2, "Fetch Transcript from Fireflies," POSTs to `https://api.fireflies.ai/graphql`
  with `variables: { transcriptId: $json.body.meetingId }` — it is not a passthrough, it re-fetches the
  full transcript FROM Fireflies by ID. A Tandem POST has no Fireflies `transcriptId`, so this node
  fails (or returns null) and the routine downstream never fires correctly. This is not "repoint the
  trigger," it requires rebuilding the middle of the workflow. It's also unclear the workflow is even
  live: node 3 ("HTTP Request") has a literal placeholder URL,
  `https://api.anthropic.com/v1/claude_code/routines/ ------------ your URL here`, and a placeholder
  bearer token, suggesting this is an unfinished scaffold, not a running automation.
- `Client Presentation Generator` (`n8n Migration/export/workflows/Client Presentation
  Generator__5YPvAW71NdEzvn7x.json`): its webhook body contract is
  `client_name` / `client_email` / `client_company` / `project_name`, feeding a Google Slides
  template-text-replace. This has nothing to do with a meeting transcript or summary payload; it isn't
  "meeting-shaped" at all, contrary to how the researcher grouped it.
Both of the two webhooks offered as evidence fail to verify as transcript/summary consumers. The
"Effort: S, an outbound HTTP POST" estimate is wrong: making either workflow actually useful means
editing n8n workflow internals (outside Tandem, in Andrew's n8n instance), which is exactly the
"downstream may not exist as assumed" risk idea-backlog item 9 was already marked down for — and here,
verified, it doesn't exist in the claimed form. Default-to-kill per the adversarial mandate: this
proposal does not clear the bar it claims to clear. A future, honestly-scoped version (design one NEW
n8n workflow to receive Tandem's payload shape, built to spec rather than reusing an unrelated one)
would just be idea-backlog 9 again, already correctly ranked marginal pending a concrete named
downstream. No new information here changes that ranking.

### 4. Voice dictation for quick-capture, borrowed from Whispering — KILLED as proposed
The underlying want (voice quick-capture, matching the north star) is legitimate, and Whispering
is a real, actively-developed fork of Epicenter (`https://github.com/epicenter-so/epicenter`,
confirmed live; upstream renamed from `braden-w/whispering`) that does run on ElevenLabs Scribe v2 per
its own To-do.md. But the proposal's mechanism doesn't survive a look at Tandem's own tree: Tandem
already ships an ElevenLabs Scribe transcription provider
([elevenlabs_provider.rs](../../frontend/src-tauri/src/audio/transcription/elevenlabs_provider.rs))
AND an existing "record a short clip, transcribe it" Tauri command built for the canvas voice feature
(`canvas_transcribe_clip`, [canvas/commands.rs](../../frontend/src-tauri/src/canvas/commands.rs#L119),
wired to Alt+Shift+A per To-do.md). That is the exact primitive voice quick-capture needs, already
in-repo, already compiled, already privacy-reviewed. Reaching into a second, unrelated Tauri app
(Whispering) that was never built to share code with Tandem, "lift the dictation service into a shared
library or shell out to Whispering," is strictly more effort and more fragile than wiring the capture
bar to the command Tandem already has, for the same end-user result. It also imports a second
standing risk the researcher itself names: the two apps have already collided once on a hotkey
(Alt+Shift+D, forcing Tandem's rename to Alt+Shift+E on 2026-07-15). Kill the "borrow from Whispering"
proposal; if voice quick-capture is wanted, scope it as reusing Tandem's own `canvas_transcribe_clip`
path instead, at a fraction of the effort (S, not M) and no cross-app coupling.

### 5. Make Real: live client mockups on the Tandem canvas — KEEP
Verified directly: agent-whiteboard's own [To-do.md](../../../visual-work/agent-whiteboard/To-do.md#L26)
and README both list "Port Make Real (draw → vision model → HTML)" as scoped, open work — this is not
invented scope. `tldraw/make-real` is a real repo (now archived Feb 2026, which if anything reinforces
"port it, don't depend on the reference standalone" rather than undermining the proposal).
tldraw's $6,000/yr-per-team watermark-free commercial licensing figure is confirmed (BigGo News,
tldraw.dev/legal/tldraw-license via search). The postMessage origin-pinning claim (snapshots can carry
confidential content) is verified verbatim in Tandem's own To-do.md. Correctly gated as cloud-vision
(one agent-whiteboard note names Gemini Flash as the target model) and licensing-cost-gated, not free.
This is a capability bet, not a chore-saver, and the researcher ranks it accordingly (#6). Kept.

### 6. ReviewLab prospect dossier in the pre-call prep card — KEEP, with a correction
ReviewLab's CLAUDE.md frontmatter is real and matches nearly every field cited (`domain`, `contact_name`,
`contact`, `company_size`, `revenue_signals`, `seo_grade`, `lead_score`, `notes`). One inaccuracy:
the proposal's "bump the ReviewLab `status` (replied/meeting/converted)" conflates two separate fields.
`status` is actually `reviewed → polished → sent → replied → converted` (with a `dead` branch);
`meeting` only appears in the separate `outreach_response` field
(`none/opened/replied/meeting/converted`). This doesn't kill feasibility (both fields are grep-able
frontmatter, per ReviewLab's own CLAUDE.md examples) but the write-back needs to target the right
field, not the one named. Everything else — I5 pre-meeting popup (e372dba), I3 calendar/attendee
routing (482aaf7) — is confirmed shipped in To-do.md and is a legitimate join surface. Fully local on
both sides, low overlap with backlog item 7 (client dossier, a riskier auto-extraction idea). Kept,
fix the field name at build time.

### 7. Whiteboard board to proposal deck bridge — KEEP, correctly ranked last
Both export artifacts it depends on (`whiteboard.md`, `whiteboard.png` written per meeting) are
confirmed shipped in To-do.md's "Agent-friendly exports" entry. Low effort, low risk, situational
value, and the researcher already sequences it after proposals 2 and 5 rather than claiming standalone
priority. No claim in this proposal fails to verify. Kept as the correctly-deprioritized #7.

### Verdict summary
**Kept (5):** Docling client-document ingest, Discovery call to pitch deck, Make Real on the Tandem
canvas, ReviewLab prospect dossier (field-name fix needed), Whiteboard-to-deck bridge.
**Killed (2):** Repoint existing n8n meeting workflows (both cited webhooks fail to verify as
transcript/summary consumers when the actual workflow JSON is opened), Voice dictation borrowed from
Whispering (Tandem already ships the exact record-clip-and-transcribe primitive this needs in its own
canvas voice feature; borrowing a second, unrelated app is unnecessary complexity for equivalent value).

## Sources
- docling_processor: d:/docling_processor/README.md, main.py, send_to_n8n.py
- Docling library: https://github.com/docling-project/docling
- Supabase pgvector: https://supabase.com/docs/guides/database/extensions/pgvector
- visual-audio-automation: d:/Dev-projects/visual-work/visual-audio-automation/README.md, new_campaign.py
- OpenAI images / Google Veo (deck toolkit providers): https://platform.openai.com/docs/guides/images , https://deepmind.google/models/veo/
- agent-whiteboard: d:/Dev-projects/visual-work/agent-whiteboard/README.md; tldraw Make Real: https://github.com/tldraw/make-real ; tldraw licensing: https://tldraw.dev/#pricing
- n8n_projects: d:/Dev-projects/n8n_projects/n8n Migration/migration_report.md (271 workflows, 57 webhooks, the Fireflies + Client Presentation webhooks)
- Whispering (Epicenter): d:/Dev-projects/Whispering/To-do.md ; upstream https://github.com/epicenter-so/epicenter
- ElevenLabs Scribe v2: https://elevenlabs.io/docs/capabilities/speech-to-text
- ReviewLab: d:/Dev-projects/ReviewLab/CLAUDE.md
- Presidio (Tandem on-device PII): https://microsoft.github.io/presidio/
- Ranked backlog cross-check: d:/Dev-projects/Tandem/research/idea-backlog-ranked.md ; Tandem status: d:/Dev-projects/Tandem/To-do.md
