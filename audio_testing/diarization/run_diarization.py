"""
Diarization eval loop: run pyannote over the clips, score against the
hand-corrected ground truth, sweep configs, report the best.

This reuses the SAME backend service the product uses
(backend/app/diarizer.py) so the harness measures the shipped pipeline, not a
parallel reimplementation.

Two modes:
  mixed     pyannote on the single mixed clip (mic+system together). Runnable on
            the existing clips. Measures raw speaker separation — the hard part.
  channels  the production target: trust the mic channel = the local speaker
            (perfect, zero error) and only run pyannote on the SYSTEM channel to
            separate remote participants. Requires split tracks
            clips/<clip>_mic.wav + clips/<clip>_system.wav (record with
            TANDEM_SAVE_RAW_TRACKS=1). Falls back with a clear message if absent.

Setup (one-time):
    pip install pyannote.audio torchaudio        # torch already present
    set HF_TOKEN=hf_...                          # accept community-1 model terms
    python run_diarization.py --hf-token %HF_TOKEN%

Usage:
    python run_diarization.py                     # sweep all configs, all clips
    python run_diarization.py --clips clip_02 --config n2
    python run_diarization.py --mode channels

Iteration loop: edit CONFIGS below (or add new ones), re-run, watch pooled WSA
climb toward ~100%. Each config is a set of pyannote knobs.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
# import the actual product diarizer
BACKEND_APP = HERE.parent.parent / "backend" / "app"
sys.path.insert(0, str(BACKEND_APP))

from diar_common import CLIPS, clip_wav, CLIPS_DIR, load_reference_words, DATA  # noqa: E402
from diar_metrics import Segment, score_words  # noqa: E402


# --- The tuning grid. Add/rename entries and re-run to iterate. --------------
CONFIGS = [
    {"name": "auto"},                                          # let pyannote decide
    {"name": "n2", "num_speakers": 2},                          # consultant 1:1
    {"name": "minmax_2_3", "min_speakers": 2, "max_speakers": 3},
    {"name": "minmax_2_5", "min_speakers": 2, "max_speakers": 5},
]


def segments_from_result(result: dict, label_prefix: str = "") -> list[Segment]:
    return [
        Segment(start=float(s["start"]), end=float(s["end"]),
                speaker=f"{label_prefix}{s['speaker']}")
        for s in result.get("segments", [])
    ]


async def diarize_mixed(clip: str, cfg: dict) -> list[Segment]:
    import diarizer
    result = await diarizer.diarize_audio(
        str(clip_wav(clip)),
        num_speakers=cfg.get("num_speakers"),
        min_speakers=cfg.get("min_speakers"),
        max_speakers=cfg.get("max_speakers"),
    )
    return segments_from_result(result)


async def diarize_channels(clip: str, cfg: dict) -> list[Segment]:
    """Channel-split target: mic = one guaranteed speaker (LOCAL); pyannote only
    separates the system channel (remote participants)."""
    import diarizer
    mic = CLIPS_DIR / f"{clip}_mic.wav"
    sysw = CLIPS_DIR / f"{clip}_system.wav"
    if not (mic.exists() and sysw.exists()):
        raise FileNotFoundError(
            f"channels mode needs {mic.name} + {sysw.name} in {CLIPS_DIR}.\n"
            f"Record with TANDEM_SAVE_RAW_TRACKS=1, or use --mode mixed."
        )
    # Mic: the local speaker. Trust it wholesale as a single speaker turn.
    import wave
    with wave.open(str(mic), "rb") as w:
        mic_dur = w.getnframes() / float(w.getframerate())
    local = [Segment(0.0, mic_dur, "LOCAL")]
    # System: separate remote speakers only.
    remote_cfg = dict(cfg)
    remote_cfg.pop("num_speakers", None)  # remote count is the unknown
    result = await diarizer.diarize_audio(
        str(sysw),
        min_speakers=cfg.get("min_speakers"),
        max_speakers=cfg.get("max_speakers"),
    )
    remote = segments_from_result(result, label_prefix="REMOTE_")
    return local + remote


async def run(mode: str, clips: list[str], configs: list[dict]) -> dict:
    diarize = diarize_channels if mode == "channels" else diarize_mixed
    # rows[config][clip] = ScoreResult
    rows: dict[str, dict] = {}
    for cfg in configs:
        rows[cfg["name"]] = {}
        for clip in clips:
            try:
                ref = load_reference_words(clip)
            except FileNotFoundError as e:
                print(f"  ! {clip}: {e}")
                continue
            segs = await diarize(clip, cfg)
            res = score_words(ref, segs)
            rows[cfg["name"]][clip] = res
            print(f"  [{cfg['name']:11s}] {clip}: {res.summary()}")
    return rows


def pooled_wsa(clip_results: dict) -> float:
    tot = sum(r.scored_words for r in clip_results.values())
    ok = sum(r.correct_words for r in clip_results.values())
    return ok / tot if tot else 0.0


def write_report(mode: str, rows: dict, out: Path) -> None:
    lines = [
        f"# Diarization eval — mode: {mode}",
        "",
        "Word Speaker Accuracy (WSA) = fraction of ground-truth words assigned",
        "the correct speaker (after optimal label mapping). Higher is better.",
        "",
        "| config | pooled WSA | per-clip WSA |",
        "|--------|-----------:|--------------|",
    ]
    best_name, best_val = None, -1.0
    for name, clip_results in rows.items():
        if not clip_results:
            continue
        pooled = pooled_wsa(clip_results)
        if pooled > best_val:
            best_name, best_val = name, pooled
        per = "  ".join(f"{c}:{r.wsa*100:.0f}%" for c, r in clip_results.items())
        lines.append(f"| {name} | {pooled*100:.1f}% | {per} |")
    lines += ["", f"**Best config:** `{best_name}` at {best_val*100:.1f}% pooled WSA."]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\nBest: {best_name} @ {best_val*100:.1f}% pooled WSA -> {out}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Diarization eval loop (pyannote vs ground truth).")
    ap.add_argument("--mode", choices=["mixed", "channels"], default="mixed")
    ap.add_argument("--clips", nargs="*", default=None)
    ap.add_argument("--config", default=None, help="run a single named config")
    ap.add_argument("--hf-token", default=os.environ.get("HF_TOKEN"))
    ap.add_argument("--cpu", action="store_true", help="force CPU")
    args = ap.parse_args()

    try:
        import diarizer
    except ImportError as e:
        sys.exit(f"pyannote/diarizer not importable: {e}\n"
                 f"Run: pip install pyannote.audio torchaudio")

    if not args.hf_token:
        sys.exit("Provide a HuggingFace token via --hf-token or $HF_TOKEN "
                 "(accept the pyannote/speaker-diarization-community-1 terms).")

    print(f"Data dir: {DATA}")
    print("Loading pyannote model (first run downloads ~1GB) ...")
    if not diarizer.load_model(args.hf_token, use_gpu=not args.cpu):
        sys.exit("Failed to load diarization model (check token / model terms).")
    print(f"Model on: {diarizer.get_device()}")

    clips = args.clips or CLIPS
    configs = [c for c in CONFIGS if c["name"] == args.config] if args.config else CONFIGS
    if not configs:
        sys.exit(f"No config named {args.config!r}. Known: {[c['name'] for c in CONFIGS]}")

    rows = asyncio.run(run(args.mode, clips, configs))
    stamp = "_".join(clips) if args.clips else "all"
    write_report(args.mode, rows, HERE / "results" / f"eval_{args.mode}_{stamp}.md")


if __name__ == "__main__":
    main()
