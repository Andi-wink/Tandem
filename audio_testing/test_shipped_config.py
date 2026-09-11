"""Contract tests for the SHIPPED flush/overlap/dedup config (backlog P0b).

Between 2026-06-03 (commit 1d0c869) and 2026-08-12 the harness scored a 25s
buffer with no left-context overlap while the Rust shipped a 12s buffer WITH a
1.0s overlap and a `dedup_overlap_prefix` pass. Every number the loop produced
in that window described a pipeline nobody was running.

These tests exist so that cannot happen silently again. Two kinds:

  1. PARITY: the constants are re-read out of the Rust source at test time, so
     changing either side without the other fails here. These are the tests that
     would have caught the 2026-06-03 drift on the day it happened.
  2. SEMANTICS: `prepend_overlap` (pipeline.rs `flush_transcription_buffer`),
     `dedup_overlap_prefix` and `emit_transcripts` (worker.rs) are pinned to
     behaviour that is DIFFERENT with and without the overlap/dedupe, so a test
     cannot pass under both the old and the new model.

Run:  PYTHONUTF8=1 .venv/Scripts/python.exe -m pytest audio_testing/ -q
"""

import re
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent))

from silero_vad import (  # noqa: E402
    MIN_VAD_SEGMENT_SAMPLES,
    TRANSCRIPTION_OVERLAP_SAMPLES,
    VAD_SHIPPED,
    assemble_buffers,
    prepend_overlap,
)
from run_tandem_meeting_wer import (  # noqa: E402
    OVERLAP_TAIL_WORDS,
    SHIPPED_MIN_SAMPLES,
    SHIPPED_OVERLAP_SAMPLES,
    buffers_to_hypothesis,
    dedup_overlap_prefix,
    emit_transcripts,
)
from run_tandem_parakeet import _MEANINGLESS, clean_repetitive_text  # noqa: E402

RUST_SRC = Path(__file__).resolve().parents[1] / "frontend" / "src-tauri" / "src"
RUST = RUST_SRC / "audio"
PIPELINE_RS = RUST / "pipeline.rs"
WORKER_RS = RUST / "transcription" / "worker.rs"
VAD_RS = RUST / "vad.rs"
WHISPER_RS = RUST_SRC / "whisper_engine" / "whisper_engine.rs"


def _rust(path):
    if not path.exists():                                    # pragma: no cover
        pytest.skip(f"Rust source not available: {path}")
    return path.read_text(encoding="utf-8")


def _rust_int(text, pattern, what):
    m = re.search(pattern, text)
    assert m, f"could not find {what} in the Rust source (pattern: {pattern})"
    return int(m.group(1).replace("_", ""))


# ───────────────────────── 1. parity with the Rust ─────────────────────────

def test_min_samples_matches_flush_profile_local():
    """Parakeet hits the `_ =>` arm of FlushProfile::for_provider, i.e. LOCAL."""
    src = _rust(PIPELINE_RS)
    local = re.search(
        r"pub const LOCAL: FlushProfile = FlushProfile \{(.*?)\};", src, re.S)
    assert local, "FlushProfile::LOCAL not found in pipeline.rs"
    shipped = _rust_int(local.group(1), r"min_samples:\s*([0-9_]+)",
                        "FlushProfile::LOCAL.min_samples")
    assert SHIPPED_MIN_SAMPLES == shipped, (
        f"harness buffer {SHIPPED_MIN_SAMPLES} samples "
        f"({SHIPPED_MIN_SAMPLES/16000:.1f}s) != shipped FlushProfile::LOCAL "
        f"{shipped} ({shipped/16000:.1f}s)")
    assert SHIPPED_MIN_SAMPLES == 192_000  # 12s @ 16k, belt and braces


def test_parakeet_still_falls_through_to_the_local_profile():
    """If Parakeet ever gets its own arm, SHIPPED_MIN_SAMPLES stops being right."""
    src = _rust(PIPELINE_RS)
    body = re.search(r"pub fn for_provider\(provider: &str\) -> FlushProfile \{(.*?)\n    \}",
                     src, re.S)
    assert body, "FlushProfile::for_provider not found"
    code = "\n".join(re.sub(r"//.*", "", ln) for ln in body.group(1).splitlines())
    assert "parakeet" not in code.lower(), (
        "pipeline.rs now matches 'parakeet' explicitly; re-check which profile ships")
    assert re.search(r"_\s*=>\s*FlushProfile::LOCAL", code)


