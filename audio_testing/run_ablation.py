"""
Ablation: measure the WER impact of each proposed engine change, end-to-end
through the exact pipeline (real Silero VAD + buffer assembly + Parakeet).

Configs:
  C0  baseline                 current VAD,    1.5s buffer, no post-proc
  C1  + post-processing        current VAD,    1.5s buffer, reps+domain   (#1, #3)
  C2  + catch-all VAD          lenient VAD,    1.5s buffer, reps+domain   (#4)
  C3  + long context window    lenient VAD,   ~12s buffer,  reps+domain   (#4,#5)

Run: python audio_testing/run_ablation.py
"""

import sys
from pathlib import Path
import numpy as np

from run_tandem_parakeet import (
    ParakeetModel, MODEL_DIR, CLIPS, CLIPS_DIR, REF_DIR,
    read_wav_16k_mono, normalize, wer_align, postprocess,
)
from silero_vad import vad_segments_for_clip, assemble_buffers

OUT_DIR = Path(__file__).parent / "parakeet_out"

VAD_CATCHALL = dict(positive=0.35, negative=0.20, pre_pad_ms=400,
                    post_pad_ms=350, redemption_ms=600, min_speech_ms=150)
# Sensitive: closes the onset-clipping gap (bigger pre-pad, slightly lower
# positive threshold) without the over-capture of catch-all.
VAD_SENSITIVE = dict(positive=0.45, negative=0.35, pre_pad_ms=500,
                     post_pad_ms=300, redemption_ms=500, min_speech_ms=200)

CONFIGS = [
    dict(name="C0 baseline",          vad=None,          min_s=1.5,  reps=False, domain=False, gentle=True),
    dict(name="C1 gentle-reps",       vad=None,          min_s=1.5,  reps=True,  domain=True,  gentle=True),
    dict(name="C4 +long-window",      vad=None,          min_s=12.0, reps=True,  domain=True,  gentle=True),
    dict(name="C5 +sensVAD+long",     vad=VAD_SENSITIVE, min_s=12.0, reps=True,  domain=True,  gentle=True),
]


def run_config(model, cfg, seg_cache):
    tS = tD = tI = tN = 0
    per = []
    tot_speech = 0.0
    for stem in CLIPS:
        ref = normalize((REF_DIR / f"{stem}.txt").read_text(encoding="utf-8"))
        segs = seg_cache[(stem, id(cfg["vad"]))]
        buffers = assemble_buffers(segs, min_samples=int(cfg["min_s"] * 16000))
        speech_s = sum(len(b) for b in buffers) / 16000.0
        tot_speech += speech_s
        parts = []
        for b in buffers:
            txt = model.transcribe(np.asarray(b, dtype=np.float32))[0]
            parts.append(postprocess(txt, do_reps=cfg["reps"], do_domain=cfg["domain"],
                                      gentle=cfg.get("gentle", True)))
        hyp = " ".join(p.strip() for p in parts if p.strip())
        S, D, I, N = wer_align(ref, normalize(hyp))
        per.append((stem, (S + D + I) / max(N, 1), S, D, I, speech_s))
        tS += S; tD += D; tI += I; tN += N
    return per, (tS + tD + tI) / max(tN, 1), (tS, tD, tI, tN), tot_speech


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    model = ParakeetModel(MODEL_DIR)

    # Cache VAD segmentation per (clip, vad-config) so we don't re-run VAD per config
    samples = {stem: read_wav_16k_mono(CLIPS_DIR / f"{stem}.wav") for stem in CLIPS}
    seg_cache = {}
    for cfg in CONFIGS:
        key_id = id(cfg["vad"])
        for stem in CLIPS:
            if (stem, key_id) not in seg_cache:
                seg_cache[(stem, key_id)] = vad_segments_for_clip(samples[stem], cfg["vad"])

    results = []
    for cfg in CONFIGS:
        per, agg, (tS, tD, tI, tN), speech = run_config(model, cfg, seg_cache)
        results.append((cfg, per, agg, (tS, tD, tI, tN), speech))
        print(f"\n### {cfg['name']}: WER={agg*100:.1f}%  "
              f"(S={tS} D={tD} I={tI} N={tN})  speech={speech:.0f}s/300s")
        for stem, w, S, D, I, sp in per:
            print(f"    {stem}: {w*100:5.1f}%  (S={S} D={D} I={I})")

    # report
    lines = ["# Parakeet engine-improvement ablation (exact pipeline)\n",
             "WER vs ElevenLabs, pooled over 5×60s clips. Lower is better. "
             "Total speech detected by VAD (of 300s) shown to track #4 'catch all speech'.\n",
             "\n| Config | Pooled WER | Subs | Del | Ins | Speech kept |",
             "|--------|-----------|------|-----|-----|-------------|"]
    for (cfg, per, agg, (tS, tD, tI, tN), speech) in results:
        lines.append(f"| {cfg['name']} | **{agg*100:.1f}%** | {tS} | {tD} | {tI} | "
                     f"{speech:.0f}s / 300s |")
    lines.append("\n## Per-clip WER by config\n")
    lines.append("| Clip | " + " | ".join(c["name"] for c in CONFIGS) + " |")
    lines.append("|------|" + "|".join("------" for _ in CONFIGS) + "|")
    for idx, stem in enumerate(CLIPS):
        cells = [f"{results[ci][1][idx][1]*100:.1f}%" for ci in range(len(CONFIGS))]
        lines.append(f"| {stem} | " + " | ".join(cells) + " |")
    (OUT_DIR / "wer_ablation_report.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"\nReport: {OUT_DIR / 'wer_ablation_report.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
