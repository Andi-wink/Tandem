"""
Exact meeting-condition WER for Tandem's current engine (shipped config).

Pipeline reproduced end-to-end:
  clip (16k mono)
    -> Silero VAD (real silero_vad.onnx, vad.rs config)                [silero_vad.py]
    -> transcription-buffer assembly (12s min / 1.2s gap, pipeline.rs) [silero_vad.py]
    -> Parakeet TDT v3 int8 per buffer (exact ONNX + decode)           [run_tandem_parakeet.py]
    -> post-process (de-stutter always; English domain correction only when the
       pinned language is English-ish, mirroring parakeet_engine.rs)  [run_tandem_parakeet.py]
    -> concatenate buffer transcripts in order
  vs ElevenLabs ground truth -> WER, pooled AND per language.

Clip languages come from the `lang` field in clips_index.json (clip_07 = de).

This module also exposes evaluate() so the regression gate (wer_gate.py) scores
the exact same pipeline.

Run:  python audio_testing/run_tandem_meeting_wer.py
      python audio_testing/run_tandem_meeting_wer.py --pin-language
      python audio_testing/run_tandem_meeting_wer.py --clips clip_07
"""

import json
import sys
from pathlib import Path

import numpy as np

from run_tandem_parakeet import (
    ParakeetModel, MODEL_DIR, CLIPS, CLIPS_DIR, REF_DIR,
    read_wav_16k_mono, normalize, wer_align, postprocess,
)
from silero_vad import vad_segments_for_clip, assemble_buffers
from run_ablation import VAD_SENSITIVE

HERE = Path(__file__).parent
OUT_DIR = HERE / "parakeet_out"
CLIPS_INDEX = HERE / "clips_index.json"

# Mirror the SHIPPED Rust engine config (post #1/#3/#4/#5 changes).
SHIPPED_VAD = VAD_SENSITIVE          # vad.rs + pipeline.rs redemption
SHIPPED_MIN_SAMPLES = 25 * 16000     # MIN_TRANSCRIPTION_SAMPLES (#5; 12s->25s, exp E6)

DEFAULT_LANG = "en"
# clips_index.json is gitignored (it embeds local recording paths), so a fresh
# checkout has no language metadata at all. This keeps the one known non-English
# clip labelled correctly in that case; the index file wins whenever it exists.
FALLBACK_CLIP_LANGS = {"clip_07": "de"}


def clip_languages():
    """Map clip stem -> ISO-639-1 language from clips_index.json.

    Falls back to FALLBACK_CLIP_LANGS / DEFAULT_LANG when the (gitignored) index
    is missing or an entry carries no `lang` field.
    """
    langs = dict(FALLBACK_CLIP_LANGS)
    if CLIPS_INDEX.exists():
        try:
            for entry in json.loads(CLIPS_INDEX.read_text(encoding="utf-8")):
                stem = str(entry.get("clip", "")).rsplit(".", 1)[0]
                if stem and entry.get("lang"):
                    langs[stem] = str(entry["lang"])
        except (ValueError, TypeError, AttributeError, OSError) as e:
            print(f"[lang] WARN: cannot read {CLIPS_INDEX}: {e}", file=sys.stderr)
    return langs


def clip_language(stem, langs=None):
    return (langs if langs is not None else clip_languages()).get(stem, DEFAULT_LANG)


def transcribe_clip(model, stem, write_hyp=False, language=None):
    """Run one clip through the full shipped pipeline; return (hyp, stats).

    `language` is the pinned user preference handed to postprocess(), mirroring
    ParakeetEngine::transcribe_audio(audio, language). None = unpinned, which is
    what the shipped default (and the gate baseline) scores.
    """
    samples = read_wav_16k_mono(CLIPS_DIR / f"{stem}.wav")
    segs = vad_segments_for_clip(samples, SHIPPED_VAD)
    buffers = assemble_buffers(segs, min_samples=SHIPPED_MIN_SAMPLES)
    parts = [postprocess(model.transcribe(np.asarray(b, dtype=np.float32))[0],
                         language=language)
             for b in buffers]
    hyp = " ".join(p.strip() for p in parts if p.strip())
    if write_hyp:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        (OUT_DIR / f"{stem}.meeting.txt").write_text(hyp, encoding="utf-8")
    return hyp, dict(n_segs=len(segs), n_buffers=len(buffers),
                     speech_s=sum(len(b) for b in buffers) / 16000.0)


