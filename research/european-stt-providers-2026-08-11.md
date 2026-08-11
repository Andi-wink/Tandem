# European STT providers: replacing ElevenLabs Scribe

**Date:** 2026-08-11
**Question:** find a European inference provider with very low error rate and, ideally, zero data retention, to replace ElevenLabs Scribe v2 as Tandem's transcription engine.
**Companion doc:** [gdpr-review-2026-08-10.md](gdpr-review-2026-08-10.md) (the criteria below come from its §3.4 / §3.7 findings)
**Baseline to beat:** [transcription memory](../CLAUDE.md) — Scribe v2 Realtime measured at **6.00% WER, 0.34s commit latency** on clips 11-16 through Tandem's own pipeline. Batch Scribe 5.9-6.3%. Price $0.39/audio-hr realtime, $0.22 batch.

---

## Headline

**No European provider currently beats Scribe v2 Realtime on streaming accuracy.** On the independent Artificial Analysis AA-WER Streaming leaderboard, Scribe v2 Realtime sits at **3.64% WER** (final after end of speech, 0.14s), near the top of the whole board. The best European streaming entry, Mistral's Voxtral Realtime, is **5.3%** final. Gladia's flagship accuracy model does not do streaming at all.

So this is not a free upgrade. The realistic framing is: **accept a modest accuracy cost in exchange for a large compliance gain**, and pick which kind of gain you want.

The strongest answer to the question as asked is not a hosted provider at all: **Voxtral Mini 4B Realtime is Apache 2.0 open weights and runs on the RTX 3090.** That is not "zero data retention by contract", it is zero data transmission. It removes the Art 28 processor contract, the Chapter V transfer question, and the § 201 StGB "makes it accessible to a third party" limb the GDPR review flagged as the residual criminal-law risk. It also happens to be the same model family Whispering already uses locally.

---

## Candidates

### 1. Mistral — Voxtral (Paris, France)

Two shipping models as of 2026-02-04:

| | Voxtral Mini Transcribe 2 | Voxtral Realtime (`voxtral-mini-transcribe-realtime-2602`) |
|---|---|---|
| Mode | batch, up to 3h/request | streaming WS `/v1/realtime` |
| Accuracy | ~4% WER FLEURS (top-10 lang avg) | FLEURS avg 8.72%, **EN 4.90%, DE 6.19%**; TEDLIUM 3.17%, Meanwhile 5.05%, E-21 10.23% (all at 480ms delay) |
| AA-WER Streaming | n/a | **5.3% final**, 9.6% first partial |
| Latency | n/a | `transcription_delay_ms`, any multiple of 80ms in [80,1200] plus 2400; **480ms recommended** |
| Diarization | yes | no (not compatible with realtime) |
| Timestamps | word-level | token = 80ms of audio |
| Languages | 13 | 13 (incl. DE, FR, ES, IT, NL) |
| Price (hosted) | $0.003/min = **$0.18/audio-hr** | $0.006/min = **$0.36/audio-hr** |
| Weights | Premier (hosted only) | **Apache 2.0, open weights** |

**Architectural note that matters more than the WER number.** Voxtral Realtime uses a causal audio encoder with a fixed transcription delay. There is **no manual commit concept**. Tandem's entire dual-bound commit-point estimator (the 34.5s stall edge, the 35.5s auto-commit trigger, the receipt re-anchoring, the predictive backstop, five rounds of adversarial QA) exists solely to work around Scribe's commit semantics. On Voxtral that machinery is dead code. The commit-cadence study also showed boundary insertions cost Tandem ~1.5pp of WER; a model with no commit boundaries does not pay that.

That means the honest comparison is not 6.00% vs 5.3%. It is "Tandem's Scribe pipeline at 6.00%" vs "Voxtral with no boundary-insertion penalty at all", and only the harness can settle it.

**Hosted-API caveats, from yesterday's review:** Mistral is EU-sited but **not transfer-clean** — their own materials allow temporary transfer outside the EU under Art 46 SCCs, a US endpoint is selectable, and trust.mistral.ai/subprocessors lists US/worldwide sub-processors. ZDR is **Scale-plan-only, stateless endpoints only**; without it, inputs *and outputs* are kept 30 rolling days for abuse monitoring. Audio *is* in scope for ZDR when you have it.

**Self-hosted:** `vllm serve mistralai/Voxtral-Mini-4B-Realtime-2602`, single GPU ≥16GB BF16. The 3090's 24GB clears it. OpenAI-Realtime-compatible WS, so the client shape is standard.

### 2. Gladia — Solaria (Paris, France)

French SAS, GDPR by default, EU data residency, SOC 2 Type 2, ISO 27001, no training on customer audio.

