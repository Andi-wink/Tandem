use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::capture;
use super::types::{ClipboardContentType, ClipboardData};

/// Serializable entry stored in clipboard.json (relative file path for images).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ClipboardEntry {
    id: String,
    content_type: ClipboardContentType,
    text: Option<String>,
    file_name: Option<String>, // Just the filename for image clips (relative to clipboard/)
    timestamp: String,
    recording_elapsed_secs: Option<f64>,
    width: Option<u32>,
    height: Option<u32>,
}

/// Read current clipboard content and emit a `clipboard-captured` event.
/// Determines the clipboard directory from the current meeting folder (if recording),
/// otherwise falls back to the app data directory.
#[tauri::command]
pub async fn read_clipboard_content<R: Runtime>(
    app: AppHandle<R>,
) -> Result<ClipboardData, String> {
    info!("Reading clipboard content");

    let clipboard_dir = get_clipboard_dir(&app)?;

    // Determine recording elapsed time (seconds since recording started)
    let recording_elapsed_secs =
        crate::audio::recording_commands::get_recording_elapsed_secs();

    let data = tokio::task::spawn_blocking(move || {
        capture::read_clipboard(&clipboard_dir, recording_elapsed_secs)
    })
    .await
    .map_err(|e| format!("Clipboard task panicked: {}", e))?
    .map_err(|e| {
        error!("Failed to read clipboard: {}", e);
        format!("Clipboard read failed: {}", e)
    })?;

    if let Err(e) = app.emit("clipboard-captured", &data) {
        error!("Failed to emit clipboard-captured event: {}", e);
    }

    info!(
        "Clipboard captured: {:?} at {:?}",
        data.content_type, data.timestamp
    );
    Ok(data)
}

/// Save clipboard items to `clipboard.json` in the meeting folder.
/// Called from the frontend when recording stops.
#[tauri::command]
pub async fn save_clipboard_json(
    folder_path: String,
    items: Vec<ClipboardData>,
) -> Result<(), String> {
    let folder = PathBuf::from(&folder_path);
    if !folder.exists() {
        return Err(format!("Meeting folder does not exist: {}", folder_path));
    }

    let entries: Vec<ClipboardEntry> = items
        .iter()
        .map(|item| {
            let file_name = item.file_path.as_ref().and_then(|fp| {
                PathBuf::from(fp).file_name().map(|n| n.to_string_lossy().to_string())
            });
            ClipboardEntry {
                id: item.id.clone(),
                content_type: item.content_type.clone(),
                text: item.text.clone(),
                file_name,
                timestamp: item.timestamp.clone(),
                recording_elapsed_secs: item.recording_elapsed_secs,
                width: item.width,
                height: item.height,
            }
        })
        .collect();

    let json = serde_json::json!({
        "version": "1.0",
        "items": entries,
        "total_count": entries.len(),
    });

    let json_path = folder.join("clipboard.json");
    let json_string = serde_json::to_string_pretty(&json).map_err(|e| {
        error!("Failed to serialize clipboard JSON: {}", e);
        format!("JSON serialization failed: {}", e)
    })?;

    std::fs::write(&json_path, json_string).map_err(|e| {
        error!("Failed to write clipboard.json: {}", e);
        format!("Failed to write clipboard.json: {}", e)
    })?;

    info!(
        "Saved {} clipboard entries to {}",
        entries.len(),
        json_path.display()
    );
    Ok(())
}

/// Load clipboard items from `clipboard.json`, regenerating image thumbnails from disk.
/// Returns an empty list if the file doesn't exist (backwards compatible).
#[tauri::command]
pub async fn load_clipboard_json(folder_path: String) -> Result<Vec<ClipboardData>, String> {
    let folder = PathBuf::from(&folder_path);
    let json_path = folder.join("clipboard.json");

    if !json_path.exists() {
        return Ok(vec![]);
    }

    let json_string = std::fs::read_to_string(&json_path).map_err(|e| {
        error!("Failed to read clipboard.json: {}", e);
        format!("Failed to read clipboard.json: {}", e)
    })?;

    let parsed: serde_json::Value = serde_json::from_str(&json_string).map_err(|e| {
        error!("Failed to parse clipboard.json: {}", e);
        format!("Failed to parse clipboard.json: {}", e)
    })?;

    let entries: Vec<ClipboardEntry> = serde_json::from_value(
        parsed
            .get("items")
            .cloned()
            .unwrap_or(serde_json::Value::Array(vec![])),
    )
    .map_err(|e| {
        error!("Failed to deserialize clipboard entries: {}", e);
        format!("Failed to deserialize clipboard entries: {}", e)
    })?;

    let clipboard_dir = folder.join("clipboard");
    let mut results: Vec<ClipboardData> = Vec::new();

    for entry in entries {
        match entry.content_type {
            ClipboardContentType::Text => {
                results.push(ClipboardData {
                    id: entry.id,
                    content_type: ClipboardContentType::Text,
                    text: entry.text,
                    file_path: None,
                    thumbnail_base64: None,
                    timestamp: entry.timestamp,
                    recording_elapsed_secs: entry.recording_elapsed_secs,
                    width: None,
                    height: None,
                });
            }
            ClipboardContentType::Image => {
                let file_name = match entry.file_name {
                    Some(ref name) => name.clone(),
                    None => {
                        warn!("Clipboard image entry missing file_name, skipping");
                        continue;
                    }
                };
                let file_path = clipboard_dir.join(&file_name);
                if !file_path.exists() {
                    warn!(
                        "Clipboard image file not found, skipping: {}",
                        file_path.display()
                    );
                    continue;
                }

                let thumbnail_base64 =
                    match crate::screenshot::capture::generate_thumbnail_from_path(&file_path) {
                        Ok(thumb) => Some(thumb),
                        Err(e) => {
                            warn!(
                                "Failed to generate thumbnail for clipboard image {}: {}",
                                file_path.display(),
                                e
                            );
                            None
                        }
                    };

                results.push(ClipboardData {
                    id: entry.id,
                    content_type: ClipboardContentType::Image,
                    text: None,
                    file_path: Some(file_path.to_string_lossy().to_string()),
                    thumbnail_base64,
                    timestamp: entry.timestamp,
                    recording_elapsed_secs: entry.recording_elapsed_secs,
                    width: entry.width,
                    height: entry.height,
                });
            }
        }
    }

    info!(
        "Loaded {} clipboard items from {}",
        results.len(),
        json_path.display()
    );
    Ok(results)
}

/// Determine the clipboard directory.
/// Uses the current meeting folder if recording, otherwise app_data_dir.
fn get_clipboard_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let meeting_folder = crate::audio::recording_commands::get_current_meeting_folder();

    if let Some(folder) = meeting_folder {
        Ok(capture::get_clipboard_dir(&folder))
    } else {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data directory: {}", e))?;
        Ok(capture::get_clipboard_dir(&app_data))
    }
}
