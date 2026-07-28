// audio/recording_commands.rs
//
// Slim Tauri command layer for recording functionality.
// Delegates to transcription and recording modules for actual implementation.

use anyhow::Result;
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::{
    parse_audio_device,
    default_input_device,   // Get default microphone
    default_output_device,  // Get default system audio
    RecordingManager,
    DeviceEvent,
    DeviceMonitorType,
    kws,                    // F047: Wake word detection
};

// Import transcription modules
use super::transcription::{
    self,
    reset_speech_detected_flag,
    ElevenLabsRealtimeSession,
    RealtimeEvent,
};

// Re-export TranscriptUpdate for backward compatibility
pub use super::transcription::TranscriptUpdate;

// ============================================================================
// GLOBAL STATE
// ============================================================================

// Simple recording state tracking. IS_RECORDING means "audio streams are open"
// (capturing). It is reserved atomically at the very top of every start path via
// compare_exchange so two near-simultaneous starts (on-screen button + hotkey +
// tray + handover auto-start) cannot both pass the guard and spawn duplicate
// pipelines. See try_reserve_recording_slot / RecordingStartGuard.
static IS_RECORDING: AtomicBool = AtomicBool::new(false);

// CLEANUP_IN_PROGRESS means "stop_recording is draining/saving" (streams already
// stopped, but the transcription task is still flushing and files are still being
// written). It decouples "capturing" from "draining": IS_RECORDING flips to false
// as soon as capture stops, while CLEANUP_IN_PROGRESS stays true until the final
// save completes. A start reservation is rejected while cleanup is in progress so a
// new recording cannot begin mid-drain, and a second concurrent stop is rejected so
// the model is not unloaded twice.
static CLEANUP_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

// The meeting folder currently being drained/saved by stop_recording. Set once the
// manager is taken out of RECORDING_MANAGER (so get_current_meeting_folder can no
// longer see it) and cleared when cleanup finishes. is_folder_recording_active reads
// this so a relocate of the folder is still refused while the final save writes into it.
static CLEANUP_FOLDER: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

/// RAII guard for the IS_RECORDING reservation made by `try_reserve_recording_slot`.
/// If a start path returns early (model validation, device resolution, or
/// manager.start_recording failure) the reservation is released on drop so the flag
/// never gets stuck true. On the success path the caller calls `disarm()` to keep the
/// reservation. This makes it impossible for an error branch to forget to reset the flag.
struct RecordingStartGuard {
    armed: bool,
}

impl RecordingStartGuard {
    /// Keep the reservation (recording started successfully): consumes the guard
    /// so Drop does not release IS_RECORDING.
    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for RecordingStartGuard {
    fn drop(&mut self) {
        if self.armed {
            IS_RECORDING.store(false, Ordering::SeqCst);
        }
    }
}

/// Atomically reserve the recording slot. Returns an armed guard on success, or an
/// error string if a recording is already in progress or a stop is still draining.
///
/// Ordering note: we reserve IS_RECORDING first (false -> true), then check
/// CLEANUP_IN_PROGRESS and roll back if a stop is mid-drain. Because stop sets
/// CLEANUP_IN_PROGRESS true before it clears IS_RECORDING, the window where
/// IS_RECORDING is false but cleanup is still running is fully covered by the rollback.
fn try_reserve_recording_slot() -> Result<RecordingStartGuard, String> {
    if IS_RECORDING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Recording already in progress".to_string());
    }
    if CLEANUP_IN_PROGRESS.load(Ordering::SeqCst) {
        // A stop is still draining/saving the previous recording; release the slot.
        IS_RECORDING.store(false, Ordering::SeqCst);
        return Err(
            "The previous recording is still finishing up. Please wait a moment and try again."
                .to_string(),
        );
    }
    Ok(RecordingStartGuard { armed: true })
}

/// What stop_recording should do, decided up front from the recording atomics and whether
/// the manager has actually been stored in RECORDING_MANAGER yet. Pure so the start-vs-stop
/// ordering invariant is unit-testable without a live pipeline.
#[derive(Debug, PartialEq, Eq)]
enum StopAction {
    /// Nothing is capturing (IS_RECORDING false): ignore this stop.
    NotRecording,
    /// A start reserved IS_RECORDING but has not populated the manager yet. Tearing down here
    /// would unload the model and clear IS_RECORDING, clobbering the in-flight start, so this
    /// stop must no-op and let the start finish.
    PendingStartNoop,
    /// A live recording exists (IS_RECORDING true and manager populated): proceed with the
    /// full graceful teardown.
    Teardown,
}

/// Decide stop_recording's action. `is_recording` is IS_RECORDING; `manager_populated` is
/// whether RECORDING_MANAGER currently holds a manager. The pending-start no-op depends on
/// BOTH being observed together: is_recording true with no manager means a start is still
/// initializing.
fn decide_stop_action(is_recording: bool, manager_populated: bool) -> StopAction {
    if !is_recording {
        StopAction::NotRecording
    } else if !manager_populated {
        StopAction::PendingStartNoop
    } else {
        StopAction::Teardown
    }
}

/// RAII guard for the CLEANUP_IN_PROGRESS flag reserved at the top of stop_recording.
/// Clears the flag on drop so every return path (including early error returns) leaves
/// cleanup state consistent.
struct CleanupGuard;

impl Drop for CleanupGuard {
    fn drop(&mut self) {
        if let Ok(mut cf) = CLEANUP_FOLDER.lock() {
            *cf = None;
        }
        CLEANUP_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

// Tracks when recording started (for screenshot elapsed-time calculation)
static RECORDING_START_TIME: Mutex<Option<std::time::Instant>> = Mutex::new(None);

// Tracks audio time (milliseconds) that has flowed through the VAD pipeline.
// Source of truth for transcript timestamps — screenshots/clipboard read this
// so their timestamps align with transcripts instead of drifting on wall-clock.
// AtomicU64 is used to allow lock-free reads from the audio hot path.
static AUDIO_ELAPSED_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Update the latest audio-elapsed time. Called by the audio pipeline as it processes audio.
pub fn update_audio_elapsed_secs(secs: f64) {
    let ms = (secs * 1000.0).max(0.0) as u64;
    AUDIO_ELAPSED_MS.store(ms, Ordering::Relaxed);
}

// C07: Global recording manager — uses tokio::sync::Mutex because it's held across .await points
static RECORDING_MANAGER: Lazy<tokio::sync::Mutex<Option<RecordingManager>>> =
    Lazy::new(|| tokio::sync::Mutex::new(None));
static TRANSCRIPTION_TASK: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);

/// B002: Single source of truth for "is recording".
/// Derives recording state from the RecordingManager itself rather than a
/// separate AtomicBool, so the UI/tray and the audio backend can never diverge.
/// The manager is only present in RECORDING_MANAGER after start_recording fully
/// succeeds and is taken back out on stop, so its presence plus its own
/// is_recording() flag is authoritative.
async fn recording_active() -> bool {
    RECORDING_MANAGER
        .lock()
        .await
        .as_ref()
        .map(|m| m.is_recording())
        .unwrap_or(false)
}

// Listener ID for proper cleanup - prevents microphone from staying active after recording stops
static TRANSCRIPT_LISTENER_ID: Mutex<Option<tauri::EventId>> = Mutex::new(None);

// ElevenLabs Scribe v2 Realtime session for the active recording (Some only when
// the realtime model is selected AND a key is present). Held across .await, so a
// tokio Mutex. Closed on stop. The bridge task maps the session's RealtimeEvent
// stream to Tauri events (transcript-partial / transcript-update / warning).
static REALTIME_SESSION: Lazy<tokio::sync::Mutex<Option<Arc<ElevenLabsRealtimeSession>>>> =
    Lazy::new(|| tokio::sync::Mutex::new(None));
static REALTIME_BRIDGE_TASK: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);

