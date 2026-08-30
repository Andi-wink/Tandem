use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::capture;
use super::types::{CaptureMode, ScreenshotData};

/// Solo Mode's active project directory. When set, screenshots route into
/// `{path}/.tandem/screenshots/` instead of the meeting folder.
static ACTIVE_SOLO_PROJECT_DIR: LazyLock<Mutex<Option<PathBuf>>> =
    LazyLock::new(|| Mutex::new(None));

/// F061: optional `.tandem`-relative session subfolder for a virtual sub-project
/// (e.g. "sessions/<slug>-<id>"). When set alongside the project dir, screenshots
/// route into `{path}/.tandem/{subfolder}/screenshots/` so each chat's captures
/// stay isolated. None → the shared `{path}/.tandem/screenshots/`.
static ACTIVE_SOLO_SESSION_FOLDER: LazyLock<Mutex<Option<String>>> =
    LazyLock::new(|| Mutex::new(None));

/// Set or clear the active Solo Mode project. Called from the frontend when
/// the user switches projects or stops the solo session. `session_folder` scopes
/// screenshots into a virtual sub-project's session folder (F061); pass None for
/// a plain project (shared `.tandem/screenshots/`).
#[tauri::command]
pub async fn set_active_solo_project(
    path: Option<String>,
    session_folder: Option<String>,
) -> Result<(), String> {
    {
        let mut guard = ACTIVE_SOLO_PROJECT_DIR
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        *guard = path.map(PathBuf::from);
        info!("Active solo project: {:?}", *guard);
    }
    {
        let mut guard = ACTIVE_SOLO_SESSION_FOLDER
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        // Ignore an empty string as "no subfolder".
        *guard = session_folder.filter(|s| !s.is_empty());
        info!("Active solo session folder: {:?}", *guard);
    }
    Ok(())
}

/// Return the pre-captured JPEG preview as raw bytes (no base64 overhead).
/// The frontend receives an ArrayBuffer and creates a blob URL.
#[tauri::command]
pub async fn get_pre_capture_preview() -> Result<tauri::ipc::Response, String> {
    let bytes = capture::take_pre_captured_jpeg()
        .ok_or_else(|| "No pre-captured preview available".to_string())?;
    info!("Returning pre-capture preview: {} raw bytes", bytes.len());
    Ok(tauri::ipc::Response::new(bytes))
}

#[derive(Debug, Clone, Serialize)]
pub struct ScreenPreview {
    pub image_data: String,
    pub width: u32,  // Original monitor width (for coordinate mapping)
    pub height: u32, // Original monitor height (for coordinate mapping)
}

/// Capture the full desktop and return a JPEG preview downscaled to viewport size.
/// Returns original monitor dimensions so the frontend can map coordinates correctly.
#[tauri::command]
pub async fn capture_screen_preview(
    viewport_width: u32,
    viewport_height: u32,
) -> Result<ScreenPreview, String> {
    info!(
        "Capturing screen preview for region selection (viewport: {}x{})",
        viewport_width, viewport_height
    );

    let (image_data, width, height) =
        capture::capture_screen_preview(viewport_width, viewport_height).map_err(|e| {
            error!("Failed to capture screen preview: {}", e);
            format!("Screen preview failed: {}", e)
        })?;

    info!(
        "Screen preview captured: original {}x{}, preview {}x{}",
        width, height, viewport_width, viewport_height,
    );
    Ok(ScreenPreview {
        image_data,
        width,
        height,
    })
}

/// Take a fullscreen screenshot.
/// Saves to the current meeting folder if recording, otherwise to app_data_dir/screenshots.
#[tauri::command]
pub async fn take_screenshot<R: Runtime>(app: AppHandle<R>) -> Result<ScreenshotData, String> {
    info!("Taking fullscreen screenshot");

    let screenshots_dir = get_screenshots_dir(&app)?;

    let data = capture::capture_fullscreen(&screenshots_dir).map_err(|e| {
        error!("Failed to capture fullscreen screenshot: {}", e);
        format!("Screenshot capture failed: {}", e)
    })?;

    // Emit event so global shortcut captures also reach the frontend
    if let Err(e) = app.emit("screenshot-taken", &data) {
        error!("Failed to emit screenshot-taken event: {}", e);
    }

    info!("Screenshot saved: {}", data.file_path);
    Ok(data)
}

