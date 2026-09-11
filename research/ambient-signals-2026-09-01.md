# Round 2: OCR reality check, and the signals that are actually cheap

Run 2026-09-01, three agents working separately: OCR accuracy research, OCR feature ideas, and non-pixel ambient signals.

**Headline: the OCR path is much weaker than round 1 assumed, and the non-pixel signals are much stronger.**

---

## The OCR correction

Round 1 treated `Windows.Media.Ocr` as a free primitive: already on the machine, no VRAM, just call it. That was wrong in three ways.

**1. It cannot be called from this app at all.**
It requires MSIX "package identity". Tandem's bundle targets are `msi` and `nsis` ([tauri.conf.json:147](../frontend/src-tauri/tauri.conf.json#L147)), which produce an unpackaged EXE. Unpackaged Win32 apps get `APPMODEL_ERROR_NO_PACKAGE`. Microsoft publishes a Tauri-specific guide purely because of this blocker, involving a `Package.appxmanifest`, a signing cert, and either a sparse package or full MSIX repackaging.

**2. There are no confidence scores.**
`OcrWord` exposes exactly `Text` and `BoundingRect`. Nothing else. You can never distinguish a confident read from a guess, which disqualifies it from anything acted on automatically.

**3. There are no published accuracy benchmarks. None.**
It does not appear in OCRBench or any comparison suite. The "98-99% on code screenshots" figures on SEO sites are unverified marketing. The research agent explicitly refused to invent a number.

The newer `TextRecognizer` API is also out: it requires a Copilot+ NPU. An RTX 3090 does not qualify.

### Verdict by use case

| Use | Verdict | Why |
|---|---|---|
| Detect the screen changed meaningfully | **Yes** | Does not need OCR at all. A perceptual hash does it |
| Read an error or stack trace | **Maybe** | Single-column high-contrast text suits it, but no confidence signal to validate against |
| Extract a `file:line` reference | **No** | The fragile case: colons, dots, digits, underscores, with no way to catch a silent misread |
| Read a whole code file | **No** | Error compounds, and there is no measured rate for this engine |

Untested and worth knowing: programming ligatures. Fira Code and Cascadia Code render `->`, `=>`, `!=`, `::` as single merged glyphs. No OCR benchmark addresses this for any engine.

### If OCR is still wanted, two better paths

