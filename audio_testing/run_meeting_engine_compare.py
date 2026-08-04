#!/usr/bin/env python
"""Score the SHIPPED realtime transcript of real meetings against batch Scribe.

Andrew is running `scribe_v2_realtime` (streaming WS, ~27s commit interval with a
32s force cutoff) as his daily driver. This asks the first-pass question: how far
does that live transcript drift from what the OLD path's engine produces when it
sees the whole recording at once?

  <meeting>/audio.mp4                     (mixed mic+system, as recorded)
      -> ffmpeg -> 16k mono wav
      -> ONE POST to scribe_v2 (batch)                   = REFERENCE
  <meeting>/transcripts.json              (what the live engine actually emitted)
      -> all segments, both streams, ordered by audio_start_time
      -> concatenated                                    = HYPOTHESIS
  same normalize() + wer_align() as every other harness here -> S/D/I/N

REFERENCE CAVEAT: batch Scribe is a PROXY for truth, not truth. It also errs, and
it reads the MIXED track while the live engine transcribed each stream separately,
so overlapping speech is harder for the reference than for the hypothesis. Read
the output as "disagreement with batch", and hand-proof a clip before treating any
absolute number as WER.

Deletion runs (consecutive reference words the live transcript never produced) are
timestamped from the batch `words` array, because for a streaming engine WHERE it
dropped speech matters more than the pooled percentage.

Batch responses are cached under scribe_out/cache_meetings/ keyed by audio hash,
so re-runs cost nothing.

Run:
  py audio_testing/run_meeting_engine_compare.py                 # 4 most recent
  py audio_testing/run_meeting_engine_compare.py --limit 2
  py audio_testing/run_meeting_engine_compare.py --meeting "Meeting 2026-08-04_10-58-12_2026-08-04_09-58"
"""
import argparse
import hashlib
import json
import os
import subprocess
import sqlite3
import sys
import time
from pathlib import Path

import requests

from run_tandem_parakeet import normalize, wer_align

HERE = Path(__file__).parent
OUT_DIR = HERE / "scribe_out"
CACHE_DIR = OUT_DIR / "cache_meetings"
WORK_DIR = OUT_DIR / "meeting_wav"
RESULTS_DIR = HERE / "results"

SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text"
SCRIBE_MODEL = "scribe_v2"
DEFAULT_RECORDINGS = Path(os.path.expandvars(r"%USERPROFILE%\Music\tandem-recordings"))

_API_KEY = None


def get_api_key():
    """Read the ElevenLabs key from the app SQLite. Never printed or logged."""
    global _API_KEY
    if _API_KEY is not None:
        return _API_KEY
    db = os.path.expandvars(r"%APPDATA%\com.tandem.ai\meeting_minutes.sqlite")
    con = sqlite3.connect(db)
    try:
        row = con.execute("SELECT elevenLabsApiKey FROM transcript_settings").fetchone()
    finally:
        con.close()
    if not row or not row[0]:
        raise RuntimeError("No elevenLabsApiKey in transcript_settings")
    _API_KEY = row[0]
    return _API_KEY


def to_wav_16k_mono(src: Path, dest: Path) -> Path:
    """Downmix the recorded mp4 to the 16k mono wav the STT API wants."""
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
         "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(dest)],
        check=True,
    )
    return dest


def batch_transcribe(wav_path: Path):
    """One batch POST for a whole meeting. Cached by audio hash + model."""
    audio = wav_path.read_bytes()
    h = hashlib.sha256(audio + SCRIBE_MODEL.encode()).hexdigest()
    cache_file = CACHE_DIR / f"{h}.json"
    if cache_file.exists():
        d = json.loads(cache_file.read_text(encoding="utf-8"))
        return d.get("text", ""), d.get("words", []), True

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    resp = requests.post(
        SCRIBE_URL,
        headers={"xi-api-key": get_api_key()},
        data={"model_id": SCRIBE_MODEL},
        files={"file": (wav_path.name, audio, "audio/wav")},
        timeout=900,
    )
    resp.raise_for_status()
    body = resp.json()
    text = body.get("text", "") or ""
    words = body.get("words", []) or []
    cache_file.write_text(
        json.dumps({"text": text, "words": words, "api_latency_s": round(time.time() - t0, 2)}),
        encoding="utf-8",
    )
    return text, words, False


