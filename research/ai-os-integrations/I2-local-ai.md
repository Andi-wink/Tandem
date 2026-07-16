# I2-local-ai: local-first AI infrastructure Tandem could integrate

Researcher pass for the "AI OS features and integrations" loop, 2026-07-16. Brief: find
privacy-first, local-first AI infrastructure Tandem could adopt while keeping the "confidential
client conversations never leave the machine" promise. Every external claim below is cited. All
VRAM figures are budgeted against Andrew's single RTX 3090 (24 GB). The live STT path is cloud
ElevenLabs Scribe v2, so during a call the 3090 is largely idle and available for local models;
the local Whisper/Parakeet engines remain installed as fallbacks.

Scope guard: I read [To-do.md](../../To-do.md) and [idea-backlog-ranked.md](../idea-backlog-ranked.md).
These proposals are the *infrastructure* under several already-ranked ideas (ask-my-meetings Q&A,
custom vocabulary, client dossier) plus net-new capture/vision/voice surfaces. Where a proposal
unblocks a backlog idea I say so explicitly; I do not re-pitch shipped work (I3-I6, quick-capture,
handover) or parked items (I7-I9).

---

## Hardware reality: the RTX 3090 budget

- RTX 3090 = 24 GB GDDR6X, ~936 GB/s bandwidth, Ampere (no FP8, but excellent INT8/FP16). It is a
  genuinely capable local-AI box: it can hold a quantized 8B VLM (~8 GB) plus an embedding model
  (~1-2 GB) plus a TTS model (~0.5 GB) simultaneously and still leave headroom for a 7-8B chat LLM.
- Because live STT is cloud Scribe v2, the GPU is not contended during recording (per
  [transcription baseline memory]). Local inference (RAG embed, TTS, vision) can run in the
  background of a call or, more safely, post-call.
- The single hard constraint: do not try to co-resident a 30B+ VLM (21+ GB, per the Ollama vision
  guide below) with anything else. Everything proposed here fits comfortably under 24 GB.

---

## 1. Custom vocabulary for STT via Scribe v2 keyterm prompting (VERIFIED FEASIBLE)

**What.** Send a per-meeting list of client names, product names, and domain jargon to ElevenLabs
Scribe v2 as *keyterms* so they stop getting mangled. This directly resolves backlog idea 15
("Custom vocabulary for STT"), which the ranker flagged as feasibility-gated on "does Scribe even
support biasing." It does.

