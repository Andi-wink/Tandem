# Parakeet improvement backlog

Decision (2026-08-11): **stay on Parakeet TDT 0.6b v3 int8 for now.** Every item below is verified
through [wer_gate.py](wer_gate.py) against [wer_baseline.json](wer_baseline.json). Nothing is
"done" on a code review alone.

## Standing facts the loop must not forget

- **The gate is deterministic.** Two consecutive runs reproduced 21.54% pooled to 5 decimal places.
  Any movement is a real change, not noise from the engine. (Noise from the *clip set* is a
  different matter: 5 clips, one German, is statistically thin.)
- **Ground truth is ElevenLabs Scribe's own output** (`audio_testing/elevenlabs/*.txt`). So the
  metric is partly "how closely does Parakeet imitate Scribe", not purely "how accurate is
  Parakeet". Shared conventions (fillers, contractions, numerals) cancel for Scribe and are charged
  to Parakeet. **Treat every absolute number as an upper bound on true error, and be suspicious of
  any change that wins by imitating Scribe rather than by hearing better.** P3 addresses this.
- **The harness is a Python replica of the Rust engine**, not the Rust engine. It only tracks
  what ships while the two are kept in sync by hand. Divergence makes the gate lie.
- **The error profile is the diagnosis, and the figures I first wrote here were from the wrong
  engine.** ~~clip_07: S 42.3% vs D 6.3%, substitution-dominant~~ and ~~clip_10: D 19.7% vs
  S 1.4%~~ both came from [baseline_summary.md](results/baseline_summary.md#L16), whose line 3
  names the engine as **openai-whisper small**. They describe Whisper, not Parakeet, and they
  propagated from there into `research/german-calls-2026-08-11.md` and `To-do.md`. Corrected by
  QA recomputation against the pipeline the gate actually scores (2026-08-11):
  - **German (clip_07) is deletion / under-generation dominant, not substitution dominant.**
    The hypothesis is 107 words against a 142-word reference, so 35 deletions are forced before
    alignment even starts. 31 of 37 deletions fall in 4 contiguous blocks, including a single
    14-word drop at ref positions 100-113. Only 7 of 37 substitutions are near-misses (>=0.6
    similarity); the rest (`ob`->`sehr`, `da`->`wichtig`) are alignment noise around the gaps.
  - **English is NOT deletion-dominant on this pipeline.** clip_10 measures D 1.5%, not 19.7%.
  - **Consequence: the German problem is content loss, not orthography.** Normalisation
    (P1) can address at most ~4.9 pp of the 53.5 pp. Chase the dropped blocks first.
- **The German sample is too small to iterate on.** N=142 reference words, one 60-second clip, one
  meeting. Wilson 95% CI on 53.52% is **[45.33%, 61.52%]**, 16.2 pp wide; minimum detectable
  effect at 80% power is ~12 pp, needing 270-390 reference words. **Any German result under ~10 pp
  is noise.** Expanding the German clip set is a prerequisite for German work, not a nice-to-have.
- **The compiled domain wordlist is dead weight on this benchmark.** `apply_domain_corrections`
  fires on 0 of 16 buffers across all 5 scored clips. The only correction that fires anywhere is
  the phrase rule `N A N` -> `n8n` on clip_04 (worth +1.875 pp). Measure before extending it.
- **Parakeet cannot be steered by a language hint.** TDT v3 auto-detects and exposes no language
  token. Language only gates post-processing. Do not file items that assume otherwise.

## Priority queue

### P0 — Teach the harness about language, and report per-language WER
**Why first:** the Rust engine changed on 2026-08-11 to gate English-only domain correction on the
language preference (commit `8d11103`). The Python replica still applies it unconditionally, so the
gate can no longer model the German path at all, and pooled WER hides a 5x English/German gap
behind a single number.
- Add a `lang` field to [clips_index.json](clips_index.json) (clip_07 = `de`, rest = `en`).
- Thread a language through `postprocess()` mirroring `english_post_processing_applies()` in
  [parakeet_engine.rs](../frontend/src-tauri/src/parakeet_engine/parakeet_engine.rs).
- Report WER per language *and* pooled. Keep pooled for baseline continuity.
- **Success:** English-only and German-only WER are reported separately, and the German clip can be
  scored with `de` pinned (which should skip the English domain corrections).

### P1a — Expand the German clip set (NEW, now blocks all German work)
Raised by QA on iteration 1. At N=142 reference words the German measurement cannot resolve
anything smaller than ~12 pp, so P1/P3/P7 would all be chasing noise. Cut further German clips
from the existing recordings (`clips_index.json` already names the source meetings and offsets;
the 2026-08-04 German client call in `To-do.md` is another source), target 270-390 reference words
minimum, and produce references the same way the existing ones were made.
**Carries the ground-truth caveat**: new references cut the same way are still Scribe's output.

### P1b — Find the dropped German blocks (NEW, was P5, promoted)
The 14-word contiguous drop at ref positions 100-113 of clip_07, plus 3 more blocks, are 31 of the
37 deletions. Instrument the VAD/buffer path for that clip: which buffer boundary do the missing
words fall on, is the audio present in the segment, and does Parakeet emit nothing or does the
concatenation lose it? This is the single largest identified chunk of German error.

### P1 — German-aware normalisation, applied symmetrically
**Demoted after iteration 1**: addressable surface is ~4.9 pp of the 53.5 pp, not the bulk of it.
Still worth doing, but after P1a/P1b.
**Why:** the normaliser has no German equivalence classes, so pure orthography scores as error:
ß/ss, umlaut vs transliteration (`präsentation` / `praesentation`), and hyphen deletion splitting
compounds (`Web-Seite` -> 2 tokens vs `Webseite` -> 1, costing a substitution *and* an insertion).
German decimal commas split numbers (`3,5` -> `3` `5`).
- **Danger:** a normaliser change can lower WER without improving anything, by folding tokens away.
  It MUST be applied identically to reference and hypothesis, and must not delete content.
- **Success:** clip_07 WER drops, English clips move by roughly nothing, and QA confirms no
  token-destroying fold.

### P2 — Re-baseline and split the gate's tolerances by language
Once P0+P1 land, the 21.54% pooled baseline is stale. Re-baseline, and give German its own
tolerance so an English win cannot mask a German regression.

### P3 — Quantify the ground-truth bias
The loop is currently optimising toward Scribe. Measure how much of the gap is convention rather
than error: dump Parakeet/Scribe disagreements for the German clip, classify a sample by hand
(real error vs stylistic), and record the ratio. Cheaper than finishing the full proofing pack, and
it tells us how much of any future win is real.
- Related, currently blocked on human effort: `proofing/window*_TYPE_HERE.txt` are still the raw
  seeded live transcript, **not proofed**. Until someone corrects them against the audio there is
  no human ground truth anywhere in this repo.

### P4 — Domain vocabulary: delete it or make it earn its place
**Re-scoped by iteration 1 QA, which already did the "measure it first" step:** the fuzzy wordlist
fires on **0 of 16 buffers across all 5 clips**. Only the phrase rule (`N A N` -> `n8n`) ever
fires, once, worth +1.875 pp. So the 0.86-similarity fuzzy pass against every 4+ character token is
pure risk (it can corrupt German) for zero measured benefit on this benchmark.
Decide between: delete the fuzzy pass and keep the phrase rules; or keep it but only with a
user-editable SQLite list (reviewer-mandated in [To-do.md](../To-do.md#L237)) and a test that
demonstrates a win. Do not extend the compiled table.

### P5 — Chunk-boundary handling (English)
~~English deletions cluster at buffer joins~~ — that premise came from the Whisper table and is
false for this pipeline (clip_10 is D 1.5%, not 19.7%). English pooled is 12.08% with S 20 / D 25 /
I 13 over 480 words, which is not obviously boundary-shaped. Keep the item, but establish the
signature first rather than assuming it. The German block-drop investigation is P1b.

### P5b — Guard the Python/Rust replica against drift (NEW)
Both skeptics flagged it and one found the drift had already happened. `test_language_gating.py`
now covers the predicate, but nothing checks that the Python `postprocess` still mirrors
`transcribe_audio`'s post-processing as a whole. Cheap options: a golden-output test, or a
generated constants file. Without it the gate silently stops describing what ships.

### P6 — int8 vs fp32
Is quantisation costing accuracy? Only worth doing if an fp32 export is available locally; do not
download a model without checking disk headroom first (C: was under 5% free on 2026-08-11).

### P7 — Evaluate `primeline/parakeet-primeline` for German
CC-BY-4.0, 600M, ~2 GB, claims 2.95% German average. Same family, so it stays inside the
"Parakeet route" decision. Blocked on disk headroom and on P0-P2 (no point comparing models
through a measurement we do not trust).

## Done

_(nothing yet)_
