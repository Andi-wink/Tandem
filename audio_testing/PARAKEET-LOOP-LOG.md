# Parakeet loop log

One line per iteration. Survives compaction: resume from the last row.

Baseline at loop start (2026-08-11, reproduced twice to 5dp, deterministic):
pooled **21.543%** | clip_02 16.4% | clip_04 17.5% | clip_06 6.5% | clip_07 (de) 53.5% | clip_10 3.1%

| # | Item | Verdict | Pooled WER | Key files | Commit |
|---|------|---------|-----------|-----------|--------|
| 1 | P0 language-aware harness | **FAIL** (1 PASS / 1 FAIL, no majority), code kept, defects fixed | 21.543% (unchanged, by design) | [run_tandem_parakeet.py](run_tandem_parakeet.py), [run_tandem_meeting_wer.py](run_tandem_meeting_wer.py), [wer_gate.py](wer_gate.py), [test_language_gating.py](test_language_gating.py) | `0053df3`, `d51430e` |

| 2 | P1b find the dropped blocks | **FAIL** (2 FAIL / 0 PASS), diagnosis rescoped, no code changed | 21.543% (untouched) | [p1b_content_loss.md](results/p1b_content_loss.md), [p1b_qa_causal.md](results/p1b_qa_causal.md), [p1b_qa_shipped_config.md](results/p1b_qa_shipped_config.md) | `31b67f5`..(docs only) |

**Iteration 2 notes.** No production code changed. The iteration paid for itself anyway, by
invalidating its own premise and the loop's baseline.

- **Upheld:** VAD is not the loss stage (2 words lost across the whole benchmark) and the buffer
  join is lossless (107=107 on all 5 clips). By elimination the decoder loses the content.
- **Falsified by QA:** the buffer-length decay mechanism was a denominator artefact (recall flat,
  r = +0.056 when the audio window is held fixed); the "14-word block" is unremarkable (60th
  percentile of clip_07 windows, better than the median 12.7% recall); and English does not share
  the mechanism (added context recovers clip_02 but not clip_07, opposite directions).
- **The finding that outranks the item: the harness has not scored the shipped config since
  2026-06-03.** `1d0c869` moved Rust to 12s buffers plus a 1s overlap and never touched
  `audio_testing/`. Shipped scores 22.830% (D=38); the gate says 21.543% (D=62). Pooled is 1.29 pp
  optimistic but the **deletion rate is overstated by 39%**, which is the exact quantity this
  iteration was analysing. New blocking item **P0b**.
- **Self-inflicted deletions:** `collapse_runaways` is worth +17.5 pp overall and must stay, but on
  clip_07 it turns 10 substitutions into deletions. 10 of the 37 German deletions are ours.
- Confidence calibration corrected: the builder claimed "medium confidence" in a mechanism it had
  only reached by elimination, and routed a fix at `model.rs::decode_sequence` on that basis.

**Iteration 1 notes.** The P0 code was verified correct by both skeptics (pooled reproduced to 17
digits, 29/29 predicate parity against real `cargo test`, no cheating, nothing sensitive committed).
It failed on what it revealed, not on what it built:

- The error-profile "standing facts" I seeded the backlog with were measured on **openai-whisper
  small**, not Parakeet. German is deletion-dominant, not substitution-dominant. Backlog corrected;
  `research/german-calls-2026-08-11.md` and `To-do.md` carry the same error and need the same fix.
- **German N=142 gives a 16.2 pp confidence interval.** Nothing under ~10 pp is measurable.
  New blocking item P1a (expand the German set) ahead of all other German work.
- Pinning `de` on clip_07 changed the WER by **exactly zero**, because the English corrector fires
  on none of the 5 clips. Honest null result for commit `8d11103` on this benchmark.
- Two real defects found and fixed in-iteration: a third divergent copy of the English predicate in
  `parakeet_provider.rs` (logged a warning contradicting the engine's actual behaviour), and the
  gate never exercising the pinned-language path (inverting the predicate still passed).

