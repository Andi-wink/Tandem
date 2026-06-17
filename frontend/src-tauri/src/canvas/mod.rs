//! Voice-driven canvas host glue.
//!
//! Tandem does NOT implement any canvas/agent logic — that lives in the agent-whiteboard `apps/agent`
//! kit (the single source of truth). Tandem only HOSTS it: it opens that app in a dedicated
//! `WebviewWindow` and drives it by injecting a `canvas:prompt` postMessage that the app's prompt
//! bridge forwards to `agent.prompt()`. See agent-whiteboard `docs/TANDEM-INTEGRATION.md`.
//!
//! Why inject a postMessage (via `webview.eval`) instead of a Tauri event: the canvas window loads a
//! REMOTE origin (the dev server / the prod sidecar), which Tauri does not grant IPC to by default.
//! `eval` works regardless of the page's capabilities, and the bridge already accepts postMessage —
//! so there are no remote-capability gymnastics. (The bridge also accepts a Tauri event when one is
//! available, but we don't rely on it here.)

pub mod commands;

/// The fixed window label for the canvas/agent webview.
pub const CANVAS_WINDOW_LABEL: &str = "canvas-agent";

/// Default agent app URL in development (`pnpm dev` in agent-whiteboard serves it here).
pub const DEFAULT_CANVAS_URL: &str = "http://localhost:5174";
