# Speaker Diarization Eval Harness

Closed-loop harness to push Tandem's "who said what" accuracy toward ~100%.
You give it **perfect examples** (ground-truth speaker-labelled transcripts),
it runs the real product diarizer over the same audio, scores prediction vs
ground truth, and sweeps configs so you can iterate.

It reuses the shipped service `backend/app/diarizer.py` (pyannote
`speaker-diarization-community-1`) — the harness measures what production does,
not a parallel copy.

## The metric

**WSA — Word Speaker Accuracy**: fraction of ground-truth words assigned the
correct speaker, after an optimal one-to-one mapping between predicted labels
(`SPEAKER_00`, …) and reference labels. We score at the *word* level because
every transcript word carries a speaker badge in the UI. `WDER = 1 - WSA`
(lower is better, DER-like). Also reported: speaker-count error, per-speaker
recall. See [diar_metrics.py](diar_metrics.py) (`python diar_metrics.py` runs a
self-test with no deps).

## Approach under test: channel split + pyannote on system

Tandem captures **mic and system as separate channels**. For a consultant call
the mic channel *is* the local speaker — zero-error, no model needed. The hard
part is separating the remote participants on the system channel. So:

- `--mode mixed` — pyannote on the combined clip. Measures raw separation (the
  hard baseline). Runs on the existing clips today.
- `--mode channels` — the production target: mic ⇒ `LOCAL` (trusted), pyannote
  only on the system channel. Needs split tracks `clips/<clip>_mic.wav` +
  `clips/<clip>_system.wav` (record with `TANDEM_SAVE_RAW_TRACKS=1`).

## One-time setup

```bash
# torch is already installed; add pyannote + the STT client
pip install pyannote.audio torchaudio requests scipy

# HuggingFace token (accept the community-1 model terms on HF first)
set HF_TOKEN=hf_...
# ElevenLabs key for bootstrapping ground truth
set ELEVENLABS_API_KEY=...
```

Confidential audio (`clips/`, `elevenlabs/`) lives in the **main checkout**
(`D:/Dev-projects/Tandem/audio_testing`), which the harness finds automatically.
Override with `TANDEM_AUDIO_TESTING=<path>`.

## Workflow

### 1. Bootstrap ground truth from ElevenLabs, then correct it

```bash
python fetch_elevenlabs_refs.py               # -> refs/<clip>.diar.json + .turns.txt
```

Open each `refs/<clip>.turns.txt`, listen to the clip, and fix wrong speaker
tags / turn boundaries. Keep labels consistent per clip (e.g. `SPEAKER_0` =
the consultant everywhere). The harness scores `refs/<clip>.diar.json`, so apply
your corrections there. **This corrected file is the "perfect example".**
(`refs/` and `results/` are gitignored — client data never leaves the machine.)

### 2. Run the eval loop

```bash
python run_diarization.py                     # sweep configs on all clips (mixed)
python run_diarization.py --mode channels     # once split tracks exist
python run_diarization.py --clips clip_02 --config n2
```

Output: a per-clip + pooled WSA table per config, and the best config, written
to `results/eval_<mode>_<clips>.md`.

### 3. Iterate

Edit `CONFIGS` at the top of [run_diarization.py](run_diarization.py) to try new
pyannote settings (speaker-count hints, min/max bounds, and — as we extend the
diarizer — clustering thresholds, segment-merge gaps). Re-run, watch pooled WSA
climb. When mixed-mode plateaus, switch to `--mode channels` for the production
win (the mic side stops contributing errors entirely).

## Files

| file | role |
|------|------|
| [diar_metrics.py](diar_metrics.py) | scoring: word alignment, optimal label map, WSA/WDER, self-test |
| [diar_common.py](diar_common.py) | data-dir resolution, clip/ElevenLabs/ground-truth loaders |
| [fetch_elevenlabs_refs.py](fetch_elevenlabs_refs.py) | bootstrap ground truth from ElevenLabs Scribe |
| [run_diarization.py](run_diarization.py) | pyannote prediction + config sweep + report |
| `refs/` *(gitignored)* | ground-truth speaker transcripts — the perfect examples |
| `results/` *(gitignored)* | eval reports |
