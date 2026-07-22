# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Tandem** is a privacy-first AI co-pilot that works alongside you on every call — capturing, transcribing, and collaborating in real time, entirely on local infrastructure. The project consists of two main components:

1. **Frontend**: Tauri-based desktop application (Rust + Next.js + TypeScript)
2. **Backend**: FastAPI server for meeting storage, LLM summarization, AI assistant (Claude Agent SDK), and PII anonymization (Python)

### Key Technology Stack
- **Desktop App**: Tauri 2.x (Rust) + Next.js 14 + React 18
- **Audio Processing**: Rust (cpal, whisper-rs, professional audio mixing)
- **Transcription**: Whisper.cpp (local, GPU-accelerated)
- **Backend API**: FastAPI + SQLite (aiosqlite for backend, sqlx for Rust frontend)
- **AI Assistant**: Claude Agent SDK (Python) with SSE streaming to frontend
- **PII Anonymization**: Microsoft Presidio + spaCy NER (on-device)
- **LLM Integration**: Ollama (local), Claude, Groq, OpenRouter
- **UI**: Tailwind CSS with dark mode (next-themes), shadcn/ui components

## Project Tracking (IMPORTANT)

**Always check these files before starting work — they are the source of truth for project status:**

- **`feature_list.json`** — All features (F001-F020+), their status (complete/in-progress/planned), implementation steps, file lists, and which branch/worktree they live on. **Read this first** when asked about feature status or what to work on next.
- **`bug_list.json`** — All known bugs (B001-B029) and refactoring items (R001-R004) with severity, affected files, line numbers, and fix descriptions. **Check this** before modifying any file to see if there are known issues.
- **`refactoring_list.json`** — Additional refactoring opportunities.

When completing work, **update these files** to reflect the new status.

## Git Worktrees

Feature branches are developed in separate worktrees to allow parallel work:

```bash
git worktree list                                           # See active worktrees
git worktree add ../Tandem-f{NNN} -b feature/{name}        # Create new feature worktree
```

Worktrees live at `D:\Dev projects\Tandem-{id}` (e.g., `Tandem-f018` for F018). The main repo is at `D:\Dev projects\Tandem` on branch `main`. When working in a worktree, `pnpm install` is needed separately since `node_modules` isn't shared.

## Essential Development Commands

### Frontend Development (Tauri Desktop App)

**Location**: `/frontend`

```bash
# macOS Development
./clean_run.sh              # Clean build and run with info logging
./clean_run.sh debug        # Run with debug logging
./clean_build.sh            # Production build

# Windows Development
clean_run_windows.bat       # Clean build and run
clean_build_windows.bat     # Production build

# Manual Commands
pnpm install                # Install dependencies
pnpm run dev                # Next.js dev server (port 3118)
pnpm run tauri:dev          # Full Tauri development mode
pnpm run tauri:build        # Production build

# GPU-Specific Builds (for testing acceleration)
pnpm run tauri:dev:metal    # macOS Metal GPU
pnpm run tauri:dev:cuda     # NVIDIA CUDA
pnpm run tauri:dev:vulkan   # AMD/Intel Vulkan
pnpm run tauri:dev:cpu      # CPU-only (no GPU)
```

### Backend Development (FastAPI Server)

**Location**: `/backend`

```bash
# macOS
./build_whisper.sh small              # Build Whisper with 'small' model
./clean_start_backend.sh              # Start FastAPI server (port 5167)

# Windows
build_whisper.cmd small               # Build Whisper with model
start_with_output.ps1                 # Interactive setup and start
clean_start_backend.cmd               # Start server

# Docker (Cross-Platform)
./run-docker.sh start --interactive   # Interactive setup (macOS/Linux)
.\run-docker.ps1 start -Interactive   # Interactive setup (Windows)
./run-docker.sh logs --service app    # View logs
```

**Available Whisper Models**: `tiny`, `tiny.en`, `base`, `base.en`, `small`, `small.en`, `medium`, `medium.en`, `large-v1`, `large-v2`, `large-v3`, `large-v3-turbo`

### Verification Commands (run after every change)

```bash
cd frontend && pnpm tsc --noEmit     # TypeScript type check (no emit)
cd frontend/src-tauri && cargo check  # Rust compilation check
```

**CI requirement**: No tests run in CI yet. PRs should not merge without `pnpm tsc --noEmit`, `pnpm test`, and `pytest` passing. See `.github/workflows/` — test steps need to be added to `pr-main-check.yml`.

