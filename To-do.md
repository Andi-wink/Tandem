# To-do

## Open

### Voice-driven canvas (feat/canvas-voice) — built, needs a runtime test
Tandem hosts the agent-whiteboard tldraw Agent kit in a Tauri window and drives it. The canvas/agent
code lives ONLY in agent-whiteboard (`apps/agent`, branch `feat/canvas-voice`); Tandem never forks it.

Built + compile-verified (`cargo check` + `tsc --noEmit` both clean), NOT yet runtime-tested:
- agent-whiteboard `apps/agent`: prompt bridge ([canvasPromptBridge.ts](../visual-work/agent-whiteboard/apps/agent/client/bridge/canvasPromptBridge.ts)) + prod `serve` server. Bridge proven in a headless browser (qa-bridge.mjs).
- Tandem Rust [canvas module](frontend/src-tauri/src/canvas/) — window open/hide/toggle, `canvas_send_prompt` (eval-injects a postMessage), `canvas_transcribe_clip`, `canvas_health_check`; Alt+Shift+A global push-to-talk in [lib.rs](frontend/src-tauri/src/lib.rs).
- Tandem frontend — [CanvasContext](frontend/src/contexts/CanvasContext.tsx), [CanvasDevPanel](frontend/src/components/CanvasPanel/CanvasDevPanel.tsx) (manual drive), [useCanvasVoice](frontend/src/hooks/useCanvasVoice.ts) + listening indicator.

**Runtime test plan (needs the GUI + a mic — couldn't be run headless):**
1. agent-whiteboard: `pnpm dev` (serves the agent at http://localhost:5174). Confirm it loads in a browser.
2. Tandem (this worktree): start the app (`cd frontend && pnpm run tauri:dev:cuda`) + backend.
3. Phase 1-2: open the canvas panel (bottom-left) -> **Open** -> a "Tandem Canvas" window loads :5174. Type "draw a 3-step onboarding flow" -> **Send** -> it draws. Then "make the middle box blue" -> it edits (scene-aware).
4. Phase 3: hold **Alt+Shift+A**, say "draw a login screen with email and password", release -> it draws. The "Listening..." pill should show while held.
5. Privacy/context: tick "Share last 5 min of transcript" in the panel, start a recording, discuss an automation, then Alt+Shift+A "build the last automation we discussed" -> it should use the transcript as context.

**Known caveats / follow-ups:**
- [ ] Mic contention: `useCanvasVoice` opens a 2nd mic stream via getUserMedia while the recording pipeline holds the mic. WASAPI shared mode should allow it; verify on the target machine.
- [ ] Alt+Shift+A registration can fail silently if another app owns it (same exposure as the existing Alt+Shift+S/R/V). Add detection + a configurable override if it bites.
- [ ] Prod sidecar: `canvas_health_check` exists, but spawning agent-whiteboard's `serve` as a packaged sidecar isn't wired (dev assumes :5174). Build that for a shippable prod path.
- [ ] Worktree setup drift (hit during this build): Cargo.lock is gitignored, so a fresh worktree resolved tauri 2.11.3 vs main's 2.10.2 and failed to compile. Copied main's Cargo.lock to pin. Also copied `binaries/llama-helper-*.exe` and several untracked frontend source files (NotificationContext, MermaidBlock, etc.) that committed code imports but which are uncommitted on main — commit those on main so worktrees build cleanly.

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
