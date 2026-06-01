"""
Exact meeting-condition WER for Tandem's current engine (shipped config).

Pipeline reproduced end-to-end:
  clip (16k mono)
    -> Silero VAD (real silero_vad.onnx, vad.rs config)                [silero_vad.py]
    -> transcription-buffer assembly (12s min / 1.2s gap, pipeline.rs) [silero_vad.py]
    -> Parakeet TDT v3 int8 per buffer (exact ONNX + decode)           [run_tandem_parakeet.py]
    -> post-process (de-stutter + domain correction)                  [run_tandem_parakeet.py]
    -> concatenate buffer transcripts in order
  vs ElevenLabs ground truth -> WER.

This module also exposes evaluate() so the regression gate (wer_gate.py) scores
the exact same pipeline.

Run:  python audio_testing/run_tandem_meeting_wer.py
"""

import sys
from pathlib import Path

import numpy as np

from run_tandem_parakeet import (
    ParakeetModel, MODEL_DIR, CLIPS, CLIPS_DIR, REF_DIR,
    read_wav_16k_mono, normalize, wer_align, postprocess,
)
from silero_vad import vad_segments_for_clip, assemble_buffers
from run_ablation import VAD_SENSITIVE

OUT_DIR = Path(__file__).parent / "parakeet_out"

# Mirror the SHIPPED Rust engine config (post #1/#3/#4/#5 changes).
SHIPPED_VAD = VAD_SENSITIVE          # vad.rs + pipeline.rs redemption
SHIPPED_MIN_SAMPLES = 25 * 16000     # MIN_TRANSCRIPTION_SAMPLES (#5; 12s->25s, exp E6)


def transcribe_clip(model, stem, write_hyp=False):
    """Run one clip through the full shipped pipeline; return (hyp, stats)."""
    samples = read_wav_16k_mono(CLIPS_DIR / f"{stem}.wav")
    segs = vad_segments_for_clip(samples, SHIPPED_VAD)
    buffers = assemble_buffers(segs, min_samples=SHIPPED_MIN_SAMPLES)
    parts = [postprocess(model.transcribe(np.asarray(b, dtype=np.float32))[0])
             for b in buffers]
    hyp = " ".join(p.strip() for p in parts if p.strip())
    if write_hyp:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        (OUT_DIR / f"{stem}.meeting.txt").write_text(hyp, encoding="utf-8")
    return hyp, dict(n_segs=len(segs), n_buffers=len(buffers),
                     speech_s=sum(len(b) for b in buffers) / 16000.0)


def evaluate(model=None, write_hyp=False):
    """Score the shipped pipeline on all clips.

    Returns dict: {pooled, totals:{S,D,I,N}, clips:{stem:{wer,S,D,I,N,...}}}.
    """
    if model is None:
        model = ParakeetModel(MODEL_DIR)
    clips = {}
    tS = tD = tI = tN = 0
    for stem in CLIPS:
        ref = normalize((REF_DIR / f"{stem}.txt").read_text(encoding="utf-8"))
        hyp, stats = transcribe_clip(model, stem, write_hyp=write_hyp)
        S, D, I, N = wer_align(ref, normalize(hyp))
        clips[stem] = dict(wer=(S + D + I) / max(N, 1), S=S, D=D, I=I, N=N, **stats)
        tS += S; tD += D; tI += I; tN += N
    return dict(pooled=(tS + tD + tI) / max(tN, 1),
                totals=dict(S=tS, D=tD, I=tI, N=tN), clips=clips)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Model: {MODEL_DIR}")
    res = evaluate(write_hyp=True)

    lines = ["# Tandem meeting-condition WER (exact pipeline, shipped config)\n",
             "**Engine:** Parakeet TDT 0.6b v3 int8. **Reference:** ElevenLabs Scribe v1.\n",
             "**Config:** sensitive VAD (pos .45 / pre 500 / post 300 / redemption 500 / "
             "min-speech 200) -> 12s buffer / 1.2s gap -> Parakeet -> de-stutter + domain.\n",
             "\n| Clip | Ref words | WER | S/D/I | VAD segs | Buffers | Speech |",
             "|------|-----------|-----|-------|----------|---------|--------|"]
    for stem in CLIPS:
        c = res["clips"][stem]
        print(f"=== {stem} ===  WER={c['wer']*100:.1f}%  (S={c['S']} D={c['D']} I={c['I']} "
              f"N={c['N']})  {c['n_buffers']} buffers, speech {c['speech_s']:.1f}s")
        lines.append(f"| {stem} | {c['N']} | **{c['wer']*100:.1f}%** | "
                     f"{c['S']}/{c['D']}/{c['I']} | {c['n_segs']} | {c['n_buffers']} | "
                     f"{c['speech_s']:.1f}s |")
    t = res["totals"]
    lines.append(f"| **POOLED** | {t['N']} | **{res['pooled']*100:.1f}%** | "
                 f"{t['S']}/{t['D']}/{t['I']} | — | — | — |")
    lines.append(f"\n**Pooled meeting-condition WER: {res['pooled']*100:.1f}%**")
    (OUT_DIR / "wer_meeting_report.md").write_text("\n".join(lines), encoding="utf-8")

    print("\n" + "=" * 60)
    print(f"POOLED meeting-condition WER: {res['pooled']*100:.1f}%")
    print(f"Report: {OUT_DIR / 'wer_meeting_report.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