### Service Endpoints
- **Whisper Server**: http://localhost:8178
- **Backend API**: http://localhost:5167
- **Backend Docs**: http://localhost:5167/docs
- **Frontend Dev**: http://localhost:3118

### Claude Code Autonomous Loop (F054 Handoff)

During a meeting, the user can say `@code <task>` to hand off work to Claude Code running in a terminal. The workflow:

1. Tandem writes a task file to `.tandem/tasks/<timestamp>.md` with the task + transcript context
2. Claude Code polls for new task files, executes them, then deletes the file
3. `.tandem/live-transcript.md` provides rolling 30-min transcript as background context

**Running locally (Windows):**
```bash
# Terminal 1: Start Claude Code in autonomous mode
cd "D:\Dev projects\Tandem"
claude --dangerously-skip-permissions

# Then inside Claude Code, start the loop:
/loop 1m Check .tandem/tasks/ for new .md files. If found, read the task, execute it, then delete the file. Use .tandem/live-transcript.md as background context only — do not start tasks from the transcript alone.
```

**Running in Docker (fully autonomous):**
```bash
# Build the Claude Code runner
docker build -f Dockerfile.claude-code -t tandem-claude-code .

# Run with project mounted + API key
docker run -it --rm \
  -v "$(pwd):/project" \
  -e ANTHROPIC_API_KEY=your-key-here \
  tandem-claude-code
```

See `Dockerfile.claude-code` and `docker-compose.claude-code.yml` for configuration. The Docker setup skips all permissions and runs the loop automatically on startup.

## High-Level Architecture

### Three-Tier System Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Frontend (Tauri Desktop App)                     │
│  ┌──────────────────┐  ┌─────────────────┐  ┌────────────────────┐  │
│  │   Next.js UI     │  │  Rust Backend   │  │  Whisper Engine    │  │
│  │  (React/TS)      │←→│  (Audio + IPC)  │←→│  (Local STT)      │  │
│  │  AI Panel        │  │  SQLite (sqlx)  │  │                    │  │
│  └──────────────────┘  └─────────────────┘  └────────────────────┘  │
│    ↑ Tauri Events + SSE        ↑ Audio Pipeline                      │
└────┼───────────────────────────┼─────────────────────────────────────┘
     │ HTTP/SSE                  │
     ↓                           │
┌────┼───────────────────────────┼─────────────────────────────────────┐
│    │         Backend (FastAPI) │                                      │
│  ┌─┴──────────┐  ┌────────────┴───────┐  ┌───────────────────────┐  │
│  │  SQLite    │←→│  Meeting Manager   │←→│  LLM Provider         │  │
│  │ (aiosqlite)│  │  (CRUD + Summary)  │  │  (Ollama/Claude/Groq) │  │
│  └────────────┘  └────────────────────┘  └───────────────────────┘  │
│                  ┌────────────────────┐  ┌───────────────────────┐   │
│                  │  Claude Agent SDK  │  │  Presidio Anonymizer  │   │
│                  │  (SSE streaming)   │  │  (PII → surrogates)   │   │
│                  └────────────────────┘  └───────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

**Two SQLite databases**: The Rust frontend has its own SQLite via `sqlx` (meetings, transcripts, settings, API keys in `src-tauri/src/database/`). The Python backend has a separate SQLite via `aiosqlite` (meeting summaries, processes). Don't confuse them.

### Audio Processing Pipeline (Critical Understanding)

The audio system has **two parallel paths** with different purposes:

```
Raw Audio (Mic + System)
         ↓
┌────────────────────────────────────────────────────────────┐
│              Audio Pipeline Manager                         │
│  (frontend/src-tauri/src/audio/pipeline.rs)                │
└─────────────┬──────────────────────────┬───────────────────┘
              ↓                          ↓
    ┌─────────────────┐        ┌─────────────────────┐
    │ Recording Path  │        │ Transcription Path  │
    │ (Pre-mixed)     │        │ (VAD-filtered)      │
    └─────────────────┘        └─────────────────────┘
              ↓                          ↓
    RecordingSaver.save()      WhisperEngine.transcribe()
```

**Key Insight**: The pipeline performs **professional audio mixing** (RMS-based ducking, clipping prevention) for recording, while simultaneously applying **Voice Activity Detection (VAD)** to send only speech segments to Whisper for transcription.

