<div align="center" style="border-bottom: none">
    <h1>
        <img src="docs/Tandem_Logo (1)-Photoroom.png" width="120" style="border-radius: 10px;" />
        <br>
        Tandem
    </h1>
    <p><strong>Privacy-first AI co-pilot for every call</strong></p>
    <p>
    <a href="https://github.com/Andi-wink/Tandem/releases"><img src="https://img.shields.io/badge/Status-In_Development-orange" alt="Status"></a>
    <a href="https://github.com/Andi-wink/Tandem"><img alt="GitHub Repo stars" src="https://img.shields.io/github/stars/Andi-wink/Tandem?style=flat"></a>
    <a href="https://github.com/Andi-wink/Tandem/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue" alt="License"></a>
    <a href="#"><img src="https://img.shields.io/badge/Platforms-Windows_|_macOS-white" alt="Platforms"></a>
    </p>
</div>

---

A privacy-first AI co-pilot that captures, transcribes, and collaborates in real time on every call — entirely on your machine. Built for consultants and freelancers on client-facing calls who need an intelligent partner without compromising on privacy.

**Fork of [Zackriya-Solutions/meeting-minutes](https://github.com/Zackriya-Solutions/meeting-minutes) (Meetily)** — extended with an AI assistant panel, PII anonymization, Claude Code handoff, screenshot/clipboard capture, and a redesigned UI.

<p align="center">
    <img src="docs/demo_small.gif" width="650" alt="Tandem Demo" />
</p>

## What's Different from Upstream

This fork adds significant new capabilities on top of the Meetily base:

| Feature | Description |
|---------|-------------|
| **AI Assistant Panel** | Claude-powered side panel with SSE streaming, context basket, and conversation history |
| **PII Anonymization** | On-device entity detection (Microsoft Presidio + spaCy) with surrogate generation |
| **Claude Code Handoff** | Say `@code <task>` during a meeting to hand off work to Claude Code in a terminal |
| **Screenshot & Clipboard Capture** | `Alt+Shift+S` for screenshots, `Alt+Shift+V` for clipboard — attached to meeting context |
| **Voice Commands** | Slash commands triggered by voice during recording |
| **Live Transcript Files** | Rolling `.tandem/live-transcript.md` for external tool consumption |
| **Redesigned UI** | Dark-first Vercel/Stripe-inspired interface with resizable panels |

## Features

- **100% Local Processing** — Transcription, audio capture, and storage never leave your machine
- **Real-time Transcription** — Whisper.cpp with GPU acceleration (Metal, CUDA, Vulkan)
- **AI Summaries** — Ollama (local), Claude, Groq, or OpenRouter
- **Professional Audio Mixing** — RMS-based ducking, simultaneous mic + system capture
- **PII Anonymization** — Presidio + spaCy NER detects and replaces sensitive entities before any cloud call
- **AI Assistant** — Claude Agent SDK with streaming responses, diagram generation, and context-aware Q&A
- **Cross-Platform** — Windows (WASAPI) and macOS (ScreenCaptureKit)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop App | Tauri 2.x (Rust) + Next.js 14 + React 18 |
| Audio | cpal, whisper-rs, Silero VAD, professional mixing pipeline |
| Transcription | Whisper.cpp — local, GPU-accelerated |
| Backend | FastAPI + SQLite (aiosqlite) |
| AI Assistant | Claude Agent SDK (Python) with SSE streaming |
| PII | Microsoft Presidio + spaCy NER |
| LLM | Ollama (local), Claude, Groq, OpenRouter |
| UI | Tailwind CSS, shadcn/ui, dark mode default |

## Getting Started

### Prerequisites

- **Rust** 1.75+ with stable toolchain
- **Node.js** 22+ with pnpm
- **Python** 3.12+ with venv
- **LLVM** 18+ (for whisper-rs bindgen)
- **GPU drivers** (optional): CUDA 11.8+ for NVIDIA, Vulkan for AMD/Intel

### Quick Start

```bash
# Clone the repo
git clone https://github.com/Andi-wink/Tandem.git
cd Tandem

# Backend
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate  |  macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn app.main:app --host 0.0.0.0 --port 5167

# Frontend (new terminal)
cd frontend
pnpm install
pnpm run tauri:dev          # CPU
pnpm run tauri:dev:cuda     # NVIDIA GPU
pnpm run tauri:dev:metal    # macOS Metal
pnpm run tauri:dev:vulkan   # AMD/Intel GPU
```

### Service Endpoints

| Service | URL |
|---------|-----|
| Frontend Dev | http://localhost:3118 |
| Backend API | http://localhost:5167 |
| API Docs | http://localhost:5167/docs |

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Frontend (Tauri Desktop App)                     │
│   Next.js UI  ←→  Rust Backend (Audio + SQLite)  ←→  Whisper Engine  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTP / SSE
┌───────────────────────────────┴──────────────────────────────────────┐
│                        Backend (FastAPI)                              │
│   SQLite  ←→  Meeting Manager  ←→  LLM Providers                    │
│               Claude Agent SDK     Presidio Anonymizer               │
└──────────────────────────────────────────────────────────────────────┘
```

Two separate SQLite databases: Rust frontend (meetings, transcripts, settings via sqlx) and Python backend (summaries, processes via aiosqlite).

For detailed architecture, see [CLAUDE.md](CLAUDE.md) and [docs/architecture.md](docs/architecture.md).

## Development

See [CLAUDE.md](CLAUDE.md) for comprehensive development guide including:
- Build commands for all platforms
- Audio pipeline deep-dive
- Tauri command/event patterns
- Project tracking files (`feature_list.json`, `bug_list.json`)
- Git worktree workflow

### Verification (run after every change)

```bash
cd frontend && pnpm tsc --noEmit      # TypeScript
cd frontend/src-tauri && cargo check   # Rust
cd backend && python -m pytest -v      # Python
```

## Contributing

Contributions welcome. Please open an issue or submit a pull request. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT License — see [LICENSE](LICENSE).

## Acknowledgments

- Forked from [Zackriya-Solutions/meeting-minutes](https://github.com/Zackriya-Solutions/meeting-minutes) (Meetily)
- [Whisper.cpp](https://github.com/ggerganov/whisper.cpp) for local transcription
- [Screenpipe](https://github.com/mediar-ai/screenpipe) for audio capture patterns
- NVIDIA for the Parakeet model
- [istupakov](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx) for the ONNX Parakeet conversion