def test_overlap_samples_matches_rust():
    src = _rust(PIPELINE_RS)
    shipped = _rust_int(src, r"TRANSCRIPTION_OVERLAP_SAMPLES:\s*usize\s*=\s*([0-9_]+)",
                        "TRANSCRIPTION_OVERLAP_SAMPLES")
    assert TRANSCRIPTION_OVERLAP_SAMPLES == shipped == 16000
    assert SHIPPED_OVERLAP_SAMPLES == shipped
    assert SHIPPED_OVERLAP_SAMPLES > 0, "the shipped pipeline DOES prepend overlap"


def test_overlap_tail_words_matches_rust():
    src = _rust(WORKER_RS)
    shipped = _rust_int(src, r"OVERLAP_TAIL_WORDS:\s*usize\s*=\s*([0-9_]+)",
                        "OVERLAP_TAIL_WORDS")
    assert OVERLAP_TAIL_WORDS == shipped == 10


def test_worker_still_calls_dedup_on_the_emitted_transcript():
    """The dedupe is only worth modelling while the Rust actually applies it."""
    src = _rust(WORKER_RS)
    assert "fn dedup_overlap_prefix(" in src
    assert re.search(r"let transcript = dedup_overlap_prefix\(prev_tail, &transcript\);", src), (
        "worker.rs no longer dedups the overlap prefix; the harness must follow")


def test_vad_config_matches_vad_rs_and_pipeline_rs():
    """The same 1d0c869 drift hit the VAD, and the P0b bullets did not name it.

    Scoring 12s buffers through the pre-1d0c869 VAD gives 26.045% pooled; through
    the shipped VAD it gives 22.830%. So this is not a detail, it is 3.2pp.
    """
    vad = _rust(VAD_RS)
    pipe = _rust(PIPELINE_RS)

    def f(pattern, what):
        m = re.search(pattern, vad)
        assert m, f"could not find {what} in vad.rs"
        return float(m.group(1))

    assert VAD_SHIPPED["positive"] == f(
        r"config\.positive_speech_threshold\s*=\s*([0-9.]+)", "positive_speech_threshold")
    assert VAD_SHIPPED["negative"] == f(
        r"config\.negative_speech_threshold\s*=\s*([0-9.]+)", "negative_speech_threshold")
    assert VAD_SHIPPED["pre_pad_ms"] == f(
        r"config\.pre_speech_pad\s*=\s*Duration::from_millis\((\d+)\)", "pre_speech_pad")
    assert VAD_SHIPPED["post_pad_ms"] == f(
        r"config\.post_speech_pad\s*=\s*Duration::from_millis\((\d+)\)", "post_speech_pad")
    assert VAD_SHIPPED["min_speech_ms"] == f(
        r"config\.min_speech_time\s*=\s*Duration::from_millis\((\d+)\)", "min_speech_time")

    # redemption is chosen in pipeline.rs, not vad.rs; the clips are scored on Windows.
    red = re.search(r'let redemption_time = if cfg!\(target_os = "macos"\) \{\s*(\d+)\s*\}'
                    r'\s*else\s*\{\s*(\d+)\s*\}', pipe)
    assert red, "pipeline.rs redemption_time selection not found"
    assert VAD_SHIPPED["redemption_ms"] == int(red.group(2)), "non-macOS redemption drifted"


def test_harness_uses_the_shipped_vad_not_the_historical_one():
    from run_tandem_meeting_wer import SHIPPED_VAD
    from silero_vad import VAD_CURRENT
    assert SHIPPED_VAD == VAD_SHIPPED
    assert SHIPPED_VAD != VAD_CURRENT, "VAD_CURRENT is pre-1d0c869 history"


def test_short_vad_segments_are_dropped_like_pipeline_rs():
    src = _rust(PIPELINE_RS)
    assert MIN_VAD_SEGMENT_SAMPLES == _rust_int(
        src, r"if segment\.samples\.len\(\) < (\d+)", "the short-segment drop")
    segs = [(0, 100, [0.0] * 799), (200, 900, [0.0] * 40_000)]
    buffers = assemble_buffers(segs, min_samples=192_000)
    assert [len(b) for b in buffers] == [40_000], "the sub-800-sample segment was not dropped"


# ─────────────── 1b. the flush rule: min_samples, NOT a silence gap ───────────────
#
# Until this fix pass the replica split buffers on a 1.2s AUDIO-TIME gap between
# VAD segment timestamps. No such rule exists in the Rust. These tests fail if it
# comes back, and pin the two properties of the real predicate that make it
# unreachable on an offline replay.

