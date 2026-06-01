"""
WER regression gate for Tandem's transcription engine.

Scores the shipped pipeline (run_tandem_meeting_wer.evaluate) against the
committed baseline in wer_baseline.json and fails (exit 1) on regression.

Usage:
  python audio_testing/wer_gate.py                 # check vs baseline, exit 1 on regress
  python audio_testing/wer_gate.py --update-baseline  # rerun and overwrite baseline
  python audio_testing/wer_gate.py --json          # machine-readable result on stdout

Exit codes:
  0  pass (within tolerance) or baseline updated
  1  regression beyond tolerance
  2  setup error (model/clips/ground-truth missing) -> CI should treat as SKIP

Tolerances (absolute WER percentage points):
  pooled regression      > +1.5   -> fail
  any single-clip regress > +5.0  -> fail

NOTE: this scores the faithful Python replica of the Rust engine. It tracks the
shipped code only while the two are kept in sync (see To-do.md for the planned
Rust --transcribe-file entry point that would let the gate score the real binary).
The benchmark is currently 5 clips (one German) and is statistically noisy; expand
the clip set before wiring this into PR CI. See README_wer_gate.md.
"""

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
BASELINE = HERE / "wer_baseline.json"

POOLED_TOL = 0.015      # +1.5 pp
PER_CLIP_TOL = 0.050    # +5.0 pp


def _load_evaluator():
    try:
        from run_tandem_meeting_wer import evaluate, MODEL_DIR, CLIPS_DIR
        if not Path(MODEL_DIR).exists():
            print(f"[gate] SKIP: Parakeet model not found at {MODEL_DIR}", file=sys.stderr)
            return None
        if not any((CLIPS_DIR).glob("clip_*.wav")):
            print(f"[gate] SKIP: no clips in {CLIPS_DIR}", file=sys.stderr)
            return None
        return evaluate
    except Exception as e:  # missing deps (onnxruntime/numpy) etc.
        print(f"[gate] SKIP: cannot load evaluator: {e}", file=sys.stderr)
        return None


def _write_baseline(res):
    payload = {
        "pooled": round(res["pooled"], 5),
        "clips": {k: round(v["wer"], 5) for k, v in res["clips"].items()},
        "tolerances": {"pooled_pp": POOLED_TOL, "per_clip_pp": PER_CLIP_TOL},
        "note": "Pooled+per-clip WER vs ElevenLabs ground truth, shipped engine config. "
                "Regenerate with: python audio_testing/wer_gate.py --update-baseline",
    }
    BASELINE.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--update-baseline", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    evaluate = _load_evaluator()
    if evaluate is None:
        return 2

    res = evaluate()
    pooled = res["pooled"]

    if args.update_baseline:
        _write_baseline(res)
        print(f"[gate] baseline updated: pooled WER {pooled*100:.2f}%")
        return 0

    if not BASELINE.exists():
        print("[gate] no baseline found; create one with --update-baseline", file=sys.stderr)
        return 2

    base = json.loads(BASELINE.read_text(encoding="utf-8"))
    pooled_tol = base.get("tolerances", {}).get("pooled_pp", POOLED_TOL)
    clip_tol = base.get("tolerances", {}).get("per_clip_pp", PER_CLIP_TOL)

    failures = []
    pooled_delta = pooled - base["pooled"]
    if pooled_delta > pooled_tol:
        failures.append(f"pooled WER {pooled*100:.2f}% vs baseline {base['pooled']*100:.2f}% "
                        f"(+{pooled_delta*100:.2f}pp > {pooled_tol*100:.1f}pp)")
    per_clip = []
    for stem, c in res["clips"].items():
        b = base["clips"].get(stem)
        if b is None:
            continue
        d = c["wer"] - b
        per_clip.append((stem, c["wer"], b, d))
        if d > clip_tol:
            failures.append(f"{stem} WER {c['wer']*100:.1f}% vs {b*100:.1f}% "
                            f"(+{d*100:.1f}pp > {clip_tol*100:.0f}pp)")

    # report
    print(f"\nPooled WER: {pooled*100:.2f}%  (baseline {base['pooled']*100:.2f}%, "
          f"delta {pooled_delta*100:+.2f}pp)")
    for stem, w, b, d in per_clip:
        flag = "  <-- REGRESSION" if d > clip_tol else ("  (improved)" if d < -0.005 else "")
        print(f"  {stem}: {w*100:5.1f}%  (baseline {b*100:5.1f}%, {d*100:+.1f}pp){flag}")

    if args.json:
        print(json.dumps({"pooled": pooled, "baseline": base["pooled"],
                          "pooled_delta": pooled_delta,
                          "clips": {s: c["wer"] for s, c in res["clips"].items()},
                          "pass": not failures}))

    if failures:
        print("\n[gate] FAIL — WER regressed:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        print("\nIf this change is an intentional/accepted trade-off, re-baseline with:\n"
              "  python audio_testing/wer_gate.py --update-baseline", file=sys.stderr)
        return 1

    improved = pooled_delta < -POOLED_TOL
    print(f"\n[gate] PASS{' — pooled improved, consider re-baselining' if improved else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