// ============================================================================
// PUBLIC TYPES
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct RecordingArgs {
    pub save_path: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct TranscriptionStatus {
    pub chunks_in_queue: usize,
    pub is_processing: bool,
    pub last_activity_ms: u64,
}

// ============================================================================
// F047: WAKE WORD DETECTION (KWS) SETUP
// ============================================================================

/// Spawn the OpenWakeWord wake word detector if models are available.
/// Gracefully skips if models not found (non-fatal — recording works without KWS).
fn spawn_kws_detector<R: Runtime>(app: &AppHandle<R>, manager: &RecordingManager) {
    let model_dir = kws::default_model_dir();
    let classifier = kws::default_classifier_filename();

    // Check if model directory and required files exist
    let mel_path = model_dir.join("melspectrogram.onnx");
    let emb_path = model_dir.join("embedding_model.onnx");
    let cls_path = model_dir.join(classifier);

    if !mel_path.exists() || !emb_path.exists() || !cls_path.exists() {
        info!(
            "KWS models not found in {} — wake word detection disabled for this session",
            model_dir.display()
        );
        return;
    }

    // Create the KWS channel
    let (kws_tx, kws_rx) = mpsc::unbounded_channel();

    // Set the sender on RecordingState so mic audio gets tapped
    manager.get_state().set_kws_sender(kws_tx);

    // Build the detector
    let app_clone = app.clone();
    match kws::WakeWordDetector::new(app_clone, kws_rx, &model_dir, classifier, None) {
        Ok(detector) => {
            // Spawn as a background tokio task — runs until kws_sender is dropped
            tokio::spawn(detector.run());
            info!("KWS wake word detector spawned (classifier: {})", classifier);
        }
        Err(e) => {
            warn!("Failed to initialize KWS detector: {} — wake word detection disabled", e);
            // Clean up the sender since detector won't consume it
            manager.get_state().clear_kws_sender();
        }
    }
}

// ============================================================================
// RECORDING COMMANDS
// ============================================================================

/// Read the configured transcript provider and pick the matching flush profile.
///
/// Cloud HTTP providers (ElevenLabs Scribe, Mistral) get a low-latency profile
/// so transcribed text isn't held back 12-30s while a large buffer fills; local
/// engines (Parakeet, Whisper) keep the large-context 12s profile. On any config
/// error we fall back to the conservative LOCAL profile.
async fn resolve_flush_profile<R: Runtime>(app: &AppHandle<R>) -> super::pipeline::FlushProfile {
    let provider = match crate::api::api::api_get_transcript_config(
        app.clone(),
        app.clone().state(),
        None,
    )
    .await
    {
        Ok(Some(config)) => config.provider,
        Ok(None) => String::new(),
        Err(e) => {
            warn!("⚠️ Could not read transcript config for flush profile: {} — using LOCAL", e);
            String::new()
        }
    };
    let profile = super::pipeline::FlushProfile::for_provider(&provider);
    info!("🎚️ Flush profile for provider '{}': min {:.1}s / gap {:.1}s / max-block {}",
          provider,
          profile.min_samples as f64 / 16000.0,
          profile.silence_gap_secs,
          if profile.max_block_secs.is_finite() {
              format!("{:.1}s", profile.max_block_secs)
          } else {
              "none".to_string()
          });
    profile
}

/// Wall-clock `HH:MM:SS` for a recording-relative audio offset.
///
/// `RECORDING_START_TIME` is monotonic (an `Instant`), so the recording's
/// wall-clock start is reconstructed as `now - start.elapsed()`; the segment's
/// display time is that plus its audio offset. Without a live recording (or if
/// the arithmetic would overflow) this degrades to the current time, which is the
/// old behaviour.
fn wall_clock_for_audio_time(audio_start_time: f64) -> String {
    let now = chrono::Local::now();
    let elapsed = RECORDING_START_TIME
        .lock()
        .ok()
        .and_then(|g| *g)
        .map(|start| start.elapsed().as_secs_f64());
    let stamp = match elapsed {
        Some(elapsed) if audio_start_time.is_finite() && audio_start_time >= 0.0 => {
            let back_secs = (elapsed - audio_start_time).max(0.0);
            chrono::Duration::try_milliseconds((back_secs * 1000.0) as i64)
                .and_then(|d| now.checked_sub_signed(d))
                .unwrap_or(now)
        }
        _ => now,
    };
    stamp.format("%H:%M:%S").to_string()
}

/// Bridge the realtime session's `RealtimeEvent` stream to Tauri events. Runs
/// until the session drops all event senders (on close/degrade). Keeps the
/// session free of Tauri generics and makes it unit-testable without a runtime.
fn spawn_realtime_bridge<R: Runtime>(
    app: AppHandle<R>,
    mut rx: mpsc::UnboundedReceiver<RealtimeEvent>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                RealtimeEvent::Partial {
                    source,
                    text,
                    session_seq,
                } => {
                    // NEW volatile-tail event (Phase 1 frontend layer drops stale seq).
                    let _ = app.emit(
                        "transcript-partial",
                        serde_json::json!({
                            "source": source,
                            "text": text,
                            "session_seq": session_seq,
                        }),
                    );
                }
                RealtimeEvent::Committed {
                    source,
                    text,
                    audio_start_time,
                    audio_end_time,
                    duration,
                } => {
                    // Existing commit event: same downstream persistence path as the
                    // batch worker (recording_commands transcript-update listener).
                    // Shares the worker's monotonic sequence_id space.
                    // Display time from the AUDIO clock, not arrival time. A
                    // commit can land up to ~36s after the words were spoken, and
                    // one commit fans out into several utterance segments, so
                    // arrival time would stamp a whole turn with one late,
                    // identical clock value. Derive the recording's wall-clock
                    // start from the monotonic start Instant and add the segment's
                    // audio offset. Falls back to now() before/after a recording.
                    let update = TranscriptUpdate {
                        text,
                        timestamp: wall_clock_for_audio_time(audio_start_time),
                        source,
                        sequence_id: transcription::next_sequence_id(),
                        chunk_start_time: audio_start_time,
                        is_partial: false,
                        // Scribe returns no chunk-level confidence; use the same
                        // neutral default the worker applies for such providers.
                        confidence: 0.85,
                        audio_start_time,
                        audio_end_time,
                        duration,
                    };
                    let _ = app.emit("transcript-update", &update);
                }
                RealtimeEvent::Warning { message } => {
                    let _ = app.emit("transcription-warning", message);
                }
            }
        }
        info!("🎧 Realtime bridge task ended (session closed)");
    })
}

/// If the configured provider+model select the realtime engine and an ElevenLabs
/// API key is present, create the session + bridge and return it for the pipeline
/// tap. Returns None (falling back to the batch path) on any missing prerequisite.
async fn maybe_start_realtime_session<R: Runtime>(
    app: &AppHandle<R>,
) -> Option<Arc<ElevenLabsRealtimeSession>> {
    let config = match crate::api::api::api_get_transcript_config(
        app.clone(),
        app.clone().state(),
        None,
    )
    .await
    {
        Ok(Some(c)) => c,
        _ => return None,
    };
    if !transcription::is_realtime_model(&config.provider, &config.model) {
        return None;
    }

    // Defensive: close any lingering session from a prior recording before starting
    // a new one, so stale WS keepalives can't accumulate.
    teardown_realtime_session().await;

    let pool = app.state::<crate::state::AppState>().db_manager.pool().clone();
    let api_key = match crate::database::repositories::setting::SettingsRepository::get_transcript_api_key(
        &pool, "elevenLabs",
    )
    .await
    {
        Ok(Some(k)) if !k.trim().is_empty() => k,
        _ => {
            warn!("🎧 Realtime model selected but no ElevenLabs API key — using batch path");
            return None;
        }
    };

    info!("🎧 Starting ElevenLabs Scribe v2 Realtime session");
    let (event_tx, event_rx) = mpsc::unbounded_channel::<RealtimeEvent>();
    // Language left as auto-detect (None); Phase 3 can seed from the picker.
    let session = ElevenLabsRealtimeSession::start(api_key, None, event_tx);

    let bridge = spawn_realtime_bridge(app.clone(), event_rx);
    {
        let mut slot = REALTIME_BRIDGE_TASK
            .lock()
            .map_err(|e| warn!("realtime bridge lock poisoned: {e}"))
            .ok();
        if let Some(ref mut s) = slot {
            **s = Some(bridge);
        }
    }
    *REALTIME_SESSION.lock().await = Some(session.clone());
    Some(session)
}

/// How long the staged stop waits for the finalize commits' replies before
/// falling back to the batch flush of the remaining shadow windows. Long enough
/// for a slow-network round trip, short enough not to stall the stop UI.
const REALTIME_FINALIZE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Close and clear the active realtime session + bridge (called on stop). Shuts
/// the WS connections down without sending any commit of its own (the staged stop
/// already had its finalize chance). Safe to call when none is active, and safe
/// to call without a prior `begin_shutdown` (close_all sets the flag itself as a
/// backstop).
async fn teardown_realtime_session() {
    let session = { REALTIME_SESSION.lock().await.take() };
    if let Some(session) = session {
        info!("🎧 Closing realtime session");
        // Dropping this Arc (and the session's own senders when its stream tasks
        // end) closes the event channel, which is what lets the bridge drain and
        // exit rather than being cut off mid-queue.
        session.close_all().await;
    }
    if let Some(bridge) = REALTIME_BRIDGE_TASK
        .lock()
        .ok()
        .and_then(|mut g| g.take())
    {
        // Let the bridge DRAIN: aborting it immediately discards events that were
        // already emitted and are still sitting in the channel, silently losing
        // transcript text that had been produced successfully. Only abort if it
        // somehow fails to finish in time.
        match tokio::time::timeout(std::time::Duration::from_millis(1500), bridge).await {
            Ok(_) => info!("🎧 Realtime bridge drained cleanly"),
            Err(_) => warn!("🎧 Realtime bridge did not drain within 1.5s"),
        }
    }
}

/// Start recording with default devices
pub async fn start_recording<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    start_recording_with_meeting_name(app, None, None).await
}

