//! Supervises the agent-whiteboard server so the canvas is "always on".
//!
//! The whiteboard UI is a SEPARATE app (agent-whiteboard `apps/agent`); Tandem hosts it in an iframe
//! at http://localhost:5174 but does not bundle its source. To remove the manual `pnpm dev` step, we
//! spawn its single-process production server (`node dist-server/serve.js`) on app startup, wait for
//! it to answer on :5174, restart it if it dies, and kill it on exit.
//!
//! Single process by design: `node serve.js` (NOT `pnpm dev`, which forks a vite/esbuild tree that is
//! painful to kill cleanly). That makes shutdown a plain `child.kill()`.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::process::{Child, Command};
use tokio::sync::Mutex;
// Note: tokio::process::Command exposes `creation_flags` as an inherent method on Windows, so no
// `std::os::windows::process::CommandExt` import is needed (it would be flagged unused).

/// Default port the whiteboard server listens on (matches DEFAULT_CANVAS_URL + the tauri.conf CSP).
pub const CANVAS_PORT: u16 = 5174;

/// Provider keys the whiteboard agent can use. We pass through whatever Tandem's process has; the
/// server's own `.env` still wins (see serve.ts), so this only helps when the .env lacks a key.
const PROVIDER_KEYS: [&str; 4] = [
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
];

/// Manages the whiteboard server child process: spawn-on-startup, health log, auto-restart, kill.
pub struct CanvasServerManager {
    child: Arc<Mutex<Option<Child>>>,
    should_shutdown: Arc<AtomicBool>,
    /// Absolute path to `dist-server/serve.js`.
    serve_js: PathBuf,
    /// The `apps/agent` dir — used as cwd so the server resolves its `dist/` and `.env` correctly.
    app_root: PathBuf,
    port: u16,
}

impl CanvasServerManager {
    /// Build a manager if the whiteboard server bundle can be located. Returns `None` (with a logged
    /// reason) otherwise, so the app still launches and the canvas simply shows its unreachable state
    /// until the bundle is built.
    pub fn locate() -> Option<Arc<Self>> {
        let port = std::env::var("TANDEM_CANVAS_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(CANVAS_PORT);
        let serve_js = Self::resolve_serve_js()?;
        // dist-server/serve.js -> apps/agent
        let app_root = serve_js
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| serve_js.clone());
        Some(Arc::new(Self {
            child: Arc::new(Mutex::new(None)),
            should_shutdown: Arc::new(AtomicBool::new(false)),
            serve_js,
            app_root,
            port,
        }))
    }