- **Solaria-3** is the accuracy story and it is a good one: **9.6% WER on real customer English audio (#1)**, beating ElevenLabs Scribe v2 at 9.9%, AssemblyAI 10.0%, Deepgram Nova-3 10.7%. Earnings22 6.4% (#1), Switchboard 33.9% (#1), Common Voice 24 multilingual 6.9%. Tuned specifically for EN/FR/DE/ES/IT. These are vendor-published on a vendor-chosen set, so treat the margin as directional, not decisive.
- **It is async/batch only.** Live transcription supports `solaria-1` only (~270ms partials, <103ms claimed). Solaria-1 is materially weaker and has no independent streaming benchmark score.
- Price: batch $0.61/hr Starter, down to $0.20/hr at Growth volume. Realtime $0.75/hr Starter, $0.25/hr Growth.
- **Zero data retention is Enterprise-only.** Paid plans get data opt-out and 1-day/1-week/1-month retention options.
- Live sessions capped at 3 hours. `POST /v2/live` returns a WS URL; `stop_recording` ends the session; partials via `messages_config.receive_partial_transcripts`.

**Where Gladia fits:** as the **post-call batch/summary engine**, not the live path. Tandem already runs a batch shadow-flush fallback; Solaria-3 is a credible upgrade there on European-language client calls specifically.

### 3. Speechmatics (Cambridge, UK)

Strong on accented English and code-switching, long track record. But:

- **UK, not EU.** Transfers rely on the UK adequacy decision rather than being intra-EU. That is a different mechanism than "no transfer at all", though a sturdier one than the DPF.
- EU cloud region available; multi-region for sovereignty constraints.
- **On-prem container (CPU or GPU, air-gappable)** is the genuinely interesting option — same category of answer as self-hosted Voxtral.
- Melia-1 batch from $0.129/hr; realtime from ~$0.0067/min (~$0.40/hr). Sub-1s realtime latency.
- Ursa 2: 18% WER reduction over Ursa 1 across 55 languages; code-switching 35% better than nearest competitor.
- Appears on the AA streaming board as "Realtime Enhanced" but I could not extract its number; do not assume it is competitive with Scribe without measuring.

### 4. EU sovereign clouds as the hosting layer

If self-hosting on the 3090 is not acceptable for uptime reasons but a US processor is not acceptable either, **Scaleway Generative APIs** (SEAL-3, the highest sovereignty tier in the EU Cloud Sovereignty Framework) and **OVHcloud AI Endpoints** both offer OpenAI-compatible inference with EU hosting, zero data retention and no training on prompts. Serving Voxtral on a Scaleway GPU under vLLM is a documented pattern. This gets EU-only processing with a French contract and no US sub-processor chain, at the cost of running the box.

### 5. Ruled out

- **AssemblyAI** — offers EU residency via `api.eu.assemblyai.com` and zero-retention modes, and Universal-3 Pro is accurate (5.6% mean AA-WER v2.0). But it is a US company; same Chapter V structure as ElevenLabs, so it does not answer the question.
- **Deepgram, Soniox, Cartesia, OpenAI, Google** — US.
- **Fun-Realtime-ASR** (1.8% AA-WER, current leader) — Alibaba. Worse on every axis you care about here.

---

## Recommendation

**Two-track, and measure before committing.**

1. **Live path → self-hosted Voxtral Mini 4B Realtime on the 3090.** Apache 2.0, ≥16GB VRAM, `vllm serve`, `/v1/realtime` WS at 480ms delay. Zero transmission beats zero retention. It deletes the commit-estimator complexity rather than porting it. It also makes the in-app privacy copy ("processed entirely on your device") true again, which the GDPR review flagged as currently inaccurate.
   - Fallback if local proves unreliable: **Mistral hosted Voxtral Realtime**, $0.36/hr, EU-sited but requires Scale plan for ZDR and is not transfer-clean.
2. **Batch / post-call path → Gladia Solaria-3**, $0.20-0.61/hr, French, EU-resident, tuned for exactly the EN/FR/DE/ES/IT client-call mix. ZDR needs Enterprise; without it, set 1-day retention.

**Do not switch on vendor numbers.** Every WER above is on a different dataset. Tandem has the harness to settle this on real client audio.

## Next step: harness runs

The existing scripts make this cheap. New scripts, mirroring [run_scribe_realtime_wer.py](../audio_testing/run_scribe_realtime_wer.py):

- `run_voxtral_realtime_wer.py` — self-hosted vLLM at 480ms, clips 11-16, same VAD/buffer/scoring path. Sweep `transcription_delay_ms` ∈ {240, 480, 960} as the accuracy/latency knob.
- `run_gladia_batch_wer.py` — Solaria-3 async against the same clips, compared to the 5.9-6.3% batch Scribe figure.
- Include German clip_07, which is the known weak spot (~65% on Parakeet). Voxtral's FLEURS German 6.19% is the reason to expect a real win there.

Gate: [wer_gate.py](../audio_testing/wer_gate.py) against [wer_baseline.json](../audio_testing/wer_baseline.json).

---

## Sources

- [Artificial Analysis — Speech to Text Streaming leaderboard](https://artificialanalysis.ai/speech-to-text/streaming) and [AA-WER Streaming methodology](https://artificialanalysis.ai/articles/new-streaming-speech-to-text-benchmark-aa-wer-streaming)
- [Voxtral Mini 4B Realtime on Hugging Face](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602), [Mistral audio docs](https://docs.mistral.ai/capabilities/audio/), [Voxtral Realtime paper](https://arxiv.org/html/2602.11298v1)
- [Gladia Solaria-3](https://www.gladia.io/solaria-3), [Gladia pricing](https://www.gladia.io/pricing), [Gladia live STT docs](https://docs.gladia.io/chapters/live-stt/getting-started), [Gladia security](https://www.gladia.io/security)
- [Speechmatics pricing](https://www.speechmatics.com/pricing), [Speechmatics deployments](https://docs.speechmatics.com/deployments), [Melia announcement](https://www.speechmatics.com/company/articles-and-news/introducing-melia-multilingual-speech-to-text-model)
- [EU AI gateways compared (EdenAI / OVHcloud / Scaleway)](https://www.edenai.co/post/european-ai-gateways-comparing-edenai-ovhcloud-ai-endpoints-and-scaleway-generative-apis)