### Audio Device Modularization

The audio system is organized into focused modules (refactored from a monolithic `core.rs`). See [AUDIO_MODULARIZATION_PLAN.md](AUDIO_MODULARIZATION_PLAN.md) for details.

```
audio/
├── devices/                    # Device discovery and configuration
│   ├── discovery.rs           # list_audio_devices, trigger_audio_permission
│   ├── microphone.rs          # default_input_device
│   ├── speakers.rs            # default_output_device
│   ├── configuration.rs       # AudioDevice types, parsing
│   └── platform/              # Platform-specific implementations
│       ├── windows.rs         # WASAPI logic (~200 lines)
│       ├── macos.rs           # ScreenCaptureKit logic
│       └── linux.rs           # ALSA/PulseAudio logic
├── capture/                   # Audio stream capture
│   ├── microphone.rs          # Microphone capture stream
│   ├── system.rs              # System audio capture stream
│   └── core_audio.rs          # macOS ScreenCaptureKit integration
├── pipeline.rs                # Audio mixing and VAD processing
├── recording_manager.rs       # High-level recording coordination
├── recording_commands.rs      # Tauri command interface
└── recording_saver.rs         # Audio file writing
```

**When working on audio features**:
- Device detection issues → `devices/discovery.rs` or `devices/platform/{windows,macos,linux}.rs`
- Microphone/speaker problems → `devices/microphone.rs` or `devices/speakers.rs`
- Audio capture issues → `capture/microphone.rs` or `capture/system.rs`
- Mixing/processing problems → `pipeline.rs`
- Recording workflow → `recording_manager.rs`

### Rust ↔ Frontend Communication (Tauri Architecture)

**Command Pattern** (Frontend → Rust):
```typescript
// Frontend: src/app/page.tsx
await invoke('start_recording', {
  mic_device_name: "Built-in Microphone",
  system_device_name: "BlackHole 2ch",
  meeting_name: "Team Standup"
});
```

```rust
// Rust: src/lib.rs
#[tauri::command]
async fn start_recording<R: Runtime>(
    app: AppHandle<R>,
    mic_device_name: Option<String>,
    system_device_name: Option<String>,
    meeting_name: Option<String>
) -> Result<(), String> {
    // Implementation delegates to audio::recording_commands
}
```

**Event Pattern** (Rust → Frontend):
```rust
// Rust: Emit transcript updates
app.emit("transcript-update", TranscriptUpdate {
    text: "Hello world".to_string(),
    timestamp: chrono::Utc::now(),
    // ...
})?;
```

```typescript
// Frontend: Listen for events
await listen<TranscriptUpdate>('transcript-update', (event) => {
  setTranscripts(prev => [...prev, event.payload]);
});
```

### Whisper Model Management

**Model Storage Locations**:
- **Development**: `frontend/models/` or `backend/whisper-server-package/models/`
- **Production (macOS)**: `~/Library/Application Support/Tandem/models/`
- **Production (Windows)**: `%APPDATA%\Tandem\models\`

**Model Loading** (frontend/src-tauri/src/whisper_engine/whisper_engine.rs):
```rust
pub async fn load_model(&self, model_name: &str) -> Result<()> {
    // Automatically detects GPU capabilities (Metal/CUDA/Vulkan)
    // Falls back to CPU if GPU unavailable
}
```

**GPU Acceleration**:
- **macOS**: Metal + CoreML (automatically enabled)
- **Windows/Linux**: CUDA (NVIDIA), Vulkan (AMD/Intel), or CPU
- Configure via Cargo features: `--features cuda`, `--features vulkan`

## Critical Development Patterns

### 1. Audio Buffer Management

**Ring Buffer Mixing** (pipeline.rs):
- Mic and system audio arrive asynchronously at different rates
- Ring buffer accumulates samples until both streams have aligned windows (50ms)
- Professional mixing applies RMS-based ducking to prevent system audio from drowning out microphone
- Uses `VecDeque` for efficient windowed processing

### 2. Thread Safety and Async Boundaries

**Recording State** (recording_state.rs):
```rust
pub struct RecordingState {
    is_recording: Arc<AtomicBool>,
    audio_sender: Arc<RwLock<Option<mpsc::UnboundedSender<AudioChunk>>>>,
    // ...
}
```

**Key Pattern**: Use `Arc<RwLock<T>>` for shared state across async tasks, `Arc<AtomicBool>` for simple flags.

### 3. Error Handling and Logging

**Performance-Aware Logging** (lib.rs):
```rust
#[cfg(debug_assertions)]
macro_rules! perf_debug {
    ($($arg:tt)*) => { log::debug!($($arg)*) };
}