/// Start recording with default devices and optional meeting name.
/// `meeting_base_dir` (R3): when Some, the meeting folder is created DATE-LED directly under this
/// directory (a known project's `.tandem`) instead of the platform default recordings folder.
pub async fn start_recording_with_meeting_name<R: Runtime>(
    app: AppHandle<R>,
    meeting_name: Option<String>,
    meeting_base_dir: Option<String>,
) -> Result<(), String> {
    info!(
        "Starting recording with default devices, meeting: {:?}",
        meeting_name
    );

    // Atomically reserve the recording slot BEFORE any awaits. This closes the
    // TOCTOU window where two near-simultaneous starts both read IS_RECORDING=false
    // and each spawned a full audio pipeline (B017). The guard releases the slot on
    // any early-return error path below; it is disarmed only once recording is live.
    // (This reservation supersedes the plain recording_active() pre-check: the atomics
    // are the write-side claim, while recording_active() stays the read-side single
    // source of truth for status queries — B002.)
    let start_guard = try_reserve_recording_slot()?;

    // Validate that transcription models are available before starting recording
    info!("🔍 Validating transcription model availability before starting recording...");
    if let Err(validation_error) = transcription::validate_transcription_model_ready(&app).await {
        error!("Model validation failed: {}", validation_error);

        // Emit error event for frontend - actionable: false to show toast instead of modal
        // (download progress is already shown in top-right toast)
        let _ = app.emit("transcription-error", serde_json::json!({
            "error": validation_error,
            "userMessage": "Recording cannot start: Transcription model is still downloading. Please wait for the download to complete.",
            "actionable": false
        }));

        return Err(validation_error);
    }
    info!("✅ Transcription model validation passed");

    // Async-first approach - no more blocking operations!
    info!("🚀 Starting async recording initialization");

    // Create new recording manager
    let mut manager = RecordingManager::new();

    // Load recording preferences to get auto_save AND device preferences
    let (auto_save, preferred_mic_name, preferred_system_name) =
        match super::recording_preferences::load_recording_preferences(&app).await {
            Ok(prefs) => {
                info!("📋 Loaded recording preferences: auto_save={}, preferred_mic={:?}, preferred_system={:?}",
                      prefs.auto_save, prefs.preferred_mic_device, prefs.preferred_system_device);
                (prefs.auto_save, prefs.preferred_mic_device, prefs.preferred_system_device)
            }
            Err(e) => {
                warn!("Failed to load recording preferences, using defaults: {}", e);
                (true, None, None)
            }
        };

    // ============================================================================
    // MICROPHONE DEVICE RESOLUTION: Preference → Default → Error
    // ============================================================================
    let microphone_device = match preferred_mic_name {
        Some(pref_name) => {
            info!("🎤 Attempting to use preferred microphone: '{}'", pref_name);
            match parse_audio_device(&pref_name) {
                Ok(device) => {
                    info!("✅ Using preferred microphone: '{}'", device.name);
                    Some(Arc::new(device))
                }
                Err(e) => {
                    warn!("⚠️ Preferred microphone '{}' not available: {}", pref_name, e);
                    warn!("   Falling back to system default microphone...");
                    match default_input_device() {
                        Ok(device) => {
                            info!("✅ Using default microphone: '{}'", device.name);
                            Some(Arc::new(device))
                        }
                        Err(default_err) => {
                            error!("❌ No microphone available (preferred and default both failed)");
                            return Err(format!(
                                "No microphone device available. Preferred device '{}' not found, and default microphone unavailable: {}",
                                pref_name, default_err
                            ));
                        }
                    }
                }
            }
        }
        None => {
            info!("🎤 No microphone preference set, using system default");
            match default_input_device() {
                Ok(device) => {
                    info!("✅ Using default microphone: '{}'", device.name);
                    Some(Arc::new(device))
                }
                Err(e) => {
                    error!("❌ No default microphone available");
                    return Err(format!("No microphone device available: {}", e));
                }
            }
        }
    };

    // ============================================================================
    // SYSTEM AUDIO DEVICE RESOLUTION: Preference → Default → None (optional)
    // ============================================================================
    let system_device = match preferred_system_name {
        Some(pref_name) => {
            info!("🔊 Attempting to use preferred system audio: '{}'", pref_name);
            match parse_audio_device(&pref_name) {
                Ok(device) => {
                    info!("✅ Using preferred system audio: '{}'", device.name);
                    Some(Arc::new(device))
                }
                Err(e) => {
                    warn!("⚠️ Preferred system audio '{}' not available: {}", pref_name, e);
                    warn!("   Falling back to system default...");
                    match default_output_device() {
                        Ok(device) => {
                            info!("✅ Using default system audio: '{}'", device.name);
                            Some(Arc::new(device))
                        }
                        Err(default_err) => {
                            warn!("⚠️ No system audio available (preferred and default both failed): {}", default_err);
                            warn!("   Recording will continue with microphone only");
                            None // System audio is optional
                        }
                    }
                }
            }
        }
        None => {
            info!("🔊 No system audio preference set, using system default");
            match default_output_device() {
                Ok(device) => {
                    info!("✅ Using default system audio: '{}'", device.name);
                    Some(Arc::new(device))
                }
                Err(e) => {
                    warn!("⚠️ No default system audio available: {}", e);
                    warn!("   Recording will continue with microphone only");
                    None // System audio is optional
                }
            }
        }
    };

    // Always ensure a meeting name is set so incremental saver initializes
    let effective_meeting_name = meeting_name.clone().unwrap_or_else(|| {
        // Example: Meeting 2025-10-03_08-25-23
        let now = chrono::Local::now();
        format!(
            "Meeting {}",
            now.format("%Y-%m-%d_%H-%M-%S")
        )
    });
    manager.set_meeting_name(Some(effective_meeting_name));

    // R3: file directly under the seeded project's .tandem if provided.
    if let Some(base) = meeting_base_dir.as_ref() {
        manager.set_base_folder_override(Some(std::path::PathBuf::from(base)));
    }

    // Set up error callback
    let app_for_error = app.clone();
    manager.set_error_callback(move |error| {
        let _ = app_for_error.emit("recording-error", error.user_message());
    });

    // Select the provider-aware flush profile: cloud HTTP providers (ElevenLabs
    // Scribe / Mistral) get low-latency flushing so text isn't delayed 12-30s;
    // local engines (Parakeet / Whisper) keep the large-context 12s profile.
    let flush_profile = resolve_flush_profile(&app).await;

    // If the realtime model is selected (+ key present), start the streaming
    // session; the pipeline taps it live and uses the batch path only if it
    // degrades (plan D2/D5). None -> unchanged batch/local behavior.
    let realtime_session = maybe_start_realtime_session(&app).await;

    // Start recording with resolved devices (replaces start_recording_with_defaults_and_auto_save call)
    let transcription_receiver = manager
        .start_recording(microphone_device, system_device, auto_save, flush_profile, realtime_session)
        .await
        .map_err(|e| format!("Failed to start recording: {}", e))?;

    // F047: Spawn wake word detector (gracefully skips if models not found)
    spawn_kws_detector(&app, &manager);

    // Store the manager globally to keep it alive
    {
        let mut global_manager = RECORDING_MANAGER.lock().await;
        *global_manager = Some(manager);
    }

    // Set start time and reset speech detection flag. IS_RECORDING was already
    // reserved at the top via try_reserve_recording_slot (no late store needed), and the
    // manager is now stored so recording_active() also reports recording.
    info!("🔍 Recording live (manager stored), resetting SPEECH_DETECTED_EMITTED");
    if let Ok(mut start_time) = RECORDING_START_TIME.lock() {
        *start_time = Some(std::time::Instant::now());
    }
    AUDIO_ELAPSED_MS.store(0, Ordering::Relaxed);
    reset_speech_detected_flag(); // Reset for new recording session

    // Start optimized parallel transcription task and store handle
    let task_handle = transcription::start_transcription_task(app.clone(), transcription_receiver);
    {
        let mut global_task = TRANSCRIPTION_TASK.lock().map_err(|e| format!("Failed to lock transcription task: {e}"))?;
        *global_task = Some(task_handle);
    }

    // CRITICAL: Listen for transcript-update events and save to recording manager
    // This enables transcript history persistence for page reload sync
    // Store listener ID for cleanup during stop_recording to ensure microphone is released
    {
        use tauri::Listener;
        let listener_id = app.listen("transcript-update", move |event: tauri::Event| {
            // Parse the transcript update from the event payload
            if let Ok(update) = serde_json::from_str::<TranscriptUpdate>(event.payload()) {
                // Create structured transcript segment
                let segment = crate::audio::recording_saver::TranscriptSegment {
                    id: format!("seg_{}", update.sequence_id),
                    text: update.text.clone(),
                    audio_start_time: update.audio_start_time,
                    audio_end_time: update.audio_end_time,
                    duration: update.duration,
                    display_time: update.timestamp.clone(), // Use wall-clock timestamp for display
                    confidence: update.confidence,
                    sequence_id: update.sequence_id,
                    source: update.source.clone(),
                };

                // Save to recording manager
                if let Ok(manager_guard) = RECORDING_MANAGER.try_lock() {
                    if let Some(manager) = manager_guard.as_ref() {
                        manager.add_transcript_segment(segment);
                    }
                }
            }
        });
        let mut global_listener = TRANSCRIPT_LISTENER_ID.lock().map_err(|e| format!("Failed to lock transcript listener: {e}"))?;
        // B017: if start_recording is called twice without an intervening stop_recording,
        // unlisten any listener left over from the prior start before overwriting the stored
        // id. Otherwise the stale listener keeps receiving transcript-update events and saving
        // duplicate segments forever (leaked listener + memory bloat).
        if let Some(previous_id) = global_listener.take() {
            app.unlisten(previous_id);
            info!("⚠️ Removed stale transcript-update listener from a prior start_recording");
        }
        *global_listener = Some(listener_id);
        info!("✅ Transcript-update event listener registered for history persistence");
    }

    // Recording is fully live: keep the IS_RECORDING reservation instead of releasing
    // it when the guard drops at end of scope.
    start_guard.disarm();

    // Emit success event
    app.emit("recording-started", serde_json::json!({
        "message": "Recording started successfully with parallel processing",
        "devices": ["Default Microphone", "Default System Audio"],
        "workers": 3
    })).map_err(|e| e.to_string())?;

    // Update tray menu to reflect recording state
    crate::tray::update_tray_menu(&app);

    info!("✅ Recording started successfully with async-first approach");

    Ok(())
}