def ref_tokens_with_times(words):
    """Normalized reference tokens plus each token's start time (for deletion spans).

    Falls back to an empty time when the API returns a word without timing.
    """
    toks, times = [], []
    for w in words:
        if w.get("type") not in (None, "word"):
            continue
        for t in normalize(w.get("text", "")):
            toks.append(t)
            times.append(w.get("start"))
    return toks, times


def live_hypothesis(transcripts_json: Path):
    """Both streams, ordered by audio time, exactly as the meeting reads to a human."""
    data = json.loads(transcripts_json.read_text(encoding="utf-8"))
    segs = data.get("segments", [])
    ordered = sorted(
        segs,
        key=lambda s: (s.get("audio_start_time") if s.get("audio_start_time") is not None else 0.0,
                       s.get("sequence_id") or 0),
    )
    text = " ".join((s.get("text") or "").strip() for s in ordered if (s.get("text") or "").strip())
    return text, ordered


def align_ops(ref, hyp):
    """Levenshtein backtrace returning the op list, so deletion RUNS can be located."""
    n, m = len(ref), len(hyp)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = i
    for j in range(m + 1):
        dp[0][j] = j
    for i in range(1, n + 1):
        ri = ref[i - 1]
        row, prev = dp[i], dp[i - 1]
        for j in range(1, m + 1):
            cost = 0 if ri == hyp[j - 1] else 1
            row[j] = min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
    ops = []
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and dp[i][j] == dp[i - 1][j - 1] + (0 if ref[i - 1] == hyp[j - 1] else 1):
            ops.append(("eq" if ref[i - 1] == hyp[j - 1] else "sub", i - 1))
            i -= 1
            j -= 1
        elif i > 0 and dp[i][j] == dp[i - 1][j] + 1:
            ops.append(("del", i - 1))
            i -= 1
        else:
            ops.append(("ins", i))
            j -= 1
    ops.reverse()
    return ops


def deletion_runs(ops, ref, times, min_len=5, top=8):
    """Longest stretches of reference words the live transcript never emitted."""
    runs, cur = [], []
    for kind, idx in ops:
        if kind == "del":
            cur.append(idx)
        else:
            if len(cur) >= min_len:
                runs.append(cur)
            cur = []
    if len(cur) >= min_len:
        runs.append(cur)
    runs.sort(key=len, reverse=True)
    out = []
    for r in runs[:top]:
        start_t = next((times[i] for i in r if times[i] is not None), None)
        out.append({
            "words": len(r),
            "at": None if start_t is None else round(float(start_t), 1),
            "at_mmss": None if start_t is None else f"{int(start_t) // 60:02d}:{int(start_t) % 60:02d}",
            "text": " ".join(ref[i] for i in r[:25]) + ("…" if len(r) > 25 else ""),
        })
    return out


def covered_span(ops, anchor=4):
    """Index of the last reference word the live transcript genuinely reached.

    Everything after it is reference the live transcript never covered at all
    (engine stopped, stream died, app closed) rather than transcription error, and
    mixing the two into one WER hides a 10-minute data loss inside a percentage.

    Requires a RUN of `anchor` consecutive exact matches: across thousands of
    words, isolated function words ("so", "ja", "the") match by chance right to
    the end of the file and would otherwise report full coverage of a transcript
    that actually stopped a third of the way in.
    """
    last, run = -1, 0
    for kind, idx in ops:
        if kind == "eq":
            run += 1
            if run >= anchor:
                last = idx
        else:
            run = 0
    return last


def insertion_runs(ops, hyp, min_len=4):
    """Runs of hypothesis words with no reference counterpart, with hyp indices."""
    j = 0
    runs, cur = [], []
    for kind, _ in ops:
        if kind == "ins":
            cur.append(j)
            j += 1
        else:
            if len(cur) >= min_len:
                runs.append(cur)
            cur = []
            if kind in ("eq", "sub"):
                j += 1
    if len(cur) >= min_len:
        runs.append(cur)
    return [{"words": len(r), "text": " ".join(hyp[r[0]:r[-1] + 1])} for r in
            sorted(runs, key=len, reverse=True)]


