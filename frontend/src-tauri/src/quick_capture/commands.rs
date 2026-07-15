//! Tauri commands + window/watcher glue for the global quick-capture bar. See `mod.rs`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use log::{error, info, warn};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, Runtime, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use super::{Clip, QuickCaptureState, QUICK_CAPTURE_WINDOW_LABEL};
use crate::api::api::DEFAULT_CLIENTS_ROOT;
use crate::audio::recording_preferences::get_default_recordings_folder;
use crate::database::repositories::{project::ProjectRepository, setting::SettingsRepository};
use crate::state::AppState;

const WIN_W: f64 = 640.0;
const WIN_H: f64 = 220.0;

/// Create the quick-capture window (hidden) if it does not already exist. Frameless,
/// always-on-top, off the taskbar, non-resizable, and pointed at the local `/capture`
/// route so its UI is plain React (and Playwright-testable at :3118). Closes on blur.
fn ensure_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    if let Some(win) = app.get_webview_window(QUICK_CAPTURE_WINDOW_LABEL) {
        return Ok(win);
    }
    info!("Creating quick-capture window at /capture");
    let win = WebviewWindowBuilder::new(
        app,
        QUICK_CAPTURE_WINDOW_LABEL,
        WebviewUrl::App("capture".into()),
    )
    .title("Tandem Quick Capture")
    .inner_size(WIN_W, WIN_H)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build()
    .map_err(|e| format!("failed to create quick-capture window: {e}"))?;

    // Dismiss on blur so the always-on-top bar can never become a zombie: if the user
    // clicks away (or Alt-Tabs), it closes and saves nothing. We only act on a blur AFTER
    // the window has actually gained focus once, so a slow first paint (cold Next.js
    // compile, delayed OS focus grant) cannot let a pre-focus blur close the bar before the
    // user ever interacts with it. This is robust regardless of how long build->visible takes.
    let has_focused = Arc::new(AtomicBool::new(false));
    let has_focused_ev = has_focused.clone();
    let win_for_events = win.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::Focused(focused) = event {
            if *focused {
                has_focused_ev.store(true, Ordering::Relaxed);
            } else if has_focused_ev.load(Ordering::Relaxed) {
                let _ = win_for_events.close();
            }
        }
    });

    Ok(win)
}

/// Position the bar centered horizontally in the upper third of the current monitor.
fn position_upper_third<R: Runtime>(win: &WebviewWindow<R>) {
    let monitor = match win.current_monitor().ok().flatten().or_else(|| win.primary_monitor().ok().flatten()) {
        Some(m) => m,
        None => return, // no monitor info: leave the OS default placement
    };
    let size = monitor.size();
    let origin = monitor.position();
    let scale = monitor.scale_factor();
    let win_w = WIN_W * scale;
    let win_h = WIN_H * scale;
    let x = origin.x as f64 + ((size.width as f64) - win_w).max(0.0) / 2.0;
    // Upper third: one sixth of the remaining vertical space from the top.
    let y = origin.y as f64 + ((size.height as f64) - win_h).max(0.0) / 6.0;
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// Toggle the bar: open it (create + position + focus) if closed, dismiss it if open. Called
/// from both the global-shortcut handler and the `quick_capture_open` command. No-op while the
/// feature is disabled.
pub fn open_or_toggle<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<Arc<QuickCaptureState>>();
    if !state.enabled() {
        info!("Quick capture hotkey ignored (feature disabled)");
        return;
    }
    if let Some(win) = app.get_webview_window(QUICK_CAPTURE_WINDOW_LABEL) {
        // Already open: a second hotkey press dismisses it (no duplicate windows).
        let _ = win.close();
        return;
    }
    match ensure_window(app) {
        Ok(win) => {
            position_upper_third(&win);
            let _ = win.show();
            let _ = win.set_focus();
        }
        Err(e) => error!("Failed to open quick-capture bar: {e}"),
    }
}

/// Open (or toggle) the quick-capture bar. Idempotent.
#[tauri::command]
pub async fn quick_capture_open<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    open_or_toggle(&app);
    Ok(())
}

