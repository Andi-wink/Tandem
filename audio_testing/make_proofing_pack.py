#!/usr/bin/env python
"""Cut the audio windows a human needs to hear to settle what the scoring can't.

The live realtime transcript and the batch reference disagree mostly through
INSERTIONS: words the live engine emitted that batch does not have. Two opposite
causes produce that same signal:

  - the live engine stuttered (a phrase repeated), which is an engine defect;
  - batch missed real speech on the mixed track (crosstalk, quiet talker), which
    is a REFERENCE defect and means the live engine was right.

No amount of alignment maths separates those two. One ear does, in minutes, if
it is pointed at the right 90 seconds. This picks the densest-insertion windows,
cuts the audio, and writes both candidate transcripts plus a blank template.

Also cuts the window around the point where the Aug 4 09:00 transcript stops, so
the data-loss finding can be confirmed by listening rather than trusted.

Run:
  py audio_testing/make_proofing_pack.py
"""
import json
import subprocess
import sys
from pathlib import Path

from run_tandem_parakeet import normalize
from run_meeting_engine_compare import (
    WORK_DIR, align_ops, batch_transcribe, hyp_tokens_with_times,
    live_hypothesis, ref_tokens_with_times, to_wav_16k_mono, DEFAULT_RECORDINGS,
)

OUT = Path(__file__).parent / "proofing"
WINDOW_SECS = 90.0

# (folder, why it is in the pack)
INSERTION_MEETINGS = [
    "Meeting 2026-08-04_10-58-12_2026-08-04_09-58",
    "Meeting 2026-08-03_16-41-09_2026-08-03_15-41",
]
# The German call: transcript stops at 16:05 while audio runs to 29:20.
CUTOFF_MEETING = ("Meeting 2026-08-04_09-00-47_2026-08-04_08-00", 945.0, 1065.0)


def mmss(t):
    return f"{int(t)//60:02d}:{int(t)%60:02d}"


def cut(src_wav: Path, start: float, end: float, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{start:.2f}", "-to", f"{end:.2f}",
         "-i", str(src_wav), "-ac", "1", "-ar", "16000", str(dest)],
        check=True,
    )


def live_lines(segs, start, end):
    """Live transcript for a window, per segment, with stream and time."""
    out = []
    for s in segs:
        a = float(s.get("audio_start_time") or 0)
        b = float(s.get("audio_end_time") or a)
        if b < start or a > end:
            continue
        who = "YOU (mic)   " if s.get("source") == "Local" else "THEM (system)"
        out.append(f"[{mmss(a)}] {who} {(s.get('text') or '').strip()}")
    return out


def batch_text(ref_words, start, end):
    got = []
    for w in ref_words:
        if w.get("type") not in (None, "word"):
            continue
        t = w.get("start")
        if t is None or t < start or t > end:
            continue
        got.append(w.get("text", ""))
    return " ".join(got).replace("  ", " ").strip()