def evaluate(model=None, write_hyp=False, clip_list=None, pin_language=False):
    """Score the shipped pipeline on all clips.

    Returns dict: {pooled, totals:{S,D,I,N}, clips:{stem:{wer,S,D,I,N,lang,...}},
                   by_lang:{lang:{wer,S,D,I,N,clips:[...]}}, langs, pin_language}.
    `pooled`, `totals` and `clips` keep their existing shape/values so
    wer_gate.py and wer_baseline.json continue to work unchanged.

    `clip_list` overrides the default CLIPS set (e.g. the held-out clip_11..16).
    `pin_language` selects what is handed to the engine's post-processing:
      False (default) -> language=None for every clip, i.e. the shipped "auto"
                         behaviour the 21.543% baseline was measured under;
      True            -> each clip's language from clips_index.json, so the
                         German clip skips the English domain corrections.
    Language *grouping* happens either way, so per-language WER is always reported.
    """
    if model is None:
        model = ParakeetModel(MODEL_DIR)
    stems = clip_list if clip_list is not None else CLIPS
    langs = clip_languages()
    clips = {}
    tS = tD = tI = tN = 0
    per_lang = {}
    for stem in stems:
        lang = clip_language(stem, langs)
        ref = normalize((REF_DIR / f"{stem}.txt").read_text(encoding="utf-8"))
        hyp, stats = transcribe_clip(model, stem, write_hyp=write_hyp,
                                     language=lang if pin_language else None)
        S, D, I, N = wer_align(ref, normalize(hyp))
        clips[stem] = dict(wer=(S + D + I) / max(N, 1), S=S, D=D, I=I, N=N,
                           lang=lang, **stats)
        tS += S; tD += D; tI += I; tN += N
        g = per_lang.setdefault(lang, dict(S=0, D=0, I=0, N=0, clips=[]))
        g["S"] += S; g["D"] += D; g["I"] += I; g["N"] += N
        g["clips"].append(stem)
    for g in per_lang.values():
        g["wer"] = (g["S"] + g["D"] + g["I"]) / max(g["N"], 1)
    return dict(pooled=(tS + tD + tI) / max(tN, 1),
                totals=dict(S=tS, D=tD, I=tI, N=tN), clips=clips,
                by_lang=per_lang,
                langs={s: clips[s]["lang"] for s in clips},
                pin_language=pin_language)


def format_by_lang(res):
    """Per-language WER lines (shared by this script and wer_gate.py)."""
    out = []
    for lang in sorted(res.get("by_lang", {})):
        g = res["by_lang"][lang]
        out.append(f"  {lang}: {g['wer']*100:5.1f}%  (S={g['S']} D={g['D']} I={g['I']} "
                   f"N={g['N']}, {len(g['clips'])} clip(s): {', '.join(g['clips'])})")
    return out


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--pin-language", action="store_true",
                    help="hand each clip's clips_index.json language to the engine "
                         "post-processing (German clips then skip English domain "
                         "correction). Default: unpinned, matching the shipped default "
                         "and the wer_baseline.json numbers.")
    ap.add_argument("--clips", help="comma-separated clip stems to score instead of the default set")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Model: {MODEL_DIR}")
    clip_list = [s.strip() for s in args.clips.split(",")] if args.clips else None
    res = evaluate(write_hyp=True, clip_list=clip_list, pin_language=args.pin_language)
    stems = clip_list if clip_list is not None else CLIPS
    mode = "pinned per clips_index.json" if args.pin_language else "unpinned (auto)"

    lines = ["# Tandem meeting-condition WER (exact pipeline, shipped config)\n",
             "**Engine:** Parakeet TDT 0.6b v3 int8. **Reference:** ElevenLabs Scribe v1.\n",
             "**Config:** sensitive VAD (pos .45 / pre 500 / post 300 / redemption 500 / "
             "min-speech 200) -> 12s buffer / 1.2s gap -> Parakeet -> de-stutter + domain.\n",
             f"**Language preference:** {mode}. De-stutter always runs; the English "
             "domain/phrase correction only runs when the pinned language is English-ish "
             "(mirrors `english_post_processing_applies` in parakeet_engine.rs).\n",
             "\n| Clip | Lang | Ref words | WER | S/D/I | VAD segs | Buffers | Speech |",
             "|------|------|-----------|-----|-------|----------|---------|--------|"]
    for stem in stems:
        c = res["clips"][stem]
        print(f"=== {stem} [{c['lang']}] ===  WER={c['wer']*100:.1f}%  (S={c['S']} D={c['D']} "
              f"I={c['I']} N={c['N']})  {c['n_buffers']} buffers, speech {c['speech_s']:.1f}s")
        lines.append(f"| {stem} | {c['lang']} | {c['N']} | **{c['wer']*100:.1f}%** | "
                     f"{c['S']}/{c['D']}/{c['I']} | {c['n_segs']} | {c['n_buffers']} | "
                     f"{c['speech_s']:.1f}s |")
    t = res["totals"]
    lines.append(f"| **POOLED** | all | {t['N']} | **{res['pooled']*100:.1f}%** | "
                 f"{t['S']}/{t['D']}/{t['I']} | — | — | — |")
    lines.append("\n| Language | Clips | Ref words | WER | S/D/I |")
    lines.append("|----------|-------|-----------|-----|-------|")
    for lang in sorted(res["by_lang"]):
        g = res["by_lang"][lang]
        lines.append(f"| {lang} | {len(g['clips'])} | {g['N']} | **{g['wer']*100:.1f}%** | "
                     f"{g['S']}/{g['D']}/{g['I']} |")
    lines.append(f"\n**Pooled meeting-condition WER: {res['pooled']*100:.1f}%**")
    (OUT_DIR / "wer_meeting_report.md").write_text("\n".join(lines), encoding="utf-8")

    print("\n" + "=" * 60)
    print(f"POOLED meeting-condition WER: {res['pooled']*100:.1f}%   [{mode}]")
    print("Per-language WER:")
    for line in format_by_lang(res):
        print(line)
    print(f"Report: {OUT_DIR / 'wer_meeting_report.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