    /// Find `apps/agent/dist-server/serve.js` from (1) `TANDEM_CANVAS_DIR` (the agent-whiteboard
    /// root), then (2) the dev sibling layout `<Dev-projects>/visual-work/agent-whiteboard` derived
    /// from the compile-time manifest dir. (3) A bundled-resource path for packaged builds is a
    /// follow-up — see To-do.md "prod sidecar".
    fn resolve_serve_js() -> Option<PathBuf> {
        let rel = |root: PathBuf| {
            root.join("apps")
                .join("agent")
                .join("dist-server")
                .join("serve.js")
        };
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(dir) = std::env::var("TANDEM_CANVAS_DIR") {
            if !dir.trim().is_empty() {
                candidates.push(rel(PathBuf::from(dir)));
            }
        }
        // CARGO_MANIFEST_DIR = <Dev-projects>/Tandem/frontend/src-tauri ; ancestors().nth(3) is
        // <Dev-projects>, alongside which the whiteboard repo lives in dev.
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(dev_projects) = manifest.ancestors().nth(3) {
            candidates.push(rel(dev_projects
                .join("visual-work")
                .join("agent-whiteboard")));
        }

        for p in candidates {
            if p.exists() {
                log::info!("[canvas] whiteboard server bundle: {}", p.display());
                return Some(p);
            }
            log::debug!("[canvas] no serve.js at {}", p.display());
        }
        log::warn!(
            "[canvas] whiteboard server bundle not found. Run `pnpm build:all` in agent-whiteboard \
             (apps/agent) or set TANDEM_CANVAS_DIR. The canvas will be unavailable until then."
        );
        None
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Start the supervisor: spawn the server, then keep it alive (restart on unexpected exit) until
    /// `shutdown()` is called. Non-blocking — runs on the Tauri/tokio runtime.
    pub fn start(self: &Arc<Self>) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            // Backoff grows only when the server dies almost immediately (crash loop); a server that
            // ran for a while and then exited restarts promptly.
            let mut backoff = Duration::from_secs(1);
            const MAX_BACKOFF: Duration = Duration::from_secs(30);

            while !this.should_shutdown.load(Ordering::SeqCst) {
                // If something already serves the port — a server orphaned by a force-killed run, a
                // manual `pnpm dev`, or a second Tandem instance — adopt it instead of spawning.
                // Spawning would just EADDRINUSE-crash-loop forever. We didn't start it, so we never
                // kill it; we wait until it goes away and then take over.
                if this.port_healthy().await {
                    log::info!("[canvas] :{} already serving; reusing it (not spawning)", this.port);
                    while !this.should_shutdown.load(Ordering::SeqCst) && this.port_healthy().await {
                        tokio::time::sleep(Duration::from_secs(3)).await;
                    }
                    continue;
                }

                let started = Instant::now();
                match this.spawn_once().await {
                    Ok(true) => {
                        this.clone().log_when_ready();
                        this.supervise_until_exit().await;
                    }
                    Ok(false) => break, // shutdown requested mid-spawn
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        log::error!(
                            "[canvas] `node` not found on PATH — cannot start the whiteboard server. \
                             Install Node.js (or bundle a runtime). Retrying in {:?}.",
                            MAX_BACKOFF
                        );
                        tokio::time::sleep(MAX_BACKOFF).await;
                        continue;
                    }
                    Err(e) => {
                        log::error!("[canvas] failed to spawn whiteboard server: {e}");
                    }
                }
                if this.should_shutdown.load(Ordering::SeqCst) {
                    break;
                }
                // Crash-loop guard: only back off if the process barely lived.
                if started.elapsed() < Duration::from_secs(5) {
                    log::warn!("[canvas] server exited quickly; backing off {:?}", backoff);
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                } else {
                    backoff = Duration::from_secs(1);
                    log::info!("[canvas] restarting whiteboard server");
                }
            }
            log::info!("[canvas] server supervisor stopped");
        });
    }

    /// Spawn `node serve.js` and store the handle. Returns `Ok(false)` if shutdown was requested
    /// before the child was stored (so the caller stops). The shutdown flag is checked while holding
    /// the `child` lock, so a concurrent `shutdown()` can never slip past and leave an orphan: either
    /// it sees the flag and skips spawning, or it stores the child where `kill_current()` will find it.
    async fn spawn_once(&self) -> std::io::Result<bool> {
        let mut cmd = Command::new("node");
        cmd.arg(&self.serve_js)
            .current_dir(&self.app_root)
            .env("PORT", self.port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);

        for key in PROVIDER_KEYS {
            if let Ok(v) = std::env::var(key) {
                if !v.is_empty() {
                    cmd.env(key, v);
                }
            }
        }

        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut guard = self.child.lock().await;
        if self.should_shutdown.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let child = cmd.spawn()?;
        *guard = Some(child);
        drop(guard);
        log::info!(
            "[canvas] spawned whiteboard server (node {}, PORT={})",
            self.serve_js.display(),
            self.port
        );
        Ok(true)
    }

    /// True if something is already answering HTTP on the canvas port (loopback).
    async fn port_healthy(&self) -> bool {
        let url = format!("http://127.0.0.1:{}/", self.port);
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_millis(1200))
            .build()
        {
            Ok(c) => c,
            Err(_) => return false,
        };
        match client.get(&url).send().await {
            Ok(resp) => resp.status().is_success() || resp.status().is_redirection(),
            Err(_) => false,
        }
    }

    /// Poll the running child until it exits (or shutdown is requested, in which case we kill it).
    async fn supervise_until_exit(&self) {
        loop {
            tokio::time::sleep(Duration::from_millis(750)).await;
            if self.should_shutdown.load(Ordering::SeqCst) {
                self.kill_current().await;
                return;
            }
            let mut guard = self.child.lock().await;
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        log::warn!("[canvas] whiteboard server exited: {status}");
                        *guard = None;
                        return;
                    }
                    Ok(None) => { /* still running */ }
                    Err(e) => {
                        log::error!("[canvas] error waiting on server: {e}");
                        *guard = None;
                        return;
                    }
                },
                None => return, // killed elsewhere
            }
        }
    }

    /// Best-effort: log once the server answers on its port (purely informational).
    fn log_when_ready(self: Arc<Self>) {
        let url = format!("http://127.0.0.1:{}/", self.port);
        tauri::async_runtime::spawn(async move {
            let client = match reqwest::Client::builder()
                .timeout(Duration::from_millis(1500))
                .build()
            {
                Ok(c) => c,
                Err(_) => return,
            };
            for _ in 0..40 {
                if self.should_shutdown.load(Ordering::SeqCst) {
                    return;
                }
                if let Ok(resp) = client.get(&url).send().await {
                    if resp.status().is_success() || resp.status().is_redirection() {
                        log::info!("[canvas] whiteboard server ready at {url}");
                        return;
                    }
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            log::warn!("[canvas] whiteboard server did not become ready at {url} within ~20s");
        });
    }

    async fn kill_current(&self) {
        let mut guard = self.child.lock().await;
        if let Some(mut child) = guard.take() {
            let _ = child.kill().await;
            log::info!("[canvas] whiteboard server killed");
        }
    }

    /// Stop supervising and kill the server. Safe to call from the app-exit handler.
    pub async fn shutdown(&self) {
        self.should_shutdown.store(true, Ordering::SeqCst);
        self.kill_current().await;
    }
}