def densest_window(times, span):
    """Start time of the `span`-second window containing the most inserted words."""
    if not times:
        return None
    times = sorted(times)
    best, best_n = times[0], 0
    j = 0
    for i, t0 in enumerate(times):
        while j < len(times) and times[j] <= t0 + span:
            j += 1
        if j - i > best_n:
            best_n, best = j - i, t0
    return max(0.0, best - 5.0), best_n


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    index = []

    for n, meeting in enumerate(INSERTION_MEETINGS, start=1):
        folder = DEFAULT_RECORDINGS / meeting
        wav = to_wav_16k_mono(folder / "audio.mp4", WORK_DIR / f"{meeting}.wav")
        ref_text, ref_words, _ = batch_transcribe(wav)
        ref_toks, _ = ref_tokens_with_times(ref_words)

        _, segs = live_hypothesis(folder / "transcripts.json")
        hyp_toks, hyp_times = hyp_tokens_with_times(segs)

        ops = align_ops(ref_toks, hyp_toks)
        ins_times, j = [], 0
        for kind, _ in ops:
            if kind == "ins":
                if j < len(hyp_times):
                    ins_times.append(hyp_times[j])
                j += 1
            elif kind in ("eq", "sub"):
                j += 1

        start, count = densest_window(ins_times, WINDOW_SECS)
        end = start + WINDOW_SECS
        # Back the clip up to the start of the first turn it overlaps (capped), so
        # every line the listener is asked to check is actually audible in the clip
        # instead of beginning mid-sentence before the cut.
        overlapping = [float(s.get("audio_start_time") or 0) for s in segs
                       if float(s.get("audio_end_time") or 0) >= start
                       and float(s.get("audio_start_time") or 0) <= end]
        if overlapping:
            start = max(0.0, min(start, max(min(overlapping), start - 25.0)))
        name = f"window{n}"
        cut(wav, start, end, OUT / f"{name}.wav")

        (OUT / f"{name}_live_TANDEM.txt").write_text(
            f"# What Tandem's LIVE engine produced — {meeting}\n"
            f"# Window {mmss(start)}-{mmss(end)} of the recording\n\n"
            + "\n".join(live_lines(segs, start, end)) + "\n",
            encoding="utf-8")
        (OUT / f"{name}_batch_REFERENCE.txt").write_text(
            f"# What BATCH Scribe produced for the same window — {meeting}\n"
            f"# Window {mmss(start)}-{mmss(end)}. One speaker track (mixed), no speaker labels.\n\n"
            + batch_text(ref_words, start, end) + "\n",
            encoding="utf-8")
        (OUT / f"{name}_TYPE_HERE.txt").write_text(
            f"# TRUTH for {name}.wav  ({meeting}, {mmss(start)}-{mmss(end)})\n"
            "#\n"
            "# Type what you actually hear. Rules that make the scoring valid:\n"
            "#   - every word, including filler (um, uh, yeah) and false starts\n"
            "#   - one line per speaker turn, prefixed YOU: or THEM:\n"
            "#   - if both talk at once, write both lines in the order they START\n"
            "#   - do not clean up grammar, and do not skip repeated words: a real\n"
            "#     repetition and an engine stutter must stay distinguishable\n"
            "#   - [inaudible] where you genuinely cannot tell\n"
            "#\n"
            "# Delete these comment lines or leave them, the scorer ignores # lines.\n\n",
            encoding="utf-8")

        index.append({"name": name, "meeting": meeting, "start": start, "end": end,
                      "inserted_words_in_window": count})
        print(f"{name}: {meeting} {mmss(start)}-{mmss(end)}  ({count} disputed words)")

    # Data-loss confirmation window.
    meeting, a, b = CUTOFF_MEETING
    folder = DEFAULT_RECORDINGS / meeting
    wav = to_wav_16k_mono(folder / "audio.mp4", WORK_DIR / f"{meeting}.wav")
    cut(wav, a, b, OUT / "window3_CUTOFF.wav")
    _, segs = live_hypothesis(folder / "transcripts.json")
    (OUT / "window3_live_TANDEM.txt").write_text(
        f"# {meeting}\n# Window {mmss(a)}-{mmss(b)}. Tandem's transcript ENDS at 16:13.\n"
        "# Everything you hear after that point was recorded and never transcribed.\n\n"
        + "\n".join(live_lines(segs, a, b)) + "\n(transcript ends here)\n",
        encoding="utf-8")
    print(f"window3_CUTOFF: {meeting} {mmss(a)}-{mmss(b)}  (listen only, no typing)")

    (OUT / "README.md").write_text(
        "# Proofing pack — 3 clips, ~5 minutes of listening\n\n"
        "Play the `.wav`, type what you hear into the matching `_TYPE_HERE.txt`.\n"
        "Do NOT read the other two files first — seeing a machine transcript before\n"
        "you type biases you toward it, and that is exactly the bias being measured.\n\n"
        "## window1.wav and window2.wav (90s each, please transcribe)\n\n"
        "These are the windows where the live engine emitted the most words batch\n"
        "does not have. Your text decides whether those are engine stutter or speech\n"
        "the reference missed. This is the whole point of the pack.\n\n"
        "## window3_CUTOFF.wav (2 min, listen only)\n\n"
        "The Aug 4 09:00 German call. Tandem's transcript stops at 16:13. The clip\n"
        "runs 15:45-17:45. Just confirm you hear the conversation continuing past the\n"
        "16:13 mark, which is the data-loss finding in one listen. No typing.\n\n"
        "## When done\n\n"
        "Tell me, and I score your text against both engines: absolute WER for each,\n"
        "and a split of the disputed words into engine error vs reference error.\n",
        encoding="utf-8")

    (OUT / "index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    print(f"\nPack: {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
