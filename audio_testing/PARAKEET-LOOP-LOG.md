# Parakeet loop log

One line per iteration. Survives compaction: resume from the last row.

Baseline at loop start (2026-08-11, reproduced twice to 5dp, deterministic):
pooled **21.543%** | clip_02 16.4% | clip_04 17.5% | clip_06 6.5% | clip_07 (de) 53.5% | clip_10 3.1%

| # | Item | Verdict | Pooled WER | Key files | Commit |
|---|------|---------|-----------|-----------|--------|
| 1 | P0 language-aware harness | **FAIL** (1 PASS / 1 FAIL, no majority), code kept, defects fixed | 21.543% (unchanged, by design) | [run_tandem_parakeet.py](run_tandem_parakeet.py), [run_tandem_meeting_wer.py](run_tandem_meeting_wer.py), [wer_gate.py](wer_gate.py), [test_language_gating.py](test_language_gating.py) | `0053df3`, `d51430e` |

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

