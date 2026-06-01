# To-do

## Open

### Transcription WER regression gate (#10) — follow-ups to make it CI-grade
The local gate is done ([wer_gate.py](audio_testing/wer_gate.py), [README](audio_testing/README_wer_gate.md), baseline [wer_baseline.json](audio_testing/wer_baseline.json)). Before wiring into PR CI:
- [ ] Expand the benchmark clip set to ~20-30 balanced clips (more speakers, more English, fewer single-language outliers). 5 clips with one German clip is statistically noisy.
- [ ] Add a Rust `transcribe_file` entry point (e.g. `cargo run --bin transcribe_file <wav>`) so the gate scores the actual shipped engine, not the Python replica/mirror.
- [ ] Wire into [.github/workflows/pr-main-check.yml](.github/workflows/) with model download + cache (int8 encoder is 652MB, can't be committed). Until then, run locally / nightly.

### Transcription quality — larger levers not yet explored (from the WER review)
- [ ] #6 Benchmark fp32 Parakeet vs int8 on the same clips to quantify the quantization WER cost (RTX 3090 makes the speed hit likely irrelevant).
- [ ] #7 Language routing: the German clip is ~65% WER. Detect language and route non-English to a stronger model or surface a low-confidence warning.
- [ ] #8 Evaluate the installed Canary models (canary-qwen-2.5b, canary-1b) through the same harness for an accuracy comparison.
- [ ] #9 Optional second-pass LLM transcript cleanup (Ollama/Claude already configured).

### Security
- [ ] Anthropic API key is stored in plaintext in the Rust `settings` table (meeting_minutes.sqlite), contradicting CLAUDE.md's "localStorage only / never stored server-side" claim. Decide on encryption-at-rest or removal.

## Done
- Established transcription WER baseline for the current engine (Parakeet TDT v3 int8) vs ElevenLabs ground truth: 31.4% pooled (exact meeting pipeline).
- Implemented engine improvements #1 (de-stutter), #3 (domain correction), #4 (sensitive VAD, ~99.5% word coverage), #5 (12s context window): pooled WER 31.4% -> 26.0%. `cargo check` passes.
- Built the WER measurement harness (real Silero VAD + buffer assembly + Parakeet replica) and the local regression gate.
