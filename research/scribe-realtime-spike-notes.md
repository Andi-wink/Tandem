# Scribe v2 Realtime WS — Phase 0 spike notes

_Spike run 2026-07-23 (Opus). Empirical, TESTED against the live ElevenLabs API with
the stored account key. Streamed ~7.5 min of audio total (clips 11 + 12, 16kHz mono
PCM). Scripts: [spike_scribe_realtime.py](../audio_testing/spike_scribe_realtime.py),
[analyze_spike.py](../audio_testing/analyze_spike.py). Raw event logs (git-ignored,
contain client transcript text): `audio_testing/spike_out/events_*.jsonl`._

## Verdict: **GO** (with two caveats Phase 2 must handle)

Realtime pricing is **$0.39/audio-hour** (1.77x batch), not punitive. Commit latency
after speech ends is **~0.44s** vs the 7.7s batch block-wait floor. Committed WER at
real-time pace is **4.24%**, better than the 6.3% batch baseline (same clip). The
Phase 0 gate ("if realtime pricing is punitive, stop") is cleared. Proceed to Phase 2.

Caveats: (C1) idle sockets are closed by the server ~15-16s after the last audio
frame, and WS protocol pings do NOT prevent it, so D2's "send nothing during silence"
is unsafe as written; (C2) pure server-VAD commit strategy can leave the trailing
segment uncommitted.

---

## 1. Confirmed contract (TESTED, not assumed)

**Endpoint** (confirmed working): `wss://api.elevenlabs.io/v1/speech-to-text/realtime`
Regional variants exist (`wss://api.us.elevenlabs.io/...`, `.eu.residency`, `.in.residency`,
`.sg.residency` — path unchanged; not exercised).

**Auth** (confirmed): `xi-api-key` header on the WS handshake. Works with the existing
stored key. (Query-param single-use `token` also documented; not tested.) NOTE: the
same key returns **401 on `GET /v1/user/subscription`** — it is STT-scoped and lacks
`user_read`, so the usage-endpoint credit-delta measurement was not possible (see §5).

**Config = query params** (all echoed back in `session_started.config`, confirmed):
`model_id=scribe_v2_realtime`, `audio_format=pcm_16000` (also pcm_8000/22050/24000/44100/48000,
ulaw_8000), `commit_strategy=manual|vad`, `vad_threshold` (default 0.4),
`vad_silence_threshold_secs` (default 1.5), `min_speech_duration_ms` (100),
`min_silence_duration_ms` (100), `include_timestamps`, `include_language_detection`,
`language_code`, `secondary_languages[]`, `keyterms[]`, `no_verbatim`,
`filter_background_audio`, `enable_logging`. Server also reports `max_tokens_to_recompute: 5`,
`timestamps_granularity: word`.

**Client -> server** (confirmed working):
```json
{"message_type":"input_audio_chunk","audio_base_64":"<b64 PCM16>","sample_rate":16000,"commit":false}
```
Optional `previous_text` on the first chunk (context seed). A `commit:true` frame (with
empty or non-empty `audio_base_64`) forces a commit. 16kHz PCM from our worker format
is accepted directly.

**Server -> client** (all observed):
- `session_started` — `{session_id, config:{...}}`
- `partial_transcript` — `{text}` (revisable running tail; text grows/rewrites)
- `committed_transcript` — `{text}` (finalized segment, plain)
- `committed_transcript_with_timestamps` — `{text, language_code, words:[...]}` — **this is
  the event Phase 2/D3 persists.** Word shape (real example, ids none):
  ```json
  {"text":"Okay.","start":0.059,"end":0.34,"type":"word","speaker_id":null,
   "logprob":-1.004,"characters":[{"text":"O","start":0.059,"end":0.119}, ...],
   "channel_index":null}
  ```
  `type` is `word` | `spacing`. `start`/`end` are audio-relative seconds -> maps directly
  to D3's `audio_start_time`/`audio_end_time`/`duration`. `speaker_id`/`channel_index`
  are null on a single mono stream (fine — attribution stays per-socket per D1).
- Documented error types (not triggered): `auth_error`, `quota_exceeded`, `rate_limited`,
  `commit_throttled`, `queue_overflow`, `resource_exhausted`, `session_time_limit_exceeded`,
  `input_error`, `chunk_size_exceeded`, `insufficient_audio_activity`, `unaccepted_terms`,
  `transcriber_error`.

Handshake sequence observed: connect -> `session_started` (~0.2s) -> `partial_transcript`
stream -> on commit, both `committed_transcript` then `committed_transcript_with_timestamps`.

## 2. Latency measurements (250ms frames, clip_11 = 60.1s)

| Scenario | Pace | time-to-first-partial | partial cadence | commit latency after audio-end | WER |
|---|---|---|---|---|---|
| (a) real-time, manual commit | 250ms/frame | 2.11s | ~1.0 ev/s | **0.44s** | **4.24%** |
| (b) server VAD commit | 250ms/frame | 2.11s | ~1.0 ev/s | auto (mid-stream) | 14.55%* |
| (c) 4x faster than real-time | 0ms | 0.30s | ~13.5 ev/s | 4.58s | 4.24% |
| (f) mid-stream commit ~/20s | 250ms/frame | 2.20s | ~1.0 ev/s | -0.12s | 4.85% |
| (e_s1/e_s2) concurrent | 250ms/frame | 2.1-2.2s | ~1.0 ev/s | — | 4.24% / (s2 ok) |

First partial needs ~2s of buffered audio (model warmup); thereafter partials refresh
~1/s. Commit latency after the final audio frame is **sub-second** — the structural win
over the batch path (7.7s median / 35.4s p95 block wait). Note: 2.1s time-to-first-partial
exceeds the plan's `<1s median` first-partial target; the meaningful live-feel metric
(ongoing cadence + commit latency) is well inside targets.

