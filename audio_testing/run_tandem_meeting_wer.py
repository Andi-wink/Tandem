"""
Exact meeting-condition WER for Tandem's current engine (shipped config).

Pipeline reproduced end-to-end:
  clip (16k mono)
    -> Silero VAD (real silero_vad.onnx, vad.rs config)                [silero_vad.py]
    -> transcription-buffer assembly (flush at FlushProfile::LOCAL's
       192_000 samples, or at end of stream; pipeline.rs)              [silero_vad.py]
    -> 1.0s left-context overlap prepended on every flush              [silero_vad.py]
       (pipeline.rs flush_transcription_buffer, TRANSCRIPTION_OVERLAP_SAMPLES)
    -> Parakeet TDT v3 int8 per buffer (exact ONNX + decode)           [run_tandem_parakeet.py]
    -> post-process (de-stutter always; English domain correction only when the
       pinned language is English-ish, mirroring parakeet_engine.rs)  [run_tandem_parakeet.py]
    -> clean_repetitive_text (worker.rs:601)                          [run_tandem_parakeet.py]
    -> dedup_overlap_prefix against the previous emission's last 10 words
       (worker.rs), then concatenate emissions in order
  vs ElevenLabs ground truth -> WER, pooled AND per language.

KNOWN DIVERGENCE (not modelled, do not read the numbers as if it were):
the shipped pipeline runs TWO independent streams, mic and system, each with its
own VAD instance, transcription buffer, overlap tail (pipeline.rs:1192-1195) and
dedup tail (worker.rs:159-160, selected at :276). The clips are cut from each
meeting's mixed `audio.mp4`, so this harness runs ONE VAD and ONE dedup chain over
both speakers. Cross-talk that the Rust keeps apart is merged here, which changes
the buffer partition and collapses two dedup chains into one. See backlog P5d.

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
    clean_repetitive_text,
)
from silero_vad import (
    vad_segments_for_clip, assemble_buffers, prepend_overlap,
    TRANSCRIPTION_OVERLAP_SAMPLES, VAD_SHIPPED,
)

HERE = Path(__file__).parent
OUT_DIR = HERE / "parakeet_out"
CLIPS_INDEX = HERE / "clips_index.json"

# Mirror the SHIPPED Rust engine config.
#
# Until 2026-08-12 this pointed at run_ablation.VAD_SENSITIVE (pos .45 / neg .35
# / pre 500 / post 300 / redemption 500 / min-speech 200), the pre-1d0c869
# values. Commit 1d0c869 (2026-06-03) retuned vad.rs and pipeline.rs together
# and touched nothing under audio_testing/, so the replica has been scoring a
# VAD nobody runs for ten weeks. See results/p0b_shipped_config.md.
SHIPPED_VAD = VAD_SHIPPED            # vad.rs + pipeline.rs redemption (800ms)
# FlushProfile::LOCAL.min_samples (pipeline.rs). Parakeet falls through the
# `_ =>` arm of FlushProfile::for_provider, so LOCAL is what ships.
#
# History (P0b, 2026-08-12): 12s was the original value; commit 3abe86e
# (2026-06-01, exp E6) raised BOTH sides to 25s on a deliberate sweep; commit
# 1d0c869 (2026-06-03) re-swept at the new VAD config, put the optimum back at
# 12s and added the overlap below, but touched no file under audio_testing/.
# So 25s here was a real experiment result that the Rust superseded two days
# later and the replica never followed. See results/p0b_shipped_config.md.
SHIPPED_MIN_SAMPLES = 192_000        # FlushProfile::LOCAL.min_samples (12s @ 16k)
SHIPPED_OVERLAP_SAMPLES = TRANSCRIPTION_OVERLAP_SAMPLES  # 16000 = 1.0s left context

# worker.rs OVERLAP_TAIL_WORDS: how many words of the previous emission are kept
# as the dedup window for the overlap prepend.
OVERLAP_TAIL_WORDS = 10

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


def dedup_overlap_prefix(prev_tail, current):
    """Exact port of `dedup_overlap_prefix` in worker.rs.

    Drops the longest prefix of `current` (up to OVERLAP_TAIL_WORDS words) that
    matches a suffix of `prev_tail`, compared case-insensitively on whole words.
    Returns `current` byte-for-byte unchanged when nothing matches, mirroring the
    Rust's `current.to_string()` early-outs.

    The match is EXACT per word: Parakeet re-decoding the replayed second does
    not have to produce the same tokens, so this catches only some of the
    duplication the overlap introduces. That residue is a real accuracy cost.
    """
    if not prev_tail:
        return current
    curr_words = current.split()
    if not curr_words:
        return ""
    max_k = min(len(curr_words), len(prev_tail), OVERLAP_TAIL_WORDS)
    overlap = 0
    for k in range(max_k, 0, -1):
        prev_slice = prev_tail[len(prev_tail) - k:]
        if all(a.lower() == b.lower() for a, b in zip(prev_slice, curr_words[:k])):
            overlap = k
            break
    if overlap == 0:
        return current
    return " ".join(curr_words[overlap:])


def emit_transcripts(texts):
    """Port of the per-emission dedup state machine in worker.rs's worker loop.

    For each engine result, in order:
      - a blank result is skipped entirely (the Rust's `!transcript.trim().is_empty()`
        guard), so it neither dedups nor updates the tail;
      - otherwise the overlap prefix is dropped, and the tail for the NEXT
        emission is the last OVERLAP_TAIL_WORDS words of the DEDUPED text
        (which can legitimately be empty if dedup consumed everything).

    Single stream here: a scored clip is one mono file, i.e. one of the Rust's
    two per-device tails.
    """
    prev_tail = []
    out = []
    for text in texts:
        if not text.strip():
            continue
        deduped = dedup_overlap_prefix(prev_tail, text)
        prev_tail = deduped.split()[-OVERLAP_TAIL_WORDS:]
        out.append(deduped)
    return out


def buffers_to_hypothesis(model, buffers, language=None,
                          overlap_samples=SHIPPED_OVERLAP_SAMPLES,
                          repetition_filter=True):
    """Flush buffers the way the shipped pipeline does and join the emissions.

    buffers -> prepend_overlap (pipeline.rs) -> engine + postprocess
            -> clean_repetitive_text (worker.rs:601)
            -> emit_transcripts (worker.rs)  -> joined hypothesis.

    `clean_repetitive_text` sits between the engine and the dedupe because that
    is where worker.rs puts it: `transcribe_chunk_with_provider`'s Parakeet arm
    runs it on `text.trim()` (worker.rs:601-606) and returns an empty string when
    it filters everything, which the worker loop's `!transcript.trim().is_empty()`
    guard (worker.rs:226) then skips without touching the dedup tail. That is
    exactly `emit_transcripts`' blank handling, so the two compose correctly.
    `repetition_filter=False` is the ablation switch, not a shipped mode.

    Returns (hyp, stats). Kept separate from transcribe_clip so the overlap and
    dedup semantics can be tested without a wav file or the real model.
    """
    chunks = prepend_overlap(buffers, overlap_samples)
    raw = []
    for c, _ in chunks:
        text = postprocess(model.transcribe(np.asarray(c, dtype=np.float32))[0],
                           language=language)
        raw.append(clean_repetitive_text(text.strip()) if repetition_filter else text)
    parts = emit_transcripts(raw)
    hyp = " ".join(p.strip() for p in parts if p.strip())
    raw_words = sum(len(p.split()) for p in raw if p.strip())
    kept_words = sum(len(p.split()) for p in parts)
    return hyp, dict(
        n_buffers=len(buffers),
        speech_s=sum(len(b) for b in buffers) / 16000.0,
        decoded_s=sum(len(c) for c, _ in chunks) / 16000.0,
        overlap_s=sum(o for _, o in chunks) / 16000.0,
        dedup_removed_words=raw_words - kept_words,
    )


def transcribe_clip(model, stem, write_hyp=False, language=None):
    """Run one clip through the full shipped pipeline; return (hyp, stats).

    `language` is the pinned user preference handed to postprocess(), mirroring
    ParakeetEngine::transcribe_audio(audio, language). None = unpinned, which is
    what the shipped default (and the gate baseline) scores.
    """
    samples = read_wav_16k_mono(CLIPS_DIR / f"{stem}.wav")
    segs = vad_segments_for_clip(samples, SHIPPED_VAD)
    buffers = assemble_buffers(segs, min_samples=SHIPPED_MIN_SAMPLES)
    hyp, stats = buffers_to_hypothesis(model, buffers, language=language)
    if write_hyp:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        (OUT_DIR / f"{stem}.meeting.txt").write_text(hyp, encoding="utf-8")
    return hyp, dict(n_segs=len(segs), **stats)


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
             "**Config:** shipped VAD (pos .40 / neg .20 / pre 300 / post 200 / "
             "redemption 800 / min-speech 100) -> drop segments <800 samples -> "
             "12s buffer (`FlushProfile::LOCAL`, 192_000 samples) or end of stream "
             "-> 1.0s left-context overlap prepended per flush -> Parakeet -> "
             "de-stutter + domain -> `clean_repetitive_text` (worker.rs:601) -> "
             "`dedup_overlap_prefix` vs the previous emission's last 10 words. "
             "Single mono stream, where the Rust runs mic and system separately "
             "(known divergence, backlog P5d).\n",
             f"**Language preference:** {mode}. De-stutter always runs; the English "
             "domain/phrase correction only runs when the pinned language is English-ish "
             "(mirrors `english_post_processing_applies` in parakeet_engine.rs).\n",
             "\n| Clip | Lang | Ref words | WER | S/D/I | VAD segs | Buffers | Speech | "
             "Decoded | Overlap | Dedup'd |",
             "|------|------|-----------|-----|-------|----------|---------|--------|"
             "---------|---------|---------|"]
    for stem in stems:
        c = res["clips"][stem]
        print(f"=== {stem} [{c['lang']}] ===  WER={c['wer']*100:.1f}%  (S={c['S']} D={c['D']} "
              f"I={c['I']} N={c['N']})  {c['n_buffers']} buffers, speech {c['speech_s']:.1f}s, "
              f"overlap {c['overlap_s']:.1f}s, dedup removed {c['dedup_removed_words']} words")
        lines.append(f"| {stem} | {c['lang']} | {c['N']} | **{c['wer']*100:.1f}%** | "
                     f"{c['S']}/{c['D']}/{c['I']} | {c['n_segs']} | {c['n_buffers']} | "
                     f"{c['speech_s']:.1f}s | {c['decoded_s']:.1f}s | {c['overlap_s']:.1f}s | "
                     f"{c['dedup_removed_words']} |")
    t = res["totals"]
    lines.append(f"| **POOLED** | all | {t['N']} | **{res['pooled']*100:.1f}%** | "
                 f"{t['S']}/{t['D']}/{t['I']} | — | — | — | — | — | — |")
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
