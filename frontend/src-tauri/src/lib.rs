use serde::{Deserialize, Serialize};
use std::sync::Mutex as StdMutex;
// Removed unused import

// Performance optimization: Conditional logging macros for hot paths
#[cfg(debug_assertions)]
macro_rules! perf_debug {
    ($($arg:tt)*) => {
        log::debug!($($arg)*)
    };
}

#[cfg(not(debug_assertions))]
macro_rules! perf_debug {
    ($($arg:tt)*) => {};
}

#[cfg(debug_assertions)]
macro_rules! perf_trace {
    ($($arg:tt)*) => {
        log::trace!($($arg)*)
    };
}

#[cfg(not(debug_assertions))]
macro_rules! perf_trace {
    ($($arg:tt)*) => {};
}

// Make these macros available to other modules
pub(crate) use perf_debug;
pub(crate) use perf_trace;

// Re-export async logging macros for external use (removed due to macro conflicts)

// Declare modules
pub mod analytics;
pub mod api;
pub mod audio;
pub mod calendar_ics;
pub mod canvas;
pub mod claude_sessions;
pub mod clipboard;
pub mod console_utils;
pub mod quick_capture;
pub mod database;
mod migration;
pub mod notifications;
pub mod ollama;
pub mod onboarding;
pub mod openai;
pub mod anthropic;
pub mod groq;
pub mod openrouter;
pub mod parakeet_engine;
pub mod screenshot;
pub mod state;
pub mod summary;
pub mod tray;
pub mod utils;
pub mod whisper_engine;

use audio::{list_audio_devices, AudioDevice, trigger_audio_permission};
use log::{error as log_error, info as log_info};
use notifications::commands::NotificationManagerState;
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::RwLock;

// Global language preference storage (default to "auto" for automatic language detection)
static LANGUAGE_PREFERENCE: std::sync::LazyLock<StdMutex<String>> =
    std::sync::LazyLock::new(|| StdMutex::new("auto".to_string()));

#[derive(Debug, Deserialize)]
struct RecordingArgs {
    save_path: String,
}

#[derive(Debug, Serialize, Clone)]
struct TranscriptionStatus {
    chunks_in_queue: usize,
    is_processing: bool,
    last_activity_ms: u64,
}

#[tauri::command]
async fn start_recording<R: Runtime>(
    app: AppHandle<R>,
    mic_device_name: Option<String>,
    system_device_name: Option<String>,
    meeting_name: Option<String>,
    meeting_base_dir: Option<String>,
) -> Result<(), String> {
    log_info!("🔥 CALLED start_recording with meeting: {:?}", meeting_name);
    log_info!(
        "📋 Backend received parameters - mic: {:?}, system: {:?}, meeting: {:?}, base_dir: {:?}",
        mic_device_name,
        system_device_name,
        meeting_name,
        meeting_base_dir
    );

    if is_recording().await {
        return Err("Recording already in progress".to_string());
    }

    // Call the actual audio recording system with meeting name
    match audio::recording_commands::start_recording_with_devices_and_meeting(
        app.clone(),
        mic_device_name,
        system_device_name,
        meeting_name.clone(),
        meeting_base_dir,
    )
    .await
    {
        Ok(_) => {
            tray::update_tray_menu(&app);

            log_info!("Recording started successfully");

            // Show recording started notification through NotificationManager
            // This respects user's notification preferences
            let notification_manager_state = app.state::<NotificationManagerState<R>>();
            if let Err(e) = notifications::commands::show_recording_started_notification(
                &app,
                &notification_manager_state,
                meeting_name.clone(),
            )
            .await
            {
                log_error!(
                    "Failed to show recording started notification: {}",
                    e
                );
            } else {
                log_info!("Successfully showed recording started notification");
            }

            Ok(())
        }
        Err(e) => {
            log_error!("Failed to start audio recording: {}", e);
            Err(format!("Failed to start recording: {}", e))
        }
    }
}

#[tauri::command]
async fn stop_recording<R: Runtime>(app: AppHandle<R>, args: RecordingArgs) -> Result<(), String> {
    log_info!("Attempting to stop recording...");

    // Check the actual audio recording system state instead of the flag
    if !audio::recording_commands::is_recording().await {
        log_info!("Recording is already stopped");
        return Ok(());
    }

    // Call the actual audio recording system to stop
    match audio::recording_commands::stop_recording(
        app.clone(),
        audio::recording_commands::RecordingArgs {
            save_path: args.save_path.clone(),
        },
    )
    .await
    {
        Ok(_) => {
            tray::update_tray_menu(&app);

            // Create the save directory if it doesn't exist
            if let Some(parent) = std::path::Path::new(&args.save_path).parent() {
                if !parent.exists() {
                    log_info!("Creating directory: {:?}", parent);
                    if let Err(e) = std::fs::create_dir_all(parent) {
                        let err_msg = format!("Failed to create save directory: {}", e);
                        log_error!("{}", err_msg);
                        return Err(err_msg);
                    }
                }
            }

            // Show recording stopped notification through NotificationManager
            // This respects user's notification preferences
            let notification_manager_state = app.state::<NotificationManagerState<R>>();
            if let Err(e) = notifications::commands::show_recording_stopped_notification(
                &app,
                &notification_manager_state,
            )
            .await
            {
                log_error!(
                    "Failed to show recording stopped notification: {}",
                    e
                );
            } else {
                log_info!("Successfully showed recording stopped notification");
            }

            Ok(())
        }
        Err(e) => {
            log_error!("Failed to stop audio recording: {}", e);
            tray::update_tray_menu(&app);
            Err(format!("Failed to stop recording: {}", e))
        }
    }
}

#[tauri::command]
async fn is_recording() -> bool {
    audio::recording_commands::is_recording().await
}

#[tauri::command]
fn get_transcription_status() -> TranscriptionStatus {
    TranscriptionStatus {
        chunks_in_queue: 0,
        is_processing: false,
        last_activity_ms: 0,
    }
}

#[tauri::command]
fn read_audio_file(file_path: String) -> Result<Vec<u8>, String> {
    match std::fs::read(&file_path) {
        Ok(data) => Ok(data),
        Err(e) => Err(format!("Failed to read audio file: {}", e)),
    }
}