def test_no_audio_time_gap_flush_however_long_the_silence():
    """REGRESSION GUARD for the invented rule.

    Three segments separated by 10 SECONDS of audio-time silence each, none of
    them anywhere near the 192_000-sample cap. The shipped partition is one
    buffer: `min_samples` is not reached and the stream never ends mid-way.
    Under the old audio-time gap rule this returned THREE buffers.
    """
    segs = [(i * 20_000, i * 20_000 + 10_000, [float(i)] * 40_000) for i in range(3)]
    buffers = assemble_buffers(segs, min_samples=SHIPPED_MIN_SAMPLES)
    assert [len(b) for b in buffers] == [120_000], (
        "a silence-gap flush reappeared in assemble_buffers; pipeline.rs has no "
        "audio-time gap rule (see the assemble_buffers docstring)")


def test_gap_flush_is_off_by_default_and_opt_in_for_the_experiment_scripts():
    """experiments.py swept an audio-time gap; that path stays available but
    must never be the default, because it is not what the Rust does."""
    import inspect

    from silero_vad import assemble_buffers as ab
    assert inspect.signature(ab).parameters["gap_ms"].default is None
    segs = [(i * 20_000, i * 20_000 + 10_000, [float(i)] * 40_000) for i in range(3)]
    assert len(assemble_buffers(segs, min_samples=SHIPPED_MIN_SAMPLES, gap_ms=1200)) == 3


def test_the_rust_gap_predicate_is_wall_clock_inside_the_recv_timeout_arm():
    """Why there is no gap rule above, re-derived from the Rust on every run.

    `silence_gap_secs` is only ever compared against a wall-clock `Instant`
    (`*_last_activity.elapsed()`), and only inside the `Err(_)` arm of a 50ms
    `timeout(.., receiver.recv())`. Offline the channel never idles for 50ms and
    the wall clock between two appends is decode time, so it cannot fire. If the
    Rust ever switches to comparing VAD timestamps, this test fails and the
    replica must grow the rule back.
    """
    src = _rust(PIPELINE_RS)
    guarded = re.findall(
        r"_last_activity\s*\.elapsed\(\)\s*\.as_secs_f64\(\)\s*>=\s*"
        r"self\.flush_profile\.silence_gap_secs", src)
    assert guarded, ("pipeline.rs no longer gates the silence-gap flush on a "
                     "wall-clock Instant::elapsed(); re-derive the offline "
                     "partition rule before trusting the harness")
    # EVERY consumption of the threshold is one of those wall-clock comparisons.
    consumed = re.findall(r"flush_profile\.silence_gap_secs", src)
    assert len(consumed) == len(guarded), (
        f"{len(consumed)} uses of flush_profile.silence_gap_secs but only "
        f"{len(guarded)} are wall-clock elapsed comparisons; a new flush rule "
        "appeared and the replica may now be wrong")
    assert re.search(r"timeout\(\s*std::time::Duration::from_millis\(50\)", src), (
        "the 50ms recv timeout that makes the silence-gap flush unreachable "
        "offline has changed")


def test_no_invented_rust_constant_is_cited_by_the_replica():
    """`SILENCE_GAP_FLUSH_SECS` never existed in the Rust. The docstrings that
    claimed it did are the reason this whole fix pass happened."""
    src = _rust(PIPELINE_RS)
    assert "SILENCE_GAP_FLUSH_SECS" not in src
    for py in ("silero_vad.py", "run_tandem_meeting_wer.py", "wer_gate.py"):
        text = (Path(__file__).parent / py).read_text(encoding="utf-8")
        assert "SILENCE_GAP_FLUSH_SECS" not in text, (
            f"{py} cites a Rust constant that does not exist")


# ───────────────────── 2. prepend_overlap (pipeline.rs) ─────────────────────

def _ramp(start, n):
    """Distinguishable sample block: values start..start+n-1."""
    return list(range(start, start + n))


def test_first_flush_has_no_overlap():
    chunks = prepend_overlap([_ramp(0, 50_000)], overlap_samples=16000)
    assert len(chunks) == 1
    chunk, overlap_len = chunks[0]
    assert overlap_len == 0
    assert chunk == _ramp(0, 50_000)


def test_second_flush_is_prefixed_with_the_previous_buffers_last_second():
    b1, b2 = _ramp(0, 200_000), _ramp(1_000_000, 200_000)
    chunks = prepend_overlap([b1, b2], overlap_samples=16000)
    chunk2, overlap_len = chunks[1]
    assert overlap_len == 16000
    assert len(chunk2) == 216_000                 # fails outright if overlap removed
    assert chunk2[:16000] == b1[-16000:]          # ...and it is the RIGHT second
    assert chunk2[16000:] == b2