/// Start recording with specific devices
pub async fn start_recording_with_devices<R: Runtime>(
    app: AppHandle<R>,
    mic_device_name: Option<String>,
    system_device_name: Option<String>,
) -> Result<(), String> {
    start_recording_with_devices_and_meeting(app, mic_device_name, system_device_name, None, None).await
}

/// Start recording with specific devices and optional meeting name.
/// `meeting_base_dir` (R3): see `start_recording_with_meeting_name`.
pub async fn start_recording_with_devices_and_meeting<R: Runtime>(
    app: AppHandle<R>,
    mic_device_name: Option<String>,
    system_device_name: Option<String>,
    meeting_name: Option<String>,
    meeting_base_dir: Option<String>,
) -> Result<(), String> {
    info!(
        "Starting recording with specific devices: mic={:?}, system={:?}, meeting={:?}",
        mic_device_name, system_device_name, meeting_name
    );

    // Atomically reserve the recording slot BEFORE any awaits (see the default-device
    // path for the full rationale). Closes the TOCTOU window that let two starts both
    // spawn a pipeline (B017); guard releases the slot on any early error return.
    let start_guard = try_reserve_recording_slot()?;

    // Validate that transcription models are available before starting recording
    info!("🔍 Validating transcription model availability before starting recording...");
    if let Err(validation_error) = transcription::validate_transcription_model_ready(&app).await {
        error!("Model validation failed: {}", validation_error);

        // Emit error event for frontend - actionable: false to show toast instead of modal
        // (download progress is already shown in top-right toast)
        let _ = app.emit("transcription-error", serde_json::json!({
            "error": validation_error,
            "userMessage": "Recording cannot start: Transcription model is still downloading. Please wait for the download to complete.",
            "actionable": false
        }));

        return Err(validation_error);
    }
    info!("✅ Transcription model validation passed");

    // Parse devices
    let mic_device = if let Some(ref name) = mic_device_name {
        Some(Arc::new(parse_audio_device(name).map_err(|e| {
            format!("Invalid microphone device '{}': {}", name, e)
        })?))
    } else {
        None
    };

    let system_device = if let Some(ref name) = system_device_name {
        Some(Arc::new(parse_audio_device(name).map_err(|e| {
            format!("Invalid system device '{}': {}", name, e)
        })?))
    } else {
        None
    };

    // Async-first approach for custom devices - no more blocking operations!
    info!("🚀 Starting async recording initialization with custom devices");

    // Create new recording manager
    let mut manager = RecordingManager::new();

    // Load recording preferences to check auto_save setting
    let auto_save = match super::recording_preferences::load_recording_preferences(&app).await {
        Ok(prefs) => {
            info!("📋 Loaded recording preferences: auto_save={}", prefs.auto_save);
            prefs.auto_save
        }
        Err(e) => {
            warn!("Failed to load recording preferences, defaulting to auto_save=true: {}", e);
            true // Default to saving if preferences can't be loaded
        }
    };

    // Always ensure a meeting name is set so incremental saver initializes
    let effective_meeting_name = meeting_name.clone().unwrap_or_else(|| {
        let now = chrono::Local::now();
        format!(
            "Meeting {}",
            now.format("%Y-%m-%d_%H-%M-%S")
        )
    });
    manager.set_meeting_name(Some(effective_meeting_name));

    // R3: file directly under the seeded project's .tandem if provided.
    if let Some(base) = meeting_base_dir.as_ref() {
        manager.set_base_folder_override(Some(std::path::PathBuf::from(base)));
    }

    // Set up error callback
    let app_for_error = app.clone();
    manager.set_error_callback(move |error| {
        let _ = app_for_error.emit("recording-error", error.user_message());
    });

    // Provider-aware flush profile (see resolve_flush_profile).
    let flush_profile = resolve_flush_profile(&app).await;

    // Realtime streaming session (None unless the realtime model + key are set).
    let realtime_session = maybe_start_realtime_session(&app).await;

    // Start recording with specified devices and auto_save setting
    let transcription_receiver = manager
        .start_recording(mic_device, system_device, auto_save, flush_profile, realtime_session)
        .await
        .map_err(|e| format!("Failed to start recording: {}", e))?;

    // F047: Spawn wake word detector (gracefully skips if models not found)
    spawn_kws_detector(&app, &manager);

    // Store the manager globally to keep it alive
    {
        let mut global_manager = RECORDING_MANAGER.lock().await;
        *global_manager = Some(manager);
    }

    // Set start time and reset speech detection flag. IS_RECORDING was already
    // reserved at the top via try_reserve_recording_slot (no late store needed), and the
    // manager is now stored so recording_active() also reports recording.
    info!("🔍 Recording live (manager stored), resetting SPEECH_DETECTED_EMITTED");
    if let Ok(mut start_time) = RECORDING_START_TIME.lock() {
        *start_time = Some(std::time::Instant::now());
    }
    AUDIO_ELAPSED_MS.store(0, Ordering::Relaxed);
    reset_speech_detected_flag(); // Reset for new recording session

    // Start optimized parallel transcription task and store handle
    let task_handle = transcription::start_transcription_task(app.clone(), transcription_receiver);
    {
        let mut global_task = TRANSCRIPTION_TASK.lock().map_err(|e| format!("Failed to lock transcription task: {e}"))?;
        *global_task = Some(task_handle);
    }

    // CRITICAL: Listen for transcript-update events and save to recording manager
    // This enables transcript history persistence for page reload sync
    // Store listener ID for cleanup during stop_recording to ensure microphone is released
    {
        use tauri::Listener;
        let listener_id = app.listen("transcript-update", move |event: tauri::Event| {
            // Parse the transcript update from the event payload
            if let Ok(update) = serde_json::from_str::<TranscriptUpdate>(event.payload()) {
                // Create structured transcript segment
                let segment = crate::audio::recording_saver::TranscriptSegment {
                    id: format!("seg_{}", update.sequence_id),
                    text: update.text.clone(),
                    audio_start_time: update.audio_start_time,
                    audio_end_time: update.audio_end_time,
                    duration: update.duration,
                    display_time: update.timestamp.clone(), // Use wall-clock timestamp for display
                    confidence: update.confidence,
                    sequence_id: update.sequence_id,
                    source: update.source.clone(),
                };

                // Save to recording manager
                if let Ok(manager_guard) = RECORDING_MANAGER.try_lock() {
                    if let Some(manager) = manager_guard.as_ref() {
                        manager.add_transcript_segment(segment);
                    }
                }
            }
        });
        let mut global_listener = TRANSCRIPT_LISTENER_ID.lock().map_err(|e| format!("Failed to lock transcript listener: {e}"))?;
        // B017: if start_recording is called twice without an intervening stop_recording,
        // unlisten any listener left over from the prior start before overwriting the stored
        // id. Otherwise the stale listener keeps receiving transcript-update events and saving
        // duplicate segments forever (leaked listener + memory bloat).
        if let Some(previous_id) = global_listener.take() {
            app.unlisten(previous_id);
            info!("⚠️ Removed stale transcript-update listener from a prior start_recording");
        }
        *global_listener = Some(listener_id);
        info!("✅ Transcript-update event listener registered for history persistence");
    }

    // Recording is fully live: keep the IS_RECORDING reservation.
    start_guard.disarm();

    // Emit success event
    app.emit("recording-started", serde_json::json!({
        "message": "Recording started with custom devices and parallel processing",
        "devices": [
            mic_device_name.unwrap_or_else(|| "Default Microphone".to_string()),
            system_device_name.unwrap_or_else(|| "Default System Audio".to_string())
        ],
        "workers": 3
    })).map_err(|e| e.to_string())?;

    // Update tray menu to reflect recording state
    crate::tray::update_tray_menu(&app);

    info!("✅ Recording started with custom devices using async-first approach");

    Ok(())
}

