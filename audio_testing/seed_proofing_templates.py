#!/usr/bin/env python
"""Seed each proofing template with an editable transcript, disputes marked.

Typing 90s of dialogue from scratch is the unbiased method but costs real time,
so this hands over Tandem's live transcript as the editing base instead, with
every line the batch reference does not corroborate flagged.

BIAS, stated plainly: correcting a seed pulls the result toward that seed. The
seed here is Tandem's own output, so a skimmed correction would FLATTER Tandem.
That is why the disputed lines are marked: they are the ones that must be judged
by ear, and they are exactly the lines whose verdict the whole comparison rests
on. The batch version of the same window sits at the bottom of the file as a
cross-check.

Run:
  py audio_testing/seed_proofing_templates.py
"""
import json
import sys
from pathlib import Path

from run_tandem_parakeet import normalize
from run_meeting_engine_compare import (
    DEFAULT_RECORDINGS, batch_transcribe, live_hypothesis, WORK_DIR,
)

OUT = Path(__file__).parent / "proofing"
# Support is measured with 3-GRAMS, not single words. A hallucinated line is
# built from ordinary words ("and I'm also a parent, and I have, you know, a
# system of..."), so word-level overlap with the window scores it as supported;
# its word ORDER matches nothing. A genuine line keeps some 3-grams even when the
# engines disagree on individual words.
SUPPORT_THRESHOLD = 0.25
NGRAM = 3

HEADER = """\
# TRUTH for {name}.wav  ({meeting}, {a}-{b})
#
# Seeded from Tandem's LIVE transcript. Correct it against the audio, in place.
#
# >> Lines marked  <<<< DISPUTED  are where the two engines disagree. They decide
# >> the whole comparison, so please judge those by ear rather than by eye. If a
# >> line is wholly invented, replace it with:  (nothing said)
#
# Keep filler words (um, uh, yeah) and false starts. Keep genuine repetitions:
# a real repeat and an engine stutter have to stay distinguishable. Use
# [inaudible] where you cannot tell. Speaker prefixes: YOU / THEM.
# Lines starting with # are ignored by the scorer.

"""

FOOTER = """

# ─────────────────────────────────────────────────────────────────────────────
# CROSS-CHECK — the same window per BATCH Scribe (one mixed track, no speaker
# labels, and it misses overlapping speech). Consult only if your ear is unsure.
#
{batch}
"""


def mmss(t):
    return f"{int(t)//60:02d}:{int(t)%60:02d}"


def main():
    index = json.loads((OUT / "index.json").read_text(encoding="utf-8"))
    for entry in index:
        name, meeting = entry["name"], entry["meeting"]
        start, end = float(entry["start"]), float(entry["end"])

        wav = WORK_DIR / f"{meeting}.wav"
        _, ref_words, _ = batch_transcribe(wav)
        batch_win = " ".join(
            w.get("text", "") for w in ref_words
            if w.get("type") in (None, "word")
            and w.get("start") is not None
            and start <= w["start"] <= end
        ).strip()
        bw = normalize(batch_win)
        batch_grams = {tuple(bw[i:i + NGRAM]) for i in range(len(bw) - NGRAM + 1)}

        _, segs = live_hypothesis(DEFAULT_RECORDINGS / meeting / "transcripts.json")
        lines, disputed = [], 0
        for s in segs:
            a = float(s.get("audio_start_time") or 0)
            b = float(s.get("audio_end_time") or a)
            if b < start or a > end:
                continue
            text = (s.get("text") or "").strip()
            if not text:
                continue
            who = "YOU " if s.get("source") == "Local" else "THEM"
            words = normalize(text)
            grams = [tuple(words[i:i + NGRAM]) for i in range(len(words) - NGRAM + 1)]
            support = (sum(1 for g in grams if g in batch_grams) / len(grams)) if grams else 1.0
            flag = ""
            if support < SUPPORT_THRESHOLD and len(words) >= 6:
                flag = "   <<<< DISPUTED"
                disputed += 1
            lines.append(f"[{mmss(a)}] {who}: {text}{flag}")

        body = HEADER.format(name=name, meeting=meeting, a=mmss(start), b=mmss(end))
        body += "\n".join(lines)
        body += FOOTER.format(batch="\n".join("# " + l for l in _wrap(batch_win, 95)))
        (OUT / f"{name}_TYPE_HERE.txt").write_text(body, encoding="utf-8")
        print(f"{name}: {len(lines)} lines seeded, {disputed} flagged disputed")
    return 0


def _wrap(text, width):
    out, line = [], ""
    for word in text.split():
        if len(line) + len(word) + 1 > width:
            out.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    if line:
        out.append(line)
    return out


if __name__ == "__main__":
    sys.exit(main())