def test_overlap_can_be_disabled_for_ablation():
    b1, b2 = _ramp(0, 200_000), _ramp(1_000_000, 200_000)
    chunks = prepend_overlap([b1, b2], overlap_samples=0)
    assert [len(c) for c, _ in chunks] == [200_000, 200_000]
    assert all(o == 0 for _, o in chunks)


def test_tail_is_taken_before_prepending_not_after():
    """The load-bearing ordering in flush_transcription_buffer.

    Buffer 2 is SHORTER than the overlap, so `new_tail` is the whole of buffer 2.
    Taking the tail from the already-overlapped chunk instead would replay a
    slice of buffer 1's audio for a third time in chunk 3.
    """
    b1, b2, b3 = _ramp(0, 200_000), _ramp(1_000_000, 5_000), _ramp(2_000_000, 100_000)
    chunks = prepend_overlap([b1, b2, b3], overlap_samples=16000)
    chunk3, overlap_len = chunks[2]
    assert overlap_len == 5_000, "tail of a short buffer is the whole buffer"
    assert chunk3[:5_000] == b2
    assert not any(v < 1_000_000 for v in chunk3[:5_000]), \
        "chunk 3 replayed buffer-1 audio: the tail was taken after prepending"


def test_short_buffer_tail_is_the_whole_buffer():
    b1, b2 = _ramp(0, 9_000), _ramp(1_000_000, 40_000)
    chunks = prepend_overlap([b1, b2], overlap_samples=16000)
    assert chunks[1][1] == 9_000
    assert chunks[1][0][:9_000] == b1


def test_buffers_are_12s_and_overlapped_end_to_end():
    """assemble_buffers + prepend_overlap at the SHIPPED constants.

    Five 5s VAD segments: the 12s cap flushes after segment 3 (15s) and the
    remainder (10s) trails. Under the old 25s harness this would be ONE buffer
    with no overlap, so the assertion below cannot pass under both models.
    """
    segs = [(i * 5000, i * 5000 + 5000, _ramp(i * 100_000, 80_000)) for i in range(5)]
    buffers = assemble_buffers(segs, min_samples=SHIPPED_MIN_SAMPLES, gap_ms=1200)
    assert [len(b) for b in buffers] == [240_000, 160_000]
    chunks = prepend_overlap(buffers, SHIPPED_OVERLAP_SAMPLES)
    assert [len(c) for c, _ in chunks] == [240_000, 176_000]
    assert sum(o for _, o in chunks) == 16000


# ─────────────────── 3. dedup_overlap_prefix (worker.rs) ───────────────────

def test_no_previous_tail_returns_current_unchanged():
    assert dedup_overlap_prefix([], "hello  world") == "hello  world"


def test_exact_prefix_is_dropped():
    assert dedup_overlap_prefix(["a", "b", "c"], "b c d e") == "d e"


def test_match_is_case_insensitive():
    assert dedup_overlap_prefix(["The", "Quick"], "the QUICK brown fox") == "brown fox"


def test_longest_match_wins():
    """k counts DOWN from max_k, so the 3-word overlap must beat the 1-word one."""
    assert dedup_overlap_prefix(["x", "a", "a", "a"], "a a a b") == "b"


def test_non_matching_prefix_is_returned_byte_identical():
    """The Rust early-outs with `current.to_string()`, it does not re-join."""
    assert dedup_overlap_prefix(["a", "b"], "zzz  yyy") == "zzz  yyy"


def test_dedup_removes_at_most_ten_words():
    """OVERLAP_TAIL_WORDS caps max_k, so a 10-word repeat is the largest catch."""
    prev = ["p"] + [f"w{i}" for i in range(10)]
    curr = " ".join(f"w{i}" for i in range(10)) + " tail"
    assert dedup_overlap_prefix(prev, curr) == "tail"


def test_an_eleven_word_repeat_is_not_deduped_at_all():
    """The cap is all-or-nothing, not partial: prefix and suffix must ALIGN.

    With an 11-word duplicated run no k <= 10 lines prev's suffix up with curr's
    prefix, so the whole 11 words survive. This is why the overlap costs
    insertions rather than being free context.
    """
    prev = [f"w{i}" for i in range(11)]
    curr = " ".join(f"w{i}" for i in range(11)) + " tail"
    assert dedup_overlap_prefix(prev, curr) == curr


