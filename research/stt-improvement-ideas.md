# STT Improvement Ideas for Tandem's Live Transcription Pipeline

_Research date: 2026-07-11. Web-only survey of open-source streaming ASR systems and commercial realtime STT APIs, mapped onto Tandem's current pipeline._

## Our current situation (baseline)

- **Live provider**: ElevenLabs Scribe v2 via **HTTP POST per accumulated chunk** (`frontend/src-tauri/src/audio/transcription/elevenlabs_provider.rs`). Request/response, not streaming.
- **Buffering**: 48 kHz mic+system mix, Silero VAD gating, chunks accumulate to a **12 s minimum buffer** (`MIN_TRANSCRIPTION_SAMPLES = 192000` at 16 kHz) and flush on **1.2 s silence gaps**.
- **Symptoms**: (1) words dropped near VAD boundaries / quiet speech, (2) high latency and large text blocks appearing at once, (3) German much worse than English on local Parakeet.

The single biggest structural problem is that we treat a streaming problem as a batch problem: we wait ~12 s, cut hard at a VAD gap, POST the whole block, and render it in one shot. Every symptom above traces back to that. The industry has two well-trodden fixes: **(A)** move to a true streaming transport with **partial + committed** results, and **(B)** if we stay batch, use **overlap + context + agreement** so boundaries stop dropping words.

---

## Ranked shortlist of adoptable ideas

### 1. Switch ElevenLabs to its Realtime WebSocket STT (Scribe v2 Realtime) - **HIGHEST LEVERAGE**
**Effort: M** · Fixes: latency AND dropped words

**What:** ElevenLabs *does* offer a realtime, WebSocket-based STT (this was worth verifying: yes, it exists, see section at bottom). We can keep our existing provider but change the transport from "POST a 12 s blob" to "stream audio frames, receive `partial_transcript` events continuously and `committed_transcript` events at endpoints." Latency claim is ~150 ms to first partial vs. our ~12 s.