- **PaddleOCR via `ort`.** `ort` is already at [Cargo.toml:109](../frontend/src-tauri/Cargo.toml#L109) for Parakeet. No packaging blocker, no new runtime, per-word confidence, and it measurably beats Tesseract on screenshot-like content. Cost is 10-40MB of model weights.
- **OneOCR**, the engine behind Windows 11's Snipping Tool. ONNX loaded as plain DLLs, so no package identity needed. Rust bindings exist with confidence scores. But it is reverse-engineered, requires shipping copied Microsoft binaries, and a Snipping Tool update could break it.

### The OCR ideas that survive

Only the ones that tolerate bad text:

- **Stuck-build tripwire.** Hash the OCR'd terminal every few seconds. A frozen hash means the build hung. Needs zero character accuracy.
- **Auto-attach screen text on `@code`.** Pure LLM context, so garbled text still helps. Today a `@code fix this` task file has no idea what "this" is.
- **Toast graveyard.** Text that appears and vanishes: Docker flashing "port is already allocated", installer dialogs with no log file.

The accuracy-sensitive ones (capturing secrets that print once, config drift detection) get much weaker without confidence scores.

---

## The real find: signals that cost almost nothing

The third agent verified what is already in the tree:

| Already present | Gives us |
|---|---|
| `xcap = "0.8"` ([Cargo.toml:161](../frontend/src-tauri/Cargo.toml#L161)) | `Window::all()` with `.title()`, `.app_name()`, `.pid()`, `.is_focused()`. Foreground tracking, zero new deps |
| `sysinfo = "0.32"` ([Cargo.toml:138](../frontend/src-tauri/Cargo.toml#L138)) | Process enumeration, already used in `whisper_engine/system_monitor.rs` |
| `windows-sys`, 6 versions in `Cargo.lock` | Already compiled transitively. Declaring it directly is a new doorway, not a new dependency tree |
| `git_branch_for()` in `claude_sessions/mod.rs:119` | Already parses `.git/HEAD` off disk. No shell-out, no `git2` |
| `quick_capture/mod.rs` | Already polls the clipboard every 1.5s, just gated behind a UI toggle |

`notify` (filesystem watching) is the only genuinely new crate.

### Best ideas, by value over cost

1. **Dev-server heartbeat.** TCP-connect to 3118, 5167, 8178, 11434 on a timer. **Stdlib only**, `TcpStream::connect_timeout`, no crate at all. Knows the instant the backend dies or comes back. Doubles as proof-of-fix for the agent: the port came back, so the crash loop is genuinely fixed.
2. **Git trainwhistle.** Watch `.git/HEAD` and `refs/heads/*`. A commit is never ambiguous, and it marks a hard boundary between units of work, which the router currently has to infer from prose. Reuses the existing HEAD parser. Needs debouncing, since `git status` also touches `.git/index`.
3. **Build/test exit ledger.** Spot `cargo`, `pytest`, `tsc` starting via `sysinfo`, then `OpenProcess` + `WaitForSingleObject` + `GetExitCodeProcess` for the **real exit code**. `sysinfo` alone cannot do this, it has no `wait()`.
4. **Non-zero exit auto-files a task.** A five-line branch on top of #3, and the sharpest idea in the batch: a failed `cargo check` does not need an LLM to decide it is actionable. It always is. This bypasses the classifier entirely.
5. **Idle-gap trigger.** `GetLastInputInfo` is one syscall returning ms since last input. Fire the classifier ~3s after the developer stops, so it captures a complete thought instead of truncating at an arbitrary 30s boundary.
6. **GPU headroom gate.** `nvidia-smi --query-gpu=memory.free`, already installed. Skip a routing call when VRAM is tight, so classification never starves live transcription. Directly addresses this machine's documented headroom problem.

Riskiest in the batch is **toast interception** (`UserNotificationListener`): powerful, but it reads Slack DM previews and email previews, needs an OS consent grant, and has inconsistent Windows 10 support. Needs per-app allowlisting, not a blanket grant. Spike it in a throwaway binary before touching Tandem.

---

## Answering round 1's open question: what replaces the 30-second timer

The current trigger ([useSoloModeRouter.ts:665-689](../frontend/src/hooks/useSoloModeRouter.ts#L665-L689)) is two things bolted together: a content gate (`MIN_NEW_SEGMENTS = 5`, already event-like and fine) and a time gate (`ROUTING_INTERVAL_MS = 30_000`, a pure clock). Only the clock is the problem.

**Keep the content gate. Replace the clock with a union of real events:**

- **Fire now**, ranked by how unambiguous they are: a git commit, a tracked build or test exiting non-zero, a dev server port transition
- **Gate on cheap-and-safe**: idle for ~3s since last input, so a complete thought is captured and the GPU is not being fought over mid-keystroke
- **Hard backstop**: skip or delay if VRAM headroom is critically low
- **Demote the 30s clock to a fallback ceiling**, not the primary trigger

A commit is the single best replacement candidate. It is never ambiguous, and it marks exactly the boundary the router currently has to guess at from prose.

---

## Cross-round conclusion

Round 1's three agents converged on the timer being the root problem. Round 2 says the fix does not need OCR, does not need a vision model, and mostly does not need new dependencies. The strongest signals are the unambiguous ones the OS already emits for free.

Build order: dev-server heartbeat, then the exit ledger with auto-filing, then the git watcher, then swap the timer. That sequence is roughly a week and removes the biggest structural problem the audit found.
