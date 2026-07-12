# Plan: ElevenLabs Scribe v2 Realtime WebSocket transcription

_Planned 2026-07-12 (Fable). No implementation yet. Predecessors: the 2026-07-11 loop
(commits 72e64f5, 1565ce5) got the batch path to 6.3% pooled WER / 7.7s median block
wait on held-out clips 11-16. The remaining latency floor is structural: silero VAD
delivers a monologue as one 13-35s segment, and the batch transport can only render
whole blocks. This plan replaces the transport, not the vendor._

## Goal and non-goals

**Goal:** live transcript text appears within ~1s of being spoken, as a revisable
partial tail that locks into committed segments, with WER no worse than the current
batch path (6.3% pooled on clips 11-16) and no regression for local providers.

**Non-goals (this plan):** German quality (separate Kroko/sherpa-onnx spike),
diarization changes, replacing the batch path (it stays as fallback and as the
harness reference), Parakeet/Whisper changes.

## API contract (verified by research 2026-07-11; re-verify in Phase 0)

- `wss://api.elevenlabs.io/v1/speech-to-text/realtime` (regional variants exist).
  Auth: `xi-api-key` header (same key we already store) or single-use token.
- Client -> server: `input_audio_chunk` = base64 PCM + `sample_rate` (16kHz PCM
  supported = our existing worker format) + optional `commit` flag.
- Server -> client: `session_started`, `partial_transcript` (revisable),
  `committed_transcript`, `committed_transcript_with_timestamps` (word timings +
  language detection), error events (`auth_error`, `quota_exceeded`, `rate_limited`,
  `input_error`).
- Commit strategies: `manual` (we send `commit`) or `vad` (server auto-commit,
  default 1.5s silence, threshold 0.4, configurable).
- Extras we want: `keyterms` biasing, `include_timestamps`,
  `include_language_detection`. Enterprise-only: zero-retention.
- Docs: [API reference](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime),
  [server-side guide](https://elevenlabs.io/docs/eleven-api/guides/cookbooks/speech-to-text/realtime/server-side-streaming).

## Architecture decisions (with rationale)

### D1. Two WS sessions per recording: one per stream (mic, system)
The app's speaker attribution is per-stream (`source: "Local" / "Remote"`, set from
device type in worker.rs). Mixing both streams into one socket would destroy that.
So: one session per active stream, owned by a new per-stream task. Cost implication
is bounded by D2.

### D2. Feed VAD-gated audio (with generous padding), not raw continuous audio
Streaming both raw streams would bill ~2x wall-clock audio-minutes even when nobody
speaks (system stream is often silent for long stretches; mic too in listen-heavy
calls). Instead, reuse the existing per-stream silero VAD output: forward speech
segments as they are DETECTED (not, as today, after the segment ends — the VAD
already emits frame decisions internally; we tap the open-segment audio as it
accrues, in ~250ms frames) plus 300ms pre-roll from a small ring buffer. During
silence, send nothing (or sparse keepalive frames if the API requires liveness;
Phase 0 answers this). Server-side `vad` commit strategy stays coherent because we
also forward our VAD-end as an explicit `commit` (belt and braces; exact mix decided
by Phase 3 measurement).

Key difference from today: audio leaves the machine ~250ms after it is spoken,
DURING an open VAD segment. The "single 35s segment = single 35s block" floor
disappears because the server transcribes and partial-emits continuously.

### D3. New engine variant, not a bolt-on to `TranscriptionProvider`
The existing trait is request/response (`transcribe(audio) -> TranscriptResult`);
a duplex stream doesn't fit it and shoehorning it in would contaminate the four
batch providers. Plan: `TranscriptionEngine::RealtimeStream` variant holding an
`ElevenLabsRealtimeSession` manager (new file
`frontend/src-tauri/src/audio/transcription/elevenlabs_realtime.rs`):
- owns the two WS connections (tokio-tungstenite; reqwest is already tokio-based),
- exposes `feed(stream_id, samples)`, `commit(stream_id)`, `close()`,
- runs a receive loop per socket that maps server events to Tauri events.
The pipeline gets a third flush profile in spirit: when the realtime engine is
active, the transcription-buffer accumulation path is BYPASSED for that stream
(no MIN_TRANSCRIPTION_SAMPLES, no overlap prepend — the server owns context).
Recording-path audio (recording_saver) is untouched.