/// Stop recording with optimized graceful shutdown ensuring NO transcript chunks are lost
pub async fn stop_recording<R: Runtime>(
    app: AppHandle<R>,
    _args: RecordingArgs,
) -> Result<(), String> {
    info!(
        "🛑 Starting optimized recording shutdown - ensuring ALL transcript chunks are preserved"
    );

    // Step 0: decide what this stop should do. IS_RECORDING is reserved (set true) at the
    // very top of a start path (try_reserve_recording_slot), several .await points BEFORE the
    // manager is stored in RECORDING_MANAGER (model validation, preference load, flush-profile
    // resolution, manager.start_recording). A stop landing in that window sees IS_RECORDING
    // true but no manager to tear down. Tearing down anyway would unload the model and clear
    // IS_RECORDING, clobbering the in-flight start's reservation: the start would then go live
    // (streams open, task running, listener registered, manager in the global) while
    // is_recording() reports false forever, making that recording unstoppable and letting a
    // later Start spawn a second full pipeline (B017). decide_stop_action encodes this: a
    // pending start is a no-op, and the manager is read before reserving cleanup so the no-op
    // path never touches CLEANUP_IN_PROGRESS.
    let manager_populated = RECORDING_MANAGER.lock().await.is_some();
    match decide_stop_action(IS_RECORDING.load(Ordering::SeqCst), manager_populated) {
        StopAction::NotRecording => {
            info!("Recording was not active");
            return Ok(());
        }
        StopAction::PendingStartNoop => {
            info!(
                "🛈 Stop received while a start is still initializing (manager not yet populated) - no-op, leaving the in-flight start's reservation intact"
            );
            return Ok(());
        }
        StopAction::Teardown => {}
    }

    // Reserve the cleanup slot. If a stop is already draining/saving, a second
    // concurrent stop (hotkey/tray toggle during the drain) is rejected here instead
    // of unloading the transcription model twice. The guard clears CLEANUP_IN_PROGRESS
    // on every return path below, and start reservations are rejected while it is set.
    // Any stop that wins this CAS holds cleanup exclusively through the final save, and the
    // manager is only take()n out of the global after that point, so once Teardown is chosen
    // the manager stays populated until this same call removes it (a concurrent stop loses
    // the CAS and returns above).
    if CLEANUP_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        info!("Recording stop already in progress - ignoring redundant stop");
        return Ok(());
    }
    let _cleanup_guard = CleanupGuard;

    // Emit shutdown progress to frontend
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "stopping_audio",
            "message": "Stopping audio capture...",
            "progress": 20
        }),
    );

    // Step 0: STAGED REALTIME STOP.
    //
    //   (a) ask both sockets for a FINALIZE commit and wait, bounded, for its
    //       committed reply. The scheduler only sends one from OUTSIDE the
    //       auto-commit danger band and with real audio outstanding, so this is
    //       never the mid-band commit that stalls the session. When it does fire
    //       the tail is transcribed by the accurate WS path, which is what the
    //       4.68% harness configuration did at clip end;
    //   (b) then suppress further emission. From here the pipeline's flush of the
    //       remaining shadow windows owns whatever is left, so a late reply must
    //       not also be emitted. Because the shadow clear is WINDOWED and driven
    //       by what the finalize commit actually covered, the two paths cannot
    //       overlap: emitted commits remove exactly their own windows.
    //
    // Both steps run before the capture force-flush below. The sockets themselves
    // are closed later, in teardown_realtime_session().
    {
        let session = { REALTIME_SESSION.lock().await.clone() };
        if let Some(session) = session {
            info!("🎧 Realtime session: sending finalize commits and waiting for replies");
            session.finalize_all(REALTIME_FINALIZE_TIMEOUT).await;
            info!("🎧 Realtime session entering shutdown (suppressing further transcript events)");
            session.begin_shutdown();
        }
    }

    // Step 1: Stop audio capture immediately (no more new chunks).
    // IMPORTANT: the manager stays in the global RECORDING_MANAGER (we do NOT take() it
    // here). The transcript-update listener writes tail segments produced during the
    // post-stop drain via RECORDING_MANAGER.try_lock(); if the manager were removed now,
    // those final force-flush segments would never reach transcripts.json (B018). The
    // manager is taken out only after the drain completes, just before the final save.
    {
        let mut global_manager = RECORDING_MANAGER.lock().await;
        if let Some(manager) = global_manager.as_mut() {
            // Use FORCE FLUSH to immediately process all accumulated audio - eliminates 30s delay!
            info!("🚀 Using FORCE FLUSH to eliminate pipeline accumulation delays");
            match manager.stop_streams_and_force_flush().await {
                Ok(_) => {
                    info!("✅ Audio streams stopped successfully - no more chunks will be created");
                }
                Err(e) => {
                    error!("❌ Failed to stop audio streams: {}", e);
                    return Err(format!("Failed to stop audio streams: {}", e));
                }
            }
        } else {
            // Unreachable in practice: decide_stop_action only returns Teardown when the
            // manager was populated, and the winning stop holds CLEANUP_IN_PROGRESS through
            // the take() below so nothing can remove it in between. Defensive: if the manager
            // is somehow gone, do NOT fall through to unload the model / clear IS_RECORDING
            // (that is exactly the start-vs-stop clobber we guard against) - bail out.
            warn!("No recording manager found to stop - aborting teardown to avoid clobbering state");
            return Ok(());
        }
    }

    // Close the realtime streaming session (if any). Sends NO commit: the tail was
    // already handed to the batch path by the force-flush above (the shadow buffer
    // holds everything the server never confirmed), and a commit here could land
    // inside the server's auto-commit danger band and stall the session.
    teardown_realtime_session().await;

    // Capture has stopped: flip IS_RECORDING to false immediately so is_recording()/tray
    // reflect "not capturing". CLEANUP_IN_PROGRESS stays true through the drain/save below,
    // which continues to reject new starts and is consulted by is_folder_recording_active.
    info!("🔍 Capture stopped - setting IS_RECORDING to false (cleanup still in progress)");
    IS_RECORDING.store(false, Ordering::SeqCst);
    if let Ok(mut start_time) = RECORDING_START_TIME.lock() {
        *start_time = None;
    }
    AUDIO_ELAPSED_MS.store(0, Ordering::Relaxed);

    // NOTE: the transcript-update listener is intentionally NOT removed here. It must stay
    // registered through the drain below so the final force-flush transcript segments are
    // still written into the manager (and transcripts.json). It is unlistened after the drain.

    // Step 2: Signal transcription workers to finish processing ALL queued chunks
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "processing_transcripts",
            "message": "Processing remaining transcript chunks...",
            "progress": 40
        }),
    );

    // Wait for transcription task with enhanced progress monitoring (NO TIMEOUT - we must process all chunks)
    let transcription_task = {
        let mut global_task = TRANSCRIPTION_TASK.lock().map_err(|e| format!("Failed to lock transcription task: {e}"))?;
        global_task.take()
    };

    if let Some(task_handle) = transcription_task {
        info!("⏳ Waiting for ALL transcription chunks to be processed (no timeout - preserving every chunk)");

        // Enhanced progress monitoring during shutdown.
        // A watch channel lets the progress loop exit promptly once transcription
        // finishes, instead of relying solely on the outer .abort() below.
        let progress_app = app.clone();
        let (done_tx, mut done_rx) = tokio::sync::watch::channel(false);
        let progress_task = tokio::spawn(async move {
            let last_update = std::time::Instant::now();

            loop {
                tokio::select! {
                    _ = tokio::time::sleep(tokio::time::Duration::from_millis(500)) => {
                        // Emit periodic progress updates during shutdown
                        let elapsed = last_update.elapsed().as_secs();
                        let _ = progress_app.emit(
                            "recording-shutdown-progress",
                            serde_json::json!({
                                "stage": "processing_transcripts",
                                "message": format!("Processing transcripts... ({}s elapsed)", elapsed),
                                "progress": 40,
                                "detailed": true,
                                "elapsed_seconds": elapsed
                            }),
                        );
                    }
                    // Exit as soon as transcription is done (success, error, or timeout),
                    // or if the sender is dropped, so no stale progress events leak out.
                    _ = done_rx.changed() => {
                        break;
                    }
                }
            }
        });

        // Wait up to 10 minutes for transcription completion to prevent indefinite hangs
        match tokio::time::timeout(
            tokio::time::Duration::from_secs(600), // 10 minutes max
            task_handle
        ).await {
            Ok(Ok(())) => {
                info!("✅ ALL transcription chunks processed successfully - no data lost");
            }
            Ok(Err(e)) => {
                warn!("⚠️ Transcription task completed with error: {:?}", e);
                // Continue anyway - the worker may have processed most chunks
            }
            Err(_) => {
                warn!("⏱️ Transcription timeout (10 minutes) reached, continuing shutdown to prevent indefinite hang");
                // Continue shutdown even on timeout - better to lose some chunks than hang forever
            }
        }

        // Signal the progress loop to stop now that transcription has finished.
        // This runs on all paths above (success, error, and timeout), so the task
        // exits within one tick instead of lingering until a later abort/timeout.
        let _ = done_tx.send(true);

        // Backstop: ensure the task is fully stopped even if the signal was missed.
        progress_task.abort();
    } else {
        info!("ℹ️ No transcription task found to wait for");
    }

    // Step 2.5: The drain is complete, so all tail transcript segments have now been
    // written into the manager (and transcripts.json) by the listener. Remove the
    // transcript-update listener to release the microphone reference, then take the
    // manager out of the global for the final analytics + save below.
    {
        use tauri::Listener;
        if let Some(listener_id) = TRANSCRIPT_LISTENER_ID.lock().map_err(|e| format!("Failed to lock transcript listener: {e}"))?.take() {
            app.unlisten(listener_id);
            info!("✅ Transcript-update listener removed");
        }
    }

    let manager_for_cleanup = {
        let mut global_manager = RECORDING_MANAGER.lock().await;
        global_manager.take()
    };

    // Record the folder being saved so is_folder_recording_active still refuses a
    // relocate of it now that the manager is no longer in the global slot.
    if let Some(ref manager) = manager_for_cleanup {
        if let Ok(mut cf) = CLEANUP_FOLDER.lock() {
            *cf = manager.get_meeting_folder();
        }
    }

    // Step 3: Now safely unload Whisper model after ALL chunks are processed
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "unloading_model",
            "message": "Unloading speech recognition model...",
            "progress": 70
        }),
    );

    info!("🧠 All transcript chunks processed. Now safely unloading transcription model...");

    // Determine which provider was used and unload the appropriate model (with timeout)
    let config = match tokio::time::timeout(
        tokio::time::Duration::from_secs(30), // 30 seconds max for DB operation
        crate::api::api::api_get_transcript_config(
            app.clone(),
            app.clone().state(),
            None,
        )
    )
    .await
    {
        Ok(Ok(Some(config))) => Some(config.provider),
        Ok(Ok(None)) => None,
        Ok(Err(e)) => {
            warn!("⚠️ Failed to get transcript config: {:?}", e);
            None
        }
        Err(_) => {
            warn!("⏱️ Transcript config timeout (30s), continuing shutdown");
            None
        }
    };

    match config.as_deref() {
        Some("parakeet") => {
            info!("🦜 Unloading Parakeet model...");
            let engine_clone = {
                let engine_guard = match crate::parakeet_engine::commands::PARAKEET_ENGINE.lock() {
                    Ok(guard) => guard,
                    Err(e) => {
                        log::error!("Parakeet engine mutex poisoned during shutdown: {e}");
                        return Err(format!("Parakeet engine mutex poisoned: {e}"));
                    }
                };
                engine_guard.as_ref().cloned()
            };

            if let Some(engine) = engine_clone {
                let current_model = engine
                    .get_current_model()
                    .await
                    .unwrap_or_else(|| "unknown".to_string());
                info!("Current Parakeet model before unload: '{}'", current_model);

                if engine.unload_model().await {
                    info!("✅ Parakeet model '{}' unloaded successfully", current_model);
                } else {
                    warn!("⚠️ Failed to unload Parakeet model '{}'", current_model);
                }
            } else {
                warn!("⚠️ No Parakeet engine found to unload model");
            }
        }
        _ => {
            // Default to Whisper
            info!("🎤 Unloading Whisper model...");
            let engine_clone = {
                let engine_guard = match crate::whisper_engine::commands::WHISPER_ENGINE.lock() {
                    Ok(guard) => guard,
                    Err(e) => {
                        log::error!("Whisper engine mutex poisoned during shutdown: {e}");
                        return Err(format!("Whisper engine mutex poisoned: {e}"));
                    }
                };
                engine_guard.as_ref().cloned()
            };

            if let Some(engine) = engine_clone {
                let current_model = engine
                    .get_current_model()
                    .await
                    .unwrap_or_else(|| "unknown".to_string());
                info!("Current Whisper model before unload: '{}'", current_model);

                if engine.unload_model().await {
                    info!("✅ Whisper model '{}' unloaded successfully", current_model);
                } else {
                    warn!("⚠️ Failed to unload Whisper model '{}'", current_model);
                }
            } else {
                warn!("⚠️ No Whisper engine found to unload model");
            }
        }
    }

    // Step 3.5: Track meeting ended analytics with privacy-safe metadata
    // Extract all data from manager BEFORE any async operations to avoid Send issues
    let analytics_data = if let Some(ref manager) = manager_for_cleanup {
        let state = manager.get_state();
        let stats = state.get_stats();

        Some((
            manager.get_recording_duration(),
            manager.get_active_recording_duration().unwrap_or(0.0),
            manager.get_total_pause_duration(),
            manager.get_transcript_segments().len() as u64,
            state.has_fatal_error(),
            state.get_microphone_device().map(|d| d.name.clone()),
            state.get_system_device().map(|d| d.name.clone()),
            stats.chunks_processed,
        ))
    } else {
        None
    };

    // Now perform async analytics tracking without holding manager reference
    if let Some((total_duration, active_duration, pause_duration, transcript_segments_count, had_fatal_error, mic_device_name, sys_device_name, chunks_processed)) = analytics_data {
        info!("📊 Collecting analytics for meeting end");

        // Helper function to classify device type from device name (privacy-safe)
        fn classify_device_type(device_name: &str) -> &'static str {
            let name_lower = device_name.to_lowercase();
            // Check for Bluetooth keywords
            if name_lower.contains("bluetooth")
                || name_lower.contains("airpods")
                || name_lower.contains("beats")
                || name_lower.contains("headphones")
                || name_lower.contains("bt ")
                || name_lower.contains("wireless") {
                "Bluetooth"
            } else {
                "Wired"
            }
        }

        // Get transcription model info (already loaded above for model unload)
        let transcription_config = match crate::api::api::api_get_transcript_config(
            app.clone(),
            app.clone().state(),
            None,
        )
        .await
        {
            Ok(Some(config)) => Some((config.provider, config.model)),
            _ => None,
        };

        let (transcription_provider, transcription_model) = transcription_config
            .unwrap_or_else(|| ("unknown".to_string(), "unknown".to_string()));

        // Get summary model info from API
        let summary_config = match crate::api::api::api_get_model_config(
            app.clone(),
            app.clone().state(),
            None,
        )
        .await
        {
            Ok(Some(config)) => Some((config.provider, config.model)),
            _ => None,
        };

        let (summary_provider, summary_model) = summary_config
            .unwrap_or_else(|| ("unknown".to_string(), "unknown".to_string()));

        // Classify device types (privacy-safe)
        let microphone_device_type = mic_device_name
            .as_ref()
            .map(|name| classify_device_type(name))
            .unwrap_or("Unknown");

        let system_audio_device_type = sys_device_name
            .as_ref()
            .map(|name| classify_device_type(name))
            .unwrap_or("Unknown");

        // Track meeting ended event with privacy-safe data
        match crate::analytics::commands::track_meeting_ended(
            transcription_provider.clone(),
            transcription_model.clone(),
            summary_provider.clone(),
            summary_model.clone(),
            total_duration,
            active_duration,
            pause_duration,
            microphone_device_type.to_string(),
            system_audio_device_type.to_string(),
            chunks_processed,
            transcript_segments_count,
            had_fatal_error,
        )
        .await
        {
            Ok(_) => info!("✅ Analytics tracked successfully for meeting end"),
            Err(e) => warn!("⚠️ Failed to track analytics: {}", e),
        }
    }

    // Step 4: Finalize recording state and cleanup resources safely
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "finalizing",
            "message": "Finalizing recording and cleaning up resources...",
            "progress": 90
        }),
    );

    // Perform final cleanup with the manager if available
    let (meeting_folder, meeting_name) = if let Some(mut manager) = manager_for_cleanup {
        info!("🧹 Performing final cleanup and saving recording data");

        // Extract meeting info BEFORE async operations
        let meeting_folder = manager.get_meeting_folder();
        let meeting_name = manager.get_meeting_name();

        match tokio::time::timeout(
            tokio::time::Duration::from_secs(300), // 5 minutes max for file I/O
            manager.save_recording_only(&app)
        ).await {
            Ok(Ok(_)) => {
                info!("✅ Recording data saved successfully during cleanup");
            }
            Ok(Err(e)) => {
                warn!(
                    "⚠️ Error during recording cleanup (transcripts preserved): {}",
                    e
                );
                // Don't fail shutdown - transcripts are already preserved
            }
            Err(_) => {
                warn!("⏱️ File I/O timeout (5 minutes) reached during save, continuing shutdown");
                // Don't fail shutdown - transcripts are already preserved
            }
        }

        (meeting_folder, meeting_name)
    } else {
        info!("ℹ️ No recording manager available for cleanup");
        (None, None)
    };

    // NOTE: IS_RECORDING / RECORDING_START_TIME / AUDIO_ELAPSED_MS were already reset
    // right after capture stopped (Step 1), and the manager has been taken out of
    // RECORDING_MANAGER above so recording_active() also reads "stopped".
    // CLEANUP_IN_PROGRESS is cleared by the _cleanup_guard when this function returns.

    // Step 4.5: Prepare metadata for frontend (NO database save)
    // NOTE: We do NOT save to database here. The frontend will save after all transcripts are displayed.
    // This ensures the user sees all transcripts streaming in before the database save happens.
    let (folder_path_str, meeting_name_str) = match (&meeting_folder, &meeting_name) {
        (Some(path), Some(name)) => (
            Some(path.to_string_lossy().to_string()),
            Some(name.clone()),
        ),
        _ => (None, None),
    };

    info!("📤 Preparing recording metadata for frontend save");
    info!("   folder_path: {:?}", folder_path_str);
    info!("   meeting_name: {:?}", meeting_name_str);

    // Database save removed - frontend will handle this after receiving all transcripts
    info!("ℹ️ Skipping database save in Rust - frontend will save after all transcripts received");

    // Step 5: Complete shutdown
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "complete",
            "message": "Recording stopped successfully",
            "progress": 100
        }),
    );

    // Emit final stop event with folder_path and meeting_name for frontend to save
    app.emit(
        "recording-stopped",
        serde_json::json!({
            "message": "Recording stopped - frontend will save after all transcripts received",
            "folder_path": folder_path_str,
            "meeting_name": meeting_name_str
        }),
    )
    .map_err(|e| e.to_string())?;

    // Update tray menu to reflect stopped state
    crate::tray::update_tray_menu(&app);

    info!("🎉 Recording stopped successfully with ZERO transcript chunks lost");
    Ok(())
}

