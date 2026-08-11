# German ASR for Tandem: state of the art, August 2026

**Date:** 2026-08-11
**Question:** Tandem runs ElevenLabs Scribe v2 Realtime (6.00% WER on the developer's English clips). German client calls must work. Switch engine, self-host on the RTX 3090, or buy a different app?
**Companion docs:** [european-stt-providers-2026-08-11.md](european-stt-providers-2026-08-11.md), [stt-improvement-ideas.md](stt-improvement-ideas.md), [gdpr-review-2026-08-10.md](gdpr-review-2026-08-10.md)

---

## 0. Headline

Five findings, in order of how much they should change what you do.

1. **Do not pin `language=de`.** The one benchmark that measures German-English code-switching directly (DECM, LREC-COLING 2024) shows that forcing Whisper's German token raised WER on the embedded English words from **34.68% to 49.49%** while leaving the German words unchanged at 15.02%. The paper's conclusion is explicit: keeping decoding language-agnostic beats pre-determining the matrix language. If Tandem forces a language code on German calls, that is a measurable, free loss on exactly the English business jargon your users care about.
2. **Tandem's German problem is deletion-shaped, not mishearing-shaped.** Every engine tested in-house shows deletions dominating substitutions, the worst by 4.6x, and the single worst German incident is a call whose transcript simply stopped at 16:13 while the conversation continued. That is a pipeline defect. No engine swap fixes it.
3. **Every public German number is read speech, and the correction factor is brutal.** Same models, same paper: German read speech 4-6% WER, German spontaneous talks **31.98%**. Whisper large-v3 goes LibriSpeech 11% → conversational telephone **54%**. **Plan for 12-20% WER on real German meetings, not 4-5%.** Artificial Analysis, the only leaderboard with a streaming methodology, is **English-only** and tells you nothing about German.
4. **`whisper-large-v3-turbo` is the wrong Whisper for German.** On the Open ASR Leaderboard's German CoVoST-2 split it scores **8.64** against large-v3's **5.25**, a 65% relative regression, while looking fine on FLEURS (3.78 vs 3.27). Turbo's decoder distillation hurt German disproportionately on the harder set.
5. **The best fully-local German option is a 600M model that costs 2 GB.** `primeline/parakeet-primeline` (CC-BY-4.0, FastConformer-TDT) claims **2.95% average** across Tuda-De / MLS-de / CV19-de, beating every Whisper variant including the German fine-tunes. The English-only Parakeet currently in Tandem scores **65.49%** on your German clip. This is the largest cheap movement available.

---

## 1. Read this before the accuracy table

Six reasons the numbers below are less comparable than they look.

**1.1 Almost every German test set is read speech.** The Open ASR Leaderboard evaluates German on **FLEURS** (Wikipedia sentences read aloud) and **CoVoST-2** (built on Common Voice audio, read, crowdsourced prompts). Common Voice is read. MLS German is read audiobooks. Tuda-De is read prompts. SWC is read Wikipedia. **Only VoxPopuli German is non-read**, and it is prepared parliamentary oratory, not conversation ([arXiv 2510.06961v4](https://arxiv.org/html/2510.06961v4) Table 1).

**1.2 Casing is uniquely destructive in German, and nobody controls for it.** German capitalises every noun. NVIDIA's own German model goes from **3.87 → 11.10** on MLS German purely by scoring punctuation and capitalisation ([stt_de_fastconformer_hybrid_large_pc](https://huggingface.co/nvidia/stt_de_fastconformer_hybrid_large_pc)). A 2.9x inflation from a scoring choice. **Any German WER quoted without stating its casing policy is close to meaningless.**

**1.3 The leaderboard applies an English normalizer to German.** The Open ASR Leaderboard "removes punctuation and casing, and applies an English text normalization pipeline closely following that of Whisper", including English number words and an English spelling map ([arXiv 2510.06961v1](https://arxiv.org/html/2510.06961v1)). Whisper's own paper, by contrast, uses only the *basic* normalizer for non-English ([arXiv 2212.04356](https://ar5iv.labs.arxiv.org/html/2212.04356)). Those two families of German numbers are not comparable.

**1.4 German compounds inflate WER as a pure artefact.** "Softwareentwicklungsabteilung" vs "Software Entwicklungs Abteilung" is one segmentation disagreement scored as three token errors. No source in this survey states a compounding-aware policy. Cross-language comparison ("is German harder than English?") is unanswerable from these leaderboards.

**1.5 Roughly half of measured German-family WER can be convention, not error.** The most rigorous recent evaluation in the German family splits 25.60% measured WER into **content WER 13.8%** and **style WER 11.3%** (semantically correct output penalised for tense choice, word order, orthography): "nearly half of the measured 25.6% WER originates from semantically correct outputs penalized for stylistic differences" ([arXiv 2606.07608](https://arxiv.org/html/2606.07608v1)). The same paper demonstrates **benchmark contamination**: a vanilla Whisper self-trained on the test set alone reaches 13.88%, beating every published system, and three published SOTA claims are shown to be contaminated.

**1.6 Tandem's own ground truth is a competitor's output.** `audio_testing/wer_baseline.json` scores against **ElevenLabs Scribe transcripts as reference**. Any engine stylistically different from Scribe scores worse regardless of accuracy. Given 1.5, on German this could be several points of pure artefact. The human proofing pack in `audio_testing/proofing/` is the correct fix and is a prerequisite for any German engine decision.

**A demonstration of how bad the incomparability is:** Whisper large-v3 on FLEURS German is **3.27** per the Open ASR Leaderboard and **5.46** per Mistral's Voxtral paper. Same model, same dataset, **67% relative gap**, purely from harness and normalization differences. Never mix tables.

---

## 2. German accuracy table

Grouped by harness, because cross-harness comparison is invalid. Every number names its dataset.

### 2.1 Open ASR Leaderboard multilingual track — the only independent cross-vendor German comparison

Snapshot **2026-03-26**, from [multilingual.csv](https://raw.githubusercontent.com/huggingface/open_asr_leaderboard/main/scripts/data/multilingual.csv), cross-checked against [arXiv 2510.06961v4](https://arxiv.org/html/2510.06961v4) Table 4. German is scored on **`de_covost` + `de_fleurs` only** — there is no `de_mls` column. The "DE mean" is the arithmetic mean of the two. Independent (one harness, one normalizer), read speech, English normalizer applied to German.

| Model | Open weights? | **de CoVoST-2** | **de FLEURS** | **DE mean** | RTFx |
|---|---|---:|---:|---:|---:|
| Speechmatics Enhanced | no | **1.99** | 3.69 | 2.84 | – |
| **ElevenLabs Scribe v2** | no | 2.24 | **2.30** | **2.27** | – |
| AssemblyAI Universal-3 Pro | no | 2.37 | 2.32 | 2.34 | – |
| **Mistral Voxtral-Small-24B-2507** | yes | 3.43 | 2.59 | **3.01** | 42 |
| Cohere Transcribe 03-2026 | yes | 3.53 | 4.16 | 3.84 | 491 |
| Microsoft Phi-4-multimodal-instruct | yes | 4.14 | 3.77 | 3.96 | 78 |
| NVIDIA Canary-1B-v2 | yes | 4.73 | 3.47 | 4.10 | 634 |
| Qwen3-ASR-1.7B | yes | 4.92 | 3.33 | 4.12 | 113 |
| **NVIDIA Parakeet-TDT-0.6B-v3** | yes | 4.13 | 4.26 | **4.20** | **1719** |
| **OpenAI Whisper large-v3** | yes | 5.25 | 3.27 | 4.26 | 111 |
| Meta omniASR-LLM-7B-v2 | yes | 5.38 | 3.73 | 4.55 | 21 |
| Mistral Voxtral-Mini-3B-2507 | yes | 5.78 | 3.82 | 4.80 | 111 |
| **OpenAI Whisper large-v3-turbo** | yes | **8.64** | 3.78 | **6.21** | 176 |
| **Mistral Voxtral-Mini-4B-Realtime-2602** | yes | 8.08 | 5.04 | **6.56** | 28 |
| Qwen3-ASR-0.6B | yes | 8.43 | 5.49 | 6.96 | 122 |

*(smaller omniASR variants omitted; full CSV linked above)*

Three things that matter more than the ranking:

- **The two German sets rank models differently.** Speechmatics wins CoVoST-2 (1.99) but is mid-pack on FLEURS (3.69); Scribe v2 wins FLEURS (2.30) and is second on CoVoST-2. Quoting a single "German WER" is misleading.
- **whisper-large-v3-turbo collapses on German CoVoST-2** (8.64 vs large-v3's 5.25). If you self-host Whisper for German, use large-v3 or a German fine-tune, not stock turbo.
- **Voxtral Mini 4B Realtime is 6.56 DE mean here** — near the bottom of the open field, worse than Whisper large-v3 and worse than Parakeet v3 at 1/60th the RTFx. This is a significant correction to the prior EU-provider research, which recommended it primarily on an English streaming leaderboard.

**Warning:** batch board, read speech, English normalizer. Nothing here predicts streaming German meeting performance.

### 2.2 Mistral's Voxtral papers — the only source measuring *streaming* German with a delay sweep

Vendor-published for Voxtral rows; the competitor rows are more interesting because a rival measured them. Note the harness disagrees with §2.1 by up to 67% relative, so use these rows only against each other.

**Batch, three German datasets** ([arXiv 2507.13264v1](https://arxiv.org/html/2507.13264v1)):

| Model | FLEURS de | Common Voice 15.1 de | MLS German |
|---|---:|---:|---:|
| Whisper large-v3 | 5.46 | 6.25 | 5.72 |
| GPT-4o mini Transcribe | 3.76 | 6.72 | 5.44 |
| Gemini 2.5 Flash | 4.74 | 7.25 | 6.52 |
| ElevenLabs Scribe | 4.78 | **3.52** | **9.81** |
| Voxtral Mini | 4.40 | 6.07 | 7.09 |
| **Voxtral Small** | **3.38** | 3.74 | 5.57 |

**Streaming delay sweep, FLEURS German** ([arXiv 2602.11298v1](https://arxiv.org/html/2602.11298v1) Table 7):

| System | Delay | FLEURS de | Common Voice de |
|---|---|---:|---:|
| Voxtral Mini Transcribe V2 (batch) | — | **3.54** | **4.35** |
| GPT-4o mini Transcribe | — | 4.07 | 6.05 |
| ElevenLabs Scribe v2 Realtime | — | 4.31 | 16.60 |
| Whisper (offline baseline) | — | 5.46 | 6.25 |
| Voxtral Realtime | 2400 ms | 4.15 | 5.66 |
| Voxtral Realtime | 960 ms | 4.87 | 6.85 |
| Voxtral Realtime | **480 ms (recommended)** | **6.19** | **8.70** |
| Voxtral Realtime | 240 ms | 8.15 | 11.13 |

**The delay knob is worth more on German than the headline suggests.** 480 → 960 ms buys **1.32 pp** on FLEURS-de and **1.85 pp** on CV-de. That is a bigger movement than most engine swaps and costs half a second. Tandem's measured commit latency is 0.34 s against a 3 s median gate, so there is budget.

**Two outliers that are probably scoring artefacts, not model failures.** Scribe scores 9.81 on MLS German (worst in the batch table) while winning Common Voice German at 3.52; and Scribe v2 Realtime scores 16.60 on Common Voice German while scoring 19.43 on Common Voice *English* in the same table. MLS German references are lowercase and unpunctuated by construction; a heavily-formatted commercial output gets penalised. This is very likely why MLS German was dropped from the Open ASR Leaderboard's German track. Treat both as hypotheses to test on your own audio, not as facts about Scribe.

### 2.3 The de-facto open-German benchmark suite (primeline's Tuda-De / MLS-de / CV19 triplet)

All self-published, internally comparable, on standard public datasets. Sources: [primeline/parakeet-primeline](https://huggingface.co/primeline/parakeet-primeline), [whisper-large-v3-turbo-german](https://huggingface.co/primeline/whisper-large-v3-turbo-german), [whisper-tiny-german-1224](https://huggingface.co/primeline/whisper-tiny-german-1224).

| Model | License | **All** | Tuda-De | MLS German | Common Voice 19.0 |
|---|---|---:|---:|---:|---:|
| **primeline/parakeet-primeline** (FastConformer-TDT 0.6B) | CC-BY-4.0 | **2.95** | **4.11** | 2.60 | 3.03 |
| primeline/whisper-large-v3-turbo-german | Apache 2.0 | 2.628 | 6.441 | **2.070** | 3.200 |
| nyrahealth/CrisperWhisper (large) | **CC-BY-NC-4.0** | 2.662 | 5.148 | 2.815 | **1.927** |
| primeline/whisper-large-v3-german | Apache 2.0 | 2.734 | 7.711 | 2.129 | 3.215 |
| openai/whisper-large-v3 | MIT | 3.279 | 7.884 | 2.832 | 3.484 |
| nvidia/parakeet-tdt-0.6b-v3 | CC-BY-4.0 | 3.64 | 7.05 | 2.95 | 3.70 |
| openai/whisper-large-v3-turbo | MIT | 3.649 | 8.300 | 3.203 | 3.849 |
| openai/whisper-medium | MIT | 5.49 | 11.13 | 5.04 | 5.53 |

Note the two different "All" columns are not the same average (primeline's turbo-german card and the parakeet-primeline card use slightly different aggregations), so read **within a column**. `parakeet-primeline` is the clear winner on Tuda-De, the hardest set, by 20% relative over the next best.

On the separate `flozi00/asr-german-mixed` test split (9.8k samples, different test set, **re-ranks the models**): primeline turbo-german **4.77**, CrisperWhisper 8.52, primeline large-v3-german 10.54 ([dataset](https://huggingface.co/datasets/flozi00/asr-german-mixed)).

**Licensing trap:** CrisperWhisper is **CC-BY-NC-4.0**, non-commercial, and deprecated in favour of CrisperWhisper 2.0. It cannot ship in a commercial product. primeline's and NVIDIA's models can.

CrisperWhisper is still worth knowing about for *what it is*: verbatim, disfluency-preserving, hallucination-mitigated, trained on **English and German only**. On English AMI (spontaneous meetings) it scores **8.72 vs Whisper large-v3's 16.01**, segmentation F1 on AMI IHM 0.79 vs 0.66 ([card](https://huggingface.co/nyrahealth/CrisperWhisper), [arXiv 2408.16589](https://arxiv.org/abs/2408.16589)). That is the clearest published demonstration that meeting-speech performance is a separate axis from read-speech performance.

### 2.4 NVIDIA German monolingual models — the punctuation-sensitivity evidence

| Model | Dataset | no punct/caps | with punct/caps |
|---|---|---:|---:|
| stt_de_fastconformer_hybrid_large_pc (115M) | MCV12 de test | 5.10 | 5.39 |
| " | **MLS German test** | **3.87** | **11.10** |
| " | VoxPopuli German test | 8.88 | 10.41 |
| stt_de_conformer_transducer_large | MCV 7.0 test | 4.93 | – |
| " | MLS German test | 3.85 | – |
| " | VoxPopuli German test | 8.85 | – |

Sources: [fastconformer](https://huggingface.co/nvidia/stt_de_fastconformer_hybrid_large_pc), [conformer transducer](https://huggingface.co/nvidia/stt_de_conformer_transducer_large). Both CC-BY-4.0, German-only, trained on 2500 h.

### 2.5 Commercial vendors publish essentially nothing on German

| Vendor | German WER self-published? |
|---|---|
| ElevenLabs Scribe v1 / v2 | **No.** Scribe v2 claims "lowest WER recorded on industry-standard benchmarks", cites FLEURS, publishes no numbers ([v1](https://elevenlabs.io/blog/meet-scribe), [v2](https://elevenlabs.io/blog/introducing-scribe-v2)) |
| Speechmatics | **No** language breakdown, no datasets cited ([languages page](https://www.speechmatics.com/product/languages)) |
| AssemblyAI | **No.** Universal-2 research report is English-only ([report](https://www.assemblyai.com/research/universal-2)) |
| Deepgram | **No.** Nova-3 launch is 9 English domains; "seven languages tested" via preference testing only ([Nova-3](https://deepgram.com/learn/introducing-nova-3-speech-to-text-api)) |
| Gladia Solaria-3 | **Relative only:** −13% on Common Voice 24 de, −3% on real customer audio vs Solaria-1. No absolute German WER ([solaria-3](https://www.gladia.io/solaria-3)) |
| Azure / Google Chirp / AWS Transcribe | **No German numbers found** |

**Not one major commercial STT vendor publishes a German WER against a named public dataset.** Every usable commercial German number in this document comes from the Open ASR Leaderboard or from a competitor's paper.

### 2.6 Tandem's own German measurement — the only conversational-German data here

From `audio_testing/results/compare_all_20260602_083940.md`, reference = ElevenLabs Scribe v1:

| Engine | Pooled WER | Sub | **Del** | Ins | **clip_07 (German)** |
|---|---:|---:|---:|---:|---:|
| voxtral/voxtral-mini-2507 | 19.61% | 7.62% | 11.35% | 0.65% | **41.55%** |
| whisper/large-v3-turbo | 20.1% | 7.46% | 10.21% | 2.43% | **39.44%** |
| whisper/large-v3-q5_0 | 23.34% | 6.32% | 16.21% | 0.81% | **58.45%** |
| parakeet (English-only) | 35.98% | 5.83% | **26.74%** | 3.4% | **65.49%** |

Shipped-engine baseline (`wer_baseline.json`): pooled 21.54%, **clip_07 53.5% with S=37, D=37**.

**Deletions dominate substitutions on every engine.** A model that mishears produces substitutions. A pipeline that loses audio produces deletions. And `audio_testing/proofing/window3_CUTOFF.wav` is a German call where "Tandem's transcript stops at 16:13" while the conversation demonstrably continues.

---

## 3. Read versus spontaneous German: the correction factor

### 3.1 The one paper that measures both with the same models

Wirth & Peinl, *ASR in German: A Detailed Error Analysis*, COINS 2022 ([arXiv 2204.05617](https://arxiv.org/abs/2204.05617), [rendered](https://www.alphaxiv.org/abs/2204.05617)). Six German models, 14 test sets. Best model (Conformer Transducer) shown; the ranking is stable across models.

| Dataset | Type | Conformer Transducer WER |
|---|---|---:|
| HUI | read | 1.89 |
| MLS German | read | 4.11 |
| Tuda-De | read | 5.82 |
| Common Voice 7.0 | read | 6.28 |
| SWC | read | 8.04 |
| **VoxPopuli** | **spoken** | **8.98** |
| **Bundestag** | **spoken** | **11.16** |
| **Merkel speeches** | **spoken** | **13.49** |
| **German TED** | **spoken** | **31.98** |

Their conclusion, verbatim: *"In general, the datasets with spontaneous speech show a higher WER than the ones with continuous speech."*

**Multipliers, best model, same paper:** CV-de → VoxPopuli **1.4x**; CV-de → Bundestag **1.8x**; CV-de → German TED **5.1x**; MLS-de → German TED **7.8x**.

### 3.2 Corroborating evidence

| Comparison | Multiplier | Source |
|---|---|---|
| Whisper large-v3: LibriSpeech 11% → conversational telephone (TalkBank) 54% | **4.9x** | [arXiv 2409.12042](https://arxiv.org/abs/2409.12042) |
| Whisper large-v3: FLEURS 23% → TalkBank 54% | **2.3x** | ibid. |
| Canary 1B: FLEURS 25% → TalkBank 54% | **2.2x** | ibid. |
| MMS: MLS-de 8.75% → spontaneous German YouTube 28.49% | **3.3x** | [DECM, LREC-COLING 2024](https://aclanthology.org/2024.lrec-main.400/) |
| Whisper large-v3: LibriSpeech clean 2.03 → AMI meetings 16.01 (English proxy) | **7.9x** | [CrisperWhisper card](https://huggingface.co/nyrahealth/CrisperWhisper) |
| Austrian German, same lab/system: read 0.4% → conversational (GRASS) 48.5% | extreme | [arXiv 2301.06475](https://arxiv.org/abs/2301.06475) |
| General rule of thumb from a German-speaking ASR group | read 2-10%, conversational 20-40% | [Wepner et al., Speech Prosody 2022](https://www.isca-archive.org/speechprosody_2022/wepner22_speechprosody.html) |

**Human calibration:** on spontaneous German oral-history interviews with clean acoustics, the estimated **human** word error rate is **8.7%**, with the best system at 15.6% clean / 23.9% noisy ([arXiv 2201.06841](https://arxiv.org/abs/2201.06841)). That is above what models score on Common Voice German. It is the honest ceiling for your product.

### 3.3 Is there a conversational-German meeting benchmark?

**No.** Definitively:

- **No German AMI/ICSI equivalent exists publicly.** AMI is English; no German portion exists.
- The nearest usable **free public** conversational German is **CallHome German via TalkBank** (100 unscripted telephone conversations, 20 eval calls public, [talkbank.org/ca/access/CallHome/deu.html](https://talkbank.org/ca/access/CallHome/deu.html), DOI 10.21415/T56P4B; paid LDC original [LDC97S43](https://catalog.ldc.upenn.edu/LDC97S43)). A 2024 preprocessing pipeline exists at [Diabolocom-Research/ConversationalDataset](https://github.com/Diabolocom-Research/ConversationalDataset).
- **DECM** (3.38 h spontaneous German YouTube, finance/CS/gaming/Denglisch, [github.com/enesyugan/DECM](https://github.com/enesyugan/DECM)) is the closest public proxy to your users' actual speech.
- **GRASS** (Austrian, face-to-face, unscripted, licence-restricted) is benchmarked at wav2vec2-XLSR **18.57-31.25%** in [arXiv 2509.10116](https://arxiv.org/html/2509.10116).
- Everything else labelled "spontaneous German" is parliamentary (VoxPopuli, [ASR Bundestag](https://arxiv.org/abs/2302.06008)), broadcast/talks (German TED), oral history, or scraped YouTube.
- **Business-meeting German, multi-party, with overlap and headset/room mics: no public corpus found at all.** You will have to build a small internal eval set.

Corpus status notes: Verbmobil (spontaneous, BAS/CLARIN) has only HMM-era numbers and no modern Whisper-era evaluation; SmartWeb, RVG-J, SI1000 and the Kiel Corpus have no published modern German WER; GerParCor is **text only**, not speech; MediaSpeech has **no German**; `flozi00/asr-german-mixed` is **read** (Common Voice + MLS) despite being widely used as "the" German benchmark.

### 3.4 Planning number

**If a vendor quotes ~2-5% German on FLEURS or Common Voice, expect roughly 12-20% on real German business-meeting audio, and 25-35%+ if there is overlap, dialect or poor acoustics.** Your clip_07 sits at 39-65% depending on engine, which is the top of that range plus a pipeline that is losing audio.

---

## 4. German-English code-switching

This is the section that should change Tandem's configuration today.

### 4.1 The measurement: DECM

[Ugan, Pham & Waibel, *DECM: Evaluating Bilingual ASR Performance on a Code-switching/mixing Benchmark*, LREC-COLING 2024](https://aclanthology.org/2024.lrec-main.400/) ([PDF](https://aclanthology.org/2024.lrec-main.400.pdf)). German-matrix, English-embedded, spontaneous YouTube speech in finance, computer science, gaming and Denglisch. 44,147 words, 3,348 English/Denglisch tokens (**7.6%**), 862 code-switched utterances. Their motivating example is literally your use case: *"Kannst du die Datei downloaden."*

| Model | Overall | German parts | **Embedded English parts** |
|---|---:|---:|---:|
| Whisper large, **language-agnostic** | 16.61 | 15.02 | **34.68** |
| Whisper large, **forced German prefix** | 17.71 | 15.02 | **49.49** |
| WMB (wav2vec2 + mBART50) | 19.08 | 15.81 | 57.41 |
| MMS (CTC) | 28.49 | 24.79 | 72.78 |

Three findings that matter:

1. **Embedded English words are 2.3x harder than the German matrix** for the best model (34.68 vs 15.02). **Overall WER hides this completely.**
2. **Forcing the language token to German makes the English 14.8 points worse and the German no better.** Paper, verbatim: *"keeping the model and the decoding language agnostic or letting the model implicitly determine the language of the speech, yields better transcriptions than pre-determining the matrix language."*
3. The damage scales with code-switch density: on high-CSW audio, forced-German Whisper hits **56.76%** on the English tokens.

### 4.2 WER is the wrong metric here

[PIER: A Novel Metric for Evaluating What Matters in Code-Switching, arXiv 2501.09512](https://arxiv.org/html/2501.09512) scores only the code-switch points, and evaluates on DECM among others. Headline evidence: on Fisher, fine-tuning Whisper-large on monolingual data **improved WER by 5.06% while worsening PIER by 39.47% relative**. On DECM, Whisper-large scores inter-word **30.42** / intra-word **45.23** — intra-word (morphologically mixed, "gecancelt", "gespeedrunt") is the worst case by far.

**Implication for Tandem: a WER improvement on a German benchmark can coincide with a regression on exactly the English terms your users care about. When you build a German eval set, annotate the English tokens and score them separately.**

### 4.3 What each engine actually does

| Engine | German-English code-switching | Realtime? | Evidence |
|---|---|---|---|
| **Deepgram Nova-3 / Flux** | **Yes, best-documented.** `language=multi` set is "English, Spanish, French, **German**, Hindi, Russian, Portuguese, Japanese, Italian, Dutch". Word-level language detection in the response; Flux returns `TurnInfo.languages`. Docs recommend `endpointing=100` for CS in streaming | **yes** | [multilingual CS docs](https://developers.deepgram.com/docs/multilingual-code-switching), [models & languages](https://developers.deepgram.com/docs/models-languages-overview) |
| **AssemblyAI Universal-3.5 Pro** | **Yes.** `language_detection: True`, 18 languages with native CS incl. German. Constraint, verbatim: *"A max of two language codes can be set and one code must be `en`."* — which is exactly a German-English pair | **yes** (Universal-Streaming multilingual) | [code-switching docs](https://www.assemblyai.com/docs/pre-recorded-audio/code-switching) |
| **ElevenLabs Scribe v2 Realtime** | Realtime session config exposes `language_code` (optional), **`secondary_languages`**, `include_language_detection`, `keyterms`. Blog claims *"Speak in any language, switch language mid conversation."* **But the batch API reference returns a single `language_code` + `language_probability` per request and documents no per-word language output** | **yes** | [realtime API ref](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime), [blog claim](https://elevenlabs.io/blog/introducing-scribe-v2-realtime) |
| **Speechmatics** | **No German-English bilingual pack exists.** Packs are `ar_en`, `en_ms`, `cmn_en`, `cmn_en_ms_ta`, `en_ta`, `tl`, plus Spanish-English. `auto` LID is **batch only**. German is monolingual-only. The multilingual **Melia 1** switches automatically but is **batch-only in production preview** | **no** for German CS | [languages](https://docs.speechmatics.com/speech-to-text/languages), [Melia](https://www.speechmatics.com/company/articles-and-news/introducing-melia-multilingual-speech-to-text-model) |
| **Azure Speech** | **Explicitly does not support your case.** Docs, verbatim: *"Continuous LID doesn't support changing languages within the same sentence... if you're primarily speaking Spanish and insert some English words, it doesn't detect the language change per word."* | n/a | [Azure LID docs](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-identification) |
| **Google Chirp 3** | `language_codes=["auto"]` identifies the *dominant* language. That is LID, not intra-sentential CS. No German-English CS claim | n/a | [Chirp 3 docs](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3) |
| **Mistral Voxtral Realtime** | **Undocumented.** Offline transcription has a `language` parameter; the **realtime** docs document `audio_stream`, `model`, `audio_format`, `target_streaming_delay_ms` and the constraint that realtime is incompatible with `diarize` — **no language parameter, no auto-detect statement, no CS statement**. vLLM's `session.update` carries only `model` | yes | [Mistral realtime docs](https://docs.mistral.ai/capabilities/audio/speech_to_text/realtime_transcription), [vLLM realtime](https://docs.vllm.ai/en/latest/examples/speech_to_text/realtime/) |
| **Gladia Solaria-3** | Code-switching listed as **"limited"**; full CS is a Solaria-1 feature | **batch only** | [solaria-3](https://www.gladia.io/solaria-3) |
| **NVIDIA Parakeet-TDT-0.6B-v3** | Auto-detects language, no prompting. Not CS-evaluated, but at least does not force a wrong token | via NeMo chunked | [card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) |
| **NVIDIA Canary-1B-v2** | **Requires explicit `source_lang`.** Structurally hostile to code-switching | chunked | [card](https://huggingface.co/nvidia/canary-1b-v2) |
| **Whisper (all variants)** | No CS support by design; single language token inferred from the first 30 s. Forcing a mismatched token is *unspecified behaviour* and causes **translation instead of transcription** | via wrappers | [openai/whisper#49](https://github.com/openai/whisper/discussions/49), [#2285](https://github.com/openai/whisper/discussions/2285), [transformers#27778](https://github.com/huggingface/transformers/issues/27778), [faster-whisper#869](https://github.com/SYSTRAN/faster-whisper/issues/869) |

**I found zero independent third-party benchmark of German-English code-switching for any commercial engine.** Every vendor row above is a capability claim from documentation. Speechmatics' impressive code-switching numbers (Arabic-English 6.3% vs Google 9.7%, "35% fewer errors") are real claims about **language pairs you do not have**.

### 4.4 The practical rule for Tandem

- **Do not force `language_code: "de"`.** DECM quantifies the cost at 14.8 points on the English tokens.
- **Do not let it default to English either.** If Tandem sends nothing and the engine latches on the first two seconds, a German call that opens with "okay, so, let's do a quick alignment" can latch English for the whole session. **This is a live suspect for the clip_07 deletion blocks and deserves an hour of investigation before any model swap.**
- **Prefer an explicit multi-language declaration over a single forced code** where the API supports it: Scribe's `secondary_languages`, Deepgram's `language=multi`, AssemblyAI's two-code (one must be `en`) form. These are *different mechanisms* from forcing a matrix language and DECM's finding does not condemn them — but nobody has measured them on German-English either.
- **Canary is disqualified** on the `source_lang` requirement alone despite good German numbers.

---

## 5. Self-hosting on the RTX 3090

Assumption confirmed as correct: run the model as a **separate server process** speaking HTTP/WebSocket and keep the Rust/Tauri app as a client. Every viable option is Python-side; none has a Windows+MSVC+CUDA Rust in-process path.

### 5.1 primeline/parakeet-primeline — the recommendation

- **License** CC-BY-4.0. FastConformer-TDT, **0.6B params**. [Model card](https://huggingface.co/primeline/parakeet-primeline).
- **German accuracy** best published anywhere for an open German model: **2.95 average** across Tuda-De 4.11 / MLS-de 2.60 / CV19-de 3.03. Beats every Whisper variant including the German fine-tunes, and beats stock `parakeet-tdt-0.6b-v3` (3.64) by 19% relative. Self-published, on standard public datasets, not independently replicated.
- **VRAM** Parakeet-class, ~2 GB to load. Leaves the whole card free for diarization, VAD and a second engine.
- **Speed** the base architecture runs at RTFx 1719 on the leaderboard. A live stream costs a rounding error of the GPU.
- **Streaming** NeMo chunked/buffered inference. NeMo's true **cache-aware streaming** is documented for Conformer and FastConformer CTC/Transducer with configurable `att_context_size` ([NeMo docs](https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/asr/models.html)) — this is a FastConformer, so cache-aware streaming is architecturally available, though no ready-made cache-aware German checkpoint is published. Being this cheap, aggressive overlap-and-agree buffering is free anyway.
- **Risk** German-only or German-first. Code-switching behaviour unknown and unmeasured.

### 5.2 NVIDIA parakeet-tdt-0.6b-v3 — the safe multilingual version of the same bet

CC-BY-4.0, 600M, **~2 GB**, RTFx 3332 (English leaderboard) / 1719 (multilingual harness), German FLEURS 5.04 / CoVoST 4.84 self-published and 4.26 / 4.13 independently on the leaderboard. **Auto-detects language across 25 European languages with no prompting** ([card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)) — which per §4 is the right default behaviour for code-switched calls.

**This is a drop-in replacement for the English-only Parakeet already wired into Tandem, the engine that scores 65.49% on clip_07.** Highest value-per-hour experiment in this document.

### 5.3 primeline/whisper-large-v3-turbo-german — the accuracy-first, latency-last option

- Apache 2.0, best German fine-tune average on the primeline suite (2.628), and **4.77 on `asr-german-mixed`** where CrisperWhisper gets 8.52.
- **VRAM** faster-whisper large-class: **fp16 ~4.5-6.1 GB, int8 ~2.9-4.5 GB** ([faster-whisper](https://github.com/SYSTRAN/faster-whisper)). Turbo is smaller.
- **Streaming: not native, but solved, and there is a German number.** UFAL LocalAgreement-2 on ESIC German: offline Whisper **9.2%**, streaming at 1.0 s min-chunk **9.4%**, latency 4.37 s ([arXiv 2307.14743](https://arxiv.org/html/2307.14743v2)). **Streaming costs 0.2 pp when done correctly.** English chunk sweep: 0.5 s → 8.5%/3.27 s, 1.0 s → 8.1%/3.62 s, 2.0 s → 8.0%/5.45 s.
- **Cost:** ~4 s latency versus Tandem's current 0.34 s commit latency.
- Windows-native CUDA builds of faster-whisper and whisper.cpp both exist, so WSL2 is optional here.

### 5.4 Voxtral Mini 4B Realtime on vLLM — the only true low-latency local streamer, and weaker on German than expected

- **License** Apache 2.0, BF16, 4.4B params (970M causal audio encoder + 3.4B decoder) ([card](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602)).
- **German accuracy is the problem.** Independently on the Open ASR Leaderboard: **de CoVoST-2 8.08 / de FLEURS 5.04, mean 6.56** — worse than Whisper large-v3 (4.26) and worse than Parakeet v3 (4.20), at 28 RTFx versus 1719. Mistral's own paper is kinder (FLEURS-de 6.19 @480 ms, 4.87 @960 ms) but that is the vendor's harness.
- **VRAM on 24 GB is unverified.** Card says ≥16 GB. Red Hat's reference deployment uses `--max-model-len 45000 --max-num-seqs 16 --gpu-memory-utilization 0.90` ([Red Hat](https://developers.redhat.com/articles/2026/02/06/run-voxtral-mini-4b-realtime-vllm-red-hat-ai)). A third-party runbook reports **mid-30s GB runtime on a 48 GB card** with those defaults, rates 24 GB as *"might run, needs tuning"*, and lists "VRAM OOM after minutes" as a documented failure mode fixed by capping `--max-model-len` and `--max-num-seqs` ([binaryverseai](https://binaryverseai.com/voxtral-mini-4b-local-vllm-v1-realtime-runbook/)). **No RTX 3090 measurement found anywhere.** Ampere sm_86 supports BF16 natively so there is no format blocker.
- **Serving** `VLLM_DISABLE_COMPILE_CACHE=1 vllm serve mistralai/Voxtral-Mini-4B-Realtime-2602 --tokenizer-mode mistral --config-format mistral --load-format mistral --compilation-config '{"cudagraph_mode":"PIECEWISE"}'`, vLLM v0.20.0+, `temperature=0.0`. `--tokenizer-mode mistral` is mandatory.
- **Protocol** OpenAI-Realtime-shaped WebSocket at `/v1/realtime`: `session.created`, `session.update`, `input_audio_buffer.append/commit`, `transcription.delta`, `transcription.done`. Base64 PCM16 @ 16 kHz mono.
- **True streaming: yes**, causal encoder, fixed `transcription_delay_ms` (multiples of 80 ms in [80,1200] plus 2400), no manual commit concept — which is what would let Tandem delete its commit-estimator machinery.
- **Missing:** no language parameter, **no keyterm/vocabulary biasing**, no diarization (explicitly incompatible with realtime). The vocabulary loss versus Scribe is a real functional regression.

### 5.5 Others

- **nvidia/stt_de_fastconformer_hybrid_large_pc** — 115M, CC-BY-4.0, German-only, VoxPopuli-de 8.88, cache-aware streaming capable. Good as a fast partials engine in a two-pass design; unusable alone on code-switched calls.
- **Voxtral Small 24B** — best open German on the leaderboard (3.01) but 24B BF16 needs ~48 GB, and it is batch, not realtime. Not a 3090 option at full precision.
- **Canary-1B-v2** — 4.10 German, CC-BY-4.0, ~6 GB, but requires `source_lang`. Disqualified for code-switching.
- **CrisperWhisper** — best spontaneous-speech behaviour, English+German, but **CC-BY-NC-4.0**. Not shippable.
- **Kroko-ASR (Banafo)** — sherpa-onnx Zipformer, confirmed English/French/German/Spanish/Portuguese, streaming over WebSocket, CPU/WASM-capable ([HF](https://huggingface.co/Banafo/Kroko-ASR), [kroko.ai](https://kroko.ai/)). **No published German WER on any named dataset.** Right shape, unverified accuracy; CC-BY-SA is also a copyleft consideration for a shipped desktop app.

### 5.6 Can a 3090 do this?

For a **single live meeting stream**, yes with room to spare for everything except Voxtral 4B on default vLLM settings. Parakeet-primeline (2 GB) or Whisper turbo German (3-6 GB) plus pyannote plus Silero VAD all fit in 24 GB simultaneously. Voxtral 4B is the one needing tuning and the one with no 3090 evidence.

---

## 6. Diarization and German

**pyannote is language-agnostic by construction** — it operates on speaker embeddings from raw audio and never sees text. pyannoteAI states it is "multilingual by default with no language configuration, retraining, or extra cost required."

**But there is no published German DER.** [speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1) benchmarks AISHELL-4 (12.2), AliMeeting (24.4), AMI (18.8), AMI SDM (22.4), AVA-AVD (50.0), DIHARD 3 (21.7), MSDWild (25.3), REPERE (7.8, French), VoxConverse (11.3). **No German dataset.** pyannoteAI's newer 13-dataset benchmark has "no per-language breakdown" and no German ([their post](https://www.pyannote.ai/blog/how-to-evaluate-speaker-diarization-performance)). A third-party comparison spanning English, Mandarin, German, Japanese and Spanish puts pyannoteAI at 11.2% DER and open-source DiariZen at 13.3%, but does not break out German.

**Verdict:** the language-agnostic claim is architecturally sound and the risk is low, but unverified on German. Expect DER to be driven by your acoustics far more than by language.

**Streaming diarization is the harder constraint.** pyannote 3.1 documents no online mode. Scribe v2 batch diarizes up to 48 speakers; **Scribe v2 Realtime exposes `speaker_id` on words but no diarization configuration parameters**. **Voxtral realtime is explicitly incompatible with `diarize`.**

**For a two-party call, channel separation beats diarization.** Tandem already captures mic and system audio as separate streams before mixing, which gives perfect two-speaker attribution for free. Use diarization only to split multiple people sharing the far-end channel.

---

## 7. Post-processing wins, ranked by evidence quality

### 7.1 Language configuration (biggest documented German-English effect, near-zero cost)
DECM quantifies it: forced-German Whisper is **14.8 points worse** on embedded English than language-agnostic Whisper, with identical German-part WER. Whatever Tandem currently sends, verify it, and log `include_language_detection` output per committed segment so language latching becomes visible. **Effort: hours.**

### 7.2 VAD/endpointing and chunking (strongest evidence that it matters *here*)
- Tandem's error profile is deletion-dominant across all four engines tested, worst case 26.74% deletions vs 5.83% substitutions.
- Prior in-project work measured boundary insertions costing **~1.5 pp of WER**.
- UFAL quantifies the ceiling: correct streaming (LocalAgreement-2, overlapping windows, commit only on agreement, buffer trimmed at punctuation) costs **0.2 pp** on German ESIC versus offline. Hard-cutting at VAD gaps costs far more.
- faster-whisper's VAD is "conservative and only removes silence longer than 2 seconds" by default and exposes speech padding precisely because trimming at the exact boundary clips soft onsets ([faster-whisper](https://github.com/SYSTRAN/faster-whisper)).
- Scribe v2 Realtime exposes `commit_strategy` (manual|vad), `vad_threshold`, `vad_silence_threshold_secs`, `min_speech_duration_ms`, `min_silence_duration_ms` — all tunable today, all currently on defaults.
- Deepgram recommends `endpointing=100` specifically for code-switching in streaming ([CS docs](https://developers.deepgram.com/docs/multilingual-code-switching)).

**German has a specific reason to be hit harder.** German main clauses put the finite verb second and push non-finite verbs and separable prefixes to the **end** of the clause ("...und dann haben wir das komplette System **umgestellt**"). A trailing-silence endpointer that clips 200 ms early removes the semantically decisive word. English rarely pays that price. **Effort: S-M. This is where the 39-65% clip_07 number lives.**

### 7.3 Custom vocabulary / keyterm prompting
- **Scribe v2 Realtime supports `keyterms`** in the realtime session config; batch Scribe v2 supports up to 1000 terms ([API ref](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime)).
- Deepgram: keyterm prompting improves **Keyword Recall Rate up to 90%**; multilingual keyterm prompting accepts **500 tokens (~100 words)**; Deepgram's own guidance puts runtime customisation at "20-30% improvement". All Deepgram-self-published ([keyterm docs](https://developers.deepgram.com/docs/keyterm)).
- Speechmatics custom dictionary: **works in realtime**, up to **1000 words/phrases**, supports `sounds_like` phonetic hints. **No accuracy numbers published** ([docs](https://docs.speechmatics.com/features/custom-dictionary)).
- Anglicism-aware G2P for German ASR reduced WER by 1% and **anglicism error rate by 3%** ([arXiv 2105.12708](https://arxiv.org/abs/2105.12708)) — direct evidence that targeting the English terms specifically pays.
- **Voxtral Realtime via vLLM has no vocabulary biasing at all.**

**Caveat from Tandem's own history:** the iteration-1 domain-term correction pass gained 22.03% → 21.54% but adversarial review found it **in-sample** and silently corrupting ("we might drop if I can't make it" → "we might shopify can't make it"). **Prefer engine-level `keyterms` over transcript-level string substitution** — the engine weighs acoustic evidence, a regex does not. Seed the keyterm list from a Denglisch term list; the [Denglisch Corpus](https://github.com/HaifaCLG/Denglisch) is text-only but ideal for exactly this.

### 7.4 LLM-based transcript correction
Published: up to **12% relative WER reduction** with 10-best T5 and lattice-constrained decoding; up to **28.5% relative** zero-shot for specialised domains ([arXiv 2505.17410](https://arxiv.org/abs/2505.17410), [arXiv 2405.15216](https://arxiv.org/html/2405.15216)). No German-specific numbers found. Known failure mode: **over-correction on rare words** when only text (no phonetics, no N-best) is available — exactly the situation for a single-hypothesis streaming API.

**Post-call only, and it cannot recover deleted audio.** Given that Tandem's errors are deletion-dominant, this is polishing the wrong surface. Deprioritise.

### 7.5 Increase the streaming delay budget
Specific to German and underrated. Voxtral Realtime 480 → 960 ms buys **1.32 pp on FLEURS-de** and **1.85 pp on CV-de**. If Tandem moves to Voxtral, **960 ms is probably the right German default** despite Mistral recommending 480 ms, because the measured commit-latency budget (0.34 s today, 3 s gate) has room.

---

## 8. Recommendations

### 8.1 Best German accuracy overall
**ElevenLabs Scribe v2, properly configured, with a Voxtral batch second pass.** Scribe v2 is the top German system on the only independent multilingual board (de FLEURS 2.30, de CoVoST-2 2.24, mean 2.27), it has a realtime WebSocket with `secondary_languages`, `keyterms` and full VAD control, and the integration already works. The change is configuration, not architecture.
- **Open risk:** Scribe's mid-conversation language switching is a *blog claim*; the API returns one language per request and documents no per-word language output. Its Common Voice German 16.60 and MLS German 9.81 outliers are probably reference-format artefacts but are unverified. Both must be checked on your audio.
- **Second pass for the saved transcript:** Voxtral Mini Transcribe V2 batch is the best-measured German batch model in Mistral's harness (3.54 FLEURS-de / 4.35 CV-de) and Voxtral Small 24B is the best open German model on the independent board (3.01).
- **If code-switching turns out to be the dominant failure**, switch the live path to **Deepgram Nova-3 `language=multi`** — German is in the set, it works in streaming, and it returns **word-level language labels**, which is the only way to diagnose CS failures at all. It is US-hosted, which conflicts with the GDPR review.

### 8.2 Best German accuracy that is EU-hosted
**Mistral Voxtral, hosted, Paris.** Batch `voxtral-mini-transcribe-2` for the saved transcript (3.54 FLEURS-de), realtime at **960 ms** rather than the recommended 480 ms (4.87 vs 6.19 FLEURS-de).
- **This is weaker than the prior EU research concluded.** Independently, Voxtral Mini 4B Realtime is **6.56 DE mean** on the Open ASR Leaderboard, below Whisper large-v3 and Parakeet v3. Its realtime API documents no language handling and no vocabulary biasing, and is incompatible with diarization. The prior recommendation rested on an **English-only** streaming leaderboard.
- **Speechmatics is eliminated for German code-switching**, not merely deprioritised: no German-English bilingual pack, `auto` LID batch-only, Melia batch-only. Their impressive code-switching numbers are for Arabic-English and Southeast Asian pairs. It remains the best German **monolingual** EU-region option (de CoVoST-2 1.99, best on that split) with an on-prem container.
- Gladia is batch-only and publishes no absolute German WER.

### 8.3 Best German accuracy fully local on the 3090

1. **primeline/parakeet-primeline** — CC-BY-4.0, 0.6B, ~2 GB, **2.95 German average** (Tuda-De 4.11 / MLS-de 2.60 / CV19 3.03), best published open German result anywhere. Self-published, unreplicated. **Test first.**
2. **nvidia/parakeet-tdt-0.6b-v3** — CC-BY-4.0, ~2 GB, 4.20 DE mean independently, **auto language detection over 25 EU languages**, RTFx 1719. The safe multilingual version of the same bet, and the direct replacement for the English-only Parakeet already in the codebase.
3. **primeline/whisper-large-v3-turbo-german** — Apache 2.0, 3-6 GB, best on `asr-german-mixed` (4.77), streaming via LocalAgreement-2 at a documented **0.2 pp** cost on German ESIC but **~4 s latency**. Accuracy-first, latency-last.
4. **Voxtral Mini 4B Realtime** — the only true sub-second local streamer and the only one that would let Tandem delete its commit-estimator machinery, but 6.56 DE mean, no language hint, no keyterms, no diarization, and 24 GB is "might run, needs tuning" with zero 3090 evidence.

**Do not use stock `whisper-large-v3-turbo` for German** (6.21 DE mean, 8.64 on CoVoST-2). Use large-v3 or a German fine-tune.

### 8.4 Buy a different app?
No. No notetaker publishes a conversational-German WER either, and none will let you fix the segmentation layer causing your deletions. The German problem you have is in the pipeline you control.

---

## 9. Engineering plan

Cheap wins first, model swaps last.

| # | Step | Effort | Expected German WER movement | Evidence |
|---|---|---|---|---|
| **0** | **Build a real German ground truth.** Finish `audio_testing/proofing/`, human-transcribe 2-3 German windows including `window3_CUTOFF.wav`. Add 3-4 German clips. **Annotate the English tokens separately.** Stop scoring German against Scribe's own output. | M (mostly listening time) | none directly; **without it every number below is unfalsifiable** | §1.5, §1.6, §4.2 |
| **1** | **Diagnose `window3_CUTOFF`.** A German call whose transcript stops at 16:13 while speech continues is a bug, not a WER problem. WS disconnect, VAD latch, language latch, or buffer stall? | S | potentially the entire 43% loss | `audio_testing/proofing/README.md` |
| **2** | **Audit language handling.** Find out what Tandem sends today. **Do not force `language=de`.** If a hint is needed, use the multi-language form (`secondary_languages: ["en"]`), not a single code. Log per-segment detected language. | S | up to 14.8 pp on English tokens if currently forced | §4.1, [DECM](https://aclanthology.org/2024.lrec-main.400/) |
| **3** | **VAD pre-roll / post-roll padding**, 200-300 ms each side. German clause-final verbs make this worth more than in English. | S | attacks the deletion mass directly | §7.2 |
| **4** | **Tune Scribe's own VAD instead of Tandem's.** Set `commit_strategy`, `vad_threshold`, `vad_silence_threshold_secs`, `min_speech_duration_ms`, `min_silence_duration_ms` explicitly and sweep on German clips. Prefer feeding pre-VAD audio and letting the engine endpoint. | S-M | prior work: boundary insertions cost ~1.5 pp | §7.2 |
| **5** | **Multi-rule endpointing** (sherpa-onnx rule1/rule2/rule3) replacing the single 1.2 s gap + 12 s cap. | S | short turns finalise faster; long turns stop becoming walls | [stt-improvement-ideas.md](stt-improvement-ideas.md) idea 7 |
| **6** | **German + Denglisch keyterms.** Populate `keyterms` per meeting. Do this **instead of** extending the string-substitution pass, which adversarial review already showed corrupts real speech. | S | high jargon recall; anglicism-targeted work shows 3% AER gain | §7.3 |
| **7** | **Swap the local engine to `parakeet-tdt-0.6b-v3`, then trial `parakeet-primeline`.** Replaces the English-only Parakeet scoring 65.49% on clip_07. Auto language detect, 2 GB, free. | S-M | largest cheap model movement available | §5.1, §5.2 |
| **8** | **Add two external German eval sets** so you stop flying blind: the German split of **TalkBank CallHome** (free, with a 2024 pipeline at [ConversationalDataset](https://github.com/Diabolocom-Research/ConversationalDataset)) and **DECM** ([github](https://github.com/enesyugan/DECM), 3.38 h, Denglisch-heavy, business/IT). DECM is close enough to your users' speech to be the primary external eval. | M | — | §3.3, §4.1 |
| **9** | **Re-measure everything** with the harness (`run_voxtral_realtime_wer.py` is the template) and only now decide whether an engine swap is needed. | M | — | — |
| **10** | *If 0-9 leave German unacceptable:* two-pass local — **parakeet-primeline for fast partials**, **primeline/whisper-large-v3-turbo-german under LocalAgreement-2** for committed segments. Stand up **Voxtral on vLLM at 960 ms** only if sub-second commit latency proves non-negotiable. | L | 2.95 / 2.628 on read German; unknown on yours | §5.1, §5.3, §5.4 |
| **11** | *Post-call only, last:* LLM correction over the saved German transcript with the keyterm list as context. | M | 12-28% relative in the literature, **cannot recover deletions** | §7.4 |

**Do steps 0-3 before anything else.** They are days of work, they address the failure mode the data actually shows, and they are prerequisites for trusting any subsequent comparison.

---

## 10. What is unknown and must be measured

1. **Every German WER here is on read speech.** The correction factor to real German meetings is 1.4x (parliamentary) to 5-8x (spontaneous talks); the honest planning band is **12-20% WER**, and up to 25-35% with overlap or dialect. Nobody has published a number for German business calls.
2. **No independent German-English code-switching evaluation exists for any commercial engine.** All §4.3 vendor rows are documentation, not measurement.
3. **What Tandem currently sends as a language hint, and what the engine does with it.** Most likely single cause of the German gap; currently unmeasured.
4. **What `window3_CUTOFF.wav` actually is.** 43% of reference words lost on a German call is not a WER story.
5. **Whether Scribe v2 Realtime really does mid-conversation language switching.** It is a blog claim; the API reference documents one language per request and no per-word language output.
6. **Whether Scribe's Common Voice German 16.60 / MLS German 9.81 are real or reference-format artefacts.** Probably artefacts. Probably.
7. **Whether Voxtral Mini 4B Realtime fits a 24 GB 3090 in sustained operation.** Documented ≥16 GB; observed mid-30s GB on defaults; 24 GB rated "needs tuning"; no 3090 measurement exists.
8. **Whether `parakeet-primeline`'s 2.95 replicates.** Self-published, unreplicated, and it is the top local recommendation.
9. **pyannote's German DER.** Architecturally language-agnostic, zero published German evaluation.
10. **Kroko-ASR's German accuracy.** Right shape (streaming, WebSocket, German, sherpa-onnx), no published WER on any named dataset.
11. **How much of your measured German WER is convention rather than error** — compound splitting, casing, Perfekt vs Präteritum, loanword orthography. In the German family this was ~44% of measured WER, and casing alone inflated one German number 2.9x. Until the human proofing pack exists you cannot separate the two.

---

## Sources

### Independent / peer-reviewed
- [Open ASR Leaderboard, arXiv 2510.06961](https://arxiv.org/abs/2510.06961) · [v4 HTML](https://arxiv.org/html/2510.06961v4) · [multilingual.csv (2026-03-26)](https://raw.githubusercontent.com/huggingface/open_asr_leaderboard/main/scripts/data/multilingual.csv) · [repo](https://github.com/huggingface/open_asr_leaderboard) · [Space](https://huggingface.co/spaces/hf-audio/open_asr_leaderboard) · [datasets](https://huggingface.co/datasets/nithinraok/asr-leaderboard-datasets)
- [Wirth & Peinl, ASR in German: A Detailed Error Analysis, arXiv 2204.05617](https://arxiv.org/abs/2204.05617) · [rendered tables](https://www.alphaxiv.org/abs/2204.05617)
- [DECM code-switching benchmark, LREC-COLING 2024](https://aclanthology.org/2024.lrec-main.400/) · [PDF](https://aclanthology.org/2024.lrec-main.400.pdf) · [data](https://github.com/enesyugan/DECM)
- [PIER: what matters in code-switching, arXiv 2501.09512](https://arxiv.org/html/2501.09512)
- [ASR Benchmarking: Need for a More Representative Conversational Dataset, arXiv 2409.12042](https://arxiv.org/abs/2409.12042) · [code](https://github.com/Diabolocom-Research/ConversationalDataset)
- [Human & Automatic ASR on German Oral History Interviews, arXiv 2201.06841](https://arxiv.org/abs/2201.06841)
- [Kaldi for Conversational Austrian German, arXiv 2301.06475](https://arxiv.org/abs/2301.06475) · [Wepner et al., Speech Prosody 2022](https://www.isca-archive.org/speechprosody_2022/wepner22_speechprosody.html) · [prominence-aware ASR, arXiv 2509.10116](https://arxiv.org/html/2509.10116)
- [Whisper-Streaming / LocalAgreement-2, arXiv 2307.14743](https://arxiv.org/html/2307.14743v2)
- [CrisperWhisper, arXiv 2408.16589](https://arxiv.org/abs/2408.16589)
- [Swiss German honest baseline & contamination, arXiv 2606.07608](https://arxiv.org/html/2606.07608v1)
- [Anglicism G2P for German ASR, arXiv 2105.12708](https://arxiv.org/abs/2105.12708)
- [ASR Bundestag, arXiv 2302.06008](https://arxiv.org/abs/2302.06008) · [MLS](https://ar5iv.labs.arxiv.org/html/2012.03411) · [VoxPopuli](https://ar5iv.labs.arxiv.org/html/2101.00390) · [FLEURS](https://ar5iv.labs.arxiv.org/html/2205.12446) · [Whisper](https://ar5iv.labs.arxiv.org/html/2212.04356)
- [LLM generative error correction, arXiv 2505.17410](https://arxiv.org/abs/2505.17410) · [Revisiting ASR error correction, arXiv 2405.15216](https://arxiv.org/html/2405.15216)
- [Artificial Analysis STT methodology — English only](https://artificialanalysis.ai/speech-to-text/methodology)

### Model cards
- [primeline/parakeet-primeline](https://huggingface.co/primeline/parakeet-primeline) · [whisper-large-v3-turbo-german](https://huggingface.co/primeline/whisper-large-v3-turbo-german) · [whisper-large-v3-german](https://huggingface.co/primeline/whisper-large-v3-german) · [whisper-tiny-german-1224](https://huggingface.co/primeline/whisper-tiny-german-1224)
- [nvidia/parakeet-tdt-0.6b-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) · [canary-1b-v2](https://huggingface.co/nvidia/canary-1b-v2) · [stt_de_fastconformer_hybrid_large_pc](https://huggingface.co/nvidia/stt_de_fastconformer_hybrid_large_pc) · [stt_de_conformer_transducer_large](https://huggingface.co/nvidia/stt_de_conformer_transducer_large)
- [mistralai/Voxtral-Mini-4B-Realtime-2602](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602) · [Voxtral paper](https://arxiv.org/html/2507.13264v1) · [Voxtral Realtime paper](https://arxiv.org/html/2602.11298v1)
- [nyrahealth/CrisperWhisper](https://huggingface.co/nyrahealth/CrisperWhisper) · [openai/whisper-large-v3](https://huggingface.co/openai/whisper-large-v3) · [Banafo/Kroko-ASR](https://huggingface.co/Banafo/Kroko-ASR)
- [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1) · [pyannoteAI DER evaluation](https://www.pyannote.ai/blog/how-to-evaluate-speaker-diarization-performance)
- [flozi00/asr-german-mixed](https://huggingface.co/datasets/flozi00/asr-german-mixed)

### Corpora for a German eval set
- [TalkBank CallHome German (free)](https://talkbank.org/ca/access/CallHome/deu.html) · [LDC97S43 (paid original)](https://catalog.ldc.upenn.edu/LDC97S43)
- [DECM](https://github.com/enesyugan/DECM) · [Idiap German-English CS corpus](https://zenodo.org/records/4434251) · [Denglisch Corpus (text)](https://github.com/HaifaCLG/Denglisch)
- [Tuda-De / kaldi-tuda-de](https://github.com/uhh-lt/kaldi-tuda-de)

### Vendor documentation (claims, not measurements)
- [ElevenLabs realtime STT API](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime) · [Scribe v2](https://elevenlabs.io/blog/introducing-scribe-v2) · [Scribe v2 Realtime](https://elevenlabs.io/blog/introducing-scribe-v2-realtime)
- [Deepgram multilingual code-switching](https://developers.deepgram.com/docs/multilingual-code-switching) · [models & languages](https://developers.deepgram.com/docs/models-languages-overview) · [keyterm prompting](https://developers.deepgram.com/docs/keyterm)
- [AssemblyAI code-switching](https://www.assemblyai.com/docs/pre-recorded-audio/code-switching)
- [Speechmatics languages](https://docs.speechmatics.com/speech-to-text/languages) · [custom dictionary](https://docs.speechmatics.com/features/custom-dictionary) · [Melia](https://www.speechmatics.com/company/articles-and-news/introducing-melia-multilingual-speech-to-text-model)
- [Azure language identification](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-identification) · [Google Chirp 3](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3)
- [Mistral realtime transcription docs](https://docs.mistral.ai/capabilities/audio/speech_to_text/realtime_transcription) · [vLLM realtime STT](https://docs.vllm.ai/en/latest/examples/speech_to_text/realtime/) · [vLLM Voxtral recipe](https://recipes.vllm.ai/mistralai/Voxtral-Mini-4B-Realtime-2602) · [Red Hat runbook](https://developers.redhat.com/articles/2026/02/06/run-voxtral-mini-4b-realtime-vllm-red-hat-ai) · [third-party VRAM runbook](https://binaryverseai.com/voxtral-mini-4b-local-vllm-v1-realtime-runbook/)
- [Gladia Solaria-3](https://www.gladia.io/solaria-3) · [NeMo ASR models](https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/asr/models.html) · [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- Whisper code-switching failure threads: [openai/whisper#49](https://github.com/openai/whisper/discussions/49) · [#2285](https://github.com/openai/whisper/discussions/2285) · [transformers#27778](https://github.com/huggingface/transformers/issues/27778) · [faster-whisper#869](https://github.com/SYSTRAN/faster-whisper/issues/869)

### In-project measurements
- [audio_testing/wer_baseline.json](../audio_testing/wer_baseline.json) · [all-engine comparison](../audio_testing/results/compare_all_20260602_083940.md) · [Phase 3 realtime report](../audio_testing/results/phase3_realtime_report.md) · [accuracy loop log](../audio_testing/results/accuracy_loop_log.md) · [proofing pack](../audio_testing/proofing/README.md)
