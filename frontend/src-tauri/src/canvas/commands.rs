//! Tauri commands for hosting + driving the canvas/agent window. See `mod.rs` for the rationale.

use log::{info, warn};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use super::{CANVAS_WINDOW_LABEL, DEFAULT_CANVAS_URL};

fn resolve_url(url: Option<String>) -> String {
    url.filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CANVAS_URL.to_string())
}

/// Get the canvas window, creating it (hidden, pointed at `url`) if it doesn't exist yet.
fn ensure_window<R: Runtime>(app: &AppHandle<R>, url: &str) -> Result<WebviewWindow<R>, String> {
    if let Some(win) = app.get_webview_window(CANVAS_WINDOW_LABEL) {
        return Ok(win);
    }
    let parsed = url
        .parse::<tauri::Url>()
        .map_err(|e| format!("invalid canvas url '{url}': {e}"))?;
    info!("Creating canvas window at {url}");
    WebviewWindowBuilder::new(app, CANVAS_WINDOW_LABEL, WebviewUrl::External(parsed))
        .title("Tandem Canvas")
        .inner_size(1100.0, 820.0)
        .visible(false)
        .build()
        .map_err(|e| format!("failed to create canvas window: {e}"))
}

/// Bring the canvas window forward (unminimize + show + focus). Screen-share-friendly: you can share
/// just this window while Tandem itself stays private.
fn pop_forward<R: Runtime>(win: &WebviewWindow<R>) {
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

/// Ensure the canvas window exists and show it. Idempotent.
#[tauri::command]
pub async fn canvas_open<R: Runtime>(app: AppHandle<R>, url: Option<String>) -> Result<(), String> {
    let win = ensure_window(&app, &resolve_url(url))?;
    pop_forward(&win);
    Ok(())
}

/// Hide the canvas window (keeps it alive so the board + agent state persist).
#[tauri::command]
pub async fn canvas_hide<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(CANVAS_WINDOW_LABEL) {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Toggle the canvas window's visibility. Returns the new visible state.
#[tauri::command]
pub async fn canvas_toggle<R: Runtime>(app: AppHandle<R>, url: Option<String>) -> Result<bool, String> {
    if let Some(win) = app.get_webview_window(CANVAS_WINDOW_LABEL) {
        if win.is_visible().unwrap_or(false) {
            win.hide().map_err(|e| e.to_string())?;
            return Ok(false);
        }
        pop_forward(&win);
        return Ok(true);
    }
    let win = ensure_window(&app, &resolve_url(url))?;
    pop_forward(&win);
    Ok(true)
}

/// Whether the canvas window exists and is currently visible.
#[tauri::command]
pub async fn canvas_is_open<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    Ok(app
        .get_webview_window(CANVAS_WINDOW_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false))
}

/// Drive the canvas: send a natural-language instruction to the agent. We inject a `canvas:prompt`
/// postMessage that polls for the bridge's readiness flag (so it works even if the window just
/// opened and the agent is still mounting). The agent does the drawing, scene-aware edits and
/// streaming — Tandem only forwards the text. Optionally pops the window forward.
#[tauri::command]
pub async fn canvas_send_prompt<R: Runtime>(
    app: AppHandle<R>,
    message: String,
    url: Option<String>,
    show: Option<bool>,
) -> Result<(), String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("empty canvas prompt".into());
    }
    let win = ensure_window(&app, &resolve_url(url))?;
    if show.unwrap_or(true) {
        pop_forward(&win);
    }

    // Build a safe JS object literal from the message (serde_json escapes it correctly), then poll
    // for the bridge readiness flag before posting — up to ~20s — so a freshly opened window works.
    let payload = serde_json::json!({ "type": "canvas:prompt", "message": trimmed }).to_string();
    let js = format!(
        "(function(){{var m={payload};var n=0;function s(){{if(window.__canvasAgentReady){{window.postMessage(m,'*');}}else if(n++<80){{setTimeout(s,250);}}}}s();}})();"
    );
    win.eval(&js).map_err(|e| {
        warn!("canvas eval failed: {e}");
        format!("failed to send prompt to canvas: {e}")
    })?;
    info!("Sent canvas prompt ({} chars)", trimmed.len());
    Ok(())
}

/// Health-check the agent app URL (used before opening the window / spawning the sidecar). Returns
/// true if the URL responds. Short timeout so the UI doesn't hang when the server is down.
#[tauri::command]
pub async fn canvas_health_check(url: Option<String>) -> Result<bool, String> {
    let url = resolve_url(url);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(2500))
        .build()
        .map_err(|e| e.to_string())?;
    match client.get(&url).send().await {
        Ok(resp) => Ok(resp.status().is_success() || resp.status().is_redirection()),
        Err(e) => {
            info!("canvas health check failed for {url}: {e}");
            Ok(false)
        }
    }
}