/// Take a region screenshot with the given coordinates and dimensions.
#[tauri::command]
pub async fn take_region_screenshot<R: Runtime>(
    app: AppHandle<R>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<ScreenshotData, String> {
    info!(
        "Taking region screenshot at ({}, {}) {}x{}",
        x, y, width, height
    );

    let screenshots_dir = get_screenshots_dir(&app)?;

    let data = capture::capture_region(x, y, width, height, &screenshots_dir).map_err(|e| {
        error!("Failed to capture region screenshot: {}", e);
        format!("Region screenshot capture failed: {}", e)
    })?;

    if let Err(e) = app.emit("screenshot-taken", &data) {
        error!("Failed to emit screenshot-taken event: {}", e);
    }

    info!("Region screenshot saved: {}", data.file_path);
    Ok(data)
}

/// Serializable screenshot entry for screenshots.json (no thumbnail, relative path)
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScreenshotEntry {
    id: String,
    file_name: String, // Just the filename, relative to screenshots/ dir
    timestamp: String,
    recording_elapsed_secs: Option<f64>,
    width: u32,
    height: u32,
    capture_mode: CaptureMode,
}

/// Save screenshot metadata to screenshots.json in the meeting folder.
/// Called from frontend when recording stops.
#[tauri::command]
pub async fn save_screenshots_json(
    folder_path: String,
    screenshots: Vec<ScreenshotData>,
) -> Result<(), String> {
    let folder = PathBuf::from(&folder_path);
    if !folder.exists() {
        return Err(format!("Meeting folder does not exist: {}", folder_path));
    }

    // Convert to entries with relative file names
    let entries: Vec<ScreenshotEntry> = screenshots
        .iter()
        .filter_map(|s| {
            // Extract just the filename from the full path
            let file_path = PathBuf::from(&s.file_path);
            let file_name = file_path.file_name()?.to_string_lossy().to_string();
            Some(ScreenshotEntry {
                id: s.id.clone(),
                file_name,
                timestamp: s.timestamp.clone(),
                recording_elapsed_secs: s.recording_elapsed_secs,
                width: s.width,
                height: s.height,
                capture_mode: s.capture_mode.clone(),
            })
        })
        .collect();

    let json = serde_json::json!({
        "version": "1.0",
        "screenshots": entries,
        "total_count": entries.len(),
    });

    let json_path = folder.join("screenshots.json");
    let json_string = serde_json::to_string_pretty(&json).map_err(|e| {
        error!("Failed to serialize screenshots JSON: {}", e);
        format!("JSON serialization failed: {}", e)
    })?;

    std::fs::write(&json_path, json_string).map_err(|e| {
        error!("Failed to write screenshots.json: {}", e);
        format!("Failed to write screenshots.json: {}", e)
    })?;

    info!(
        "Saved {} screenshot entries to {}",
        entries.len(),
        json_path.display()
    );
    Ok(())
}

/// Load screenshot metadata from screenshots.json, regenerating thumbnails from disk.
/// Returns empty array if file doesn't exist (backwards compatible).
#[tauri::command]
pub async fn load_screenshots_json(folder_path: String) -> Result<Vec<ScreenshotData>, String> {
    let folder = PathBuf::from(&folder_path);
    let json_path = folder.join("screenshots.json");

    if !json_path.exists() {
        return Ok(vec![]);
    }

    let json_string = std::fs::read_to_string(&json_path).map_err(|e| {
        error!("Failed to read screenshots.json: {}", e);
        format!("Failed to read screenshots.json: {}", e)
    })?;

    let parsed: serde_json::Value = serde_json::from_str(&json_string).map_err(|e| {
        error!("Failed to parse screenshots.json: {}", e);
        format!("Failed to parse screenshots.json: {}", e)
    })?;

    let entries: Vec<ScreenshotEntry> = serde_json::from_value(
        parsed
            .get("screenshots")
            .cloned()
            .unwrap_or(serde_json::Value::Array(vec![])),
    )
    .map_err(|e| {
        error!("Failed to deserialize screenshot entries: {}", e);
        format!("Failed to deserialize screenshot entries: {}", e)
    })?;

    let screenshots_dir = folder.join("screenshots");
    let mut results: Vec<ScreenshotData> = Vec::new();

    for entry in entries {
        let file_path = screenshots_dir.join(&entry.file_name);

        if !file_path.exists() {
            warn!(
                "Screenshot file not found, skipping: {}",
                file_path.display()
            );
            continue;
        }

        // Regenerate thumbnail from the file on disk
        let thumbnail_base64 = match capture::generate_thumbnail_from_path(&file_path) {
            Ok(thumb) => thumb,
            Err(e) => {
                warn!(
                    "Failed to generate thumbnail for {}: {}",
                    file_path.display(),
                    e
                );
                String::new()
            }
        };

        results.push(ScreenshotData {
            id: entry.id,
            file_path: file_path.to_string_lossy().to_string(),
            thumbnail_base64,
            timestamp: entry.timestamp,
            recording_elapsed_secs: entry.recording_elapsed_secs,
            width: entry.width,
            height: entry.height,
            capture_mode: entry.capture_mode,
        });
    }

    info!(
        "Loaded {} screenshots from {}",
        results.len(),
        json_path.display()
    );
    Ok(results)
}

/// Crop a region from the pre-captured screen image (stored in memory by the hotkey handler).
/// This avoids capturing the screen a second time — the image was already captured when the
/// user pressed Alt+Shift+R.
#[tauri::command]
pub async fn crop_pre_captured_region<R: Runtime>(
    app: AppHandle<R>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<ScreenshotData, String> {
    info!(
        "Cropping pre-captured region at ({}, {}) {}x{}",
        x, y, width, height
    );

    let screenshots_dir = get_screenshots_dir(&app)?;

    let data =
        capture::crop_from_pre_captured(x, y, width, height, &screenshots_dir).map_err(|e| {
            error!("Failed to crop pre-captured region: {}", e);
            format!("Region crop failed: {}", e)
        })?;

    if let Err(e) = app.emit("screenshot-taken", &data) {
        error!("Failed to emit screenshot-taken event: {}", e);
    }

    info!("Region screenshot (pre-capture) saved: {}", data.file_path);
    Ok(data)
}

/// Start region capture: pre-capture the screen and return the JPEG preview + dimensions
/// in a single IPC response (no event, no second round-trip).
/// Format: [width: u32 LE][height: u32 LE][JPEG bytes...]
#[tauri::command]
pub async fn start_region_capture() -> Result<tauri::ipc::Response, String> {
    info!("Starting region capture from UI button");

    // Self-healing: clear stale state if previous capture didn't finish
    if capture::is_region_capture_in_progress() {
        info!("Clearing stale region capture state");
        capture::clear_pre_captured();
    }

    let result = tokio::task::spawn_blocking(|| capture::pre_capture_screen())
        .await
        .map_err(|e| format!("Pre-capture task failed: {}", e))?
        .map_err(|e| format!("Pre-capture failed: {}", e))?;

    let jpeg_bytes = capture::take_pre_captured_jpeg()
        .ok_or_else(|| "No pre-captured JPEG available".to_string())?;

    info!(
        "Pre-captured screen via button: {}x{}, {} raw bytes",
        result.monitor_width, result.monitor_height, jpeg_bytes.len(),
    );

    // Pack dimensions + JPEG into a single binary response
    let mut response = Vec::with_capacity(8 + jpeg_bytes.len());
    response.extend_from_slice(&result.monitor_width.to_le_bytes());
    response.extend_from_slice(&result.monitor_height.to_le_bytes());
    response.extend_from_slice(&jpeg_bytes);

    Ok(tauri::ipc::Response::new(response))
}

/// Crop a preview from the pre-captured screen image for annotation.
/// Returns a JPEG data URI and the cropped dimensions WITHOUT consuming the stored image.
/// The original remains available for the final save via save_annotated_screenshot.
#[derive(Debug, Clone, Serialize)]
pub struct CropPreviewResult {
    pub data_uri: String,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub async fn crop_pre_captured_preview(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<CropPreviewResult, String> {
    info!(
        "Cropping preview from pre-captured at ({}, {}) {}x{}",
        x, y, width, height
    );

    let (data_uri, w, h) =
        capture::crop_preview_from_pre_captured(x, y, width, height).map_err(|e| {
            error!("Failed to crop preview from pre-captured: {}", e);
            format!("Crop preview failed: {}", e)
        })?;

    Ok(CropPreviewResult {
        data_uri,
        width: w,
        height: h,
    })
}

/// Cancel region capture and free the pre-captured image from memory.
#[tauri::command]
pub async fn cancel_region_capture() -> Result<(), String> {
    info!("Cancelling region capture, clearing pre-captured image");
    capture::clear_pre_captured();
    Ok(())
}

/// Save an annotated screenshot from a base64-encoded PNG.
/// Used after the user draws on a region screenshot in the annotation overlay.
#[tauri::command]
pub async fn save_annotated_screenshot<R: Runtime>(
    app: AppHandle<R>,
    image_base64: String,
) -> Result<ScreenshotData, String> {
    info!(
        "Saving annotated screenshot (base64 length: {})",
        image_base64.len()
    );

    // Free the pre-captured buffer since we're using the annotated version
    capture::clear_pre_captured();

    let screenshots_dir = get_screenshots_dir(&app)?;

    let data = capture::save_from_base64(&image_base64, &screenshots_dir).map_err(|e| {
        error!("Failed to save annotated screenshot: {}", e);
        format!("Annotated screenshot save failed: {}", e)
    })?;

    if let Err(e) = app.emit("screenshot-taken", &data) {
        error!("Failed to emit screenshot-taken event: {}", e);
    }

    info!("Annotated screenshot saved: {}", data.file_path);
    Ok(data)
}

/// Determine the screenshots directory.
/// Priority: active Solo project → current meeting folder → app_data_dir.
fn get_screenshots_dir<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    if let Ok(guard) = ACTIVE_SOLO_PROJECT_DIR.lock() {
        if let Some(project_dir) = guard.as_ref() {
            let mut dir = project_dir.join(".tandem");
            // F061: a virtual sub-project scopes its screenshots under the session
            // folder. `Path::join` treats the '/' in "sessions/<slug>-<id>" as a
            // component separator on all platforms.
            if let Ok(sub) = ACTIVE_SOLO_SESSION_FOLDER.lock() {
                if let Some(subfolder) = sub.as_ref() {
                    dir = dir.join(subfolder);
                }
            }
            return Ok(dir.join("screenshots"));
        }
    }

    let meeting_folder = {
        crate::audio::recording_commands::get_current_meeting_folder()
    };

    if let Some(folder) = meeting_folder {
        Ok(capture::get_screenshots_dir(&folder))
    } else {
        let app_data = app.path().app_data_dir().map_err(|e| {
            format!("Failed to get app data directory: {}", e)
        })?;
        Ok(capture::get_screenshots_dir(&app_data))
    }
}

/// Read an image from disk and return it as a JPEG data URI scaled for document embedding.
///
/// Used by the handover export so the generated HTML carries its own images and stays readable
/// when it is moved or emailed. Missing files return an error rather than a placeholder, so the
/// caller can decide whether to fall back to a plain file reference.
#[tauri::command]
pub async fn screenshot_embed_data_uri(
    file_path: String,
    max_width: Option<u32>,
) -> Result<String, String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!("Image not found: {}", file_path));
    }
    let width = max_width.unwrap_or(capture::EMBED_MAX_WIDTH);
    capture::generate_embed_data_uri(&path, width).map_err(|e| {
        error!("Failed to embed image {}: {}", file_path, e);
        format!("Failed to embed image: {}", e)
    })
}
