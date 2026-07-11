//! Supervises the agent-whiteboard local servers so the canvas is "always on".
//!
//! Two single-process Node servers, each spawned on startup, health-logged, auto-restarted on crash,
//! and killed on app exit:
//!   - the whiteboard APP server  (`apps/agent/dist-server/serve.js`, :5174) — serves the canvas UI
//!     and the `/stream` SSE that drives AI drawing.
//!   - the MCP CANVAS server      (`vendor/tldraw-mcp-server/dist/canvas-server.js`, :3939) — REST +
//!     `/ws` so an MCP client (Claude Code) can drive/read the same board ("Connect MCP" in the canvas).
//!
//! Single process each (`node <script>`, NOT `pnpm dev`) so shutdown is a plain `child.kill()`.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::process::{Child, Command};
use tokio::sync::Mutex;
// tokio::process::Command exposes `creation_flags` inherently on Windows, so no
// `std::os::windows::process::CommandExt` import is needed (it would be flagged unused).

/// Default port for the whiteboard app server (matches DEFAULT_CANVAS_URL + the tauri.conf CSP).
pub const CANVAS_PORT: u16 = 5174;
/// Default port for the MCP canvas server (the vendored server defaults here too — off :3000, which
/// collides with common local dev apps).
pub const MCP_PORT: u16 = 3939;

/// Provider keys the whiteboard agent can use. Passed through if Tandem's process has them; the app
/// server's own `.env` still wins (see serve.ts). Harmless for the MCP server (it ignores them).
const PROVIDER_KEYS: [&str; 4] = [
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
];

/// Manages one supervised Node server child: spawn-on-startup, health log, auto-restart, kill.
pub struct CanvasServerManager {
    label: &'static str,
    child: Arc<Mutex<Option<Child>>>,
    should_shutdown: Arc<AtomicBool>,
    /// Absolute path to the `.js` entrypoint run with `node`.
    script: PathBuf,
    /// Working directory for the child (so it resolves its own `dist/` / `.env`).
    cwd: PathBuf,
    port: u16,
}

impl CanvasServerManager {
    /// The whiteboard APP server (serve.js on :5174). Returns `None` (logged) if the bundle is absent.
    pub fn locate_app() -> Option<Arc<Self>> {
        let root = Self::whiteboard_root()?;
        let script = root
            .join("apps")
            .join("agent")
            .join("dist-server")
            .join("serve.js");
        let cwd = root.join("apps").join("agent");
        Self::make("whiteboard app", script, cwd, env_port("TANDEM_CANVAS_PORT", CANVAS_PORT))
    }

    /// The MCP CANVAS server (canvas-server.js on :3939) — powers "Connect MCP". `None` if absent.
    pub fn locate_mcp() -> Option<Arc<Self>> {
        let root = Self::whiteboard_root()?;
        let base = root.join("vendor").join("tldraw-mcp-server");
        let script = base.join("dist").join("canvas-server.js");
        Self::make("MCP canvas", script, base, env_port("TANDEM_MCP_PORT", MCP_PORT))
    }

    fn make(label: &'static str, script: PathBuf, cwd: PathBuf, port: u16) -> Option<Arc<Self>> {
        if !script.exists() {
            log::warn!(
                "[canvas] {label} server bundle not found at {} — that server won't start. Build it \
                 (agent-whiteboard: `pnpm build:all`; vendor/tldraw-mcp-server: `npm run build`) or set \
                 TANDEM_CANVAS_DIR.",
                script.display()
            );
            return None;
        }
        log::info!("[canvas] {label} server bundle: {}", script.display());
        Some(Arc::new(Self {
            label,
            child: Arc::new(Mutex::new(None)),
            should_shutdown: Arc::new(AtomicBool::new(false)),
            script,
            cwd,
            port,
        }))
    }

