"""
Grid-tune the CLOUD flush profile (min_samples / silence-gap / max-block ceiling)
for Tandem's live ElevenLabs Scribe path, on held-out clips 11-16.

Reuses run_scribe_meeting_wer.run_clip (same VAD + buffer assembly + timestamp
overlap trim + response cache). For each candidate profile it reports pooled WER,
pooled S/D/I, total chunk count, and POOLED block-wait median/max (across every
chunk of all six clips, not a median of per-clip medians).

Goal: lowest median block wait whose pooled WER stays within +0.4pp of the
iteration-1 baseline (5.6% at min=12s / gap=1.2s / no-ceiling). API budget is
capped (cache makes repeats free); the driver aborts before exceeding it.

Run:
  .venv/Scripts/python.exe audio_testing/tune_scribe_flush_loop.py
  .venv/Scripts/python.exe audio_testing/tune_scribe_flush_loop.py --budget 200
"""

import argparse
import statistics
import sys

import run_scribe_meeting_wer as H

CLIPS = [f"clip_{n:02d}" for n in (11, 12, 13, 14, 15, 16)]
BASELINE_WER = 0.056  # iteration-1 pooled meeting WER (min 12s / gap 1.2s / no cap)
WER_TOLERANCE = 0.004  # +0.4pp


def run_profile(min_s, gap_s, max_wait_s):
    """Run all clips at one profile; return metrics + api-call delta."""
    profile = dict(min_samples=int(round(min_s * H.SR)),
                   gap_ms=int(round(gap_s * 1000.0)),
                   max_wait_ms=int(round(max_wait_s * 1000.0)))
    before = H._api_calls
    rows = [H.run_clip(stem, profile) for stem in CLIPS]
    delta = H._api_calls - before

    pm, (mS, mD, mI, mN) = H.pooled(rows, "meeting")
    all_durs = [d for r in rows for d in r["stats"]["durs"]]
    n_chunks = len(all_durs)
    block_med = statistics.median(all_durs) if all_durs else 0.0
    block_max = max(all_durs) if all_durs else 0.0
    return dict(min_s=min_s, gap_s=gap_s, max_wait_s=max_wait_s,
                wer=pm, S=mS, D=mD, I=mI, N=mN, n_chunks=n_chunks,
                block_med=block_med, block_max=block_max, api=delta)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=int, default=200,
                    help="max NEW API calls across the whole grid")
    args = ap.parse_args()

    # Candidate grid (min first, then refine gap/max-wait). Ordered so the most
    # informative configs run first; the driver stops before the API budget is
    # exceeded. Baseline included for an in-run reference row (free from cache).
    grid = [
        (12.0, 1.2, 0.0),   # iteration-1 baseline (cached)
        # Phase 1: vary min (fixed gap 0.8 / max-wait 6)
        (6.0, 0.8, 6.0),
        (4.0, 0.8, 6.0),
        (3.0, 0.8, 6.0),
        # Phase 2: refine gap / max-wait around the promising min values
        (4.0, 1.2, 6.0),
        (4.0, 0.8, 5.0),
        (4.0, 0.8, 8.0),
        (6.0, 0.8, 8.0),
        (3.0, 0.8, 5.0),
    ]

    results = []
    spent = 0
    for (min_s, gap_s, max_wait_s) in grid:
        if spent >= args.budget:
            print(f"\n[budget] Stopping: {spent} API calls spent (>= {args.budget}).",
                  file=sys.stderr)
            break
        r = run_profile(min_s, gap_s, max_wait_s)
        spent += r["api"]
        results.append(r)
        print(f"min={min_s:>4} gap={gap_s} max={max_wait_s:>3}  "
              f"WER={r['wer']*100:5.2f}%  S/D/I={r['S']}/{r['D']}/{r['I']}  "
              f"chunks={r['n_chunks']:>3}  block med/max={r['block_med']:5.1f}/"
              f"{r['block_max']:5.1f}s  (+{r['api']} api, {spent} total)")

    # Report
    print("\n" + "=" * 96)
    print(f"{'min':>4} {'gap':>4} {'max':>4} | {'WER':>6} | {'S/D/I':>10} | "
          f"{'chunks':>6} | {'blk_med':>7} | {'blk_max':>7} | within+0.4pp?")
    print("-" * 96)
    ok = []
    for r in results:
        within = r["wer"] <= BASELINE_WER + WER_TOLERANCE
        flag = "yes" if within else "NO"
        if within and r["min_s"] < 12.0:
            ok.append(r)
        print(f"{r['min_s']:>4} {r['gap_s']:>4} {r['max_wait_s']:>4} | "
              f"{r['wer']*100:5.2f}% | {r['S']}/{r['D']}/{r['I']:>2} | "
              f"{r['n_chunks']:>6} | {r['block_med']:6.1f}s | {r['block_max']:6.1f}s | {flag}")

    print("\nBaseline (iter-1): 5.6% WER, block med ~17-29s (per-clip).")
    if ok:
        # Winner = lowest median block wait among WER-acceptable configs;
        # tie-break on lower max block wait, then lower WER.
        winner = min(ok, key=lambda r: (round(r["block_med"], 1),
                                        round(r["block_max"], 1), r["wer"]))
        print(f"\nWINNER (within +0.4pp, lowest median block wait): "
              f"min={winner['min_s']}s gap={winner['gap_s']}s "
              f"max-wait={winner['max_wait_s']}s -> WER {winner['wer']*100:.2f}%, "
              f"block med {winner['block_med']:.1f}s / max {winner['block_max']:.1f}s")
    else:
        print("\nNo sub-12s config stayed within +0.4pp of baseline. "
              "Report the Pareto frontier and pick the best compromise.")
    print(f"\nTotal NEW API calls this grid: {spent}")


if __name__ == "__main__":
    sys.exit(main())