/// Close the quick-capture bar (used by Esc and after a save). Saves nothing.
#[tauri::command]
pub async fn quick_capture_close<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(QUICK_CAPTURE_WINDOW_LABEL) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Return the current rolling clipboard buffer (most recent first) for the bar to preview.
#[tauri::command]
pub async fn get_quick_capture_clips(
    state: State<'_, Arc<QuickCaptureState>>,
) -> Result<Vec<Clip>, String> {
    Ok(state.clips())
}

/// Enable/disable the feature. Disabling stops the watcher from recording and clears the buffer.
#[tauri::command]
pub async fn set_quick_capture_enabled(
    state: State<'_, Arc<QuickCaptureState>>,
    enabled: bool,
) -> Result<(), String> {
    state.set_enabled(enabled);
    info!("Quick capture {}", if enabled { "enabled" } else { "disabled" });
    Ok(())
}

/// Normalize a path for prefix comparison: forward slashes, no trailing slash, lowercased.
fn normalize(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// True if `fname` (a bare filename) is a reserved Windows device name, which the OS treats
/// specially regardless of extension (CON, PRN, AUX, NUL, COM1-9, LPT1-9). The check is on the
/// stem before the first dot and is case-insensitive.
fn is_reserved_windows_name(fname: &str) -> bool {
    let stem = fname.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

/// Validate that `project_path` is under a known root before we ever write to it. Allowed roots:
/// the configured clients folder, every registered project's path, and the default recordings
/// folder. Rejects traversal outright. Returns the vetted destination directory.
async fn validate_project_path(
    state: &State<'_, AppState>,
    project_path: &str,
) -> Result<PathBuf, String> {
    let target = normalize(project_path);
    if target.is_empty() {
        return Err("Empty destination path".to_string());
    }
    // Reject real traversal (a `..` path SEGMENT), but not a folder that merely contains
    // two consecutive dots in its name (e.g. "R&D..Phase2").
    if target.split('/').any(|seg| seg == "..") {
        return Err("Path traversal is not allowed".to_string());
    }

    let pool = state.db_manager.pool();
    // Each root carries whether an EXACT match is allowed. A registered project or the
    // recordings folder may be written to directly; the clients root is a container only,
    // so notes must land in one of its subfolders (a specific client), never generically
    // in the bare clients root itself.
    let mut roots: Vec<(String, bool)> = Vec::new();

    // Clients root (falls back to the compiled default): subfolders only.
    let clients_root = SettingsRepository::get_clients_root(pool)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| DEFAULT_CLIENTS_ROOT.to_string());
    roots.push((normalize(&clients_root), false));

    // Default recordings folder (the safe "Unfiled" fallback destination): exact ok.
    roots.push((normalize(&get_default_recordings_folder().to_string_lossy()), true));

    // Every registered project path: exact ok.
    if let Ok(projects) = ProjectRepository::list_projects(pool).await {
        for p in projects {
            roots.push((normalize(&p.path), true));
        }
    }

    let allowed = roots.iter().any(|(root, allow_exact)| {
        !root.is_empty()
            && ((*allow_exact && target == *root) || target.starts_with(&format!("{root}/")))
    });
    if !allowed {
        warn!("Rejected quick-capture save outside known roots: {project_path}");
        return Err("Destination is not under a known project or the recordings folder".to_string());
    }

    Ok(PathBuf::from(project_path.replace('\\', "/")))
}

/// True when `child`, after fully resolving symlinks/junctions, still lives inside `root`
/// (also resolved). Used as the last line of defense before writing: a `.tandem` (or `notes`)
/// directory that is secretly a junction/symlink pointing outside the vetted project would
/// otherwise let `fs::write` escape the root even though the string path passed prefix checks.
fn resolved_within(child: &Path, root: &Path) -> Result<bool, String> {
    let canon_child = std::fs::canonicalize(child)
        .map_err(|e| format!("Failed to resolve note directory: {e}"))?;
    let canon_root = std::fs::canonicalize(root)
        .map_err(|e| format!("Failed to resolve project directory: {e}"))?;
    Ok(canon_child.starts_with(&canon_root))
}

/// Save a quick-capture note into `<project_path>/.tandem/notes/<filename>`.
///
/// Narrowly scoped on purpose (NOT a general file-write primitive): the destination must be
/// under a known project/recordings root, the filename may not contain separators or `..`, and
/// an existing file is never overwritten (a numeric suffix is appended). `content` is the
/// already-rendered markdown (built + unit-tested in the frontend's quickCapture.ts). Returns
/// the absolute path written.
#[tauri::command]
pub async fn save_quick_capture<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    project_path: String,
    project_name: Option<String>,
    filename: String,
    content: String,
) -> Result<String, String> {
    // 1. Filename must be a bare, safe name. Beyond separators and `..`, reject Windows-only
    //    tricks: `:` (NTFS alternate-data-stream syntax, e.g. "note:hidden.md") and reserved
    //    device names (CON, PRN, NUL, AUX, COM1-9, LPT1-9). The filename is machine-generated by
    //    quickCaptureFilename(), so this is defense-in-depth against a direct invoke() bypass.
    let fname = filename.trim();
    if fname.is_empty()
        || fname.contains('/')
        || fname.contains('\\')
        || fname.contains("..")
        || fname.contains(':')
        || fname.chars().any(|c| c.is_control())
        || !fname.ends_with(".md")
        || is_reserved_windows_name(fname)
    {
        return Err("Invalid note filename".to_string());
    }

    // 2. Destination must be inside a known root.
    let target_dir = validate_project_path(&state, &project_path).await?;

    // 3. Ensure the notes directory exists.
    let notes_dir = target_dir.join(".tandem").join("notes");
    std::fs::create_dir_all(&notes_dir)
        .map_err(|e| format!("Failed to create notes folder: {e}"))?;

    // 3b. Symlink/junction escape check: the string path passed the prefix vetting, but a
    //     `.tandem`/`notes` directory that is really a junction could resolve outside the root.
    //     Refuse to write if the RESOLVED notes directory is not inside the resolved project root.
    if !resolved_within(&notes_dir, &target_dir)? {
        warn!("Rejected quick-capture save: notes dir resolves outside the project root ({project_path})");
        return Err("Destination resolves outside the project folder".to_string());
    }

    // 4. Never overwrite: create the file atomically (create_new), bumping -2, -3, ... on
    //    collision. Using an exclusive create closes the TOCTOU window that a separate
    //    exists()-then-write check left open between two concurrent saves.
    let stem = Path::new(fname)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "quick-capture".to_string());
    let mut candidate = notes_dir.join(fname);
    let mut n = 2u32;
    let mut file = loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(f) => break f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                candidate = notes_dir.join(format!("{stem}-{n}.md"));
                n += 1;
            }
            Err(e) => return Err(format!("Failed to write note: {e}")),
        }
    };
    use std::io::Write as _;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("Failed to write note: {e}"))?;

    let path_str = candidate.to_string_lossy().to_string();
    info!("Quick-capture note saved: {path_str}");

    // Confirmation for the main window (a toast), naming the destination so a misroute is visible.
    let _ = app.emit(
        "quick-capture-saved",
        serde_json::json!({ "path": path_str, "project": project_name }),
    );

    Ok(path_str)
}

/// After (or instead of) saving, hand the captured content to the AI panel: focus the main
/// window and emit `quick-capture-to-ai` for the renderer to inject as context.
#[tauri::command]
pub async fn quick_capture_send_to_ai<R: Runtime>(
    app: AppHandle<R>,
    content: String,
    project_name: Option<String>,
) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
    app.emit(
        "quick-capture-to-ai",
        serde_json::json!({ "content": content, "project": project_name }),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Spawn the background clipboard watcher. While the feature is enabled it polls the current
/// clipboard text every ~1.5s and rolls it into the memory-only buffer (consecutive dupes
/// collapse). Text only this pass. Never logs clipboard contents.
pub fn spawn_clipboard_watcher(state: Arc<QuickCaptureState>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            if !state.enabled() {
                continue;
            }
            let state_for_blocking = state.clone();
            let _ = tokio::task::spawn_blocking(move || {
                match arboard::Clipboard::new() {
                    Ok(mut clipboard) => {
                        if let Ok(text) = clipboard.get_text() {
                            state_for_blocking.push_text(text);
                        }
                    }
                    Err(_) => { /* clipboard busy/unavailable: try again next tick */ }
                }
            })
            .await;
        }
    });
}
