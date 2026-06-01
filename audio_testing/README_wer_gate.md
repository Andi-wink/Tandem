# Transcription WER regression gate

Scores Tandem's current transcription engine (Parakeet TDT v3 int8) against
human-QC'd ElevenLabs ground truth and fails if word error rate regresses.

## Why

There were no automated quality metrics for transcription. This makes WER a
checkable number so engine / VAD / threshold / model changes are scored before
they ship, the same way unit tests guard logic.

## What it measures

The gate runs the **exact live pipeline** end-to-end:

```
clip.wav (16k mono)
  -> real Silero VAD            (silero_vad.onnx, vad.rs config)      silero_vad.py
  -> buffer assembly            (12s min / 1.2s silence gap)          silero_vad.py
  -> Parakeet TDT v3 int8       (same ONNX graphs + greedy TDT)       run_tandem_parakeet.py
  -> de-stutter + domain fix    (mirrors parakeet_engine.rs)          run_tandem_parakeet.py
  vs elevenlabs/*.txt           -> pooled + per-clip WER
```

Current baseline: **26.0% pooled** (English-only ~16%; the one German clip ~65%).

## Usage

```bash
# Check current engine vs committed baseline (exit 1 on regression)
python audio_testing/wer_gate.py

# Accept a new number as the baseline (after an intentional change)
python audio_testing/wer_gate.py --update-baseline

# Full per-clip report + transcripts written to parakeet_out/
python audio_testing/run_tandem_meeting_wer.py

# Compare improvement configs (ablation)
python audio_testing/run_ablation.py
```

Exit codes: `0` pass, `1` regression, `2` setup error (model/clips missing -> CI SKIP).

Tolerances (in `wer_baseline.json`): pooled regression > +1.5pp, or any single
clip > +5.0pp, fails the gate. Results are deterministic (greedy decode, CPU),
so a clean run reports +0.00pp.

## Requirements

- `onnxruntime`, `numpy` (already in the project venv).
- Parakeet model at `%APPDATA%\com.tandem.ai\models\parakeet\parakeet-tdt-0.6b-v3-int8\`.
- `silero_vad.onnx` from the `silero-rs` cargo checkout (auto-located).

If the model isn't present the gate exits `2` (SKIP), not `1`, so it won't break
machines that haven't downloaded it.

## Wiring into CI (not yet done — see To-do.md)

This is a **local** gate today. Before adding it to `.github/workflows/pr-main-check.yml`:

1. **Expand the clip set.** 5 clips (one German) is statistically noisy; per-clip
   swings of several points are sample noise. Target ~20-30 balanced clips so the
   pooled number is stable enough to gate on.
2. **CI model access.** The int8 encoder is 652MB and can't live in the repo. CI
   must download + cache it, or run this gate nightly / locally only.
3. **Score the real binary.** Today the gate scores a faithful Python replica of
   the Rust engine. A small `cargo run --bin transcribe_file <wav>` entry point
   would let the gate score the actually-shipped code instead of a mirror.