#[cfg(not(debug_assertions))]
macro_rules! perf_debug {
    ($($arg:tt)*) => {};  // Zero overhead in release builds
}
```

**Usage**: Use `perf_debug!()` and `perf_trace!()` for hot-path logging that should be eliminated in production.

### 4. Frontend State Management

The app uses multiple React contexts. Key ones:

| Context | File | Purpose |
|---------|------|---------|
| **SidebarProvider** | `components/Sidebar/SidebarProvider.tsx` | Meetings list, current meeting, server address |
| **RecordingStateContext** | `contexts/RecordingStateContext.tsx` | Single source of truth for recording state (isRecording, isPaused, status) |
| **TranscriptContext** | `contexts/TranscriptContext.tsx` | Live transcript segments from Whisper via Tauri `transcript-update` events |
| **ClaudeContext** | `contexts/ClaudeContext.tsx` | AI panel: session, conversation, context basket, SSE streaming with RAF batching |
| **ScreenshotContext** | `contexts/ScreenshotContext.tsx` | Screenshot (Alt+Shift+S) and annotate (Alt+Shift+R) capture events |
| **ClipboardContext** | `contexts/ClipboardContext.tsx` | Clipboard capture events (Alt+Shift+V) |
| **ConfigContext** | `contexts/ConfigContext.tsx` | App config, transcript model settings |

**Pattern**: Tauri commands update Rust state → Emit events → Frontend listeners update React state → Context propagates to components

**AI Panel pattern**: Frontend sends HTTP POST to backend → backend streams SSE events → frontend reads via `fetch()` + `ReadableStream` → RAF-batched state updates (max 60fps)

## Common Development Tasks

### Adding a New Audio Device Platform

1. Create platform file: `audio/devices/platform/{platform_name}.rs`
2. Implement device enumeration for the platform
3. Add platform-specific configuration in `audio/devices/configuration.rs`
4. Update `audio/devices/platform/mod.rs` to export new platform functions
5. Test with `cargo check` and platform-specific device tests

### Adding a New Tauri Command

1. Define command in `src/lib.rs`:
   ```rust
   #[tauri::command]
   async fn my_command(arg: String) -> Result<String, String> { /* ... */ }
   ```
2. Register in `tauri::Builder`:
   ```rust
   .invoke_handler(tauri::generate_handler![
       start_recording,
       my_command,  // Add here
   ])
   ```
3. Call from frontend:
   ```typescript
   const result = await invoke<string>('my_command', { arg: 'value' });
   ```

### Modifying Audio Pipeline Behavior

**Location**: `frontend/src-tauri/src/audio/pipeline.rs`

Key components:
- `AudioMixerRingBuffer`: Manages mic + system audio synchronization
- `ProfessionalAudioMixer`: RMS-based ducking and mixing
- `AudioPipelineManager`: Orchestrates VAD, mixing, and distribution

**Testing Audio Changes**:
```bash
# Enable verbose audio logging
RUST_LOG=app_lib::audio=debug ./clean_run.sh

# Monitor audio metrics in real-time
# Check Developer Console in the app (Cmd+Shift+I on macOS)
```

### Backend API Development

**Adding New Endpoints** (backend/app/main.py):
```python
@app.post("/api/my-endpoint")
async def my_endpoint(request: MyRequest) -> MyResponse:
    # Use DatabaseManager for persistence
    db = DatabaseManager()
    result = await db.some_operation()
    return result
```

**Database Operations** (backend/app/db.py):
- All meeting data stored in SQLite
- Use `DatabaseManager` class for all DB operations
- Async operations with `aiosqlite`

## Testing and Debugging

### Frontend Debugging

**Enable Rust Logging**:
```bash
# macOS
RUST_LOG=debug ./clean_run.sh