    /// agent-whiteboard repo root: `TANDEM_CANVAS_DIR` if set+exists, else the dev sibling layout
    /// `<Dev-projects>/visual-work/agent-whiteboard` derived from the compile-time manifest dir.
    /// (Packaged builds need a bundled-resource path here — see To-do.md "prod packaging".)
    fn whiteboard_root() -> Option<PathBuf> {
        if let Ok(dir) = std::env::var("TANDEM_CANVAS_DIR") {
            if !dir.trim().is_empty() {
                let p = PathBuf::from(dir);
                if p.exists() {
                    return Some(p);
                }
            }
        }
        // CARGO_MANIFEST_DIR = <Dev-projects>/Tandem/frontend/src-tauri ; ancestors().nth(3) = <Dev-projects>.
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let root = manifest
            .ancestors()
            .nth(3)?
            .join("visual-work")
            .join("agent-whiteboard");
        if root.exists() {
            Some(root)
        } else {
            None
        }
    }

    /// Start the supervisor: spawn the server, keep it alive (restart on unexpected exit) until
    /// `shutdown()`. Non-blocking — runs on the Tauri/tokio runtime.
    pub fn start(self: &Arc<Self>) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut backoff = Duration::from_secs(1);
            const MAX_BACKOFF: Duration = Duration::from_secs(30);

            while !this.should_shutdown.load(Ordering::SeqCst) {
                // If something already serves the port — a server orphaned by a force-killed run, a
                // manual dev server, or a second Tandem instance — adopt it instead of spawning.
                // Spawning would just EADDRINUSE-crash-loop. We didn't start it, so we never kill it;
                // we wait until it goes away and then take over.
                if this.port_healthy().await {
                    log::info!("[canvas] {}: :{} already serving; reusing it (not spawning)", this.label, this.port);
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
                            "[canvas] `node` not found on PATH — cannot start the {} server. Install \
                             Node.js (or bundle a runtime). Retrying in {:?}.",
                            this.label,
                            MAX_BACKOFF
                        );
                        tokio::time::sleep(MAX_BACKOFF).await;
                        continue;
                    }
                    Err(e) => {
                        log::error!("[canvas] failed to spawn {} server: {e}", this.label);
                    }
                }
                if this.should_shutdown.load(Ordering::SeqCst) {
                    break;
                }
                // Crash-loop guard: only back off if the process barely lived.
                if started.elapsed() < Duration::from_secs(5) {
                    log::warn!("[canvas] {} server exited quickly; backing off {:?}", this.label, backoff);
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                } else {
                    backoff = Duration::from_secs(1);
                    log::info!("[canvas] restarting {} server", this.label);
                }
            }
            log::info!("[canvas] {} server supervisor stopped", this.label);
        });
    }

    /// Spawn `node <script>` and store the handle. Returns `Ok(false)` if shutdown was requested
    /// before the child was stored. The shutdown flag is checked while holding the `child` lock, so a
    /// concurrent `shutdown()` can never slip past and leave an orphan.
    async fn spawn_once(&self) -> std::io::Result<bool> {
        let mut cmd = Command::new("node");
        cmd.arg(&self.script)
            .current_dir(&self.cwd)
            .env("PORT", self.port.to_string())
            .env("HOST", "127.0.0.1")
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
            "[canvas] spawned {} server (node {}, PORT={})",
            self.label,
            self.script.display(),
            self.port
        );
        Ok(true)
    }

    /// True if something is already answering HTTP on this server's port (loopback).
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
                        log::warn!("[canvas] {} server exited: {status}", self.label);
                        *guard = None;
                        return;
                    }
                    Ok(None) => { /* still running */ }
                    Err(e) => {
                        log::error!("[canvas] error waiting on {} server: {e}", self.label);
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
                        log::info!("[canvas] {} server ready at {url}", self.label);
                        return;
                    }
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            log::warn!("[canvas] {} server did not become ready at {url} within ~20s", self.label);
        });
    }

    async fn kill_current(&self) {
        let mut guard = self.child.lock().await;
        if let Some(mut child) = guard.take() {
            let _ = child.kill().await;
            log::info!("[canvas] {} server killed", self.label);
        }
    }

    /// Stop supervising and kill the server. Safe to call from the app-exit handler.
    pub async fn shutdown(&self) {
        self.should_shutdown.store(true, Ordering::SeqCst);
        self.kill_current().await;
    }
}

fn env_port(var: &str, default: u16) -> u16 {
    std::env::var(var)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}
