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

**Done since the first build (per-meeting boards + save/view):**
- [x] Per-meeting board: the board is no longer one global store. On opening the canvas during a meeting it loads that meeting's saved board (or a blank one); switching meetings swaps boards. ([useWhiteboardPersistence.ts](frontend/src/hooks/useWhiteboardPersistence.ts), bridge `canvas:load`/`canvas:clear`).
- [x] Save + view like notes: the board auto-saves to `<meeting folder>/whiteboard.tldr.json` on canvas close, recording-stop, and app exit. Meeting-details shows a Whiteboard button (when a saved board exists) that reopens it ([page-content.tsx](frontend/src/app/meeting-details/page-content.tsx), `tandem:canvas-open-saved`).
- [x] Agent-friendly exports: each save also writes `whiteboard.png` (render, via `editor.toImage`) and `whiteboard.md` (text labels + raw HTML/CSS of built shapes) next to the JSON, so a separate agent can pick up what was drawn. New Rust `save_base64_file` command writes the PNG bytes.
- [x] Live agent access: "Connect MCP" button kept visible in embed mode so an MCP-capable agent (Claude Code) can drive/read the live board. (Complementary to the saved files.)
- [x] Solo HUD overlap: [CanvasHudGuard](frontend/src/components/CanvasPanel/CanvasHudGuard.tsx) hides the floating Solo HUD window while the canvas is open, restores it only if a Solo session is active.
- [x] Canvas-not-reachable state: [CanvasIframe](frontend/src/components/CanvasPanel/CanvasIframe.tsx) shows a message + Retry (instead of a blank frame) if the agent server readiness handshake never arrives.
- [x] Mic-contention error messages: `useCanvasVoice` now distinguishes "mic in use by another app" vs "permission denied".
- [x] Two-pass review fixes: wrong-meeting board load/save (stale folder ref), single-flight saves, `sendPrompt` stale-ready read, unmount timer cleanup, completed the `.canvas-chat-light` token set.
- [x] Save-on-quit: intercepts the Tauri window close, finishes the async save, then destroys the window (beforeunload couldn't await the IPC round-trip).
- [x] Multi-page boards: `clearBoard` wipes all pages + drops extras; `extractMarkdown` walks all pages.
- [x] postMessage hardening: both sides origin-pin replies and validate inbound source/origin (snapshots can carry confidential meeting content).
- [x] Previous-boards picker (reuse across meetings with the same client): each save mirrors into a per-client library `{project}/.tandem/whiteboards/{meeting}.{tldr.json,md,png}` + `.meta.json`; new Rust `list_whiteboards` + a History dropdown in the canvas header (shown when a Solo project is active). Client anchor = Solo project. Today's board stays separate (saves keyed to the current meeting).

**Known caveats / follow-ups:**
- [ ] Collaboration (multi-user, same board): deferred by decision. Needs tldraw `@tldraw/sync` + a sync server (self-hosted on LAN to keep data local). Revisit later.
- [ ] Prod sidecar (#3 — still open): the canvas still assumes the dev agent at :5174. For a shippable build, either (a) bundle agent-whiteboard's `serve` (node) as a Tauri sidecar (externalBin + spawn-on-startup + point `agentUrl` at it), or (b) port the kit's `/stream` SSE endpoint into Tandem's Python backend and serve the static `dist/` from Rust — removing the node dependency entirely. (b) is cleaner long-term but more work. Health check + configurable URL + the unreachable UI are already in place as the foundation.
- [ ] Mic contention: runtime-verify on the target machine that the 2nd getUserMedia stream coexists with the recording pipeline under WASAPI shared mode (error handling is now graceful either way).
- [ ] Alt+Shift+A registration can fail silently if another app owns it (same exposure as the existing Alt+Shift+S/R/V). Add detection + a configurable override if it bites.
- [ ] Voice + auto-routing need a proper runtime pass (only lightly exercised).
- [ ] (Backlog) Production CSP: `connect-src` has no `ws:`/`127.0.0.1` entries and the agent app ships no CSP, so a hardened/packaged build would block the MCP WebSocket (`ws://127.0.0.1:3000`). Works in dev (same-origin from the iframe, Vite-proxied). Fix alongside the prod sidecar: add `ws://localhost:* ws://127.0.0.1:* http://127.0.0.1:*` to connect-src + a CSP on the agent app.
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

### Channel-based speaker labels (you / Client) — shipped on feature/speaker-diarization
The simple 1:1-call approach: mic channel = your name (default "Andrew", set in Preferences), system channel = "Client". Surfaced as transcript badges + in summaries + AI/@code context, reusing the `source` label already on every segment. Pyannote stays optional (takes precedence when present). Commit 9733d49; `tsc` + `cargo check` clean. Adversarial QA done (3 skeptics). Follow-ups / known limits:
- [ ] Echo bleed (the #1 real-world accuracy risk): on open speakers the client's voice re-enters your mic and can be labelled as you. AEC runs but is undercut by ring-buffer drift + no `set_stream_delay_ms` hint. Options: feed AEC a delay hint / align channels before AEC; detect headphones and nudge the user; add a "use headphones for best speaker accuracy" note near recording. Headphones eliminate it today.
- [ ] Device-role validation: if the mic slot is a loopback / "Stereo Mix" / virtual cable / the same device as system, "your" channel is poisoned with client audio. Warn when the mic device looks like a loopback or duplicates the system device.
- [ ] Multiple remote speakers all show as "Client" (inherent). Layer pyannote-on-system (the eval harness already supports `--mode channels`) if per-remote-speaker splitting is ever needed.
- [ ] pyannote `speaker_label` is not persisted (no column), so its precedence only applies to a freshly-diarized, still-open meeting. Add a column + model/API field if pyannote labels should survive a reload.
- [ ] "Client" label is fixed (not per-meeting editable). Add a remote-name setting if desired.

### Speaker Diarization (F022) — recovered onto main, harness built
Recovered the orphaned F022 work onto `feature/speaker-diarization` (rebased off main) and built an eval harness in [audio_testing/diarization/](audio_testing/diarization/). Approach chosen: **channel split + pyannote on the system channel** (mic = local speaker, trusted). Remaining:
- [ ] Phase 5.5 runtime: `pip install pyannote.audio torchaudio scipy requests`, accept the `pyannote/speaker-diarization-community-1` terms on HuggingFace, set `HF_TOKEN`. (torch already installed; pyannote is NOT.)
- [ ] Bootstrap ground truth: `ELEVENLABS_API_KEY` set, run [fetch_elevenlabs_refs.py](audio_testing/diarization/fetch_elevenlabs_refs.py), then hand-correct `refs/<clip>.diar.json` into the perfect examples.
- [ ] Run the loop ([run_diarization.py](audio_testing/diarization/run_diarization.py)) in `--mode mixed`, iterate `CONFIGS`, push pooled WSA toward ~100%.
- [ ] Channel-split (`--mode channels`) needs split-track clips `clips/<clip>_mic.wav` + `clips/<clip>_system.wav`. Record a few short calls with `TANDEM_SAVE_RAW_TRACKS=1` (the audio-aec worktree saves raw tracks) to unlock the production-target evaluation.
- [ ] End-to-end product test: install deps, download model via Settings, diarize a real recording, verify speaker badges render (recovered UI compiles; not yet runtime-tested).
- [ ] Cleanup: once recovery is confirmed good, delete the stale `D:/Dev-projects/Tandem-f022-orphan` directory (kept as the recovery source).

## Done
- Established transcription WER baseline for the current engine (Parakeet TDT v3 int8) vs ElevenLabs ground truth: 31.4% pooled (exact meeting pipeline).
- Implemented engine improvements #1 (de-stutter), #3 (domain correction), #4 (sensitive VAD, ~99.5% word coverage), #5 (12s context window): pooled WER 31.4% -> 26.0%. `cargo check` passes.
- Built the WER measurement harness (real Silero VAD + buffer assembly + Parakeet replica) and the local regression gate.