# Windows (PowerShell)
$env:RUST_LOG="debug"; ./clean_run_windows.bat
```

**Developer Tools**:
- Open DevTools: `Cmd+Shift+I` (macOS) or `Ctrl+Shift+I` (Windows)
- Console Toggle: Built into app UI (console icon)
- View Rust logs: Check terminal output

### Backend Debugging

**View API Logs**:
```bash
# Backend logs show in terminal with detailed formatting:
# 2025-01-03 12:34:56 - INFO - [main.py:123 - endpoint_name()] - Message
```

**Test API Directly**:
- Swagger UI: http://localhost:5167/docs
- ReDoc: http://localhost:5167/redoc

### Audio Pipeline Debugging

**Key Metrics** (emitted by pipeline):
- Buffer sizes (mic/system)
- Mixing window count
- VAD detection rate
- Dropped chunk warnings

**Monitor via Developer Console**: The app includes real-time metrics display when recording.

## Platform-Specific Notes

### macOS
- **Audio Capture**: Uses ScreenCaptureKit for system audio (macOS 13+)
- **GPU**: Metal + CoreML automatically enabled
- **Permissions**: Requires microphone + screen recording permissions
- **System Audio**: Requires virtual audio device (BlackHole) for system capture

### Windows
- **Audio Capture**: Uses WASAPI (Windows Audio Session API)
- **GPU**: CUDA (NVIDIA) or Vulkan (AMD/Intel) via Cargo features
- **Build Tools**: Requires Visual Studio Build Tools with C++ workload
- **System Audio**: Uses WASAPI loopback for system capture

### Linux
- **Audio Capture**: ALSA/PulseAudio
- **GPU**: CUDA (NVIDIA) or Vulkan via Cargo features
- **Dependencies**: Requires cmake, llvm, libomp

## Performance Optimization Guidelines

### Audio Processing
- Use `perf_debug!()` / `perf_trace!()` for hot-path logging (zero cost in release)
- Batch audio metrics using `AudioMetricsBatcher` (pipeline.rs)
- Pre-allocate buffers with `AudioBufferPool` (buffer_pool.rs)
- VAD filtering reduces Whisper load by ~70% (only processes speech)

### Whisper Transcription
- **Model Selection**: Balance accuracy vs speed
  - Development: `base` or `small` (fast iteration)
  - Production: `medium` or `large-v3` (best quality)
- **GPU Acceleration**: 5-10x faster than CPU
- **Parallel Processing**: Available in `whisper_engine/parallel_processor.rs` for batch workloads

### Frontend Performance
- React state updates batched via Sidebar context
- Transcript rendering virtualized for large meetings
- Audio level monitoring throttled to 60fps
- AI streaming uses `requestAnimationFrame` batching (max 60 setState/sec instead of unbounded SSE events)
- Sidebar search debounced at 300ms to avoid IPC spam; search results bounded to 50 via SQL LIMIT

## Important Constraints and Gotchas

1. **Audio Chunk Size**: Pipeline expects consistent 48kHz sample rate. Resampling happens at capture time.

2. **Platform Audio Quirks**:
   - macOS: ScreenCaptureKit requires macOS 13+, needs screen recording permission
   - Windows: WASAPI exclusive mode can conflict with other apps
   - System audio requires virtual device (BlackHole on macOS, WASAPI loopback on Windows)

3. **Whisper Model Loading**: Models are loaded once and cached. Changing models requires app restart or manual unload/reload.

4. **Backend Dependency**: Frontend can run standalone (local Whisper), but meeting persistence, AI assistant, and PII anonymization require the backend running.

5. **CORS Configuration**: Backend allows all origins (`"*"`) for development. Restrict for production deployment.

6. **File Paths**: Use Tauri's path APIs (`downloadDir`, etc.) for cross-platform compatibility. Never hardcode paths.

7. **Audio Permissions**: Request permissions early. macOS requires both microphone AND screen recording for system audio.

8. **AI Panel Branding**: Per Claude Agent SDK docs, third-party apps must NOT use "Claude Code" branding. All user-facing text says "AI Assistant". Internal code names (ClaudeContext, claudeService) are fine.

9. **API Keys**: The Anthropic/Claude API key is held in the OS credential store (Windows Credential Manager / macOS Keychain, via the `keyring` crate), encrypted at rest and never in plaintext SQLite. Access goes through `database::secure_store`; the `settings` repository delegates the `claude` provider there, and a startup migration moves any legacy plaintext `anthropicApiKey` out of SQLite and blanks the column. Other API keys (Groq, OpenAI, etc.) are still stored in the Rust SQLite `settings` table.

10. **Two SQLite Databases**: The Rust frontend and Python backend each have their own SQLite. Don't mix up `sqlx` queries (Rust) with `aiosqlite` queries (Python). See architecture diagram.

## Repository-Specific Conventions

- **Logging Format**: Backend uses detailed formatting with filename:line:function
- **Error Handling**: Rust uses `anyhow::Result`, frontend uses try-catch with user-friendly messages
- **Naming**: Audio devices use "microphone" and "system" consistently (not "input"/"output")
- **Dark Mode**: All new components MUST include `dark:` Tailwind variants. Use semantic colors (`bg-background`, `text-foreground`, `border-border`) from shadcn/ui where possible.
- **Git Branches**:
  - `main`: Stable releases
  - `feature/*`: New features (developed in worktrees, see "Git Worktrees" above)
  - `fix/*`: Bug fixes
  - `enhance/*`: Feature enhancements

## Key Files Reference

**Core Coordination**:
- [frontend/src-tauri/src/lib.rs](frontend/src-tauri/src/lib.rs) - Main Tauri entry point, command registration
- [frontend/src-tauri/src/audio/mod.rs](frontend/src-tauri/src/audio/mod.rs) - Audio module exports
- [backend/app/main.py](backend/app/main.py) - FastAPI application, all API endpoints (meetings, summaries, AI, anonymization)

**Audio System**:
- [frontend/src-tauri/src/audio/recording_manager.rs](frontend/src-tauri/src/audio/recording_manager.rs) - Recording orchestration
- [frontend/src-tauri/src/audio/pipeline.rs](frontend/src-tauri/src/audio/pipeline.rs) - Audio mixing and VAD
- [frontend/src-tauri/src/audio/recording_saver.rs](frontend/src-tauri/src/audio/recording_saver.rs) - Audio file writing

**Rust Database** (frontend-side SQLite via sqlx):
- [frontend/src-tauri/src/database/repositories/transcript.rs](frontend/src-tauri/src/database/repositories/transcript.rs) - Transcript save + search
- [frontend/src-tauri/src/api/api.rs](frontend/src-tauri/src/api/api.rs) - Tauri commands wrapping DB operations

**AI Assistant (F007)**:
- [frontend/src/contexts/ClaudeContext.tsx](frontend/src/contexts/ClaudeContext.tsx) - AI panel state, streaming, context basket assembly
- [frontend/src/services/claudeService.ts](frontend/src/services/claudeService.ts) - SSE fetch to backend AI endpoints
- [frontend/src/components/ClaudePanel/ClaudePanel.tsx](frontend/src/components/ClaudePanel/ClaudePanel.tsx) - AI panel UI shell
- [backend/app/claude_agent.py](backend/app/claude_agent.py) - Claude Agent SDK wrapper, session management

**PII Anonymization (F005)**:
- [backend/app/anonymizer.py](backend/app/anonymizer.py) - Presidio + spaCy NER, entity registry, surrogate generation

**Slash Commands (F018)**:
- [frontend/src/lib/slashCommands.ts](frontend/src/lib/slashCommands.ts) - Command registry, built-in + custom commands
- [frontend/src/hooks/useSlashCommand.ts](frontend/src/hooks/useSlashCommand.ts) - Live transcript capture hook
- [frontend/src/components/CommandSettings.tsx](frontend/src/components/CommandSettings.tsx) - Custom command CRUD in Settings

**UI Components**:
- [frontend/src/app/page.tsx](frontend/src/app/page.tsx) - Main recording interface
- [frontend/src/components/Sidebar/SidebarProvider.tsx](frontend/src/components/Sidebar/SidebarProvider.tsx) - Meetings list, server address
- [frontend/src/app/settings/page.tsx](frontend/src/app/settings/page.tsx) - Settings page (5 tabs: General, Recordings, Transcription, Summary, Commands)

**Whisper Integration**:
- [frontend/src-tauri/src/whisper_engine/whisper_engine.rs](frontend/src-tauri/src/whisper_engine/whisper_engine.rs) - Whisper model management and transcription

**Project Tracking**:
- [feature_list.json](feature_list.json) - Feature status, steps, branches, worktrees
- [bug_list.json](bug_list.json) - Known bugs and refactoring items with severity/fix details

## Design Context

### Users
Consultants and freelancers on client-facing calls — discovery calls, sales conversations, advisory sessions. They need the interface to feel invisible during a live call: no distractions, no cognitive overhead. When not on a call, they review transcripts, generate summaries, and hand off tasks. Privacy is paramount — these are confidential client conversations.

### Brand Personality
**Calm, Capable, Private.** Tandem is the senior colleague who takes perfect notes without being asked. It doesn't demand attention. It earns trust through competence and discretion. The interface should communicate: "your conversation is safe here, and everything is handled."

### Aesthetic Direction
**Vercel / Stripe inspired** — ultra-polished, high contrast, dramatic. Bold typography hierarchy with generous whitespace. Dark-first (dark mode is default). Subtle gradients and depth rather than flat design. Premium feel without being flashy.

- **Reference apps**: Vercel dashboard (dramatic dark mode, confident typography), Stripe docs (precision, whitespace, clarity), Linear (fast, keyboard-driven, monochrome + accent)
- **Anti-references**: Slack (too busy, too colorful), Notion (too playful for professional context), generic SaaS dashboards with rounded cards everywhere

### Color System
- **Font**: Source Sans 3 (400/500/600/700) — professional, readable, good at small sizes
- **Base palette**: Achromatic neutrals with tinted warmth (avoid pure gray — tint toward brand hue)
- **Brand palette**: Define primary, secondary, and accent colors that give Tandem a recognizable identity. The current pure-gray palette needs a distinctive brand color (consider a confident teal, deep blue, or muted violet — something that says "trustworthy and modern" without being generic)
- **Semantic colors**: Success (green), Error (red/destructive), Warning (amber), Info (blue) — these should be tinted to harmonize with the brand palette, not raw Tailwind defaults
- **Dark mode**: Not inverted light mode. Use lighter surfaces for elevation/depth, desaturate accents slightly, never use pure black (#000), reduce font weight by one step
- **Contrast**: WCAG AA minimum (4.5:1 body text, 3:1 large text/UI elements)

### Typography
- **Scale**: Already defined (display/h1/h2/body/small/caption) — enforce consistently
- **Hierarchy**: Use weight and size together, not just size. Bold for emphasis, not color
- **Measure**: Cap paragraph widths at ~65ch for readability
- **Numbers**: Use tabular figures (`font-variant-numeric: tabular-nums`) for timestamps, durations, and data

### Spacing & Layout
- **Base unit**: 4px grid (4, 8, 12, 16, 24, 32, 48, 64, 96)
- **Use semantic spacing tokens** rather than arbitrary Tailwind values
- **Prefer `gap`** over margins for component spacing
- **Three-panel layout**: Sidebar (collapsible) | Main content | AI panel (resizable). Each panel should have clear visual boundaries without heavy borders — use subtle background differences or elevation

### Motion
- **100/300/500 rule**: 100-150ms for hover/feedback, 200-300ms for state changes, 300-500ms for layout shifts
- **framer-motion** is available — use for meaningful transitions (panel open/close, tab switches, recording state changes)
- **Respect `prefers-reduced-motion`** — always provide a reduced/no-motion fallback
- **No bounce/elastic effects** — they undermine the calm, professional tone

### Interaction Patterns
- **Focus rings**: Use `:focus-visible` (not `:focus`), 2px offset, ring color from design tokens
- **Disabled states**: `opacity-50` + `pointer-events-none` (already in button.tsx — maintain this)
- **Loading states**: Prefer skeleton/shimmer over spinners. Never block the UI during streaming
- **Error states**: Three-part structure: what happened, why, what to do next. Never blame the user
- **Empty states**: Show value proposition and clear next action, not just "nothing here"

### Design Principles

1. **Invisible when active** — During a live call, Tandem should disappear. No demanding animations, no attention-grabbing colors. The transcript flows, the AI panel waits. The user's focus stays on their conversation.

2. **Confident, not loud** — Every element should feel intentional. Bold typography over bright colors. Generous whitespace over decorative elements. One accent color used sparingly beats a rainbow palette.

3. **Privacy is visible** — The interface should communicate trust. PII anonymization indicators, local processing badges, encrypted storage signals. Privacy isn't just a feature — it's a design language.

4. **Progressive disclosure** — Show only what's needed for the current task. Recording view is sparse. Review view is rich. Settings are layered. The AI panel slides in on demand, not permanently competing for space.

5. **Semantic over arbitrary** — Use design tokens (`bg-background`, `text-muted-foreground`) over raw values (`bg-gray-100`, `text-gray-500`). Use the type scale (`text-body`, `text-small`) over arbitrary sizes. This ensures consistency and makes theming maintainable.