def looping_words(runs, n=3):
    """Words inside insertion runs that are a phrase the run already said.

    Streaming ASR stutter ("i think it's a good idea" three times) is an engine
    artifact; genuinely missed speech in the reference is not. Counting them apart
    keeps the two from being read as one number.
    """
    total = 0
    for r in runs:
        w = r["text"].split()
        seen, dup = set(), 0
        for i in range(len(w) - n + 1):
            g = tuple(w[i:i + n])
            if g in seen:
                dup += 1
            seen.add(g)
        if dup:
            total += min(len(w), dup + n - 1)
    return total


def hyp_tokens_with_times(segs):
    """Live tokens with an approximate time each (words spread across the segment).

    Segment-level timing is all the live path records; for minute-sized buckets
    that is precise enough.
    """
    toks, times = [], []
    for s in segs:
        w = normalize(s.get("text") or "")
        if not w:
            continue
        a = float(s.get("audio_start_time") or 0.0)
        b = float(s.get("audio_end_time") or a)
        step = (b - a) / len(w) if len(w) > 1 and b > a else 0.0
        for k, t in enumerate(w):
            toks.append(t)
            times.append(a + k * step)
    return toks, times


def bucketed_wer(ref_toks, ref_times, hyp_toks, hyp_times, bucket=60.0):
    """WER computed inside time buckets instead of over the whole transcript.

    The live path transcribes mic and system SEPARATELY, so a segment from each
    speaker is emitted whole, while the mixed-track reference interleaves the two
    speakers word by word during crosstalk. Plain end-to-end Levenshtein charges
    that re-ordering as a wall of insertions AND deletions even when both
    transcripts contain the same words. Anchoring both sides to the clock they
    already agree on (measured drift < 0.5s) removes that artifact. Words landing
    either side of a bucket edge are still charged, which slightly overstates
    error; wider buckets trade that against looser ordering.
    """
    def group(toks, times):
        out = {}
        for t, ts in zip(toks, times):
            if ts is None:
                continue
            out.setdefault(int(float(ts) // bucket), []).append(t)
        return out

    R, H = group(ref_toks, ref_times), group(hyp_toks, hyp_times)
    S = D = I = N = 0
    for b in sorted(set(R) | set(H)):
        s, d, i, n = wer_align(R.get(b, []), H.get(b, []))
        S += s; D += d; I += i; N += n
    return S, D, I, N


def find_meetings(root: Path, limit: int, only: list[str] | None):
    cands = []
    for d in sorted(root.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not d.is_dir():
            continue
        if only and d.name not in only:
            continue
        audio, tx = d / "audio.mp4", d / "transcripts.json"
        if audio.exists() and tx.exists():
            cands.append(d)
        if not only and len(cands) >= limit:
            break
    return cands


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--recordings-dir", default=str(DEFAULT_RECORDINGS))
    ap.add_argument("--limit", type=int, default=4)
    ap.add_argument("--meeting", action="append", help="exact folder name (repeatable)")
    ap.add_argument("--min-run", type=int, default=5, help="min words for a reported deletion run")
    args = ap.parse_args()

    root = Path(args.recordings_dir)
    meetings = find_meetings(root, args.limit, args.meeting)
    if not meetings:
        print(f"No meetings with audio.mp4 + transcripts.json under {root}", file=sys.stderr)
        return 2

    rows, pooled = [], {"S": 0, "D": 0, "I": 0, "N": 0}
    for d in meetings:
        meta = {}
        meta_file = d / "metadata.json"
        if meta_file.exists():
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
        print(f"\n=== {d.name}  ({meta.get('duration_seconds', 0) / 60:.1f} min)")

        wav = to_wav_16k_mono(d / "audio.mp4", WORK_DIR / f"{d.name}.wav")
        ref_text, ref_words, cached = batch_transcribe(wav)
        print(f"    batch reference: {len(ref_text)} chars ({'cached' if cached else 'API call'})")

        hyp_text, segs = live_hypothesis(d / "transcripts.json")
        ref_toks, ref_times = ref_tokens_with_times(ref_words)
        if not ref_toks:                      # older responses may omit `words`
            ref_toks, ref_times = normalize(ref_text), [None] * len(normalize(ref_text))
        hyp_toks = normalize(hyp_text)

        S, D, I, N = wer_align(ref_toks, hyp_toks)
        wer = (S + D + I) / N if N else 0.0
        ops = align_ops(ref_toks, hyp_toks)
        runs = deletion_runs(ops, ref_toks, ref_times, min_len=args.min_run)

        # Split "never transcribed at all" from "transcribed differently".
        last = covered_span(ops)
        tail_words = N - (last + 1)
        tail_start = ref_times[last + 1] if 0 <= last + 1 < len(ref_times) else None
        if tail_words > 0:
            cS, cD, cI, cN = wer_align(ref_toks[:last + 1], hyp_toks)
        else:
            cS, cD, cI, cN = S, D, I, N
        covered_wer = (cS + cD + cI) / cN if cN else 0.0

        ins_runs = insertion_runs(ops, hyp_toks)
        loops = looping_words(ins_runs)

        # Primary metric: clock-anchored, so speaker interleaving isn't scored as error.
        hyp_toks_t, hyp_times = hyp_tokens_with_times(segs)
        bS, bD, bI, bN = bucketed_wer(ref_toks, ref_times, hyp_toks_t, hyp_times)
        bucket_wer = (bS + bD + bI) / bN if bN else 0.0

        for k, v in (("S", bS), ("D", bD), ("I", bI), ("N", bN)):
            pooled[k] += v

        rows.append({
            "meeting": d.name,
            "duration_min": round(meta.get("duration_seconds", 0) / 60, 1),
            "audio_min": round(len(wav.read_bytes()) / (16000 * 2) / 60, 1),
            "ref_words": N,
            "hyp_words": len(hyp_toks),
            "never_transcribed_words": tail_words,
            "never_transcribed_from_mmss": None if tail_start is None
                else f"{int(tail_start)//60:02d}:{int(tail_start)%60:02d}",
            "covered": {"S": cS, "D": cD, "I": cI, "N": cN, "wer": round(covered_wer, 4)},
            "bucketed_60s": {"S": bS, "D": bD, "I": bI, "N": bN, "wer": round(bucket_wer, 4)},
            "insertion_words_in_loops": loops,
            "wer_including_tail": round(wer, 4),
            "segments": len(segs),
            "deletion_runs": runs,
            "top_insertion_runs": ins_runs[:5],
        })
        print(f"    ref {N} words | live {len(hyp_toks)} words")
        if tail_words > 0:
            pct = tail_words / N
            print(f"    !! {tail_words} reference words ({pct:.0%}) NEVER transcribed — "
                  f"live output ends at {rows[-1]['never_transcribed_from_mmss']} "
                  f"while audio continues")
        print(f"    60s-bucketed WER {bucket_wer:.2%}  (S {bS} / D {bD} / I {bI} / N {bN})"
              f"   <- primary")
        print(f"    whole-transcript WER {covered_wer:.2%}  (S {cS} / D {cD} / I {cI})"
              f"   [{loops} insertion words are repetition loops]")
        for r in runs[:4]:
            print(f"      dropped {r['words']}w at {r['at_mmss']}: {r['text'][:80]}")

    pooled_wer = (pooled["S"] + pooled["D"] + pooled["I"]) / pooled["N"] if pooled["N"] else 0
    print(f"\nPOOLED across {len(rows)} meetings: WER {pooled_wer:.2%} "
          f"(S {pooled['S']} / D {pooled['D']} / I {pooled['I']} / N {pooled['N']})")

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out = RESULTS_DIR / "meeting_engine_compare.json"
    out.write_text(json.dumps({
        "reference": f"ElevenLabs {SCRIBE_MODEL} batch, single POST per meeting (PROXY for truth)",
        "hypothesis": "live transcripts.json from the shipped scribe_v2_realtime path",
        "pooled": {**pooled, "wer": round(pooled_wer, 4)},
        "meetings": rows,
    }, indent=2), encoding="utf-8")
    print(f"Wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