#[tauri::command]
async fn save_transcript(file_path: String, content: String) -> Result<(), String> {
    log_info!("Saving transcript to: {}", file_path);

    // Ensure parent directory exists
    if let Some(parent) = std::path::Path::new(&file_path).parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
    }

    // Write content to file
    std::fs::write(&file_path, content)
        .map_err(|e| format!("Failed to write transcript: {}", e))?;

    log_info!("Transcript saved successfully");
    Ok(())
}

/// Copy a file from source to destination, creating parent directories as needed.
#[tauri::command]
async fn copy_file(source: String, destination: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&destination).parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
    }
    std::fs::copy(&source, &destination)
        .map_err(|e| format!("Failed to copy file: {}", e))?;
    Ok(())
}

/// Read a file if it exists and has non-empty content.
/// Returns None if the file is missing, unreadable, or empty.
#[tauri::command]
async fn read_file_if_exists(path: String) -> Result<Option<String>, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Ok(None);
    }
    match std::fs::read_to_string(p) {
        Ok(content) => {
            let trimmed = content.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
        Err(e) => Err(format!("Failed to read file: {}", e)),
    }
}

/// Delete a file at an arbitrary path (e.g. undoing a just-written HANDOFF.md).
/// Uses raw std::fs so it works outside the ACL-scoped fs plugin (which only permits $APPDATA).
/// A missing file is treated as success so Undo is idempotent.
#[tauri::command]
async fn delete_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Ok(());
    }
    std::fs::remove_file(p).map_err(|e| format!("Failed to delete file: {}", e))?;
    Ok(())
}

/// Recursively copy a directory tree from `src` into `dst` (creating `dst`).
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Normalize a path for case- and separator-insensitive equality (Windows-friendly): unify
/// separators to `/`, drop any trailing slash, lowercase. Used to detect a same-folder relocate.
fn normalize_path_for_eq(p: &std::path::Path) -> String {
    p.to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

/// True when re-filing to `dest_parent` would land the folder exactly where it already is
/// (`dest_parent/leaf == src`), making the move a no-op that must not fall through to the
/// collision-rename loop (which would spuriously rename it to "<leaf> (2)").
fn is_noop_relocation(
    dest_parent: &std::path::Path,
    leaf: &std::ffi::OsStr,
    src: &std::path::Path,
) -> bool {
    let initial = dest_parent.join(leaf);
    normalize_path_for_eq(&initial) == normalize_path_for_eq(src)
}

#[cfg(test)]
mod relocate_tests {
    use super::is_noop_relocation;
    use std::path::Path;

    #[test]
    fn same_folder_is_noop() {
        let src = Path::new("D:/Clients/Acme/.tandem/Meeting_11_07_2026");
        let dest_parent = Path::new("D:/Clients/Acme/.tandem");
        let leaf = src.file_name().unwrap();
        assert!(is_noop_relocation(dest_parent, leaf, src));
    }

    #[test]
    fn same_folder_is_noop_across_separators_and_casing() {
        // Windows: DB stores one casing/separator, caller rebuilds with another — still a no-op.
        let src = Path::new(r"D:\Clients\Acme\.tandem\Meeting_11_07_2026");
        let dest_parent = Path::new("d:/clients/acme/.tandem");
        let leaf = Path::new("meeting_11_07_2026").file_name().unwrap();
        assert!(is_noop_relocation(dest_parent, leaf, src));
    }

    #[test]
    fn different_project_is_not_noop() {
        let src = Path::new("D:/Clients/Acme/.tandem/Meeting_11_07_2026");
        let dest_parent = Path::new("D:/Clients/Globex/.tandem");
        let leaf = src.file_name().unwrap();
        assert!(!is_noop_relocation(dest_parent, leaf, src));
    }

    #[test]
    fn recordings_base_is_not_noop() {
        let src = Path::new("D:/Clients/Acme/.tandem/Meeting_11_07_2026");
        let dest_parent = Path::new("C:/Users/andre/AppData/Roaming/Tandem/recordings");
        let leaf = src.file_name().unwrap();
        assert!(!is_noop_relocation(dest_parent, leaf, src));
    }
}

/// Relocate a saved meeting's folder into `dest_parent_dir`, preserving its leaf name, and update
/// the SQLite `folder_path` row (R3 deferred filing). Plain Rust command because the plugin-fs ACL
/// is $APPDATA-scoped. Refuses to move a folder the live recording is still writing.
///
/// Returns the new folder path on success. The move is a rename (fast path) with a
/// copy-then-delete fallback for cross-drive moves; on any copy failure the source is left
/// authoritative and the DB row is NOT updated.
#[tauri::command]
async fn relocate_meeting_folder(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
    dest_parent_dir: String,
) -> Result<String, String> {
    use crate::database::repositories::meeting::MeetingsRepository;

    let pool = state.db_manager.pool();
    let meeting = MeetingsRepository::get_meeting_metadata(pool, &meeting_id)
        .await
        .map_err(|e| format!("Could not load the meeting: {}", e))?
        .ok_or_else(|| "That meeting no longer exists.".to_string())?;

    let src_str = meeting.folder_path.ok_or_else(|| {
        "This meeting has no folder on disk yet, so there is nothing to move. It will file once it finishes saving.".to_string()
    })?;
    let src = std::path::Path::new(&src_str);

    // Never move a folder the recording pipeline is still writing into.
    if audio::recording_commands::is_folder_recording_active(&src_str) {
        return Err(
            "This recording is still writing to its folder. Filing will complete automatically once the recording finishes saving.".to_string(),
        );
    }

    if !src.exists() {
        return Err(format!(
            "The recording folder was not found on disk ({}). It may have been moved already; nothing was changed.",
            src_str
        ));
    }

    let leaf = src
        .file_name()
        .ok_or_else(|| "Could not determine the recording folder name.".to_string())?;

    let dest_parent = std::path::Path::new(&dest_parent_dir);

    // Same-folder no-op guard, BEFORE the collision loop. Re-filing a meeting into the folder it
    // already lives in (`dest_parent/leaf == src`) must return the source untouched. Otherwise the
    // collision loop below sees the leaf "already exists" (it IS src) and renames the folder to
    // "<leaf> (2)", turning a pure no-op into a destructive rename. Compared case/separator-
    // insensitively so a Windows casing-only difference is also treated as a no-op.
    if is_noop_relocation(dest_parent, leaf, src) {
        return Ok(src_str);
    }

    std::fs::create_dir_all(dest_parent)
        .map_err(|e| format!("Could not create the destination folder ({}): {}. The files stay where they are.", dest_parent_dir, e))?;

    // Pick a non-colliding destination: <parent>/<leaf>, then "<leaf> (2)", "(3)", …
    let mut dest = dest_parent.join(leaf);
    if dest.exists() {
        let leaf_str = leaf.to_string_lossy().to_string();
        let mut n = 2;
        loop {
            let candidate = dest_parent.join(format!("{} ({})", leaf_str, n));
            if !candidate.exists() {
                dest = candidate;
                break;
            }
            n += 1;
        }
    }

    // Fast path: rename. Falls back to recursive copy + delete for cross-drive moves.
    if std::fs::rename(src, &dest).is_err() {
        copy_dir_recursive(src, &dest).map_err(|e| {
            // Copy failed partway: remove the partial dest, leave the source authoritative.
            let _ = std::fs::remove_dir_all(&dest);
            format!("Could not move the recording files: {}. The files stay in the original folder.", e)
        })?;
        // Copy succeeded — now remove the source. If this fails, the move still succeeded (dest is
        // complete); the stale source is harmless.
        if let Err(e) = std::fs::remove_dir_all(src) {
            log::warn!("Relocated meeting copied to {} but source cleanup failed: {}", dest.display(), e);
        }
    }

    let dest_str = dest.to_string_lossy().to_string();
    if let Err(e) = MeetingsRepository::update_meeting_folder_path(pool, &meeting_id, &dest_str).await {
        // The files already moved but the DB row could not be repointed (e.g. a transient SQLite
        // lock). Roll the filesystem move back so the DB (still src) and disk agree, leaving a
        // retry clean instead of stranding the row pointing at an empty/absent folder. Try the
        // rename fast-path first; fall back to copy+delete for the cross-drive case.
        let rolled_back = std::fs::rename(&dest, src).is_ok()
            || match copy_dir_recursive(&dest, src) {
                Ok(()) => {
                    let _ = std::fs::remove_dir_all(&dest);
                    true
                }
                Err(_) => false,
            };
        if rolled_back {
            return Err(format!(
                "Filing did not complete: the database update failed ({}). The files were moved back to their original folder, so nothing changed. Please try again.",
                e
            ));
        }
        // Rollback also failed: this is the genuine unavoidable divergence (disk at dest, DB at
        // src). Keep the reopen guidance.
        return Err(format!(
            "Files moved to {} but the database update failed: {}. Reopen the meeting to refresh.",
            dest_str, e
        ));
    }

    log_info!("Relocated meeting {} folder -> {}", meeting_id, dest_str);
    Ok(dest_str)
}

/// Write a base64-encoded payload to a binary file (e.g. a PNG export of the whiteboard),
/// creating parent directories as needed. Accepts a bare base64 string or a data URL.
#[tauri::command]
async fn save_base64_file(path: String, base64: String) -> Result<(), String> {
    use base64::Engine as _;
    // Tolerate a "data:image/png;base64,...." prefix.
    let payload = base64.rsplit(',').next().unwrap_or(&base64);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("Invalid base64: {}", e))?;
    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
    }
    std::fs::write(&path, bytes).map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(())
}