**Evidence/sources:**
- [Scribe v2 Realtime product page](https://elevenlabs.io/realtime-speech-to-text) - "under 100-150 ms latency", partial + committed transcripts.
- [Realtime WebSocket API reference](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime) - message types `session_started`, `partial_transcript`, `committed_transcript`, `committed_transcript_with_timestamps`; client sends `input_audio_chunk` (base64 PCM + sample rate + optional `commit` flag); server-side VAD auto-commit (default 1.5 s silence, VAD threshold 0.4); `keyterms` biasing; `no_verbatim`; zero-retention mode.
- [Client-side streaming guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/client-side-streaming).

**Expected effect:** Text appears within a few hundred ms as revisable partials, then locks in as committed. This alone eliminates the "big block, high latency" symptom and largely eliminates boundary deletions, because ElevenLabs owns the endpointing and keeps encoder context across our VAD gaps instead of us hard-cutting the audio.

**Implementation sketch (our Rust pipeline):**
- Add `wss` client (`tokio-tungstenite`) in a new `elevenlabs_realtime_provider.rs`. Open one socket per recording session.
- Feed the *pre-VAD* mixed 16 kHz PCM stream (or lightly VAD-gated) as small `input_audio_chunk` frames (e.g. 100-250 ms), base64-encoded. Do NOT wait for `MIN_TRANSCRIPTION_SAMPLES`.
- Use `commit_strategy: "vad"` with tuned silence threshold, OR keep our Silero VAD and send explicit `commit` flags at our endpoints.
- Emit two Tauri event kinds: `transcript-partial` (replace-in-place, greyed) and `transcript-final` (committed). Frontend renders partials as a live "tail" that gets replaced, matching how every streaming transcriber shows text.
- Set `keyterms` from our existing domain vocabulary (ties into the phrase-level domain correction already in the codebase).

**Risks:** cost model differs (per-minute streaming), network dependency, needs a reconnect/backpressure strategy. But it reuses our existing vendor and the frontend already has SSE-style incremental rendering patterns.

---

### 2. Add a partial/interim rendering layer in the frontend (decouple "shown" from "committed")
**Effort: S-M** · Fixes: perceived latency, large blocks

**What:** Regardless of provider, split the UI into a **stable committed transcript** plus a **volatile tail** that updates in place. This is the universal pattern in RealtimeSTT, WhisperLive, sherpa-onnx, Deepgram, and ElevenLabs.

**Evidence:** [RealtimeSTT](https://github.com/KoljaB/RealtimeSTT) exposes `on_realtime_transcription_update` (volatile) vs `on_realtime_transcription_stabilized` vs final; it even runs a *smaller* model (`realtime_model_type="tiny.en"`) for the fast volatile stream and a bigger one for the final. [whisper_streaming](https://github.com/ufal/whisper_streaming) confirms text via LocalAgreement-2 before it "commits".

**Expected effect:** Even before any backend change, showing revisable partial text makes the app *feel* real-time and stops the "wall of text" effect. Prerequisite for ideas 1, 3, 6.

**Implementation sketch:** New `TranscriptContext` state: `committedSegments[]` + `pendingText`. Rust emits `transcript-partial`. Render pending text muted/italic; on final, append to committed and clear pending.

---

### 3. If we keep the HTTP provider: LocalAgreement-2 over a sliding window (kill boundary deletions)
**Effort: M** · Fixes: dropped words, latency

**What:** The UFAL whisper_streaming policy. Instead of waiting 12 s and cutting at a VAD gap, run shorter overlapping requests (e.g. every 1-2 s of new audio over a growing buffer) and **only commit the longest common prefix that is stable across two consecutive responses.** Trim the confirmed prefix out of the buffer; keep the unconfirmed tail plus context.

**Evidence/sources:**
- [whisper_streaming README](https://github.com/ufal/whisper_streaming/blob/main/README.md) and [paper (arXiv 2307.14743)](https://arxiv.org/html/2307.14743v2) - LocalAgreement-n: "if n consecutive updates agree on a prefix, it is confirmed." 3.3 s avg latency on long-form speech; `--min-chunk-size` ~1 s; buffer trimmed at segment/sentence boundaries; **confirmed prefixes are re-fed as Whisper init prompt** for cross-window context.

**Expected effect:** Directly attacks deletions: words near a boundary are never lost because the window overlaps and nothing is committed until two passes agree. Cuts latency from ~12 s toward ~2-3 s. Downside: more inference calls (more ElevenLabs requests / more local GPU passes).

**Implementation sketch:** In the pipeline, replace "flush whole 12 s block" with a rolling buffer + a `committed_prefix` tracker. After each POST, diff new hypothesis against previous; commit the common prefix; keep remainder. On ElevenLabs, cost roughly multiplies by overlap factor, so this is more attractive for the *local* engines (Parakeet/whisper.cpp) where compute is free on the 3090.

---

### 4. VAD pre-roll / post-roll padding around every segment
**Effort: S** · Fixes: dropped words (quiet onsets/offsets)

**What:** Silero VAD trims exactly at the speech/non-speech boundary, which clips soft word onsets and trailing consonants, which is a classic deletion source. Every mature pipeline pads: include ~200-300 ms of audio *before* VAD-detected speech start and *after* speech end before sending to the recognizer.

**Evidence:** faster-whisper / RealtimeSTT wrap Silero VAD with `speech_pad_ms` (default 400 ms in faster-whisper's VAD params) precisely for this; [faster-whisper](https://github.com/SYSTRAN/faster-whisper) and [RealtimeSTT docs](https://github.com/KoljaB/RealtimeSTT/blob/master/docs/engines/faster-whisper.md). ElevenLabs realtime exposes `min_speech_duration` / silence thresholds for the same reason.

**Expected effect:** Cheap, high-value reduction in boundary deletions. No architecture change.

**Implementation sketch:** In `pipeline.rs`, keep a small ring buffer of pre-VAD audio; when VAD opens, prepend the last N ms; when VAD closes, wait N ms of extra samples before finalizing the segment. This is a handful of lines around the existing VAD gate.

---

### 5. Two-pass: fast local partials + accurate final re-transcription of the whole utterance
**Effort: M-L** · Fixes: latency and quality together

**What:** Show partials fast from a cheap model, then re-transcribe the *complete* utterance once with a stronger model/context for the committed text. RealtimeSTT does exactly this (small realtime model + large final model). This also naturally fixes deletions because the final pass sees the whole utterance, not fragments.

**Evidence:** [RealtimeSTT](https://github.com/KoljaB/RealtimeSTT) two-model design; [whisperX](https://github.com/m-bain/whisperX) for word-timestamp final alignment.

**Expected effect:** Best-of-both: instant feedback + high-quality final transcript that matches what gets saved. Higher complexity (two engines, reconciliation).

**Implementation sketch:** Local Parakeet int8 (already installed) for the volatile stream at 1 s cadence; on utterance end, one clean pass over the full padded utterance (ElevenLabs or whisper.cpp medium/large on the 3090) produces the committed segment that replaces the accumulated partials.

---

### 6. Evaluate a true local streaming engine (cache-aware) as the live path - sherpa-onnx Kroko (DE) or NeMo streaming Parakeet
**Effort: L** · Fixes: latency, dropped words, offline privacy; partially German

**What:** Replace the batch local engine with a **cache-aware streaming transducer** that consumes audio continuously and emits tokens with tens-of-ms latency, reusing encoder cache instead of re-running windows. Two strong candidates:

- **sherpa-onnx streaming Zipformer + Kroko models** - importantly, [Kroko-ASR](https://huggingface.co/Banafo/Kroko-ASR) ships **streaming English, French AND German** Zipformer2-transducer models that run on CPU/WASM/WebSocket via the sherpa-onnx engine. This is the most direct fix for our German weakness in a streaming context. sherpa-onnx also gives us built-in **endpoint rules**: [rule1 min trailing silence (default 80 ms/2.4 s), rule2 (default 1.2 s), rule3 max utterance length (default 20 s)](https://k2-fsa.github.io/sherpa/ncnn/endpoint.html) - a principled replacement for our single hard-coded 1.2 s gap. Reported ~40 ms latency, RTF ~0.02.
- **NVIDIA NeMo cache-aware streaming Parakeet / FastConformer** - [Scaling Real-Time Voice Agents with Cache-Aware Streaming ASR](https://huggingface.co/blog/nvidia/nemotron-speech-asr-scaling-voice-agents), configurable chunk sizes 80/160/560/1120 ms, ~3x more efficient than buffered streaming. Caveat: the strong streaming Parakeet variants ([nemotron-speech-streaming-en](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b), [parakeet_realtime_eou_120m](https://huggingface.co/nvidia/parakeet_realtime_eou_120m-v1)) are **English-only**, so they help latency but not our German problem.

**Evidence/sources:** links inline above; [sherpa-onnx streaming zipformer models](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html).

**Expected effect:** Fully local, sub-second streaming with proper endpointing and a real German streaming model (Kroko). Biggest effort: new ONNX runtime path, model management, and integrating sherpa-onnx endpoint rules into `pipeline.rs`. Best treated as a spike: benchmark Kroko-DE and NeMo-EN on the 3090 for WER + latency before committing.

---

### 7. Replace the single hard 1.2 s flush with sherpa-onnx-style multi-rule endpointing
**Effort: S** · Fixes: latency (short utterances), block size

**What:** Even without changing engines, adopt the **rule1/rule2/rule3** logic: finalize a segment when (rule1) a short trailing silence follows non-trivial speech, OR (rule2) a longer trailing silence regardless, OR (rule3) the utterance exceeds a max length. Today we effectively only have rule2 (1.2 s) plus a 12 s max, which is why short answers still wait for the full gap and long monologues become huge blocks.

**Evidence:** [sherpa-onnx endpointing docs](https://k2-fsa.github.io/sherpa/ncnn/endpoint.html). Defaults: rule1 ~2.4 s trailing silence after speech, rule2 1.2 s, rule3 20 s utterance cap.

**Expected effect:** Short turns finalize faster; long turns get chopped into readable segments instead of one 12 s wall. Low risk, small change to the flush condition in `pipeline.rs`.

---

## ElevenLabs Realtime STT availability (verified)

**Confirmed: ElevenLabs offers a realtime, WebSocket-based STT, not just batch.** It is **Scribe v2 Realtime**, distinct from the batch Scribe v2 file endpoint we currently POST to.

- **Transport:** WebSocket at `wss://api.elevenlabs.io/` (regional endpoints: US/EU/India/Singapore). Auth via `xi-api-key` header or single-use `token` query param.
- **Client → server:** `input_audio_chunk` messages = base64 PCM + `sample_rate` + optional `commit` flag + optional first-chunk text context.
- **Server → client:** `session_started`, `partial_transcript` (revisable interim), `committed_transcript` (final), `committed_transcript_with_timestamps` (word-level timing + language detection), plus error events (`auth_error`, `quota_exceeded`, `rate_limited`, `input_error`).
- **Audio formats:** PCM at 8/16/22.05/24/44.1/48 kHz (default 16 kHz) and µ-law 8 kHz. Our 48 kHz mix downsampled to 16 kHz PCM is directly compatible.
- **Endpointing:** two commit strategies - `manual` (explicit `commit` flag) or `vad` (auto-commit; default 1.5 s silence, VAD threshold 0.4, configurable min speech/silence durations).
- **Extras:** `keyterms` biasing, `no_verbatim` (strip fillers), `include_timestamps`, `include_language_detection`, `filter_background_audio`, zero-retention (`enable_logging: false`, enterprise).
- **Latency claim:** ~100-150 ms to first partial; 93.5% accuracy across 30 languages on FLEURS (their marketing benchmark vs Gemini Flash 2.5 / GPT-4o Mini Transcribe / Deepgram Nova 3).
- **Sources:** [product page](https://elevenlabs.io/realtime-speech-to-text) · [API reference](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime) · [client-side streaming guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/client-side-streaming) · [server-side streaming guide](https://elevenlabs.io/docs/eleven-api/guides/cookbooks/speech-to-text/realtime/server-side-streaming).

**Implication:** Idea 1 is a transport swap within our existing vendor, not a new integration. It is the single highest-leverage change and should be prototyped first. Docs did not list realtime-specific per-minute pricing; verify billing before shipping.

---

## Quick-win vs. strategic summary

- **Do first (S, no vendor change):** Idea 4 (VAD pre/post-roll padding) + Idea 7 (multi-rule endpointing) + Idea 2 (partial rendering layer). These reduce deletions and block size with small, local changes.
- **Highest leverage (M):** Idea 1 (ElevenLabs Realtime WebSocket) - turns the whole thing streaming with partials.
- **Strategic / local-first (L):** Idea 6 spike - sherpa-onnx + **Kroko German streaming model** is the real answer to our German weakness, with proper endpoint rules baked in.
- **If staying local-batch:** Idea 3 (LocalAgreement-2 + overlap) and Idea 5 (two-pass) eliminate boundary deletions using the free GPU compute on the 3090.