/// Check if recording is active
pub async fn is_recording() -> bool {
    recording_active().await
}

/// Get recording statistics
pub async fn get_transcription_status() -> TranscriptionStatus {
    TranscriptionStatus {
        chunks_in_queue: 0,
        is_processing: recording_active().await,
        last_activity_ms: 0,
    }
}

/// Pause the current recording
#[tauri::command]
pub async fn pause_recording<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    info!("Pausing recording");

    // Check if currently recording (single source of truth: the RecordingManager)
    if !recording_active().await {
        return Err("No recording is currently active".to_string());
    }

    // Access the recording manager and pause it
    let manager_guard = RECORDING_MANAGER.lock().await;
    if let Some(manager) = manager_guard.as_ref() {
        manager.pause_recording().map_err(|e| e.to_string())?;

        // Emit pause event to frontend
        app.emit(
            "recording-paused",
            serde_json::json!({
                "message": "Recording paused"
            }),
        )
        .map_err(|e| e.to_string())?;

        // Update tray menu to reflect paused state
        crate::tray::update_tray_menu(&app);

        info!("Recording paused successfully");
        Ok(())
    } else {
        Err("No recording manager found".to_string())
    }
}

/// Resume the current recording
#[tauri::command]
pub async fn resume_recording<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    info!("Resuming recording");

    // Check if currently recording (single source of truth: the RecordingManager)
    if !recording_active().await {
        return Err("No recording is currently active".to_string());
    }

    // Access the recording manager and resume it
    let manager_guard = RECORDING_MANAGER.lock().await;
    if let Some(manager) = manager_guard.as_ref() {
        manager.resume_recording().map_err(|e| e.to_string())?;

        // Emit resume event to frontend
        app.emit(
            "recording-resumed",
            serde_json::json!({
                "message": "Recording resumed"
            }),
        )
        .map_err(|e| e.to_string())?;

        // Update tray menu to reflect resumed state
        crate::tray::update_tray_menu(&app);

        info!("Recording resumed successfully");
        Ok(())
    } else {
        Err("No recording manager found".to_string())
    }
}