/// Relay a Tauri event between windows by broadcasting it through the Rust core.
///
/// The JS `emit`/`emitTo` APIs did not reliably cross the `main` <-> `solo-hud`
/// window boundary in this app, but Rust `AppHandle::emit` broadcasts to ALL
/// webviews (the same path the audio/recording events use, which the frontend
/// receives reliably). The Solo HUD and main window use this to talk to each
/// other (project switch picks, active-project pill updates, ready/stopped
/// handshakes); the receiving side keeps its normal JS `listen(event, ...)`.
#[tauri::command]
async fn relay_event<R: Runtime>(
    app: AppHandle<R>,
    event: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    use tauri::Emitter as _;
    app.emit(&event, payload)
        .map_err(|e| format!("relay_event('{}') failed: {}", event, e))
}

/// Bring the main window to the foreground. Used by the pre-meeting recording prompt (I5) so the
/// dialog is seen even when Tandem is minimized or behind other windows. Delegates to the tray's
/// shared helper so the unminimize/show/set_focus sequence lives in exactly one place.
#[tauri::command]
fn focus_main_window<R: Runtime>(app: AppHandle<R>) {
    tray::focus_main_window(&app);
}

/// Fire a native OS notification as a backup for the pre-meeting recording prompt (I5), so an
/// imminent call is noticed even when the window is not focused. Thin wrapper over the notification
/// plugin's Rust API (the same path recording notifications use); needs no extra JS capability.
#[tauri::command]
fn notify_meeting_starting<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: String,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| format!("notify_meeting_starting failed: {}", e))
}

/// One saved whiteboard in a client's library ({project}/.tandem/whiteboards/).
#[derive(serde::Serialize)]
pub struct WhiteboardMeta {
    /// Stable id = the filename stem (the originating meeting folder leaf).
    id: String,
    /// Friendly title (from the sibling .meta.json, else the id).
    title: String,
    /// Last-modified time of the board JSON, ms since epoch.
    saved_at_ms: u64,
    json_path: String,
    png_path: Option<String>,
}

/// List the saved whiteboards for a client, newest first. Anchored on the Solo project folder:
/// scans `{project_path}/.tandem/whiteboards/*.tldr.json`. Empty if the folder doesn't exist.
#[tauri::command]
async fn list_whiteboards(project_path: String) -> Result<Vec<WhiteboardMeta>, String> {
    let dir = std::path::Path::new(&project_path)
        .join(".tandem")
        .join("whiteboards");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out: Vec<WhiteboardMeta> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let fname = match path.file_name().and_then(|s| s.to_str()) {
            Some(f) if f.ends_with(".tldr.json") => f.to_string(),
            _ => continue,
        };
        let stem = fname.trim_end_matches(".tldr.json").to_string();
        let saved_at_ms = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let title = std::fs::read_to_string(dir.join(format!("{}.meta.json", stem)))
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.get("title").and_then(|t| t.as_str().map(str::to_string)))
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| stem.clone());
        let png = dir.join(format!("{}.png", stem));
        let png_path = if png.exists() {
            Some(png.to_string_lossy().to_string())
        } else {
            None
        };
        out.push(WhiteboardMeta {
            id: stem,
            title,
            saved_at_ms,
            json_path: path.to_string_lossy().to_string(),
            png_path,
        });
    }
    out.sort_by(|a, b| b.saved_at_ms.cmp(&a.saved_at_ms));
    Ok(out)
}