*(b) 14.55% is inflated by the uncommitted trailing segment (148 vs 165 words, 19
deletions clustered at the end) because scenario (b) sent no final `commit`. Server VAD
*did* auto-fire 3 commits mid-stream without any client commit — the strategy works, but
needs an explicit final flush. See D-dev-2.

## 3. Scenario findings (a-f)

- **(a) real-time + manual commit** — clean. 4.24% WER, 0.44s commit latency. Primary path.
- **(b) server VAD** — auto-commits fire (3x, no client commit sent). Viable but the last
  segment stays uncommitted without a final `commit`; also risks the "server-VAD fights our
  VAD" clipping the plan flags. Recommend manual (or hybrid: our VAD-end -> explicit commit).
- **(c) 4x faster than real-time** — **tolerated fully.** Identical committed text/WER as (a),
  0.30s to first partial, 13.5 partials/s, no rate_limited/queue_overflow. Phase 3 grid can
  run faster-than-realtime to cut wall-clock cost (subject to the audio-minute billing, §5).
- **(d) idle/gap test** — **socket does NOT survive idle.** Server closes with code 1000
  ~15.7s after the last audio frame (clean passive measurement). WS protocol pings
  (ping_interval=15s) did **not** keep it alive — the timeout is on *audio* inactivity, not
  socket liveness. **Direct hit on D2** (see D-dev-1).
- **(e) two concurrent sessions, one key** — **allowed.** Both sockets ran to completion
  with full partials + commits, no `rate_limited`/`resource_exhausted`. D1's two-sockets-per-
  recording (mic+system) is safe on a single key.
- **(f) mid-stream explicit commit ~every 20s** — **no context reset penalty.** 4.85% WER
  (vs 4.24% single-commit), full 165 words, quality intact across commit boundaries. Committing
  frequently to lock the tail is safe.

## 4. Pricing conclusion

From the ElevenLabs API pricing page (fetched 2026-07-23):

| | Scribe v2 (batch) | Scribe v2 Realtime |
|---|---|---|
| Rate | **$0.22 / audio-hour** | **$0.39 / audio-hour** (~150ms latency) |
| Entity detection | +$0.070/hr | +$0.070/hr |
| Keyterm prompting | +$0.050/hr | +$0.050/hr |
| Pro tier ($99/mo) incl. | 100 hrs | 56 hrs |
| Scale tier ($299/mo) incl. | 450 hrs | 254 hrs |

Realtime is **per audio-hour** (the tier tables list included *hours*, not connection-minutes),
so **D2's VAD-gating genuinely reduces cost** — you pay for streamed audio-seconds, not
wall-clock connection time. Realtime = **1.77x batch**. Keyterms (D6) add $0.05/hr.

Cost sanity (D2 gating, ~50% speech fraction typical for calls): a 1h call streams ~30
speech-min -> ~$0.195 realtime vs a full-hour batch ~$0.22. Even *ungated* continuous
streaming is $0.39/h. **Not punitive — GATE CLEARED.**

Caveat on evidence: the intended before/after credit measurement via `GET /v1/user/subscription`
failed (401 — key is STT-scoped). Pricing here is from the *published* per-hour rates, which
are explicit and authoritative, not inferred. If a usage-delta confirmation is wanted, use a
key with `user_read` scope.

## 5. Deviations from plan assumptions (Phase 2 must adapt)

- **D-dev-1 (D2 — idle keepalive REQUIRED).** The plan says "During silence, send nothing (or
  sparse keepalive frames if the API requires liveness; Phase 0 answers this)." **Answer: the
  API requires liveness, and it must be AUDIO.** Server closes ~15-16s after the last audio
  frame; WS pings do not help. Phase 2 must, during VAD gaps longer than ~10s, either (a)
  forward silence PCM keepalive frames (cheap: silence still bills as audio-seconds, but a few
  frames/15s is negligible), or (b) accept the close and lazily reconnect on the next speech
  onset (the reconnect ladder in D5 already exists). Option (b) is likely cheaper and simpler;
  a fresh session per speech burst is fine given `previous_text` seeding for context.
- **D-dev-2 (D2/server-VAD — needs a final flush).** Server `vad` commit strategy auto-commits
  but leaves the trailing segment uncommitted at stream end. Keep the plan's belt-and-braces
  explicit `commit` on our VAD-segment-end (and on session close), don't rely on server VAD
  alone. Manual strategy gave the best WER anyway.
- **D-dev-3 (contract naming).** Field is `audio_base_64` (not `audio` / `data`), message key
  is `message_type`, and the commit event Phase 2 keys off is `committed_transcript_with_timestamps`
  (there is ALSO a plain `committed_transcript` — ignore it to avoid double-emit, as the spike
  collector had to). Word timings are already in the payload (`words[].start/.end`), so D3's
  timestamp mapping needs no extra call.
- **D-dev-4 (auth scope).** The stored key works for STT-WS but is scoped without `user_read`
  (401 on subscription). No impact on the transcription path; note it if any usage/quota UI is
  added later.
- **No contradiction found** for: 16kHz PCM accepted (D2/D3 worker format ✓), concurrent
  mic+system sockets on one key (D1 ✓), keyterms/timestamps/language-detection config present
  (D6 ✓), commit does not reset context (D-open-question resolved: safe, f=4.85%).

## Open items for Phase 3
- Measure D-dev-1 option (a) silence-keepalive vs (b) reconnect-on-onset for cost + word loss.
- Measure server-VAD-vs-our-VAD onset clipping (plan risk) on domain-term clips with keyterms on.
- First-partial ~2s: confirm acceptable for the live tail UX, or seed with `previous_text`.