### D4. Frontend: committed segments + one volatile tail per source
TranscriptContext today is append-only keyed by `sequence_id`
(processBufferedTranscripts drops duplicate ids; nothing replaces in place).
Plan, matching research idea 2:
- New event `transcript-partial` `{ source, text, session_seq }`: replaces the
  volatile tail for that source (state: `pendingBySource: Record<source, string>`),
  rendered muted/italic below the committed list. RAF-batched like the AI panel
  (partials can arrive many times per second).
- Existing `transcript-update` stays THE commit event, emitted only on
  `committed_transcript_with_timestamps`, so every downstream consumer —
  recording_commands persistence, IndexedDB save, live-transcript.md for @code,
  slash-command capture, canvas transcript sharing, ClaudeContext basket — keeps
  working unchanged and never sees volatile text. On commit, the matching pending
  tail is cleared.
- `is_partial` already exists in the TranscriptUpdate payload (always false today);
  it stays false on `transcript-update`. Partials live only in the new event.

### D5. Failure handling: reconnect, then degrade to the batch path
- WS drop mid-meeting: buffer the affected stream's VAD segments locally (the
  existing transcription-buffer code path — it is exactly a batch accumulator),
  reconnect with backoff (1s/3s/8s, capped ~30s). On reconnect, drain the buffer
  through the batch HTTP provider (existing, already has retry + overlap trim) as
  catch-up so no words are lost, then resume streaming. This reuses iteration-1/2
  machinery as the degraded mode instead of inventing a second recovery path.
- Sustained failure (N reconnects or `quota_exceeded`): flip the session to batch
  mode for the rest of the recording + emit the existing `transcription-warning`
  event once ("live mode degraded, transcript continues with higher delay").
- App-side kill switch: settings model stays `scribe_v2` = batch; realtime is opt-in
  (D6), so rollback = flip the setting.

### D6. Settings and rollout
- New model option under the elevenLabs provider: `scribe_v2_realtime`
  (transcript_settings.model), surfaced in the existing transcription settings UI
  as "Scribe v2 Realtime (live)" with a short description. Default remains batch
  until the runtime pass proves it.
- `FlushProfile::for_provider` and engine selection key off provider+model; batch
  constants untouched.
- `keyterms`: seed from the existing domain-correction wordlist (parakeet_engine's
  alias/domain terms) at session start; ties into the queued "user-editable custom
  vocabulary" To-do item later.

## Phases

### Phase 0 — API spike + cost check (Python, no app changes) — S
1. Standalone `audio_testing/spike_scribe_realtime.py`: connect with the stored
   key, stream clip_11 at real-time pace (and at 4x to test server pacing
   tolerance), capture all events with timestamps.
2. Verify/decide: exact WS URL + auth handshake; message schema vs research notes;
   whether idle sockets need keepalive; whether `commit` mid-stream resets context;
   partial cadence; committed word-timestamp shape; behavior on 16kHz PCM from our
   worker format; two concurrent sessions on one key.
3. **Billing**: confirm realtime per-minute pricing vs batch (docs didn't list it).
   Estimate monthly cost for the user's real call volume (recordings dir gives
   hours/week) under D2 gating vs raw streaming. GATE: if realtime pricing is
   punitive, stop and revisit idea 3/6 from the research report instead.
4. Deliverable: `research/scribe-realtime-spike-notes.md` with the confirmed
   contract + cost table. Everything downstream depends on this.

### Phase 1 — Frontend partial rendering layer — S/M (independent of Phase 0)
1. `transcript-partial` listener + `pendingBySource` in TranscriptContext, RAF-
   batched; volatile tail UI in the transcript view (muted, no timestamp chip),
   auto-cleared on the next committed segment from that source; respects
   virtualization (tail rendered outside the virtualized list).
2. No Rust emitter yet — testable via a dev-only Tauri mock/Playwright (emit fake
   partial sequences; assert replace-in-place, commit clears tail, IndexedDB gets
   committed only).
3. Ship independently: harmless with batch (event never fires), and it is the
   prerequisite for any streaming source (also useful for a future local streaming
   engine).

### Phase 2 — Rust realtime session engine — M
1. `elevenlabs_realtime.rs`: session manager per D3 (connect, feed, commit, close,
   receive loop, reconnect ladder), `tokio-tungstenite` + base64 frames.