// Audio level monitoring commands
#[tauri::command]
async fn start_audio_level_monitoring<R: Runtime>(
    app: AppHandle<R>,
    device_names: Vec<String>,
) -> Result<(), String> {
    log_info!(
        "Starting audio level monitoring for devices: {:?}",
        device_names
    );

    audio::simple_level_monitor::start_monitoring(app, device_names)
        .await
        .map_err(|e| format!("Failed to start audio level monitoring: {}", e))
}

#[tauri::command]
async fn stop_audio_level_monitoring() -> Result<(), String> {
    log_info!("Stopping audio level monitoring");

    audio::simple_level_monitor::stop_monitoring()
        .await
        .map_err(|e| format!("Failed to stop audio level monitoring: {}", e))
}

#[tauri::command]
async fn is_audio_level_monitoring() -> bool {
    audio::simple_level_monitor::is_monitoring()
}

// Analytics commands are now handled by analytics::commands module

// Whisper commands are now handled by whisper_engine::commands module

#[tauri::command]
async fn get_audio_devices() -> Result<Vec<AudioDevice>, String> {
    list_audio_devices()
        .await
        .map_err(|e| format!("Failed to list audio devices: {}", e))
}

#[tauri::command]
async fn trigger_microphone_permission() -> Result<bool, String> {
    trigger_audio_permission()
        .map_err(|e| format!("Failed to trigger microphone permission: {}", e))
}

#[tauri::command]
async fn start_recording_with_devices<R: Runtime>(
    app: AppHandle<R>,
    mic_device_name: Option<String>,
    system_device_name: Option<String>,
) -> Result<(), String> {
    start_recording_with_devices_and_meeting(app, mic_device_name, system_device_name, None, None).await
}

#[tauri::command]
async fn start_recording_with_devices_and_meeting<R: Runtime>(
    app: AppHandle<R>,
    mic_device_name: Option<String>,
    system_device_name: Option<String>,
    meeting_name: Option<String>,
    meeting_base_dir: Option<String>,
) -> Result<(), String> {
    log_info!("🚀 CALLED start_recording_with_devices_and_meeting - Mic: {:?}, System: {:?}, Meeting: {:?}, base_dir: {:?}",
             mic_device_name, system_device_name, meeting_name, meeting_base_dir);

    // Clone meeting_name for notification use later
    let meeting_name_for_notification = meeting_name.clone();

    // Call the recording module functions that support meeting names
    let recording_result = match (mic_device_name.clone(), system_device_name.clone()) {
        (None, None) => {
            log_info!(
                "No devices specified, starting with defaults and meeting: {:?}",
                meeting_name
            );
            audio::recording_commands::start_recording_with_meeting_name(app.clone(), meeting_name, meeting_base_dir)
                .await
        }
        _ => {
            log_info!(
                "Starting with specified devices: mic={:?}, system={:?}, meeting={:?}",
                mic_device_name,
                system_device_name,
                meeting_name
            );
            audio::recording_commands::start_recording_with_devices_and_meeting(
                app.clone(),
                mic_device_name,
                system_device_name,
                meeting_name,
                meeting_base_dir,
            )
            .await
        }
    };

    match recording_result {
        Ok(_) => {
            log_info!("Recording started successfully via tauri command");

            // Show recording started notification through NotificationManager
            // This respects user's notification preferences
            let notification_manager_state = app.state::<NotificationManagerState<R>>();
            if let Err(e) = notifications::commands::show_recording_started_notification(
                &app,
                &notification_manager_state,
                meeting_name_for_notification.clone(),
            )
            .await
            {
                log_error!(
                    "Failed to show recording started notification: {}",
                    e
                );
            }

            Ok(())
        }
        Err(e) => {
            log_error!("Failed to start recording via tauri command: {}", e);
            Err(e)
        }
    }
}

// Language preference commands
#[tauri::command]
async fn get_language_preference() -> Result<String, String> {
    let language = LANGUAGE_PREFERENCE
        .lock()
        .map_err(|e| format!("Failed to get language preference: {}", e))?;
    log_info!("Retrieved language preference: {}", &*language);
    Ok(language.clone())
}

#[tauri::command]
async fn set_language_preference(language: String) -> Result<(), String> {
    let mut lang_pref = LANGUAGE_PREFERENCE
        .lock()
        .map_err(|e| format!("Failed to set language preference: {}", e))?;
    log_info!("Setting language preference to: {}", language);
    *lang_pref = language;
    Ok(())
}

// Internal helper function to get language preference (for use within Rust code)
pub fn get_language_preference_internal() -> Option<String> {
    LANGUAGE_PREFERENCE.lock().ok().map(|lang| lang.clone())
}

/// Supervisors for the agent-whiteboard servers (app server :5174 + MCP canvas server :3939). Set in
/// `setup()`, killed in `RunEvent::Exit`.
static CANVAS_SERVERS: std::sync::OnceLock<Vec<std::sync::Arc<canvas::server::CanvasServerManager>>> =
    std::sync::OnceLock::new();

