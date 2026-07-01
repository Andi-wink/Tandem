"""
Speaker-diarization scoring for the Tandem harness.

The unit we score is the WORD, because Tandem's product surface is a
"who said what" transcript: every transcript word carries a speaker badge, so
the metric that matters is "what fraction of words got the right speaker".

Hypothesis speaker labels (SPEAKER_00, SPEAKER_01, ...) are arbitrary, so before
scoring we find the optimal one-to-one mapping between hypothesis labels and
reference labels that maximises agreement (the standard diarization approach,
here computed over words instead of time frames).

Primary metric:
    WSA  Word Speaker Accuracy = correctly-attributed words / scored words

Also reported:
    - speaker-count error (predicted #speakers - reference #speakers)
    - per-reference-speaker recall
    - WDER  Word Diarization Error Rate = 1 - WSA (so lower is better, DER-like)

This module has NO heavy dependencies (numpy only, scipy optional) so it can be
unit-tested without pyannote or an ElevenLabs key. Run it directly to self-test:

    python diar_metrics.py
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

try:
    from scipy.optimize import linear_sum_assignment  # type: ignore
    _HAVE_SCIPY = True
except Exception:  # pragma: no cover - scipy is optional
    _HAVE_SCIPY = False


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class Word:
    """A single reference or hypothesis word with its time span and speaker."""
    text: str
    start: float
    end: float
    speaker: Optional[str] = None

    @property
    def mid(self) -> float:
        return (self.start + self.end) / 2.0


@dataclass
class Segment:
    """A diarization turn: one speaker speaking from start to end."""
    start: float
    end: float
    speaker: str


@dataclass
class ScoreResult:
    wsa: float                       # word speaker accuracy [0,1]
    wder: float                      # 1 - wsa
    scored_words: int
    correct_words: int
    ref_speakers: int
    hyp_speakers: int
    speaker_count_error: int
    label_map: dict = field(default_factory=dict)   # hyp label -> ref label
    per_speaker_recall: dict = field(default_factory=dict)
    unmapped_hyp_labels: list = field(default_factory=list)

    def summary(self) -> str:
        return (
            f"WSA={self.wsa*100:5.1f}%  WDER={self.wder*100:5.1f}%  "
            f"correct={self.correct_words}/{self.scored_words}  "
            f"spk hyp/ref={self.hyp_speakers}/{self.ref_speakers} "
            f"(err {self.speaker_count_error:+d})"
        )


# ---------------------------------------------------------------------------
# Alignment: assign a hypothesis speaker to each reference word by time
# ---------------------------------------------------------------------------

def assign_hyp_speaker_to_words(
    words: list[Word],
    hyp_segments: list[Segment],
    slack: float = 1.0,
) -> list[Optional[str]]:
    """For each word, return the hypothesis speaker covering its midpoint.

    Strategy 1: the segment whose [start,end] contains the word midpoint.
    Strategy 2: fallback to the segment with greatest temporal overlap.
    Returns None where no segment is within `slack` seconds (silence / miss).

    Mirrors backend/app/diarizer.align_with_transcripts so the harness scores
    the same alignment the product uses.
    """
    seg = sorted(hyp_segments, key=lambda s: s.start)
    out: list[Optional[str]] = []
    for w in words:
        mid = w.mid
        chosen: Optional[str] = None
        # Strategy 1: containment at midpoint
        for s in seg:
            if s.end < mid - slack:
                continue
            if s.start > mid + slack:
                break
            if s.start <= mid <= s.end:
                chosen = s.speaker
                break
        # Strategy 2: greatest overlap with the word span
        if chosen is None:
            best = 0.0
            for s in seg:
                if s.end < w.start:
                    continue
                if s.start > w.end:
                    break
                ov = max(0.0, min(w.end, s.end) - max(w.start, s.start))
                if ov > best:
                    best = ov
                    chosen = s.speaker
        out.append(chosen)
    return out


# ---------------------------------------------------------------------------
# Optimal label mapping (hypothesis labels -> reference labels)
# ---------------------------------------------------------------------------

def optimal_label_map(
    ref_labels: list[Optional[str]],
    hyp_labels: list[Optional[str]],
) -> dict:
    """Return a hyp-label -> ref-label mapping maximising word agreement.

    Uses the Hungarian algorithm when scipy is available, otherwise a greedy
    fallback. Only words where BOTH ref and hyp are non-None contribute to the
    contingency counts (a None hyp is a miss, scored as wrong later).
    """
    ref_set = sorted({r for r in ref_labels if r is not None})
    hyp_set = sorted({h for h in hyp_labels if h is not None})
    if not ref_set or not hyp_set:
        return {}

    ri = {r: i for i, r in enumerate(ref_set)}
    hi = {h: i for i, h in enumerate(hyp_set)}
    # contingency[hyp][ref] = shared word count
    cont = [[0] * len(ref_set) for _ in range(len(hyp_set))]
    for r, h in zip(ref_labels, hyp_labels):
        if r is None or h is None:
            continue
        cont[hi[h]][ri[r]] += 1

    mapping: dict = {}
    if _HAVE_SCIPY:
        import numpy as np
        cost = -np.array(cont, dtype=float)  # maximise agreement = minimise -counts
        rows, cols = linear_sum_assignment(cost)
        for hrow, rcol in zip(rows, cols):
            # only map if there is real agreement mass
            if cont[hrow][rcol] > 0:
                mapping[hyp_set[hrow]] = ref_set[rcol]
    else:
        # Greedy: repeatedly take the highest remaining (hyp,ref) cell.
        used_ref: set = set()
        used_hyp: set = set()
        cells = sorted(
            ((cont[h][r], h, r) for h in range(len(hyp_set)) for r in range(len(ref_set))),
            reverse=True,
        )
        for count, h, r in cells:
            if count <= 0:
                break
            if hyp_set[h] in used_hyp or ref_set[r] in used_ref:
                continue
            mapping[hyp_set[h]] = ref_set[r]
            used_hyp.add(hyp_set[h])
            used_ref.add(ref_set[r])
    return mapping


# ---------------------------------------------------------------------------
# Top-level scoring
# ---------------------------------------------------------------------------

def score_words(
    ref_words: list[Word],
    hyp_segments: list[Segment],
    label_map: Optional[dict] = None,
) -> ScoreResult:
    """Score hypothesis diarization segments against reference-labelled words.

    Every reference word must carry a `.speaker`. Words with no reference
    speaker are skipped (not part of the "who said what" ground truth).
    """
    scored = [w for w in ref_words if w.speaker is not None]
    hyp_per_word = assign_hyp_speaker_to_words(scored, hyp_segments)
    ref_per_word = [w.speaker for w in scored]

    if label_map is None:
        label_map = optimal_label_map(ref_per_word, hyp_per_word)

    correct = 0
    per_spk_total: dict = {}
    per_spk_ok: dict = {}
    for ref_spk, hyp_spk in zip(ref_per_word, hyp_per_word):
        per_spk_total[ref_spk] = per_spk_total.get(ref_spk, 0) + 1
        mapped = label_map.get(hyp_spk) if hyp_spk is not None else None
        if mapped == ref_spk:
            correct += 1
            per_spk_ok[ref_spk] = per_spk_ok.get(ref_spk, 0) + 1

    n = len(scored)
    ref_spk_count = len(set(ref_per_word))
    hyp_spk_count = len({h for h in hyp_per_word if h is not None})
    recall = {
        spk: per_spk_ok.get(spk, 0) / tot
        for spk, tot in per_spk_total.items()
    }
    mapped_hyp = set(label_map.keys())
    all_hyp = {h for h in hyp_per_word if h is not None}
    wsa = correct / n if n else 0.0
    return ScoreResult(
        wsa=wsa,
        wder=1.0 - wsa,
        scored_words=n,
        correct_words=correct,
        ref_speakers=ref_spk_count,
        hyp_speakers=hyp_spk_count,
        speaker_count_error=hyp_spk_count - ref_spk_count,
        label_map=label_map,
        per_speaker_recall=recall,
        unmapped_hyp_labels=sorted(all_hyp - mapped_hyp),
    )


# ---------------------------------------------------------------------------
# Self-test (no external deps / data)
# ---------------------------------------------------------------------------

def _selftest() -> None:
    # Reference: A speaks 0-2s and 4-6s, B speaks 2-4s. 6 words.
    ref = [
        Word("hello", 0.0, 1.0, "A"),
        Word("there", 1.0, 2.0, "A"),
        Word("hi", 2.0, 3.0, "B"),
        Word("back", 3.0, 4.0, "B"),
        Word("okay", 4.0, 5.0, "A"),
        Word("sure", 5.0, 6.0, "A"),
    ]

    # Perfect hypothesis with swapped/arbitrary labels -> should map to 100%.
    perfect = [
        Segment(0.0, 2.0, "SPEAKER_1"),
        Segment(2.0, 4.0, "SPEAKER_0"),
        Segment(4.0, 6.0, "SPEAKER_1"),
    ]
    r = score_words(ref, perfect)
    assert r.wsa == 1.0, r.summary()
    assert r.label_map == {"SPEAKER_1": "A", "SPEAKER_0": "B"}, r.label_map
    assert r.speaker_count_error == 0

    # One word misattributed (the 2-4s turn collapsed into A) -> 4/6.
    one_off = [Segment(0.0, 6.0, "SPEAKER_0")]  # everything one speaker
    r2 = score_words(ref, one_off)
    assert r2.correct_words == 4 and r2.scored_words == 6, r2.summary()
    assert r2.speaker_count_error == -1, r2.summary()

    # Over-segmentation: 3 hyp speakers for 2 real -> still maps best 2.
    over = [
        Segment(0.0, 2.0, "S0"),
        Segment(2.0, 4.0, "S1"),
        Segment(4.0, 6.0, "S2"),
    ]
    r3 = score_words(ref, over)
    assert r3.speaker_count_error == 1, r3.summary()
    # A appears as S0 and S2; best single map catches one block (2 of 4 A-words)
    # plus both B words -> 4/6.
    assert r3.correct_words == 4, r3.summary()

    print("diar_metrics self-test OK")
    print("  perfect      :", r.summary())
    print("  single-spk   :", r2.summary())
    print("  over-segment :", r3.summary())
    print("  scipy hungarian:", _HAVE_SCIPY)


if __name__ == "__main__":
    _selftest()