2. Pipeline tap per D2: in `process_stream_vad`, when realtime is active, forward
   open-segment audio in ~250ms frames (+300ms pre-roll on segment open, from a
   new small pre-VAD ring) instead of accumulating; send `commit` on VAD segment
   end; keep the batch accumulator DORMANT but code-live for the degraded mode.
3. Event mapping: `partial_transcript` -> `transcript-partial`;
   `committed_transcript_with_timestamps` -> existing `transcript-update` with
   real word-span `audio_start_time`/`audio_end_time`/`duration` and a fresh
   `sequence_id` (worker's monotonic counter reused).
4. Engine selection: provider `elevenLabs` + model `scribe_v2_realtime` ->
   RealtimeStream engine; anything else -> current paths. Settings UI option.
5. Gates: `cargo check`, unit tests for frame slicing/pre-roll/commit edges and
   reconnect state machine (transport mocked at the message level), `tsc`.

### Phase 3 — Harness measurement (keep-or-kill evidence) — M
1. Python realtime replica: stream clips 11-16 over the WS at real-time pace with
   the SAME gating as the Rust tap (reuse the harness silero + pre-roll), collect
   committed transcript + latency metrics per word (spoken-time vs partial-time vs
   commit-time, from clip timestamps).
2. Score vs the existing ground truth: committed WER vs batch path's 6.3%;
   time-to-first-partial (target <1s median); commit latency (target: median <3s,
   p95 <8s — vs 7.7s/35.4s today).
3. Tune: manual-commit vs server-vad vs hybrid; pre-roll length; keyterms on/off
   (measure on domain-term clips); frame size 100/250/500ms.
4. Adversarial QA pass on the replica fidelity + numbers (same pattern as
   iterations 1-2). GATE: committed WER within +0.5pp of batch AND latency targets
   hit, else stop and keep batch as default.
5. Note: real-time pacing makes each grid config cost wall-clock time (6 clips ×
   60s = 6 min per config) + realtime API minutes — budget the grid (~8-10 configs)
   before running.

### Phase 4 — Runtime pass + hardening — S/M (needs the machine + a mic)
1. Live meeting dry-run: mic + system stream, watch partial tail behavior,
   attribution, commit cadence; kill the network mid-call and verify catch-up via
   batch (no lost words vs the saved recording), verify `transcription-warning`
   fires once.
2. Verify recording save, meeting-details view, summary generation, live-transcript.md
   and @code handoff all see only committed text.
3. Decide default-on vs opt-in; update wer_gate baseline if realtime becomes the
   shipped default; To-do.md + memory updates.

## Risks / open questions
- **Pricing unknown** (Phase 0 gate). Realtime may bill per connection-minute, not
  per audio-minute — D2's gating saves nothing in that case; decision point.
- **Server VAD vs our VAD fight**: double-gating can clip onsets (we gate, then the
  server's VAD gates again inside our padded segments). Phase 3 measures deletions
  specifically at segment starts; fallback is manual commit strategy only.
- **Ordering across two sockets**: mic and system commits interleave by arrival,
  not by audio time; today's batch path has the same property, but partials make it
  visible. If it reads badly, sort committed segments by `audio_start_time` at
  render (data is in the payload already).
- **Backpressure**: if the socket send buffer backs up (slow network), frames must
  drop-oldest with a warn (recording file is the source of truth; transcript
  degrades gracefully) — never block the audio pipeline thread.
- **Session limits**: unknown max session duration (batch meetings run to 2.5h in
  the recordings dir); Phase 0 tests a long-lived session; reconnect ladder must
  rotate sessions seamlessly if the server caps duration.
- **Privacy**: same data leaves the machine as today (batch already sends audio to
  ElevenLabs), but continuously; zero-retention is enterprise-only — note in the
  privacy settings copy either way.
- **Harness ground-truth circularity** (accepted since the baseline): reference and
  hypothesis share a vendor; WER deltas remain valid for pipeline comparisons.

## Effort and sequencing
Phase 0 (S) and Phase 1 (S/M) can run in parallel; Phase 2 (M) after Phase 0;
Phase 3 (M) after 2; Phase 4 needs the user at the machine. Realistic shape:
one loop session for Phases 0-1, one for 2, one for 3 + QA, then a short manual
runtime pass. Rollback at every stage = settings stays `scribe_v2` batch.