**Verified detail.** Scribe v2 supports keyterm prompting: the batch API accepts **up to 1000
keyterms at 50 characters each**; the realtime WebSocket variant accepts **up to 50 keyterms at 20
characters each** ([ElevenLabs STT docs](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)).
Keyterm prompting biases the model toward a term when it is plausibly spoken, without force-matching
it when it is not ([ElevenLabs: Introducing Scribe v2](https://elevenlabs.io/blog/introducing-scribe-v2),
[Toolworthy Scribe v2 review](https://www.toolworthy.ai/tool/elevenlabs-scribe-v2)). Pricing note:
keyterms add a ~30% premium over base transcription per the same review, so keep the list tight.

**Productivity case.** STT errors propagate into search, summaries, action items, and any future
dossier, so cutting recurring misrecognitions has compounding leverage. Tandem already knows the
active project (I3 routing) and its client folder, so it can auto-assemble the keyterm list from the
project name, past attendee names, and a small user-curated per-project vocab list with zero extra
user effort.

**Privacy fit.** Neutral-to-good. Keyterms travel to ElevenLabs alongside audio that already goes
there; no *new* data leaves the machine, and the per-project term list stays in the Rust SQLite. No
change to the trust boundary.

**Feasibility.** Small. The ElevenLabs provider already exists in the Rust pipeline; this adds a
`keyterms` field to the request built from project context. Batch path is the safe first target
(1000-term budget); the realtime path (idea from the Scribe Realtime WS plan) can carry the same
list capped at 50. No new dependencies, no GPU.

---

## 2. Local RAG over transcripts: sqlite-vec + Ollama embeddings (unblocks "ask-my-meetings")

**What.** A local semantic index over all past transcripts and summaries so Tandem can answer "when
did we agree the deadline with Acme" with synthesized, cited answers. This is the infrastructure
under backlog idea 1 (ask-my-meetings Q&A, ranked #4 "strong tier") and idea 10 (client dossier).

**Concrete tech.**
- **Vector store: sqlite-vec.** Pure-C SQLite extension, official Rust binding on crates.io
  (`cargo add sqlite-vec`), supports float/int8/binary vectors and metadata/auxiliary columns for
  filtering ([sqlite-vec repo](https://github.com/asg017/sqlite-vec)). It loads as an extension into
  the *existing* Rust SQLite that Tandem already runs via sqlx, so there is no second database and no
  server process. Caveat to flag honestly: it is pre-v1 (v0.1.9), so expect breaking changes and pin
  the version. The main embedded alternative is **LanceDB** (in-process, zero-copy Lance columnar
  format, no server), which is stronger at multimodal/large-scale but adds a separate on-disk store
  and a heavier dependency ([Encore vector DB guide](https://encore.dev/articles/best-vector-databases),
  [Shaharia: embeddable vector DBs](https://shaharia.com/blog/choosing-embeddable-vector-database-go-application/)).
  For "index one consultant's meetings" sqlite-vec is the right-sized choice; reach for LanceDB only
  if volume or multimodal (screenshots) grows.
- **Embedding model (local, via Ollama): nomic-embed-text or BGE-M3.** nomic-embed-text is the best
  size/quality balance for lightweight local deployment with an 8192-token context; BGE-M3 is the
  stronger multilingual/hybrid pick (useful for Andrew's German calls) and is the 2026 production
  default paired with a reranker ([Vucense embedding guide](https://vucense.com/dev-corner/embedding-models-2026/),
  [PromptQuorum local RAG embeddings](https://www.promptquorum.com/power-local-llm/best-embedding-models-local-rag-2026),
  [Milvus embedding model guide](https://milvus.io/blog/choose-embedding-model-rag-2026.md)). Both
  run in Ollama, which Tandem already integrates.
- **Optional quality lift: BGE-reranker-v2.** Most 2026 local RAG stacks default to BGE-M3 plus
  BGE-reranker-v2 to re-order the top-k before it hits the LLM ([Vucense guide](https://vucense.com/dev-corner/embedding-models-2026/)).

**VRAM/latency reality.** Embedding models are tiny: nomic-embed-text is ~0.5 GB, BGE-M3 ~1-2 GB;
even a Qwen3-Embedding-8B Q4 is only ~5 GB ([Milvus guide](https://milvus.io/blog/choose-embedding-model-rag-2026.md)).
Indexing is a one-time background pass over stored transcripts; query embed is single-digit ms on
the 3090. The vector search itself is CPU in sqlite-vec and trivially fast at one user's scale.

**Productivity case.** 15-30 min/week on the "what did we actually agree" moments (ranker's
estimate). The infrastructure also feeds the dossier and prep one-pager.

**Privacy fit.** Excellent, and this is the whole point: unlike a cloud RAG, embeddings and index
stay in the local SQLite, and answering can use a local LLM (Ollama) so no transcript text leaves
the machine. This is the privacy-preserving way to build a capability that would otherwise force
confidential transcripts to a cloud vector DB.

**Feasibility.** Medium. New index table + migration, an embed-on-summary-write hook, a retrieval
function, and a Q&A surface (Ctrl+K "Ask my meetings"). The ranker's hard requirement stands:
answers must be exact-quote-linked to a meeting+timestamp or the feature corrodes trust. sqlite-vec
metadata columns make the citation (meeting id, segment id, timestamp) a stored field, not a guess.

---

## 3. Local TTS for spoken answers: Kokoro-82M

**What.** Let Tandem speak short answers and confirmations aloud (e.g. answer to an "ask-my-meetings"
question, or a spoken "filed under Acme") so Andrew can stay eyes-up during or between calls.

**Concrete tech: Kokoro-82M.** 82M-param open-weight model, Apache 2.0, 54 voices across 8 languages,
24 kHz output; it reached #1 on the TTS Spaces Arena leaderboard despite its size
([Local AI Master: Kokoro setup](https://localaimaster.com/blog/kokoro-tts-local-setup),
[CodeSOTA TTS guide](https://www.codesota.com/guides/tts-models)). Fallback: **Piper** (CPU-only,
tiny per-voice files, runs real-time on a Raspberry Pi) if we want zero GPU use, at the cost of
audibly more synthetic voice ([Contra Collective: Kokoro vs Piper vs XTTS](https://contracollective.com/blog/kokoro-vs-piper-vs-xtts-local-text-to-speech-m5-max-2026)).

**VRAM/latency reality.** Kokoro is ~0.3 GB, RTF ~0.03 on GPU (a 10s clip synthesized in ~0.3s), and
posts the lowest first-audio latency across every GPU tier; ~28 ms first-audio on a 5090, so the
3090 lands comfortably in the tens-of-ms range ([Local AI Master: best local TTS](https://localaimaster.com/blog/best-local-tts-models)).
Effectively free alongside everything else on the 3090.

**Productivity case.** Modest and situational. This is an enabler for a hands-free/eyes-up mode, not
a headline time-saver on its own; its value is entirely tied to whether spoken Q&A (proposal 2) or a
voice loop gets built. Rank it as a dependency, not a standalone win.

**Privacy fit.** Excellent: fully local, no network, Apache 2.0.

**Feasibility.** Small-medium. Python sidecar (RealtimeTTS wraps Kokoro,
[realtimetts on PyPI](https://pypi.org/project/realtimetts/)) or an ONNX build; wire to a Rust
command that streams PCM to the existing audio output. Respect a global mute and never speak during
an active recording (design principle: invisible when active).

---

## 4. Local vision model for screenshot understanding: Qwen3-VL 8B (Ollama)

**What.** Turn Tandem's existing screenshot capture (Alt+Shift+S) and clipboard-image capture into
*understood* content: OCR the text, describe the UI, extract the diagram/table, so a screenshot
filed to a project is searchable and summarizable, not just a PNG.

**Concrete tech: Qwen3-VL 8B via Ollama.** Released late 2025, it is the current local OCR/screenshot
accuracy leader in its class (Qwen3-VL 8B ~= MiniCPM-V 4.5 > Llama 3.2 Vision 11B > LLaVA > Moondream
for OCR), handles screenshots/charts/math well, and covers 32 languages
([PromptQuorum local vision](https://www.promptquorum.com/power-local-llm/local-vision-models-llava-ollama-2026),
[MyLocalAI OCR VLMs](https://mylocalai.org/blog/best-local-vision-model-ocr),
[Ollama qwen3-vl library](https://ollama.com/library/qwen3-vl)). Needs Ollama 0.12.7+ (Tandem's Ollama
is current). Low-VRAM fallback: **Moondream 2** (1.9B, ~2 GB) for quick alt-text/description when the
3090 is busy ([PromptQuorum](https://www.promptquorum.com/power-local-llm/local-vision-models-llava-ollama-2026));
**MiniCPM-V 4.5** as a document-OCR-focused alternative on 6-8 GB.

**VRAM/latency reality.** Qwen3-VL 8B quantized is ~8 GB on the 3090; the 32B variant needs 21+ GB and
should be avoided here ([PromptQuorum](https://www.promptquorum.com/power-local-llm/local-vision-models-llava-ollama-2026)).
Single-screenshot inference is a few seconds, fine for an on-capture background job.

**Productivity case.** Moderate. Makes screenshots first-class searchable artifacts (feeds proposal
2's index) and can auto-caption a pasted diagram into a project note. Real but not daily-spine.

**Privacy fit.** Excellent: fully local via Ollama, screenshots (which may contain client screens)
never leave the machine. This is strictly better than any cloud vision API for confidential content.

**Feasibility.** Medium. On-capture hook posts the image to local Ollama, stores the extracted
text/description next to the screenshot, indexes it. Guard: OCR of a client's screen is sensitive, so
extraction output inherits the same PII/anonymization and local-only treatment as transcripts.

---

## 5. Ambient screen/audio memory (Screenpipe-style), scoped to opt-in and project-bounded

**What.** A "what was on my screen when we discussed X" recall layer: continuous, event-driven screen
capture with OCR + accessibility-tree text, searchable locally. Screenpipe is the reference
implementation.

**Concrete tech: Screenpipe (reference / possible dependency).** YC S26, MIT-licensed, 100% local,
Mac/Windows/Linux; it captures a screenshot only when the screen meaningfully changes, pairs it with
the OS accessibility tree (much lighter than always-OCR), does local Whisper STT, stores everything
locally, and exposes an MCP server so an agent can query screen history; typical CPU 5-10%
([Screenpipe GitHub](https://github.com/screenpipe/screenpipe),
[Screenpipe about](https://screenpipe.com/about),
[Screenpipe README](https://github.com/screenpipe/screenpipe/blob/main/README.md)). Two integration
paths: (a) run Screenpipe alongside Tandem and query its MCP server, or (b) build a narrow
Tandem-native equivalent (event-driven capture + proposal 4's VLM/OCR + proposal 2's index) that only
records during meetings and only files under the active project.

**VRAM/latency reality.** Capture is cheap (accessibility-tree-first, OCR fallback, 5-10% CPU per
Screenpipe's own figures). The cost is the VLM/OCR pass, which is proposal 4's budget. Storage, not
compute, is the real cost of 24/7 capture.

**Productivity case.** Potentially high (perfect recall of what was shown in a call), but
speculative for this user and overlaps the parked video-capture feature (F061) and screenshot
capture already shipped.

**Privacy fit.** This is the sharpest tension in the whole brief. 24/7 ambient capture of a
consultant's screen is a privacy *liability* even when local: it will record other clients' data,
credentials, and unrelated windows. Recommendation: do NOT adopt always-on Screenpipe as-is. If
built, scope it hard: opt-in only, capture ONLY during an active recording, ONLY the meeting-related
window if the OS allows, auto-file to the active project, and honor a pause/redact control. Framed
that way it becomes "screen memory for this call," consistent with the trust brand; framed as 24/7 it
contradicts "privacy is paramount." Flag for an explicit user decision before any build.

**Feasibility.** Medium (query existing Screenpipe over MCP) to Large (native scoped build). Given
the privacy tension and overlap with F061, treat this as research-only until the user rules on scope.

---

## 6. Speaker-aware summarization (attributed summaries + talking-time)

**What.** Feed speaker labels into the summary so minutes carry attributed quotes ("Client committed
to $40k by Friday") and the review shows talking-time balance, instead of an unattributed wall of
text. This is the *useful downstream* of the in-flight diarization work (F022), turning raw speaker
IDs into consultant-relevant output.

**Concrete tech.** Two label sources. Cheapest and already available: the **mic-vs-system channel
split** Tandem records, which cleanly separates "me" (mic) from "them" (system) on the common 2-party
call, no model needed. For 3+ voices on one channel, **pyannote** provides the labels; in 2026
pyannote ships Community-1 (open) and Precision-2 (production) diarization, and offers STT
orchestration that returns speaker-attributed transcripts in one call
([pyannoteAI STT orchestration](https://www.pyannote.ai/blog/stt-orchestration),
[Gladia x pyannoteAI](https://www.gladia.io/blog/gladia-x-pyannoteai-speaker-diarization-and-the-future-of-voice-ai)).
The summarization step is then a prompt change: pass the speaker-tagged transcript to the existing
summary LLM and ask for attributed action items. Research confirms LLM recap systems produce
per-speaker summaries and attributed minutes from diarized input
([VexaScribe diarization tools](https://novascribe.ai/compare/best-speaker-diarization-tools)).

**VRAM/latency reality.** Channel-split path is free (no model). pyannote Community-1 runs on the
3090 in well under real-time; it is a post-call batch pass, not a live-path cost.

**Productivity case.** The idea-backlog ranker rated raw diarization *surfacing* as worst
gain-to-effort (idea 7, skip tier) BECAUSE the 2-party channel split already separates speakers.
This proposal is deliberately narrower and cheaper: skip pyannote for the common case, use the free
channel split to attribute the summary, and only invoke pyannote when >2 voices are detected on one
channel. Framed this way the value is real (attributed commitments feed the action-item inbox and
dossier) at near-zero cost for most calls.

**Privacy fit.** Excellent if it stays on the channel-split + local-pyannote path; both are on-device.
Avoid the cloud pyannoteAI orchestration API for confidential audio.

**Feasibility.** Small for the channel-split-attributed summary (prompt + label plumbing). Medium if
pyannote is wired for the >2-speaker case (the F022 worktree already has the harness). Sequence the
cheap channel-split win first.

---

## 7. Ollama structured outputs for reliable extraction (summaries, action items, keyterms)

**What.** Replace free-text-then-regex parsing of summaries and action items with JSON-schema-
constrained model output, so the action-item checklist (I4) and any future inbox get clean, typed
data instead of scraped Markdown headings.

**Concrete tech.** Ollama now supports **structured outputs**: constrain generation to a JSON schema,
with Python and JS library support ([Ollama structured outputs docs](https://docs.ollama.com/capabilities/structured-outputs),
[Ollama structured outputs blog](https://ollama.com/blog/structured-outputs)). Current Ollama is
v0.32.0 (2026-07-11), which also adds improved tool calling and an agent experience
([PromptQuorum Ollama July 2026](https://www.promptquorum.com/local-llms/top-open-source-models-ollama)).
Anthropic/Claude, the other configured provider, has tool-use/JSON modes for the same purpose.

**Productivity case.** Indirect but high-leverage: the ranker's #1 idea (cross-meeting action-item
inbox) is "only as trustworthy as the underlying action-item parsing." Structured extraction is the
single cheapest way to de-noise that parsing, which lifts every feature that consumes action items.

**Privacy fit.** Excellent when run against local Ollama; the extraction never leaves the machine.

**Feasibility.** Small. Change the summarize/extract calls to pass a schema and parse typed JSON.
Backwards-compatible behind the existing summary flow.

---

## 8. Local LLM answer layer for RAG/dossier (keep synthesis on-device)

**What.** When proposals 2/4 synthesize an answer or a dossier fact sheet from confidential
transcripts, run the *generation* on a local Ollama model by default, reserving cloud Claude for when
the user explicitly opts in per query. This keeps the highest-risk step (a model reading many client
transcripts at once) on-device.

**Concrete tech.** Ollama's current strong general/agentic models (v0.32.0 era) run well on a 24 GB
3090 at 7-14B sizes; the ecosystem guide lists the July 2026 model lineup and use-case picks
([ML Journey best Ollama models 2026](https://mljourney.com/best-ollama-models-in-2026-a-practical-guide-by-use-case/),
[PromptQuorum Ollama July 2026](https://www.promptquorum.com/local-llms/top-open-source-models-ollama)).
Pair with proposal 2's retrieval and proposal 7's structured outputs for cited, typed answers.

**VRAM/latency reality.** A 7-8B model is ~5-8 GB quantized on the 3090, leaving room for an embedding
model co-resident; a 14B is ~10-12 GB. Answer latency is a few seconds, acceptable for an
ask-my-meetings surface.

**Productivity case.** This is a policy/enabler proposal rather than a feature: it is what makes the
ranker's "strong tier but risky" ideas (Q&A, dossier) shippable without breaking the privacy promise.

**Privacy fit.** Excellent, and the core differentiator: Tandem can offer meeting-memory features
that competitors only do in the cloud, because synthesis stays local by default.

**Feasibility.** Small (Tandem already talks to Ollama and Claude; this is a default + a per-query
opt-in toggle) but depends on proposal 2 existing.

---

## Summary: sequencing recommendation

1. **Proposal 1 (Scribe keyterms)** first: verified feasible, small, resolves a gated backlog idea,
   improves every downstream feature by cutting STT errors, no GPU.
2. **Proposal 7 (structured outputs)** next: small, de-noises the action-item parsing the ranker's #1
   idea depends on.
3. **Proposal 6 (channel-split attributed summaries)**: small, near-free, feeds attributed action
   items.
4. **Proposals 2 + 8 (local RAG + local answer layer)**: the medium-effort infrastructure that
   unblocks ask-my-meetings and the dossier while keeping confidential transcripts on-device. Build
   with exact-quote citations from day one.
5. **Proposal 4 (local vision)** and **3 (Kokoro TTS)**: enablers for screenshot understanding and
   spoken answers; build when their consuming feature is scheduled.
6. **Proposal 5 (ambient capture)**: research-only, gate on an explicit user decision about scope
   because 24/7 capture conflicts with the privacy brand and overlaps F061.

[transcription baseline memory]: the live STT provider is ElevenLabs Scribe v2 (cloud); the 3090 is
free for local inference during calls. See project memory `transcription-engine-baseline`.

---

## Skeptic verdicts

Adversarial pass, 2026-07-16. Method: verified every external claim against primary sources (not the
researcher's secondary citations alone), read the actual Tandem code the feasibility claims rest on,
and applied the strict ranking criterion from [idea-backlog-ranked.md](../idea-backlog-ranked.md):
minutes saved per week or dropped balls prevented, nothing else. Default to kill on any unverified or
undemonstrated claim.

### 1. Custom vocabulary via Scribe v2 keyterm prompting - KEEP

Verified directly against the primary ElevenLabs docs, not just the secondary sources the researcher
cited: batch is confirmed **1000 keyterms, 50 characters each**; realtime is confirmed **50 keyterms,
20 characters each** ([ElevenLabs keyterm prompting guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/batch/keyterm-prompting),
[ElevenLabs STT overview](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)). Keyterm
prompting does carry "an additional cost" per the primary docs, confirming a premium exists, though
the specific "~30%" figure traces only to a secondary review site
([Toolworthy](https://www.toolworthy.ai/tool/elevenlabs-scribe-v2)) and should be treated as
directional, not exact, until checked against ElevenLabs' own pricing page. This is the smallest,
best-evidenced proposal in the set and correctly resolves the feasibility gate idea-backlog-ranked.md
left open on idea 15. No privacy regression (keyterms ride with audio that already goes to
ElevenLabs). Ship first.

### 2. Local RAG over transcripts (sqlite-vec + Ollama embeddings) - KEEP, feasibility downgraded

The component claims check out: sqlite-vec is a real, actively maintained crate
(`cargo add sqlite-vec`, MIT/Apache-2.0, 1.7M+ downloads, v0.1.9,
[crates.io](https://crates.io/crates/sqlite-vec)), and nomic-embed-text/BGE-M3 are real Ollama-servable
embedding models. But the load-bearing feasibility claim, "it loads as an extension into the existing
Rust SQLite that Tandem already runs via sqlx", does not hold up under verification. sqlite-vec's
documented Rust integration path uses `sqlite3_auto_extension()`, demonstrated only against
**rusqlite** ([alexgarcia.xyz/sqlite-vec/rust.html](https://alexgarcia.xyz/sqlite-vec/rust.html)).
sqlx does not expose `sqlite3_auto_extension`; it only offers `.extension()` /
`.extension_with_entrypoint()` for dynamically-loaded shared-library extensions, a different
mechanism. The exact question "how do I load sqlite-vec through sqlx" is an **open, unresolved GitHub
issue since February 2025 with no answer, workaround, or PR**
([asg017/sqlite-vec#198](https://github.com/asg017/sqlite-vec/issues/198)). Tandem's frontend DB is
sqlx-based per CLAUDE.md, so this is not a paperwork gap, it is an unverified integration path the
researcher stated as settled fact. Downgrade "Medium effort" to "Medium effort, gated on a spike":
either prove `.extension_with_entrypoint()` works against `sqlite3_vec_init`, or fall back to a
side-channel rusqlite connection dedicated to the vector table, or skip the SQL extension entirely and
do brute-force cosine similarity in Rust (trivially fast at one user's transcript volume, per the
doc's own latency numbers). Keep the proposal, but treat proposal 2 as one tier riskier than described
and sequence it behind a 30-minute technical spike, not straight into a migration. Concur with
idea-backlog-ranked.md's own caution on idea 1 (strong tier, not top tier: "build carefully").

### 3. Local TTS for spoken answers (Kokoro-82M) - KILL

Every fact checks out: Apache 2.0, 82M params, 54 voices/8 languages, 24kHz, reached #1 on the TTS
Arena leaderboard at launch as v0.19 before settling lower as the leaderboard filled in
([Local AI Master](https://localaimaster.com/blog/kokoro-tts-local-setup),
[OfflineTTS TTS Arena 2026](https://offlinetts.com/blog/tts-arena-leaderboard-2026/)). None of that
rescues the proposal from the ranking criterion. No item in the 20-idea backlog
([idea-backlog-20.md](../idea-backlog-20.md)) or its ranking asks for spoken output; the researcher's
own text concedes it is "modest and situational... a dependency, not a standalone win," which is a
self-admission it scores zero on both axes (no minutes saved, no dropped-ball prevention) until some
other feature that needs a voice exists. It also cuts against the shipped design principle "invisible
when active": Tandem speaking during or near a call is a new attention surface, not a removed one. Kill
as a standalone proposal; revisit only if a specific consuming feature (e.g. a hands-free ask-my-
meetings mode) is greenlit first, at which point Kokoro is a fine implementation choice.

### 4. Local vision model for screenshot understanding (Qwen3-VL 8B via Ollama) - KILL (defer)

Model claims verified: Qwen3-VL 8B's OCR is genuinely competitive with MiniCPM-V 4.5 and ahead of
Llama 3.2 Vision 11B and LLaVA, 32-language OCR, native Ollama vision support
([codersera Qwen3-VL benchmarks](https://codersera.com/blog/qwen3-vl-4b-vs-qwen3-vl-8b-benchmarks-vram-guide/),
[Ollama qwen3-vl library](https://ollama.com/library/qwen3-vl:8b)). Screenshot capture is confirmed
real and shipped ([screenshotService.ts](../../frontend/src/services/screenshotService.ts)). The
problem is demand, not feasibility: screenshot understanding appears in **none** of the 20 ranked
backlog ideas, meaning no one, including Andrew in the sessions that produced that backlog, has
flagged "I can't find/use a screenshot" as a real friction point. The researcher's own productivity
case is the tell: "Moderate... real but not daily-spine." Per the ranking rule (novelty scores
nothing), an unrequested capability with a self-rated moderate-at-best case does not clear the bar.
Kill for now; keep as a fast follow only if a user actually hits "I filed a screenshot and can't find
what it said" in practice.

### 5. Ambient screen/audio memory (Screenpipe-style) - KILL as proposed, concur with researcher's own hedge

Screenpipe's facts verify: YC S26, MIT-licensed, 100% local storage, event-driven capture (screenshot
+ accessibility tree on meaningful change, not continuous video), ships an MCP server
([Screenpipe GitHub](https://github.com/screenpipe/screenpipe),
[Screenpipe README](https://github.com/screenpipe/screenpipe/blob/main/README.md)). No factual issue
here; the researcher already reached the right verdict inside proposal 5 itself ("do NOT adopt
always-on Screenpipe as-is... treat as research-only"). An adversarial pass has nothing to add except
to make that verdict a formal KILL rather than a soft caveat buried in prose: 24/7 capture of a solo
consultant's screen across multiple clients' confidential material is a liability even 100% local
(other clients' windows, credentials, unrelated apps all get recorded), it duplicates ground already
covered by parked F061 (video capture), and it has no anchor in the ranked backlog. If a narrow,
meeting-scoped variant is ever built, that is new-proposal territory requiring its own explicit user
sign-off, not a variant of this one.

### 6. Speaker-aware summarization (channel-split-attributed, pyannote for 3+) - KEEP, correction on feasibility framing

Concept and cost model hold: the mic/system channel split needs no model and pyannote's Community-1 /
Precision-2 split (open vs. paid-cloud) is accurately described, including the correct call to avoid
the cloud pyannoteAI orchestration API for confidential audio
([pyannoteAI models](https://www.pyannote.ai/md/models),
[pyannoteAI STT orchestration](https://www.pyannote.ai/blog/stt-orchestration)). But the proposal
materially **understates** how built the diarization substrate already is: it describes F022 as "the
F022 worktree already has the harness," while [feature_list.json](../../feature_list.json) (lines
917-980) shows F022 has completed Phases 1-5, backend `diarizer.py` with GPU inference and transcript
alignment, 4 database tables, 7 `/api/diarize/*` endpoints, frontend speaker badges, and a speaker-
naming UI, with only Phase 5.5 (runtime install/verify) and Phases 6-7 (voice fingerprinting, export)
outstanding. This is good news for proposal 6, wiring speaker labels into a summarization prompt is
smaller than the doc implies, since the labeling pipeline already exists end to end. It also means
[idea-backlog-ranked.md](../../research/idea-backlog-ranked.md)'s own characterization of idea 7
("eval harness still being built in the Tandem-f022 worktree", skip tier) is now stale against
feature_list.json and should be reconciled the next time that ranking is touched. Keep proposal 6, with
the corrected, more-feasible framing; sequence the free channel-split path first exactly as the doc
recommends.

### 7. Ollama structured outputs for reliable extraction - KEEP

Verified against the primary Ollama docs: structured outputs constrain generation to a JSON schema via
a `format` parameter, with first-class Python (Pydantic) and JS (Zod) support
([Ollama structured outputs docs](https://docs.ollama.com/capabilities/structured-outputs),
[Ollama structured outputs blog](https://ollama.com/blog/structured-outputs)). The v0.32.0 / July 11
2026 release date checks out too
([Freedom.Tech Ollama 0.32.0](https://freedom.tech/posts/2026-07-11-ollama-0-32-0/)). Checked the
fragility claim against the actual code, not just the pitch: action items are currently extracted by a
regex over freeform markdown headings
([actionItems.ts](../../frontend/src/lib/actionItems.ts) line 15: `/action items/i` heading match,
then list-item scraping), exactly the brittle parsing this proposal describes. Ollama is already
integrated in the backend (title-generation provider branch,
[backend/app/main.py](../../backend/app/main.py) line ~278-282), so this is additive, not a new
dependency. Small effort claim holds; keep, and prioritize it as the doc's sequencing already suggests.

### 8. Local LLM answer layer for RAG/dossier - KEEP, but non-standalone

The claim that Ollama is "already talked to" by Tandem is confirmed (see proposal 7's citation of
main.py's ollama provider branch), so the default-local/opt-in-cloud policy is a real, small change
when it has something to sit on top of. It has nothing to sit on top of yet: this proposal is entirely
parasitic on proposal 2 shipping, and proposal 2 just got downgraded to "gated on a spike." Keep the
policy decision as correct and worth committing to in principle (never let bulk-transcript synthesis
default to cloud), but do not schedule or estimate it independently of proposal 2, doing so would
double-count effort and hide proposal 2's real risk behind a separately-"small" line item.

### Verdict summary

**Kept (4):** custom vocabulary via Scribe v2 keyterms; local RAG over transcripts (feasibility
downgraded, spike required before build); speaker-aware summarization (feasibility framing corrected,
easier than described); Ollama structured outputs. **Kept but non-standalone (1):** local LLM answer
layer, sequence strictly behind proposal 2. **Killed (3):** local TTS (Kokoro-82M) - no demand, no
consuming feature, self-admitted non-standalone; local vision for screenshot understanding (Qwen3-VL
8B) - accurate model claims but zero anchor in the ranked backlog and a self-rated "moderate at best"
case; ambient screen/audio memory (Screenpipe-style) - formalizing the researcher's own hedge into a
kill, given the privacy liability of any always-on variant and the F061 overlap.