pub fn run() {
    log::set_max_level(log::LevelFilter::Info);

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin({
            use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};
            let fullscreen_shortcut: Shortcut = "Alt+Shift+S".parse().expect("Invalid shortcut: Alt+Shift+S");
            let region_shortcut: Shortcut = "Alt+Shift+R".parse().expect("Invalid shortcut: Alt+Shift+R");
            let clipboard_shortcut: Shortcut = "Alt+Shift+V".parse().expect("Invalid shortcut: Alt+Shift+V");
            let canvas_shortcut: Shortcut = "Alt+Shift+A".parse().expect("Invalid shortcut: Alt+Shift+A");
            let voice_command_shortcut: Shortcut = "Alt+Shift+Q".parse().expect("Invalid shortcut: Alt+Shift+Q");
            let record_shortcut: Shortcut = "Alt+Shift+E".parse().expect("Invalid shortcut: Alt+Shift+E");
            let quick_capture_shortcut: Shortcut = "Alt+Shift+N".parse().expect("Invalid shortcut: Alt+Shift+N");

            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["Alt+Shift+S", "Alt+Shift+R", "Alt+Shift+V", "Alt+Shift+A", "Alt+Shift+Q", "Alt+Shift+E", "Alt+Shift+N"])
                .expect("Failed to parse global shortcuts")
                .with_handler(move |app, shortcut, event| {
                    use tauri::Emitter as _;

                    // Canvas voice command (Alt+Shift+A) is PUSH-TO-TALK: it needs both edges.
                    // Hold to speak the command, release to fire. The renderer captures the mic
                    // clip between these events, transcribes it, and drives the canvas window.
                    if shortcut == &canvas_shortcut {
                        match event.state {
                            ShortcutState::Pressed => {
                                log::info!("Global shortcut pressed: Alt+Shift+A (canvas voice — start)");
                                let _ = app.emit("canvas-voice-start", ());
                            }
                            ShortcutState::Released => {
                                log::info!("Global shortcut released: Alt+Shift+A (canvas voice — stop)");
                                let _ = app.emit("canvas-voice-stop", ());
                            }
                        }
                        return;
                    }

                    // AI panel push-to-talk (F047, Alt+Shift+Q — replaces the old webview-level
                    // Ctrl+Space, which Windows can intercept as an IME toggle and swallow the
                    // release of). Registered at the OS level via this plugin instead, so it works
                    // regardless of webview focus/IME state, mirroring the canvas-voice shortcut above.
                    if shortcut == &voice_command_shortcut {
                        match event.state {
                            ShortcutState::Pressed => {
                                log::info!("Global shortcut pressed: Alt+Shift+Q (voice command — start)");
                                let _ = app.emit("voice-command-start", ());
                            }
                            ShortcutState::Released => {
                                log::info!("Global shortcut released: Alt+Shift+Q (voice command — stop)");
                                let _ = app.emit("voice-command-stop", ());
                            }
                        }
                        return;
                    }

                    // Global record start/stop toggle (Alt+Shift+E). Fires on the Pressed edge only.
                    // The renderer decides start-vs-stop from the current recording state and drives
                    // the exact same code paths as the on-screen record/stop button (I4).
                    if shortcut == &record_shortcut {
                        if let ShortcutState::Pressed = event.state {
                            log::info!("Global shortcut pressed: Alt+Shift+E (record toggle)");
                            let _ = app.emit("global-record-toggle", ());
                        }
                        return;
                    }

                    // Global quick-capture bar (Alt+Shift+N). Fires on the Pressed edge only. Opens
                    // (or dismisses) the frameless capture window. Run window creation on the main
                    // thread to satisfy the platform windowing requirements.
                    if shortcut == &quick_capture_shortcut {
                        if let ShortcutState::Pressed = event.state {
                            log::info!("Global shortcut pressed: Alt+Shift+N (quick capture)");
                            let app_for_main = app.clone();
                            let _ = app.run_on_main_thread(move || {
                                quick_capture::commands::open_or_toggle(&app_for_main);
                            });
                        }
                        return;
                    }

                    if let ShortcutState::Pressed = event.state {
                        if shortcut == &clipboard_shortcut {
                            log::info!("Global shortcut pressed: Alt+Shift+V (clipboard capture)");
                            let app_for_task = app.clone();
                            tauri::async_runtime::spawn(async move {
                                match clipboard::commands::read_clipboard_content(app_for_task).await {
                                    Ok(data) => log::info!("Clipboard captured via hotkey: {:?}", data.content_type),
                                    Err(e) => log::error!("Clipboard hotkey capture failed: {}", e),
                                }
                            });
                        } else if shortcut == &fullscreen_shortcut {
                            log::info!("Global shortcut pressed: Alt+Shift+S (region screenshot)");

                            // Self-healing guard: clear stale state from previous capture
                            if screenshot::capture::is_region_capture_in_progress() {
                                log::warn!("Region capture flag still set — clearing stale state");
                                screenshot::capture::clear_pre_captured();
                            }

                            let app_for_task = app.clone();
                            tauri::async_runtime::spawn(async move {
                                use tauri::Emitter as _;

                                match tokio::task::spawn_blocking(move || {
                                    screenshot::capture::pre_capture_screen()
                                })
                                .await
                                {
                                    Ok(Ok(result)) => {
                                        log::info!(
                                            "Pre-captured screen for region select: {}x{}",
                                            result.monitor_width,
                                            result.monitor_height,
                                        );

                                        // Bring window to foreground so the overlay can mount
                                        if let Some(win) = app_for_task.get_webview_window("main") {
                                            let _ = win.unminimize();
                                            let _ = win.show();
                                            let _ = win.set_focus();
                                        }

                                        let _ = app_for_task.emit(
                                            "screenshot-region-select",
                                            serde_json::json!({
                                                "monitor_width": result.monitor_width,
                                                "monitor_height": result.monitor_height,
                                                "annotate": false,
                                            }),
                                        );
                                    }
                                    Ok(Err(e)) => {
                                        log::error!("Pre-capture failed: {}", e);
                                        screenshot::capture::clear_pre_captured();
                                    }
                                    Err(e) => {
                                        log::error!("Pre-capture task panicked: {}", e);
                                        screenshot::capture::clear_pre_captured();
                                    }
                                }
                            });
                        } else if shortcut == &region_shortcut {
                            log::info!("Global shortcut pressed: Alt+Shift+R (annotate screenshot)");

                            // Self-healing guard: if a previous capture left the flag stuck
                            // (e.g. overlay failed to mount or user dismissed it unexpectedly),
                            // clear the stale state and allow a fresh capture.
                            if screenshot::capture::is_region_capture_in_progress() {
                                log::warn!("Region capture flag still set — clearing stale state");
                                screenshot::capture::clear_pre_captured();
                            }

                            // Pre-capture the screen, then emit dimensions only
                            // (frontend fetches JPEG preview via get_pre_capture_preview)
                            let app_for_task = app.clone();
                            tauri::async_runtime::spawn(async move {
                                use tauri::Emitter as _;

                                match tokio::task::spawn_blocking(move || {
                                    screenshot::capture::pre_capture_screen()
                                })
                                .await
                                {
                                    Ok(Ok(result)) => {
                                        log::info!(
                                            "Pre-captured screen for annotation: {}x{}",
                                            result.monitor_width,
                                            result.monitor_height,
                                        );

                                        // Bring window to foreground so the overlay can mount
                                        if let Some(win) = app_for_task.get_webview_window("main") {
                                            let _ = win.unminimize();
                                            let _ = win.show();
                                            let _ = win.set_focus();
                                        }

                                        let _ = app_for_task.emit(
                                            "screenshot-region-select",
                                            serde_json::json!({
                                                "monitor_width": result.monitor_width,
                                                "monitor_height": result.monitor_height,
                                                "annotate": true,
                                            }),
                                        );
                                    }
                                    Ok(Err(e)) => {
                                        log::error!("Pre-capture failed: {}", e);
                                        screenshot::capture::clear_pre_captured();
                                    }
                                    Err(e) => {
                                        log::error!("Pre-capture task panicked: {}", e);
                                        screenshot::capture::clear_pre_captured();
                                    }
                                }
                            });
                        }
                    }
                })
                .build()
        })
        .manage(whisper_engine::parallel_commands::ParallelProcessorState::new())
        .manage(Arc::new(RwLock::new(
            None::<notifications::manager::NotificationManager<tauri::Wry>>,
        )) as NotificationManagerState<tauri::Wry>)
        .manage(audio::init_system_audio_state())
        .manage(summary::summary_engine::ModelManagerState(Arc::new(tokio::sync::Mutex::new(None))))
        .manage(Arc::new(quick_capture::QuickCaptureState::new()))
        .setup(|_app| {
            // Migrate data from old Meetily paths to Tandem paths (runs once)
            migration::run_migration();

            // Quick capture (Alt+Shift+N): start the rolling clipboard watcher. It only records
            // while the feature is enabled and keeps its buffer memory-only (see quick_capture).
            {
                let qc_state = _app.state::<Arc<quick_capture::QuickCaptureState>>().inner().clone();
                quick_capture::commands::spawn_clipboard_watcher(qc_state);
            }

            log::info!("Application setup complete");

            // Initialize system tray
            if let Err(e) = tray::create_tray(_app.handle()) {
                log::error!("Failed to create system tray: {}", e);
            }

            // Global shortcuts are registered via .with_shortcuts() on the plugin builder
            log::info!("Global shortcuts registered via plugin builder (Alt+Shift+S, Alt+Shift+R, Alt+Shift+V, Alt+Shift+A, Alt+Shift+Q, Alt+Shift+E)");

            // Canvas: spawn + supervise the agent-whiteboard servers so the whiteboard (and its MCP
            // canvas server, for "Connect MCP") are reachable on localhost the moment Tandem launches
            // (no manual `pnpm dev`). Killed on exit (RunEvent::Exit).
            {
                let servers: Vec<_> = [
                    canvas::server::CanvasServerManager::locate_app(),
                    canvas::server::CanvasServerManager::locate_mcp(),
                ]
                .into_iter()
                .flatten()
                .inspect(|mgr| mgr.start())
                .collect();
                if servers.is_empty() {
                    log::warn!("Canvas servers not started (bundles not found) — canvas will be unavailable");
                }
                let _ = CANVAS_SERVERS.set(servers);
            }

            // Initialize notification system with proper defaults
            log::info!("Initializing notification system...");
            let app_for_notif = _app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let notif_state = app_for_notif.state::<NotificationManagerState<tauri::Wry>>();
                match notifications::commands::initialize_notification_manager(app_for_notif.clone()).await {
                    Ok(manager) => {
                        // Set default consent and permissions on first launch
                        if let Err(e) = manager.set_consent(true).await {
                            log::error!("Failed to set initial consent: {}", e);
                        }
                        if let Err(e) = manager.request_permission().await {
                            log::error!("Failed to request initial permission: {}", e);
                        }

                        // Store the initialized manager
                        let mut state_lock = notif_state.write().await;
                        *state_lock = Some(manager);
                        log::info!("Notification system initialized with default permissions");
                    }
                    Err(e) => {
                        log::error!("Failed to initialize notification manager: {}", e);
                    }
                }
            });

            // Set models directory to use app_data_dir (unified storage location)
            whisper_engine::commands::set_models_directory(&_app.handle());

            // Initialize Whisper engine on startup
            tauri::async_runtime::spawn(async {
                if let Err(e) = whisper_engine::commands::whisper_init().await {
                    log::error!("Failed to initialize Whisper engine on startup: {}", e);
                }
            });

            // Set Parakeet models directory
            parakeet_engine::commands::set_models_directory(&_app.handle());

            // Initialize Parakeet engine on startup
            tauri::async_runtime::spawn(async {
                if let Err(e) = parakeet_engine::commands::parakeet_init().await {
                    log::error!("Failed to initialize Parakeet engine on startup: {}", e);
                }
            });

            // Initialize ModelManager for summary engine (async, non-blocking)
            let app_handle_for_model_manager = _app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match summary::summary_engine::commands::init_model_manager_at_startup(&app_handle_for_model_manager).await {
                    Ok(_) => log::info!("ModelManager initialized successfully at startup"),
                    Err(e) => {
                        log::warn!("Failed to initialize ModelManager at startup: {}", e);
                        log::warn!("ModelManager will be lazy-initialized on first use");
                    }
                }
            });

            // Trigger system audio permission request on startup (similar to microphone permission)
            // #[cfg(target_os = "macos")]
            // {
            //     tauri::async_runtime::spawn(async {
            //         if let Err(e) = audio::permissions::trigger_system_audio_permission() {
            //             log::warn!("Failed to trigger system audio permission: {}", e);
            //         }
            //     });
            // }

            // Initialize database (handles first launch detection and conditional setup)
            tauri::async_runtime::block_on(async {
                database::setup::initialize_database_on_startup(&_app.handle()).await
            })
            .expect("Failed to initialize database");

            // Initialize bundled templates directory for dynamic template discovery
            log::info!("Initializing bundled templates directory...");
            if let Ok(resource_path) = _app.handle().path().resource_dir() {
                let templates_dir = resource_path.join("templates");
                log::info!("Setting bundled templates directory to: {:?}", templates_dir);
                summary::templates::set_bundled_templates_dir(templates_dir);
            } else {
                log::warn!("Failed to resolve resource directory for templates");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            is_recording,
            get_transcription_status,
            read_audio_file,
            save_transcript,
            copy_file,
            read_file_if_exists,
            delete_file,
            save_base64_file,
            relay_event,
            focus_main_window,
            notify_meeting_starting,
            list_whiteboards,
            analytics::commands::init_analytics,
            analytics::commands::disable_analytics,
            analytics::commands::track_event,
            analytics::commands::identify_user,
            analytics::commands::track_meeting_started,
            analytics::commands::track_recording_started,
            analytics::commands::track_recording_stopped,
            analytics::commands::track_meeting_deleted,
            analytics::commands::track_settings_changed,
            analytics::commands::track_feature_used,
            analytics::commands::is_analytics_enabled,
            analytics::commands::start_analytics_session,
            analytics::commands::end_analytics_session,
            analytics::commands::track_daily_active_user,
            analytics::commands::track_user_first_launch,
            analytics::commands::is_analytics_session_active,
            analytics::commands::track_summary_generation_started,
            analytics::commands::track_summary_generation_completed,
            analytics::commands::track_summary_regenerated,
            analytics::commands::track_model_changed,
            analytics::commands::track_custom_prompt_used,
            analytics::commands::track_meeting_ended,
            analytics::commands::track_analytics_enabled,
            analytics::commands::track_analytics_disabled,
            analytics::commands::track_analytics_transparency_viewed,
            whisper_engine::commands::whisper_init,
            whisper_engine::commands::whisper_get_available_models,
            whisper_engine::commands::whisper_load_model,
            whisper_engine::commands::whisper_get_current_model,
            whisper_engine::commands::whisper_is_model_loaded,
            whisper_engine::commands::whisper_has_available_models,
            whisper_engine::commands::whisper_validate_model_ready,
            whisper_engine::commands::whisper_transcribe_audio,
            whisper_engine::commands::whisper_get_models_directory,
            whisper_engine::commands::whisper_download_model,
            whisper_engine::commands::whisper_cancel_download,
            whisper_engine::commands::whisper_delete_corrupted_model,
            // Parakeet engine commands
            parakeet_engine::commands::parakeet_init,
            parakeet_engine::commands::parakeet_get_available_models,
            parakeet_engine::commands::parakeet_load_model,
            parakeet_engine::commands::parakeet_get_current_model,
            parakeet_engine::commands::parakeet_is_model_loaded,
            parakeet_engine::commands::parakeet_has_available_models,
            parakeet_engine::commands::parakeet_validate_model_ready,
            parakeet_engine::commands::parakeet_transcribe_audio,
            parakeet_engine::commands::parakeet_get_models_directory,
            parakeet_engine::commands::parakeet_download_model,
            parakeet_engine::commands::parakeet_retry_download,
            parakeet_engine::commands::parakeet_cancel_download,
            parakeet_engine::commands::parakeet_delete_corrupted_model,
            parakeet_engine::commands::open_parakeet_models_folder,
            // Parallel processing commands
            whisper_engine::parallel_commands::initialize_parallel_processor,
            whisper_engine::parallel_commands::start_parallel_processing,
            whisper_engine::parallel_commands::pause_parallel_processing,
            whisper_engine::parallel_commands::resume_parallel_processing,
            whisper_engine::parallel_commands::stop_parallel_processing,
            whisper_engine::parallel_commands::get_parallel_processing_status,
            whisper_engine::parallel_commands::get_system_resources,
            whisper_engine::parallel_commands::check_resource_constraints,
            whisper_engine::parallel_commands::calculate_optimal_workers,
            whisper_engine::parallel_commands::prepare_audio_chunks,
            whisper_engine::parallel_commands::test_parallel_processing_setup,
            get_audio_devices,
            trigger_microphone_permission,
            start_recording_with_devices,
            start_recording_with_devices_and_meeting,
            start_audio_level_monitoring,
            stop_audio_level_monitoring,
            is_audio_level_monitoring,
            // Recording pause/resume commands
            audio::recording_commands::pause_recording,
            audio::recording_commands::resume_recording,
            audio::recording_commands::is_recording_paused,
            audio::recording_commands::get_recording_state,
            audio::recording_commands::get_meeting_folder_path,
            audio::recording_commands::get_recordings_base_dir,
            // Reload sync commands (retrieve transcript history and meeting name)
            audio::recording_commands::get_transcript_history,
            audio::recording_commands::get_recording_meeting_name,
            // Device monitoring commands (AirPods/Bluetooth disconnect/reconnect)
            audio::recording_commands::poll_audio_device_events,
            audio::recording_commands::get_reconnection_status,
            audio::recording_commands::attempt_device_reconnect,
            // Playback device detection (Bluetooth warning)
            audio::recording_commands::get_active_audio_output,
            // Audio recovery commands (for transcript recovery feature)
            audio::incremental_saver::recover_audio_from_checkpoints,
            audio::incremental_saver::cleanup_checkpoints,
            audio::incremental_saver::has_audio_checkpoints,
            console_utils::show_console,
            console_utils::hide_console,
            console_utils::toggle_console,
            ollama::get_ollama_models,
            ollama::pull_ollama_model,
            ollama::delete_ollama_model,
            ollama::get_ollama_model_context,
            ollama::ollama_chat_json,
            openai::openai::get_openai_models,
            anthropic::anthropic::get_anthropic_models,
            groq::groq::get_groq_models,
            api::api_get_meetings,
            api::api_search_transcripts,
            api::api_get_profile,
            api::api_save_profile,
            api::api_update_profile,
            api::api_get_model_config,
            api::api_save_model_config,
            api::api_save_api_key,
            api::api_get_api_key,
            // api::api_get_auto_generate_setting,
            // api::api_save_auto_generate_setting,
            api::api_get_transcript_config,
            api::api_save_transcript_config,
            api::api_get_transcript_api_key,
            api::api_delete_meeting,
            api::api_get_meeting,
            api::api_get_meeting_metadata,
            api::api_get_meeting_transcripts,
            api::api_save_meeting_title,
            api::api_save_transcript,
            api::api_update_transcript_text,
            api::open_meeting_folder,
            api::test_backend_connection,
            api::debug_backend_connection,
            api::open_external_url,
            api::show_in_folder,
            api::copy_to_downloads,
            api::get_home_dir,
            api::open_folder,
            // Custom OpenAI commands
            api::api_save_custom_openai_config,
            api::api_get_custom_openai_config,
            api::api_test_custom_openai_connection,
            // Project management commands (Solo Mode)
            api::project_list,
            api::project_create,
            api::project_create_virtual,
            api::project_update,
            api::project_delete,
            api::project_import_scanned,
            api::project_scan_directory,
            api::project_pick_directory,
            // Client-folder discovery + clients-root setting (R2)
            api::get_clients_root,
            api::set_clients_root,
            api::list_client_folders,
            // Deferred meeting-folder relocation (R3)
            relocate_meeting_folder,
            // F061: session archival (virtual sub-projects)
            api::list_dir_file_names,
            api::archive_session_folder,
            // F055: session-aware HUD + branch stamping
            claude_sessions::get_git_branch,
            claude_sessions::list_claude_session_candidates,
            // Summary commands
            summary::api_process_transcript,
            summary::api_get_summary,
            summary::api_save_meeting_summary,
            summary::api_cancel_summary,
            // Template commands
            summary::api_list_templates,
            summary::api_get_template_details,
            summary::api_validate_template,
            // Built-in AI commands
            summary::summary_engine::builtin_ai_list_models,
            summary::summary_engine::builtin_ai_get_model_info,
            summary::summary_engine::builtin_ai_download_model,
            summary::summary_engine::builtin_ai_cancel_download,
            summary::summary_engine::builtin_ai_delete_model,
            summary::summary_engine::builtin_ai_is_model_ready,
            summary::summary_engine::builtin_ai_get_available_summary_model,
            summary::summary_engine::builtin_ai_get_recommended_model,
            openrouter::get_openrouter_models,
            audio::recording_preferences::get_recording_preferences,
            audio::recording_preferences::set_recording_preferences,
            audio::recording_preferences::get_default_recordings_folder_path,
            audio::recording_preferences::open_recordings_folder,
            audio::recording_preferences::select_recording_folder,
            audio::recording_preferences::get_available_audio_backends,
            audio::recording_preferences::get_current_audio_backend,
            audio::recording_preferences::set_audio_backend,
            audio::recording_preferences::get_audio_backend_info,
            // Language preference commands
            get_language_preference,
            set_language_preference,
            // Notification system commands
            notifications::commands::get_notification_settings,
            notifications::commands::set_notification_settings,
            notifications::commands::request_notification_permission,
            notifications::commands::show_notification,
            notifications::commands::show_test_notification,
            notifications::commands::is_dnd_active,
            notifications::commands::get_system_dnd_status,
            notifications::commands::set_manual_dnd,
            notifications::commands::set_notification_consent,
            notifications::commands::clear_notifications,
            notifications::commands::is_notification_system_ready,
            notifications::commands::initialize_notification_manager_manual,
            notifications::commands::test_notification_with_auto_consent,
            notifications::commands::get_notification_stats,
            // System audio capture commands
            audio::system_audio_commands::start_system_audio_capture_command,
            audio::system_audio_commands::list_system_audio_devices_command,
            audio::system_audio_commands::check_system_audio_permissions_command,
            audio::system_audio_commands::start_system_audio_monitoring,
            audio::system_audio_commands::stop_system_audio_monitoring,
            audio::system_audio_commands::get_system_audio_monitoring_status,
            // Screen Recording permission commands
            audio::permissions::check_screen_recording_permission_command,
            audio::permissions::request_screen_recording_permission_command,
            audio::permissions::trigger_system_audio_permission_command,
            // Screenshot capture commands
            screenshot::commands::take_screenshot,
            screenshot::commands::take_region_screenshot,
            screenshot::commands::capture_screen_preview,
            screenshot::commands::get_pre_capture_preview,
            screenshot::commands::crop_pre_captured_region,
            screenshot::commands::crop_pre_captured_preview,
            screenshot::commands::start_region_capture,
            screenshot::commands::cancel_region_capture,
            screenshot::commands::save_screenshots_json,
            screenshot::commands::load_screenshots_json,
            screenshot::commands::save_annotated_screenshot,
            screenshot::commands::set_active_solo_project,
            // Clipboard capture commands
            clipboard::commands::read_clipboard_content,
            clipboard::commands::save_clipboard_json,
            clipboard::commands::load_clipboard_json,
            // Database import commands
            database::commands::check_first_launch,
            database::commands::select_legacy_database_path,
            database::commands::detect_legacy_database,
            database::commands::check_default_legacy_database,
            database::commands::check_homebrew_database,
            database::commands::import_and_initialize_database,
            database::commands::initialize_fresh_database,
            // Database and Models path commands
            database::commands::get_database_directory,
            database::commands::open_database_folder,
            whisper_engine::commands::open_models_folder,
            // Onboarding commands
            onboarding::get_onboarding_status,
            onboarding::save_onboarding_status_cmd,
            onboarding::reset_onboarding_status_cmd,
            onboarding::complete_onboarding,
            // System settings commands
            #[cfg(target_os = "macos")]
            utils::open_system_settings,
            // Voice-driven canvas (hosts the agent-whiteboard app in a window)
            canvas::commands::canvas_open,
            canvas::commands::canvas_hide,
            canvas::commands::canvas_toggle,
            canvas::commands::canvas_is_open,
            canvas::commands::canvas_send_prompt,
            canvas::commands::canvas_transcribe_clip,
            canvas::commands::canvas_health_check,
            // Calendar (read-only ICS) commands
            calendar_ics::fetch_calendar_ics,
            api::api_get_calendar_config,
            api::api_save_calendar_config,
            // Quick capture (Alt+Shift+N)
            quick_capture::commands::quick_capture_open,
            quick_capture::commands::quick_capture_close,
            quick_capture::commands::get_quick_capture_clips,
            quick_capture::commands::set_quick_capture_enabled,
            quick_capture::commands::save_quick_capture,
            quick_capture::commands::quick_capture_send_to_ai,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                log::info!("Application exiting, cleaning up resources...");
                tauri::async_runtime::block_on(async {
                    // Kill the supervised whiteboard servers so no node process is orphaned.
                    if let Some(servers) = CANVAS_SERVERS.get() {
                        log::info!("Shutting down canvas servers...");
                        for mgr in servers {
                            mgr.shutdown().await;
                        }
                    }
                    // Clean up database connection and checkpoint WAL
                    if let Some(app_state) = _app_handle.try_state::<state::AppState>() {
                        log::info!("Starting database cleanup...");
                        if let Err(e) = app_state.db_manager.cleanup().await {
                            log::error!("Failed to cleanup database: {}", e);
                        } else {
                            log::info!("Database cleanup completed successfully");
                        }
                    } else {
                        log::warn!("AppState not available for database cleanup (likely first launch)");
                    }

                    // Clean up sidecar
                    log::info!("Cleaning up sidecar...");
                    if let Err(e) = summary::summary_engine::force_shutdown_sidecar().await {
                        log::error!("Failed to force shutdown sidecar: {}", e);
                    }
                });
                log::info!("Application cleanup complete");
            }
        });
}