/// Check if recording is currently paused
#[tauri::command]
pub async fn is_recording_paused() -> Result<bool, String> {
    let manager_guard = RECORDING_MANAGER.lock().await;
    if let Some(manager) = manager_guard.as_ref() {
        Ok(manager.is_paused())
    } else {
        Ok(false)
    }
}

/// Get detailed recording state
#[tauri::command]
pub async fn get_recording_state() -> Result<serde_json::Value, String> {
    // Single source of truth: derive recording state from the manager itself.
    let manager_guard = RECORDING_MANAGER.lock().await;
    let is_recording = manager_guard.as_ref().map(|m| m.is_recording()).unwrap_or(false);

    if let Some(manager) = manager_guard.as_ref() {
        Ok(serde_json::json!({
            "is_recording": is_recording,
            "is_paused": manager.is_paused(),
            "is_active": manager.is_active(),
            "recording_duration": manager.get_recording_duration(),
            "active_duration": manager.get_active_recording_duration(),
            "total_pause_duration": manager.get_total_pause_duration(),
            "current_pause_duration": manager.get_current_pause_duration()
        }))
    } else {
        Ok(serde_json::json!({
            "is_recording": is_recording,
            "is_paused": false,
            "is_active": false,
            "recording_duration": null,
            "active_duration": null,
            "total_pause_duration": 0.0,
            "current_pause_duration": null
        }))
    }
}

