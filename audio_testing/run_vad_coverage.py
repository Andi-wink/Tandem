"""
Does the VAD drop real speech? (#4 verification)

For each clip, take ElevenLabs word-level timestamps (ground truth) and measure
the fraction of words whose center time falls inside a VAD-detected speech
segment. 100% => VAD keeps all speech; lower => VAD is gating real words.

Compares current vad.rs config vs a lenient "catch-all" config.
"""
import json
from pathlib import Path

from run_tandem_parakeet import CLIPS, CLIPS_DIR, REF_DIR, read_wav_16k_mono
from silero_vad import vad_segments_for_clip
from run_ablation import VAD_CATCHALL

HERE = Path(__file__).parent


def words_with_times(stem):
    d = json.load(open(REF_DIR / f"{stem}.json", encoding="utf-8"))
    return [(w["text"], w["start"], w["end"]) for w in d["words"]
            if w.get("type") == "word"]


def coverage(stem, samples, vad_cfg):
    segs = vad_segments_for_clip(samples, vad_cfg)
    spans = [(s / 1000.0, e / 1000.0) for (s, e, _) in segs]
    words = words_with_times(stem)
    covered = 0
    missed = []
    for (txt, ws, we) in words:
        mid = (ws + we) / 2.0
        if any(s <= mid <= e for (s, e) in spans):
            covered += 1
        else:
            missed.append(txt)
    speech_s = sum(e - s for (s, e) in spans)
    return covered, len(words), speech_s, missed


def main():
    print(f"{'clip':10} {'cfg':9} {'coverage':>10} {'speech':>8}  missed words")
    for stem in CLIPS:
        samples = read_wav_16k_mono(CLIPS_DIR / f"{stem}.wav")
        for name, cfg in (("current", None), ("catchall", VAD_CATCHALL)):
            cov, tot, sp, missed = coverage(stem, samples, cfg)
            pct = 100.0 * cov / max(tot, 1)
            ex = " ".join(missed[:12])
            print(f"{stem:10} {name:9} {cov:4}/{tot:<4} {pct:5.1f}% {sp:6.1f}s  {ex}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
