# Enhance-my-notes, phase 1: typed jot box (plan, 2026-07-16)

User approved Option 1 (typed jots now; ink/canvas and voice jots are explicitly phase 2+, but
the jot data shape must not preclude them). Source research: the Enhance-my-notes proposal in
[ai-os-integrations/I1-landscape.md](ai-os-integrations/I1-landscape.md) (top-5 roadmap entry).

## The loop

During a recording the user jots two-word fragments ("pricing concerns", "wants Q3 rollout").
Each jot is an act of judgment: this mattered. After the call, a model pass weaves the transcript
into the user's jots: each jot becomes a proper note section grounded in what was actually said
around that moment, with verbatim quotes. The user stays present during the call; nothing they
flagged gets lost; the output reads like notes they wrote, not a generic summary.

## Build spec

1. JOT DATA (design for phase 2 now): `{ id, createdAtMs, audioMs: number | null, content,
   kind: 'text' }` where audioMs is the recording-relative time (derive from the live transcript
   context's latest audio timestamp at jot time; null if unavailable). New pure module
   `frontend/src/lib/meetingJots.ts`: add/edit/delete, sessionStorage persistence keyed by the
   live recording (crash-safe, mirror how recordingSeed does TTL-free session persistence),
   serialization to jots.json, and the enhance-prompt builder (pure, unit-testable).
2. JOT STRIP UI on the home recording view (find the right host near RecordingControls /
   the transcript pane in app/page.tsx): a single-line input, placeholder "Jot a note...
   (Enter)", visible only while a meeting recording is active. Enter appends a timestamped chip
   to a compact running list above the input (newest last, scrollable, click to edit, x to
   delete). Zero other chrome: this must not compete with the call for attention ("invisible
   when active"). Dark variants, semantic tokens, tabular-nums timestamps. Keyboard-only usable.
   Must not steal global shortcuts; typing 1/2/3 in it must not toggle anything (note the
   quick-capture digit-toggle lesson).
3. PERSIST AT STOP: on recording stop (the same post-save path that kicks off auto-summary in
   useRecordingStop), write jots.json into the meeting folder (reuse save_transcript) and clear
   the session store. If zero jots: write nothing, skip the enhance pass entirely, change no
   existing behavior.
4. ENHANCE PASS (after transcripts saved, parallel to auto-summary, non-blocking): build the
   prompt from (a) the user's jots in order, (b) for each jot a transcript window of ±90s around
   its audioMs (fallback: proportional position), (c) a compressed full-transcript pass for the
   "Also discussed" appendix. Investigate the smallest model-call path: the backend already has
   LLM provider plumbing (api_process_transcript with customPrompt/templateId); prefer adding a
   dedicated lightweight endpoint or template over overloading the summary pipeline, but pick
   the smallest sound option after reading backend/app/main.py. Use the user's configured
   provider (their setup: local Ollama available; do not hardcode a provider).
   PROMPT RULES: notes in the user's voice: direct, plain language, no em dashes, no hype; every
   factual claim grounded in the transcript; quotes verbatim with [MM:SS] stamps; if the
   transcript around a jot does not support anything, the section says "flagged, but the
   transcript around this moment does not elaborate" rather than inventing content.
5. ANTI-HALLUCINATION VERIFIER (deterministic, not model-based): after generation, every quoted
   span in the output is checked against the actual transcript (normalized fuzzy contains); any
   quote that does not verify gets visibly marked "[unverified]" in the saved notes. Pure
   function, unit-tested. This is the trust backbone of the feature.
6. OUTPUT: enhanced-notes.md saved to the meeting folder next to the summary; a "Notes" section
   on the meeting details page rendering it (read-only markdown render is fine for phase 1)
   above/beside the existing summary, with a "Regenerate" button and a calm toast lifecycle like
   auto-summary ("Enhancing your notes..." -> "Notes ready - View"). If the model call fails:
   jots.json is still saved (raw jots are never lost), error toast offers retry.
7. NO new Settings toggle: the feature activates only when jots exist. Document the jot box in
   the Settings shortcuts/help card copy if a natural spot exists.

## Tests

- vitest: meetingJots store round-trip, prompt builder (windows, ordering, empty-transcript
  fallback), quote verifier (verbatim pass, near-miss fuzzy pass, fabricated quote flagged).
- Playwright: recording-active mock -> jot strip visible, Enter adds chip, edit/delete work,
  not visible when idle; stop flow writes jots.json (assert via mock calls) and triggers the
  enhance call; meeting details renders a mocked enhanced-notes.md with an [unverified] marker
  styled distinctly.

## Risks for skeptics

- Hallucinated content or quotes surviving the verifier (attack the fuzzy matcher: paraphrased
  fake quotes, quotes spliced from two real spans, timestamps pointing at the wrong speaker).
- Jot strip stealing focus or shortcuts during a live call; jots lost on crash/reload mid-call
  (sessionStorage survival), or leaking across two consecutive recordings (handover! the I5b
  wrap-up-and-start-next path must bind jots to the correct meeting).
- Enhance pass racing auto-summary (shared provider/model config, toast collisions, double
  navigation), enhance firing for solo/non-meeting recordings, huge transcripts blowing the
  context window (window the transcript, never truncate silently).
- Meeting folder relocation (post-stop routing) happening between save and enhance: notes must
  land in the folder the meeting actually ends up in (reuse how auto-summary handles this, or
  write via meetingId-resolved path at write time).