/// Get the meeting folder path for the current recording
/// Returns the path if a meeting name was set and folder structure initialized
#[tauri::command]
pub async fn get_meeting_folder_path() -> Result<Option<String>, String> {
    let manager_guard = RECORDING_MANAGER.lock().await;
    if let Some(manager) = manager_guard.as_ref() {
        Ok(manager.get_meeting_folder().map(|p| p.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
}

/// Get accumulated transcript segments from current recording session
/// Used for syncing frontend state after page reload during active recording
#[tauri::command]
pub async fn get_transcript_history() -> Result<Vec<crate::audio::recording_saver::TranscriptSegment>, String> {
    let manager_guard = RECORDING_MANAGER.lock().await;

    if let Some(manager) = manager_guard.as_ref() {
        Ok(manager.get_transcript_segments())
    } else {
        Ok(Vec::new()) // No recording active, return empty
    }
}

/// Get meeting name from current recording session
/// Used for syncing frontend state after page reload during active recording
#[tauri::command]
pub async fn get_recording_meeting_name() -> Result<Option<String>, String> {
    let manager_guard = RECORDING_MANAGER.lock().await;

    if let Some(manager) = manager_guard.as_ref() {
        Ok(manager.get_meeting_name())
    } else {
        Ok(None)
    }
}

// ============================================================================
// DEVICE MONITORING COMMANDS (AirPods/Bluetooth disconnect/reconnect support)
// ============================================================================

/// Response structure for device events
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type")]
pub enum DeviceEventResponse {
    DeviceDisconnected {
        device_name: String,
        device_type: String,
    },
    DeviceReconnected {
        device_name: String,
        device_type: String,
    },
    DeviceListChanged,
}

impl From<DeviceEvent> for DeviceEventResponse {
    fn from(event: DeviceEvent) -> Self {
        match event {
            DeviceEvent::DeviceDisconnected { device_name, device_type } => {
                DeviceEventResponse::DeviceDisconnected {
                    device_name,
                    device_type: format!("{:?}", device_type),
                }
            }
            DeviceEvent::DeviceReconnected { device_name, device_type } => {
                DeviceEventResponse::DeviceReconnected {
                    device_name,
                    device_type: format!("{:?}", device_type),
                }
            }
            DeviceEvent::DeviceListChanged => DeviceEventResponse::DeviceListChanged,
        }
    }
}

/// Reconnection status information
#[derive(Debug, Serialize, Clone)]
pub struct ReconnectionStatus {
    pub is_reconnecting: bool,
    pub disconnected_device: Option<DisconnectedDeviceInfo>,
}

/// Information about a disconnected device
#[derive(Debug, Serialize, Clone)]
pub struct DisconnectedDeviceInfo {
    pub name: String,
    pub device_type: String,
}

/// Poll for audio device events (disconnect/reconnect)
/// Should be called periodically (every 1-2 seconds) by frontend during recording
#[tauri::command]
pub async fn poll_audio_device_events() -> Result<Option<DeviceEventResponse>, String> {
    let mut manager_guard = RECORDING_MANAGER.lock().await;

    if let Some(manager) = manager_guard.as_mut() {
        if let Some(event) = manager.poll_device_events() {
            info!("📱 Device event polled: {:?}", event);
            Ok(Some(event.into()))
        } else {
            Ok(None)
        }
    } else {
        // Not recording, no events
        Ok(None)
    }
}

/// Get current reconnection status
/// Returns whether the system is attempting to reconnect and which device
#[tauri::command]
pub async fn get_reconnection_status() -> Result<ReconnectionStatus, String> {
    let manager_guard = RECORDING_MANAGER.lock().await;

    if let Some(manager) = manager_guard.as_ref() {
        let state = manager.get_state();
        let disconnected_device = state.get_disconnected_device().map(|(device, device_type)| {
            DisconnectedDeviceInfo {
                name: device.name.clone(),
                device_type: format!("{:?}", device_type),
            }
        });

        Ok(ReconnectionStatus {
            is_reconnecting: manager.is_reconnecting(),
            disconnected_device,
        })
    } else {
        // Not recording, no reconnection in progress
        Ok(ReconnectionStatus {
            is_reconnecting: false,
            disconnected_device: None,
        })
    }
}

/// Get information about the active audio output device
/// Used to warn users about Bluetooth playback issues
#[tauri::command]
pub async fn get_active_audio_output() -> Result<super::playback_monitor::AudioOutputInfo, String> {
    super::playback_monitor::get_active_audio_output()
        .await
        .map_err(|e| format!("Failed to get audio output info: {}", e))
}

/// Manually trigger device reconnection attempt
/// Useful for UI "Retry" button
#[tauri::command]
pub async fn attempt_device_reconnect(
    device_name: String,
    device_type: String,
) -> Result<bool, String> {
    // Parse device type first
    let monitor_type = match device_type.as_str() {
        "Microphone" => DeviceMonitorType::Microphone,
        "SystemAudio" => DeviceMonitorType::SystemAudio,
        _ => return Err(format!("Invalid device type: {}", device_type)),
    };

    // Check if recording is active
    {
        let manager_guard = RECORDING_MANAGER.lock().await;
        if manager_guard.is_none() {
            return Err("Recording not active".to_string());
        }
    } // Release lock

    // C08: Direct async lock — no spawn_blocking/block_on needed with tokio::sync::Mutex
    let result = {
        let mut manager_guard = RECORDING_MANAGER.lock().await;
        if let Some(manager) = manager_guard.as_mut() {
            manager.attempt_device_reconnect(&device_name, monitor_type).await
        } else {
            Err(anyhow::anyhow!("Recording not active"))
        }
    };

    match result {
        Ok(success) => {
            if success {
                info!("✅ Manual reconnection successful");
            } else {
                warn!("❌ Manual reconnection failed - device not available");
            }
            Ok(success)
        }
        Err(e) => {
            error!("Manual reconnection error: {}", e);
            Err(e.to_string())
        }
    }
}

// ============================================================================
// PUBLIC HELPERS (for use by other modules, e.g. screenshot)
// ============================================================================

/// Get elapsed seconds since recording started, or None if not recording.
pub fn get_recording_elapsed_secs() -> Option<f64> {
    // Single source of truth: derive from the RecordingManager. Uses a non-blocking
    // try_lock since this is a sync helper on the screenshot/clipboard path.
    let recording = RECORDING_MANAGER
        .try_lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|m| m.is_recording()))
        .unwrap_or(false);
    if !recording {
        return None;
    }
    // Use audio-elapsed time so screenshot/clipboard timestamps align with
    // transcripts (which are sourced from the same VAD audio clock).
    // Falls back to wall-clock if no audio has been processed yet (briefly,
    // right at the start of a recording).
    let audio_ms = AUDIO_ELAPSED_MS.load(Ordering::Relaxed);
    if audio_ms > 0 {
        return Some(audio_ms as f64 / 1000.0);
    }
    RECORDING_START_TIME
        .lock()
        .ok()?
        .as_ref()
        .map(|start| start.elapsed().as_secs_f64())
}

/// Get the current meeting folder path, or None if not recording or no folder set.
pub fn get_current_meeting_folder() -> Option<std::path::PathBuf> {
    let manager_guard = RECORDING_MANAGER.try_lock().ok()?;
    manager_guard.as_ref()?.get_meeting_folder()
}

/// True when `path` is (a normalized match of) the folder the live recording is writing into.
/// Used by the relocate command to hard-refuse moving a folder while the pipeline writes it (R3).
pub fn is_folder_recording_active(path: &str) -> bool {
    fn norm(p: &std::path::Path) -> String {
        p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase()
    }
    // Refuse a relocate while the pipeline is either capturing (IS_RECORDING) or still
    // draining/saving the just-finished meeting (CLEANUP_IN_PROGRESS): in both states
    // the saver may still be writing transcripts.json / the audio file into this folder.
    if !IS_RECORDING.load(Ordering::SeqCst) && !CLEANUP_IN_PROGRESS.load(Ordering::SeqCst) {
        return false;
    }
    // While capturing, the live manager holds the folder; during cleanup the manager has
    // been taken out of the global, so fall back to the tracked CLEANUP_FOLDER.
    let active = get_current_meeting_folder()
        .or_else(|| CLEANUP_FOLDER.lock().ok().and_then(|g| g.clone()));
    match active {
        Some(active) => norm(&active) == norm(std::path::Path::new(path)),
        None => false,
    }
}

/// Get the base recordings directory (parent of per-meeting folders).
/// Useful as a default path hint before a recording has started.
#[tauri::command]
pub async fn get_recordings_base_dir() -> Result<Option<String>, String> {
    let base = super::recording_preferences::get_default_recordings_folder();
    Ok(Some(base.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression for the start_recording TOCTOU (B017) and the stop/start decoupling.
    /// Both concerns share the module-level IS_RECORDING / CLEANUP_IN_PROGRESS atomics,
    /// so this is a single serial test to avoid interference from the parallel runner.
    #[test]
    fn reservation_is_exclusive_releases_on_drop_and_respects_cleanup() {
        // Clean baseline.
        IS_RECORDING.store(false, Ordering::SeqCst);
        CLEANUP_IN_PROGRESS.store(false, Ordering::SeqCst);

        // First start reserves the slot atomically, up front (no late store).
        let guard = try_reserve_recording_slot().expect("first reserve should succeed");
        assert!(IS_RECORDING.load(Ordering::SeqCst));

        // A near-simultaneous second start (button + hotkey + tray + handover) is rejected
        // instead of spawning a duplicate audio pipeline.
        assert!(
            try_reserve_recording_slot().is_err(),
            "concurrent second start must be rejected"
        );

        // An early-return error path drops the guard, which releases the reservation so
        // IS_RECORDING is never left stuck true.
        drop(guard);
        assert!(!IS_RECORDING.load(Ordering::SeqCst));

        // A subsequent start reserves again; disarm() (the success path) keeps it held.
        let guard2 = try_reserve_recording_slot().expect("reserve after release should succeed");
        guard2.disarm();
        assert!(IS_RECORDING.load(Ordering::SeqCst));
        assert!(try_reserve_recording_slot().is_err());

        // Simulate stop: capture ends (IS_RECORDING false) while cleanup drains/saves.
        IS_RECORDING.store(false, Ordering::SeqCst);
        CLEANUP_IN_PROGRESS.store(true, Ordering::SeqCst);

        // A start during the drain is rejected even though IS_RECORDING is false, and the
        // reservation is rolled back so IS_RECORDING is not left stuck true.
        assert!(
            try_reserve_recording_slot().is_err(),
            "start during cleanup must be rejected"
        );
        assert!(!IS_RECORDING.load(Ordering::SeqCst));

        // Once cleanup finishes, starting works again.
        CLEANUP_IN_PROGRESS.store(false, Ordering::SeqCst);
        let guard3 = try_reserve_recording_slot().expect("reserve after cleanup should succeed");
        drop(guard3);

        // Restore baseline for any other tests.
        IS_RECORDING.store(false, Ordering::SeqCst);
        CLEANUP_IN_PROGRESS.store(false, Ordering::SeqCst);
    }

    /// Regression for the start-vs-stop manager-population race. IS_RECORDING is reserved at
    /// the top of a start path, several .await points before the manager is stored in
    /// RECORDING_MANAGER. A stop landing in that window must NOT tear down (which would unload
    /// the model and clear IS_RECORDING, clobbering the in-flight start), it must no-op.
    /// decide_stop_action is the single decision point stop_recording branches on, so covering
    /// its full truth table here exercises the ordering invariant the fix relies on.
    #[test]
    fn stop_action_no_ops_while_a_start_has_not_populated_the_manager() {
        // is_recording=false -> nothing to stop, regardless of manager state.
        assert_eq!(decide_stop_action(false, false), StopAction::NotRecording);
        assert_eq!(decide_stop_action(false, true), StopAction::NotRecording);

        // is_recording=true but manager not yet populated: this is exactly the start-vs-stop
        // window. Must no-op so the in-flight start's reservation is left intact.
        assert_eq!(
            decide_stop_action(true, false),
            StopAction::PendingStartNoop,
            "a stop during a pending start (IS_RECORDING reserved, manager not yet stored) must no-op"
        );

        // is_recording=true and manager populated: a genuine live recording, tear it down.
        assert_eq!(decide_stop_action(true, true), StopAction::Teardown);
    }
}