def test_partial_rematch_is_not_deduped():
    """Exact-match only: a re-decode that differs by one word keeps the whole run."""
    assert dedup_overlap_prefix(["the", "cat", "sat"], "the cat sats on") == \
        "the cat sats on"


def test_dedup_can_consume_the_whole_emission():
    assert dedup_overlap_prefix(["a", "b"], "a b") == ""


def test_empty_current_returns_empty():
    assert dedup_overlap_prefix(["a"], "   ") == ""


# ─────────────────── 4. emit_transcripts (worker.rs loop) ───────────────────

def test_tail_comes_from_the_deduped_text_not_the_raw_text():
    # "b c" is dropped from emission 2; the tail for emission 3 must be "d e",
    # so emission 3's leading "b c" is NOT removed a second time.
    out = emit_transcripts(["a b c", "b c d e", "b c f"])
    assert out == ["a b c", "d e", "b c f"]


def test_blank_emission_does_not_reset_the_tail():
    """The Rust skips the whole block for a blank transcript."""
    out = emit_transcripts(["a b", "   ", "b c"])
    assert out == ["a b", "c"]


def test_emissions_are_deduped_pairwise_not_globally():
    out = emit_transcripts(["one two", "two three", "two four"])
    assert out == ["one two", "three", "two four"]


def test_emit_without_dedup_would_differ():
    """Guards the test suite itself: the fixture is not dedup-neutral."""
    raw = ["one two", "two three"]
    assert " ".join(emit_transcripts(raw)) != " ".join(raw)


# ─────────────── 5. end-to-end through buffers_to_hypothesis ───────────────

class _WordBlockModel:
    """Fake engine: decodes each whole 16000-sample block to the word `w<value>`.

    Every block in a buffer is filled with a constant, so the decoded text is a
    direct read-out of which audio the chunk contained. That makes the replayed
    overlap second visible as a duplicated word.
    """

    def transcribe(self, samples):
        arr = np.asarray(samples)
        words = []
        for i in range(0, len(arr) - 15999, 16000):
            words.append(f"w{int(arr[i])}")
        return " ".join(words), []


def _blocks(values):
    out = []
    for v in values:
        out.extend([float(v)] * 16000)
    return out


def test_overlap_duplicates_a_word_and_the_dedupe_removes_it():
    """One run, two assertions: the first fails if the overlap is dropped, the
    second fails if the dedupe is dropped. Neither can pass under both models."""
    model = _WordBlockModel()
    buffers = [_blocks([1, 2, 3]), _blocks([4, 5, 6])]

    chunks = prepend_overlap(buffers, SHIPPED_OVERLAP_SAMPLES)
    raw = [model.transcribe(np.asarray(c))[0] for c, _ in chunks]
    assert raw == ["w1 w2 w3", "w3 w4 w5 w6"], \
        "the second chunk did not replay the previous buffer's last second"

    hyp, stats = buffers_to_hypothesis(model, buffers)
    assert hyp == "w1 w2 w3 w4 w5 w6", "the duplicated 'w3' survived the dedupe"
    assert stats["overlap_s"] == pytest.approx(1.0)
    assert stats["decoded_s"] == pytest.approx(7.0)   # 6s speech + 1s replay
    assert stats["speech_s"] == pytest.approx(6.0)
    assert stats["dedup_removed_words"] == 1


def test_undeduped_overlap_would_corrupt_the_hypothesis():
    """Shows what the 25.884% figure was: overlap modelled without the dedupe."""
    model = _WordBlockModel()
    buffers = [_blocks([1, 2, 3]), _blocks([4, 5, 6])]
    chunks = prepend_overlap(buffers, SHIPPED_OVERLAP_SAMPLES)
    undeduped = " ".join(model.transcribe(np.asarray(c))[0] for c, _ in chunks)
    assert undeduped == "w1 w2 w3 w3 w4 w5 w6"
    assert buffers_to_hypothesis(model, buffers)[0] != undeduped


def test_no_overlap_hypothesis_differs_from_the_shipped_one_in_stats():
    """Ablation path stays available and is measurably different."""
    model = _WordBlockModel()
    buffers = [_blocks([1, 2, 3]), _blocks([4, 5, 6])]
    _, off = buffers_to_hypothesis(model, buffers, overlap_samples=0)
    _, on = buffers_to_hypothesis(model, buffers)
    assert off["overlap_s"] == 0.0 and on["overlap_s"] == pytest.approx(1.0)
    assert off["decoded_s"] < on["decoded_s"]
    assert off["dedup_removed_words"] == 0 and on["dedup_removed_words"] == 1
